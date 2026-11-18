use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "com.zcnz2026.textorganization";
const ACCOUNT_NAME: &str = "vault";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredOAuthClient {
    pub client_id: String,
    pub client_secret: String,
    pub auth_uri: String,
    pub token_uri: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredOAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub email: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SecretVault {
    pub oauth_client: Option<StoredOAuthClient>,
    pub oauth_tokens: Option<StoredOAuthTokens>,
    #[serde(default)]
    pub gemini_keys: Vec<String>,
}

pub fn load_vault() -> SecretVault {
    let Ok(entry) = Entry::new(SERVICE_NAME, ACCOUNT_NAME) else {
        return SecretVault::default();
    };
    let Ok(raw) = entry.get_password() else {
        return SecretVault::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_vault(vault: &SecretVault) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(vault).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn mask_secret(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 10 {
        return "****".to_string();
    }
    let start: String = t.chars().take(6).collect();
    let end: String = t
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}...{end}")
}
