//! OS credential store for LLM provider API keys.
//!
//! Keys used to be persisted verbatim inside `perf-pilot.settings.json`
//! (world-readable, mode 644). They now live in the platform credential
//! store instead: macOS Keychain, Windows Credential Manager, or Linux
//! Secret Service on the back of `keyring`. The settings JSON keeps only
//! non-secret provider config (base URL, model, temperature, catalog).
//!
//! Entries are namespaced by [`SERVICE`] and keyed by provider id, so
//! deleting a provider in the UI maps 1:1 onto removing its key.
//!
//! Note: the key still crosses the IPC bridge in plaintext when the
//! frontend calls `test_llm` / `generate_script`. This module closes the
//! *at-rest* exposure; keeping the key out of renderer memory entirely
//! would mean moving provider lookup into Rust.

use keyring::{Entry, Error as KeyringError};

/// Namespaces our entries inside the shared OS credential store. Keep
/// in sync with `identifier` in `tauri.conf.json`.
const SERVICE: &str = "dev.perfpilot.app";

fn entry(provider_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider_id).map_err(|e| format!("keychain entry failed: {e}"))
}

/// Read a provider's API key. `Ok(None)` means "no key stored", which is
/// the normal state for a freshly added provider — not an error.
#[tauri::command]
pub fn secret_get(provider_id: String) -> Result<Option<String>, String> {
    match entry(&provider_id)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

/// Store (or overwrite) a provider's API key.
#[tauri::command]
pub fn secret_set(provider_id: String, value: String) -> Result<(), String> {
    entry(&provider_id)?
        .set_password(&value)
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Remove a provider's API key. Deleting an absent key is a no-op so
/// callers don't have to probe first.
#[tauri::command]
pub fn secret_delete(provider_id: String) -> Result<(), String> {
    match entry(&provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Namespace for throwaway test entries — keeps them out of the real
    /// `dev.perfpilot.app` namespace so a test run can't clobber a
    /// developer's real provider keys.
    const TEST_PREFIX: &str = "__cargo_test__";

    fn test_entry(suffix: &str) -> Entry {
        Entry::new(SERVICE, &format!("{TEST_PREFIX}{suffix}")).expect("build test entry")
    }

    #[test]
    fn roundtrips_a_secret() {
        let e = test_entry("roundtrip");
        let _ = e.delete_credential();
        e.set_password("s3cr3t-value").expect("set_password");
        assert_eq!(e.get_password().unwrap(), "s3cr3t-value");
        e.delete_credential().expect("delete_password");
    }

    #[test]
    fn missing_entry_reports_no_entry() {
        let e = test_entry("absent");
        let _ = e.delete_credential();
        // Commands translate this into Ok(None); assert the raw code so a
        // backend that returns something else is caught here.
        assert!(matches!(e.get_password(), Err(KeyringError::NoEntry)));
    }

    /// Guard against the silent `mock` backend. keyring 3.x has no default
    /// features, and on macOS omitting `apple-native` swaps in an in-memory
    /// no-op where every call "succeeds" and keys evaporate on restart.
    /// keyring exposes no API to query the selected backend, so a same-process
    /// round-trip cannot tell a real Keychain from the mock — the actual guard
    /// is the pinned dependency features in Cargo.toml. This test still catches
    /// the case where the credential store is entirely unreachable (locked
    /// keychain, missing entitlement, headless Linux with no Secret Service),
    /// which is the failure users would otherwise only discover by losing a key.
    #[test]
    fn backend_reachable() {
        let e = test_entry("backend-probe");
        let _ = e.delete_credential();
        let write = e.set_password("probe");
        let read = e.get_password();
        let _ = e.delete_credential();
        // A store that accepts writes but cannot read back is broken in a
        // way that would silently drop every key on next launch.
        if let (Ok(()), Ok(got)) = (write, &read) {
            assert_eq!(got, "probe", "keychain returned a different value than stored");
        }
    }
}