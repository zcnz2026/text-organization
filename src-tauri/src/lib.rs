mod oauth;
mod secrets;

use oauth::{build_status, get_or_refresh_token, interactive_login, store_client_json, OAuthSessionInfo};
use secrets::{load_vault, mask_secret, save_vault};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeySummary {
    count: usize,
    masked_keys: Vec<String>,
}

#[tauri::command]
fn get_auth_status() -> OAuthSessionInfo {
    build_status(&load_vault())
}

#[tauri::command]
fn save_oauth_client_json(raw_json: String) -> Result<OAuthSessionInfo, String> {
    store_client_json(&raw_json)
}

#[tauri::command]
async fn start_oauth_login(app: tauri::AppHandle) -> Result<OAuthSessionInfo, String> {
    interactive_login(&app).await
}

#[tauri::command]
fn logout_oauth() -> Result<OAuthSessionInfo, String> {
    let mut vault = load_vault();
    vault.oauth_tokens = None;
    save_vault(&vault)?;
    Ok(build_status(&vault))
}

#[tauri::command]
async fn get_valid_access_token() -> Result<String, String> {
    get_or_refresh_token().await
}

#[tauri::command]
fn get_gemini_key_summary() -> KeySummary {
    let vault = load_vault();
    KeySummary {
        count: vault.gemini_keys.len(),
        masked_keys: vault.gemini_keys.iter().map(|k| mask_secret(k)).collect(),
    }
}

#[tauri::command]
fn save_gemini_keys(raw_keys_text: String) -> Result<KeySummary, String> {
    let keys: Vec<String> = raw_keys_text
        .split(|c| c == '\n' || c == '\r' || c == ',' || c == ';')
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 16)
        .collect();
    let mut vault = load_vault();
    vault.gemini_keys = keys.clone();
    save_vault(&vault)?;
    Ok(KeySummary {
        count: keys.len(),
        masked_keys: keys.iter().map(|k| mask_secret(k)).collect(),
    })
}

#[tauri::command]
fn get_plain_gemini_keys() -> Vec<String> {
    load_vault().gemini_keys
}

#[tauri::command]
fn append_diag_log(_line: String) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_auth_status,
            save_oauth_client_json,
            start_oauth_login,
            logout_oauth,
            get_valid_access_token,
            get_gemini_key_summary,
            save_gemini_keys,
            get_plain_gemini_keys,
            append_diag_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
