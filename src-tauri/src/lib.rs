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
async fn fetch_public_sheet_xlsx_base64(spreadsheet_id: String) -> Result<String, String> {
    use base64::Engine;
    let sid = spreadsheet_id.trim();
    if sid.len() < 15 || sid.len() > 80 || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("无效的 Google 表格 ID".to_string());
    }
    let url = format!("https://docs.google.com/spreadsheets/d/{}/export?format=xlsx", sid);
    let resp = reqwest::get(&url).await.map_err(|e| format!("请求 Google 表格失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("无法访问该表格 (HTTP {})，请在设置中登录 Google OAuth 账号", resp.status()));
    }
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
    if ct.contains("text/html") {
        return Err("该 Google 表格需要权限访问，请在右上角「设置」登录 Google OAuth 账号".to_string());
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取表格字节失败: {}", e))?;
    if bytes.len() > 24 * 1024 * 1024 {
        return Err("Google 表格体积超过 24MB 上限".to_string());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
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
            fetch_public_sheet_xlsx_base64,
            append_diag_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
