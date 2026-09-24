//! Settings module — left as a thin layer on top of the Tauri Store plugin.
//! Frontend persists settings directly via the store plugin; this module is a placeholder
//! for future server-side settings helpers.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub last_script_path: Option<String>,
    #[serde(default)]
    pub last_llm_provider: Option<String>,
}

#[allow(dead_code)]
pub const SETTINGS_KEY: &str = "perf-pilot.settings";