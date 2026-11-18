use crate::secrets::{
    load_vault, mask_secret, save_vault, SecretVault, StoredOAuthClient, StoredOAuthTokens,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

const OAUTH_SCOPES: &str = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/userinfo.email";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSessionInfo {
    pub has_client_json: bool,
    pub authorized: bool,
    pub email: String,
    pub client_id_masked: String,
    pub expires_at: u64,
}

#[derive(Deserialize)]
struct RawClientNode {
    client_id: Option<String>,
    client_secret: Option<String>,
    auth_uri: Option<String>,
    token_uri: Option<String>,
}

#[derive(Deserialize)]
struct RawOAuthWrapper {
    installed: Option<RawClientNode>,
    web: Option<RawClientNode>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn build_status(vault: &SecretVault) -> OAuthSessionInfo {
    let client = vault.oauth_client.as_ref();
    let tokens = vault.oauth_tokens.as_ref();
    OAuthSessionInfo {
        has_client_json: client.map(|c| !c.client_id.is_empty()).unwrap_or(false),
        authorized: tokens
            .map(|t| !t.refresh_token.is_empty() || !t.access_token.is_empty())
            .unwrap_or(false),
        email: tokens.map(|t| t.email.clone()).unwrap_or_default(),
        client_id_masked: client
            .map(|c| mask_secret(&c.client_id))
            .unwrap_or_default(),
        expires_at: tokens.map(|t| t.expires_at).unwrap_or(0),
    }
}

pub fn store_client_json(raw_json: &str) -> Result<OAuthSessionInfo, String> {
    let parsed: RawOAuthWrapper =
        serde_json::from_str(raw_json).map_err(|_| "无效的 OAuth 2.0 JSON 文件".to_string())?;
    let node = parsed
        .installed
        .or(parsed.web)
        .ok_or_else(|| "JSON 中缺少 installed 或 web 客户端配置".to_string())?;
    let client_id = node
        .client_id
        .unwrap_or_default()
        .trim()
        .to_string();
    let client_secret = node
        .client_secret
        .unwrap_or_default()
        .trim()
        .to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("缺少 client_id 或 client_secret".to_string());
    }

    let mut vault = load_vault();
    let changed = vault
        .oauth_client
        .as_ref()
        .map(|c| c.client_id != client_id)
        .unwrap_or(true);
    vault.oauth_client = Some(StoredOAuthClient {
        client_id,
        client_secret,
        auth_uri: node
            .auth_uri
            .unwrap_or_else(|| "https://accounts.google.com/o/oauth2/v2/auth".to_string()),
        token_uri: node
            .token_uri
            .unwrap_or_else(|| "https://oauth2.googleapis.com/token".to_string()),
    });
    if changed {
        vault.oauth_tokens = None;
    }
    save_vault(&vault)?;
    Ok(build_status(&vault))
}

pub async fn interactive_login(app: &tauri::AppHandle) -> Result<OAuthSessionInfo, String> {
    let vault = load_vault();
    let client = vault
        .oauth_client
        .clone()
        .ok_or_else(|| "请先加载 Google OAuth 2.0 客户端 .json 文件".to_string())?;

    let mut rnd = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut rnd);
    let verifier = URL_SAFE_NO_PAD.encode(rnd);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut st_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut st_bytes);
    let expected_state = URL_SAFE_NO_PAD.encode(st_bytes);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法启动本地授权回调端口: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth2callback");

    let mut auth_url = Url::parse(&client.auth_uri).map_err(|e| e.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &client.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", OAUTH_SCOPES)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", &expected_state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("打开浏览器失败: {e}"))?;

    let (mut stream, _) = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        listener.accept(),
    )
    .await
    .map_err(|_| "等待浏览器授权确认超时（3 分钟）".to_string())?
    .map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap_or(0);
    let req_line = String::from_utf8_lossy(&buf[..n]);
    let path = req_line
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let cb_url = Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;

    let mut code = String::new();
    let mut got_state = String::new();
    for (k, v) in cb_url.query_pairs() {
        if k == "code" {
            code = v.to_string();
        } else if k == "state" {
            got_state = v.to_string();
        }
    }

    if code.is_empty() || got_state != expected_state {
        let html = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h3>授权失败或已取消，请返回工作台重试。</h3>";
        let _ = stream.write_all(html.as_bytes()).await;
        return Err("Google 授权未完成或状态校验未通过".to_string());
    }

    let http = reqwest::Client::new();
    let token_res: serde_json::Value = http
        .post(&client.token_uri)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let access_token = token_res["access_token"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if access_token.is_empty() {
        return Err("换取 Google 访问令牌失败".to_string());
    }
    let refresh_token = token_res["refresh_token"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let expires_in = token_res["expires_in"].as_u64().unwrap_or(3500);

    let mut email = String::new();
    if let Ok(u_resp) = http
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
    {
        if let Ok(u_json) = u_resp.json::<serde_json::Value>().await {
            email = u_json["email"].as_str().unwrap_or_default().to_string();
        }
    }

    let mut latest = load_vault();
    let prev_refresh = latest
        .oauth_tokens
        .as_ref()
        .map(|t| t.refresh_token.clone())
        .unwrap_or_default();
    latest.oauth_tokens = Some(StoredOAuthTokens {
        access_token,
        refresh_token: if refresh_token.is_empty() {
            prev_refresh
        } else {
            refresh_token
        },
        expires_at: now_ms() + expires_in * 1000,
        email,
    });
    save_vault(&latest)?;

    let ok_html = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<!doctype html><html><body style='font-family:system-ui;text-align:center;padding-top:12vh'><h2>Google 账号授权成功</h2><p>现在可以关闭此页面返回剧本对应语系工作台。</p></body></html>";
    let _ = stream.write_all(ok_html.as_bytes()).await;

    Ok(build_status(&latest))
}

pub async fn get_or_refresh_token() -> Result<String, String> {
    let mut vault = load_vault();
    let client = vault
        .oauth_client
        .clone()
        .ok_or_else(|| "尚未加载 OAuth 2.0 JSON".to_string())?;
    let mut tokens = vault
        .oauth_tokens
        .clone()
        .ok_or_else(|| "尚未登录 Google 账号".to_string())?;

    if !tokens.access_token.is_empty() && tokens.expires_at > now_ms() + 90_000 {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_token.is_empty() {
        return Err("Google 登录已过期，请重新点击登录".to_string());
    }

    let http = reqwest::Client::new();
    let res: serde_json::Value = http
        .post(&client.token_uri)
        .form(&[
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let new_token = res["access_token"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if new_token.is_empty() {
        return Err("刷新访问令牌失败，请重新登录 Google 账号".to_string());
    }
    tokens.access_token = new_token.clone();
    tokens.expires_at = now_ms() + res["expires_in"].as_u64().unwrap_or(3500) * 1000;
    vault.oauth_tokens = Some(tokens);
    save_vault(&vault)?;
    Ok(new_token)
}
