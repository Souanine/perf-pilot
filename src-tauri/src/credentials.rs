//! Credential vault for load-test auth (tokens, basic accounts, API keys,
//! OAuth2 client/refresh pools).
//!
//! Split storage: non-secret metadata (name, mode, env var names, usernames,
//! token URL) lives in the `credentials.list` key of the frontend-owned
//! `perf-pilot.settings.json`; secret values live in the OS credential store
//! under `cred:<id>:<index>` — one entry per pool value, so a pool of 50
//! tokens is 50 entries. Per-value entries sidestep the Windows Credential
//! Manager's ~2.5 KB per-entry cap, which a single JSON blob would hit.
//!
//! Security contract: there is deliberately **no get command**. Values are
//! written once by the frontend and only ever read back inside this process
//! (`resolve_for_run`), so a secret never crosses the IPC bridge — unlike
//! the LLM API keys in `secrets.rs`. Editing a credential means re-entering
//! its values; the UI shows only the pool size.
//!
//! `RunOptions.credentials` carries credential *ids* only. `k6::prepare_run`
//! calls [`resolve_for_run`] to turn them into env vars on the k6 child
//! process. Values go through `Command::envs()`, never argv, so they stay
//! out of the `RunEvent::Started` command echo and the persisted RunOutput.

use crate::secrets::SERVICE;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;

/// Safety cap for pool size and for the shrink-probe loops below. Real pools
/// are tens of entries; this only bounds pathological input.
const MAX_POOL_SIZE: usize = 4096;

/// Key in `perf-pilot.settings.json` holding the credential metadata array.
/// Same read-only-from-Rust contract as `fs::SCRIPTS_DIR_KEY`: the frontend
/// owns writes, Rust only reads.
const CREDENTIALS_KEY: &str = "credentials.list";

/// Non-secret metadata for one credential, as persisted by the frontend.
/// `mode` selects which fields matter and how values are injected:
///
/// - `token` / `apikey`: values are the secret strings; injected as
///   `envKey = values.join("\n")`.
/// - `basic`: values are passwords (parallel to `users`); injected as
///   `userEnvKey = users.join("\n")` and `passEnvKey = passwords.join("\n")`.
/// - `oauth2_client`: each value is a JSON object `{"id","secret"}`;
///   injected as `{envKey}_TOKEN_URL`, `{envKey}_CLIENT_ID`,
///   `{envKey}_CLIENT_SECRET`, and `{envKey}_SCOPE` when set.
/// - `oauth2_refresh`: each value is `{"refresh","id"?,"secret"?}`;
///   injected as `{envKey}_TOKEN_URL`, `{envKey}_REFRESH_TOKEN`, plus
///   `{envKey}_CLIENT_ID` / `{envKey}_CLIENT_SECRET` when any entry carries them.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMeta {
    pub id: String,
    pub name: String,
    pub mode: String,
    /// Env var name (or `OAUTH`-style prefix for oauth2 modes).
    pub env_key: String,
    #[serde(default)]
    pub user_env_key: Option<String>,
    #[serde(default)]
    pub pass_env_key: Option<String>,
    #[serde(default)]
    pub header_name: Option<String>,
    /// "header" | "query" — non-secret, consumed by the script generator.
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub token_url: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    /// basic mode: usernames, parallel to the password pool. Non-secret.
    #[serde(default)]
    pub users: Vec<String>,
    /// Number of secret values in the keychain pool for this credential.
    #[serde(default)]
    pub value_count: usize,
}

/// Metadata-only view of a credential sent to the LLM with each script
/// generation request. Never carries values — the model sees variable
/// names and pool sizes so generated scripts read the right `__ENV` keys.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBrief {
    pub name: String,
    pub mode: String,
    pub env_key: String,
    #[serde(default)]
    pub user_env_key: Option<String>,
    #[serde(default)]
    pub pass_env_key: Option<String>,
    #[serde(default)]
    pub header_name: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub token_url: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub value_count: usize,
}

impl CredentialBrief {
    pub fn from_meta(m: &CredentialMeta) -> Self {
        Self {
            name: m.name.clone(),
            mode: m.mode.clone(),
            env_key: m.env_key.clone(),
            user_env_key: m.user_env_key.clone(),
            pass_env_key: m.pass_env_key.clone(),
            header_name: m.header_name.clone(),
            location: m.location.clone(),
            token_url: m.token_url.clone(),
            scope: m.scope.clone(),
            value_count: m.value_count,
        }
    }
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keychain entry failed: {e}"))
}

fn value_key(id: &str, index: usize) -> String {
    format!("cred:{id}:{index}")
}

/// Ids land inside keychain keys, so they must not contain the `:` separator
/// or anything that could collide with another credential's index space.
fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid credential id: {id:?}"))
    }
}

/// Env var names reach a child process environment; keep them to the
/// portable `[A-Za-z_][A-Za-z0-9_]*` subset.
fn validate_env_key(key: &str) -> Result<String, String> {
    let ok = !key.is_empty()
        && key.len() <= 128
        && !key.chars().next().unwrap().is_ascii_digit()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        Ok(key.to_string())
    } else {
        Err(format!("invalid env var name: {key:?}"))
    }
}

/// Store (or overwrite) the whole secret pool for a credential. Values are
/// written one keychain entry per index; entries left over from a previously
/// larger pool are deleted by probing past the new length until NoEntry.
/// Probing avoids depending on the metadata's `valueCount`, which the
/// frontend writes *after* this command and may therefore lag behind.
#[tauri::command]
pub fn credential_set_values(id: String, values: Vec<String>) -> Result<(), String> {
    validate_id(&id)?;
    if values.len() > MAX_POOL_SIZE {
        return Err(format!("credential pool too large ({} values)", values.len()));
    }
    for (i, v) in values.iter().enumerate() {
        entry(&value_key(&id, i))?
            .set_password(v)
            .map_err(|e| format!("keychain write failed: {e}"))?;
    }
    let mut i = values.len();
    while i < MAX_POOL_SIZE {
        match entry(&value_key(&id, i))?.delete_credential() {
            Ok(()) => i += 1,
            Err(KeyringError::NoEntry) => break,
            Err(e) => return Err(format!("keychain delete failed: {e}")),
        }
    }
    Ok(())
}

/// Remove every keychain entry belonging to a credential. Deleting an
/// empty/absent pool is a no-op so callers don't have to probe first.
#[tauri::command]
pub fn credential_delete(id: String) -> Result<(), String> {
    validate_id(&id)?;
    let mut i = 0;
    while i < MAX_POOL_SIZE {
        match entry(&value_key(&id, i))?.delete_credential() {
            Ok(()) => i += 1,
            Err(KeyringError::NoEntry) => break,
            Err(e) => return Err(format!("keychain delete failed: {e}")),
        }
    }
    Ok(())
}

/// Turn selected credential ids into the env map for a k6 run. Called from
/// `k6::prepare_run` so values never leave this process. Any selected
/// credential that is missing metadata or keychain values aborts the run —
/// silently running without auth would produce meaningless results.
pub fn resolve_for_run(
    app: &tauri::AppHandle,
    ids: &[String],
) -> Result<HashMap<String, String>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?
        .join("perf-pilot.settings.json");
    let raw = std::fs::read_to_string(&file)
        .map_err(|e| format!("reading settings for credentials failed: {e}"))?;
    let metas = parse_credential_list(&raw);
    resolve_from_metas(&metas, ids)
}

/// Split out from [`resolve_for_run`] so metadata parsing + env assembly is
/// testable without an `AppHandle`. Keychain reads still happen for real.
fn resolve_from_metas(metas: &[CredentialMeta], ids: &[String]) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    for id in ids {
        let meta = metas
            .iter()
            .find(|m| m.id == *id)
            .ok_or_else(|| format!("credential '{id}' not found — it may have been deleted"))?;
        let values = read_pool(&meta.id, meta.value_count)
            .map_err(|e| format!("credential '{}': {e}", meta.name))?;
        inject(meta, &values, &mut env)
            .map_err(|e| format!("credential '{}': {e}", meta.name))?;
    }
    Ok(env)
}

fn parse_credential_list(raw: &str) -> Vec<CredentialMeta> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = v.get(CREDENTIALS_KEY).and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|x| serde_json::from_value::<CredentialMeta>(x.clone()).ok())
        .collect()
}

fn read_pool(id: &str, count: usize) -> Result<Vec<String>, String> {
    if count == 0 {
        return Err("has no values stored — set them on the Credentials page".to_string());
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        match entry(&value_key(id, i))?.get_password() {
            Ok(v) => out.push(v),
            Err(KeyringError::NoEntry) => {
                return Err(format!("value #{i} is missing from the credential store"))
            }
            Err(e) => return Err(format!("keychain read failed: {e}")),
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
struct OauthClientPair {
    id: String,
    secret: String,
}

#[derive(Deserialize)]
struct OauthRefreshEntry {
    refresh: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    secret: String,
}

fn inject(
    meta: &CredentialMeta,
    values: &[String],
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    match meta.mode.as_str() {
        "token" | "apikey" => {
            env.insert(validate_env_key(&meta.env_key)?, values.join("\n"));
        }
        "basic" => {
            let user_key = meta
                .user_env_key
                .as_deref()
                .ok_or("basic mode requires a username env var name")?;
            let pass_key = meta
                .pass_env_key
                .as_deref()
                .ok_or("basic mode requires a password env var name")?;
            if meta.users.len() != values.len() {
                return Err(format!(
                    "username/password pools are out of sync ({} users, {} passwords)",
                    meta.users.len(),
                    values.len()
                ));
            }
            env.insert(validate_env_key(user_key)?, meta.users.join("\n"));
            env.insert(validate_env_key(pass_key)?, values.join("\n"));
        }
        "oauth2_client" => {
            let prefix = validate_env_key(&meta.env_key)?;
            let token_url = meta
                .token_url
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("oauth2 client mode requires a token URL")?;
            let mut ids = Vec::with_capacity(values.len());
            let mut secrets = Vec::with_capacity(values.len());
            for v in values {
                let pair: OauthClientPair = serde_json::from_str(v)
                    .map_err(|e| format!("client value is malformed: {e}"))?;
                ids.push(pair.id);
                secrets.push(pair.secret);
            }
            env.insert(format!("{prefix}_TOKEN_URL"), token_url.to_string());
            env.insert(format!("{prefix}_CLIENT_ID"), ids.join("\n"));
            env.insert(format!("{prefix}_CLIENT_SECRET"), secrets.join("\n"));
            if let Some(scope) = meta.scope.as_deref().filter(|s| !s.trim().is_empty()) {
                env.insert(format!("{prefix}_SCOPE"), scope.to_string());
            }
        }
        "oauth2_refresh" => {
            let prefix = validate_env_key(&meta.env_key)?;
            let token_url = meta
                .token_url
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .ok_or("oauth2 refresh mode requires a token URL")?;
            let mut refreshes = Vec::with_capacity(values.len());
            let mut ids = Vec::with_capacity(values.len());
            let mut secrets = Vec::with_capacity(values.len());
            let mut has_client = false;
            for v in values {
                let e: OauthRefreshEntry = serde_json::from_str(v)
                    .map_err(|e| format!("refresh value is malformed: {e}"))?;
                refreshes.push(e.refresh);
                has_client |= !e.id.is_empty() || !e.secret.is_empty();
                ids.push(e.id);
                secrets.push(e.secret);
            }
            env.insert(format!("{prefix}_TOKEN_URL"), token_url.to_string());
            env.insert(format!("{prefix}_REFRESH_TOKEN"), refreshes.join("\n"));
            if has_client {
                env.insert(format!("{prefix}_CLIENT_ID"), ids.join("\n"));
                env.insert(format!("{prefix}_CLIENT_SECRET"), secrets.join("\n"));
            }
        }
        other => return Err(format!("unknown credential mode: {other}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Namespace for throwaway test pools — keeps them out of the real
    /// `cred:` space so a test run can't clobber a user's credentials.
    const TEST_PREFIX: &str = "__cargo_test__";

    fn test_id(suffix: &str) -> String {
        format!("{TEST_PREFIX}{suffix}")
    }

    fn meta(id: &str, mode: &str, env_key: &str, value_count: usize) -> CredentialMeta {
        CredentialMeta {
            id: id.to_string(),
            name: format!("test-{mode}"),
            mode: mode.to_string(),
            env_key: env_key.to_string(),
            user_env_key: None,
            pass_env_key: None,
            header_name: None,
            location: None,
            token_url: None,
            scope: None,
            users: vec![],
            value_count,
        }
    }

    fn cleanup(id: &str) {
        let _ = credential_delete(id.to_string());
    }

    #[test]
    fn pool_roundtrips_and_shrinks() {
        let id = test_id("pool");
        cleanup(&id);
        credential_set_values(id.clone(), vec!["a".into(), "b".into(), "c".into()]).unwrap();
        assert_eq!(read_pool(&id, 3).unwrap(), vec!["a", "b", "c"]);
        // Shrink to one value: the old tail entries must be gone.
        credential_set_values(id.clone(), vec!["z".into()]).unwrap();
        assert_eq!(read_pool(&id, 1).unwrap(), vec!["z"]);
        assert!(read_pool(&id, 2).is_err(), "stale tail entry survived a shrink");
        cleanup(&id);
    }

    #[test]
    fn delete_absent_pool_is_noop() {
        let id = test_id("absent");
        cleanup(&id);
        assert!(credential_delete(id).is_ok());
    }

    #[test]
    fn rejects_bad_ids() {
        assert!(validate_id("ok-id_1").is_ok());
        assert!(validate_id("bad:id").is_err());
        assert!(validate_id("").is_err());
    }

    #[test]
    fn rejects_bad_env_keys() {
        assert_eq!(validate_env_key("AUTH_TOKEN").unwrap(), "AUTH_TOKEN");
        assert!(validate_env_key("9BAD").is_err());
        assert!(validate_env_key("HAS SPACE").is_err());
        assert!(validate_env_key("").is_err());
    }

    #[test]
    fn parses_credential_list_tolerantly() {
        let raw = r#"{
            "credentials.list": [
                {"id":"c1","name":"t","mode":"token","envKey":"AUTH_TOKEN","valueCount":2},
                {"garbage": true},
                {"id":"c2","name":"u","mode":"basic","envKey":"X","userEnvKey":"AUTH_USER","passEnvKey":"AUTH_PASS","users":["alice"],"valueCount":1}
            ],
            "scripts.dir": "/tmp/x"
        }"#;
        let metas = parse_credential_list(raw);
        assert_eq!(metas.len(), 2, "malformed entry should be skipped, not fatal");
        assert_eq!(metas[0].env_key, "AUTH_TOKEN");
        assert_eq!(metas[0].value_count, 2);
        assert_eq!(metas[1].users, vec!["alice"]);
        assert!(parse_credential_list("not json").is_empty());
        assert!(parse_credential_list("{}").is_empty());
    }

    #[test]
    fn inject_token_joins_pool() {
        let m = meta("x", "token", "AUTH_TOKEN", 2);
        let mut env = HashMap::new();
        inject(&m, &["t1".into(), "t2".into()], &mut env).unwrap();
        assert_eq!(env.get("AUTH_TOKEN").map(String::as_str), Some("t1\nt2"));
    }

    #[test]
    fn inject_apikey_uses_its_own_env_key() {
        let mut m = meta("x", "apikey", "API_KEY", 1);
        m.header_name = Some("X-API-Key".into());
        let mut env = HashMap::new();
        inject(&m, &["k1".into()], &mut env).unwrap();
        assert_eq!(env.get("API_KEY").map(String::as_str), Some("k1"));
        // headerName is script-level metadata, never an env var.
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn inject_basic_builds_parallel_arrays() {
        let mut m = meta("x", "basic", "AUTH_PASS", 2);
        m.user_env_key = Some("AUTH_USER".into());
        m.pass_env_key = Some("AUTH_PASS".into());
        m.users = vec!["alice".into(), "bob".into()];
        let mut env = HashMap::new();
        inject(&m, &["pw1".into(), "pw2".into()], &mut env).unwrap();
        assert_eq!(env.get("AUTH_USER").map(String::as_str), Some("alice\nbob"));
        assert_eq!(env.get("AUTH_PASS").map(String::as_str), Some("pw1\npw2"));
    }

    #[test]
    fn inject_basic_rejects_count_mismatch() {
        let mut m = meta("x", "basic", "AUTH_PASS", 2);
        m.user_env_key = Some("AUTH_USER".into());
        m.pass_env_key = Some("AUTH_PASS".into());
        m.users = vec!["only-one".into()];
        let mut env = HashMap::new();
        assert!(inject(&m, &["p1".into(), "p2".into()], &mut env).is_err());
    }

    #[test]
    fn inject_oauth2_client() {
        let mut m = meta("x", "oauth2_client", "OAUTH", 2);
        m.token_url = Some("https://auth.example/token".into());
        m.scope = Some("orders".into());
        let values = vec![
            r#"{"id":"cid1","secret":"sec1"}"#.to_string(),
            r#"{"id":"cid2","secret":"sec2"}"#.to_string(),
        ];
        let mut env = HashMap::new();
        inject(&m, &values, &mut env).unwrap();
        assert_eq!(env.get("OAUTH_TOKEN_URL").map(String::as_str), Some("https://auth.example/token"));
        assert_eq!(env.get("OAUTH_CLIENT_ID").map(String::as_str), Some("cid1\ncid2"));
        assert_eq!(env.get("OAUTH_CLIENT_SECRET").map(String::as_str), Some("sec1\nsec2"));
        assert_eq!(env.get("OAUTH_SCOPE").map(String::as_str), Some("orders"));
    }

    #[test]
    fn inject_oauth2_client_requires_token_url() {
        let m = meta("x", "oauth2_client", "OAUTH", 1);
        let mut env = HashMap::new();
        assert!(inject(&m, &[r#"{"id":"a","secret":"b"}"#.into()], &mut env).is_err());
    }

    #[test]
    fn inject_oauth2_refresh_without_client_auth() {
        let mut m = meta("x", "oauth2_refresh", "OAUTH", 1);
        m.token_url = Some("https://auth.example/token".into());
        let mut env = HashMap::new();
        inject(&m, &[r#"{"refresh":"r1"}"#.into()], &mut env).unwrap();
        assert_eq!(env.get("OAUTH_REFRESH_TOKEN").map(String::as_str), Some("r1"));
        assert!(!env.contains_key("OAUTH_CLIENT_ID"), "absent client auth must not inject empty vars");
    }

    #[test]
    fn inject_oauth2_refresh_with_client_auth() {
        let mut m = meta("x", "oauth2_refresh", "OAUTH", 1);
        m.token_url = Some("https://auth.example/token".into());
        let mut env = HashMap::new();
        inject(&m, &[r#"{"refresh":"r1","id":"cid","secret":"sec"}"#.into()], &mut env).unwrap();
        assert_eq!(env.get("OAUTH_CLIENT_ID").map(String::as_str), Some("cid"));
        assert_eq!(env.get("OAUTH_CLIENT_SECRET").map(String::as_str), Some("sec"));
    }

    #[test]
    fn inject_rejects_unknown_mode() {
        let m = meta("x", "magic", "X", 1);
        let mut env = HashMap::new();
        assert!(inject(&m, &["v".into()], &mut env).is_err());
    }

    #[test]
    fn resolve_reports_missing_metadata_and_empty_pool() {
        // Unknown id → clear error mentioning the id.
        let err = resolve_from_metas(&[], &["gone".into()]).unwrap_err();
        assert!(err.contains("gone"), "got: {err}");
        // Known id but zero values → actionable error, not an empty env.
        let m = meta(&test_id("empty"), "token", "AUTH_TOKEN", 0);
        let err = resolve_from_metas(&[m], &[test_id("empty")]).unwrap_err();
        assert!(err.contains("no values"), "got: {err}");
    }

    #[test]
    fn resolve_end_to_end_with_keychain() {
        let id = test_id("resolve");
        cleanup(&id);
        credential_set_values(id.clone(), vec!["tok-a".into(), "tok-b".into()]).unwrap();
        let m = meta(&id, "token", "AUTH_TOKEN", 2);
        let env = resolve_from_metas(&[m], &[id.clone()]).unwrap();
        assert_eq!(env.get("AUTH_TOKEN").map(String::as_str), Some("tok-a\ntok-b"));
        cleanup(&id);
    }
}
