import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { maskSecret, readVault, writeVault } from "./secret-store.mjs";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export function openExternalUrl(url) {
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

export function parseOAuthClientJson(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("无效的 JSON 文件，请确认选择的是 Google Cloud 下载的 OAuth 2.0 客户端凭据");
  }
  const node = parsed.installed || parsed.web;
  if (!node || !node.client_id || !node.client_secret) {
    throw new Error("未在 JSON 中找到 installed/web client_id 与 client_secret，请下载「桌面应用 (Desktop app)」类型的 OAuth 2.0 客户端 JSON");
  }
  return {
    clientId: String(node.client_id).trim(),
    clientSecret: String(node.client_secret).trim(),
    authUri: String(node.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth"),
    tokenUri: String(node.token_uri || "https://oauth2.googleapis.com/token"),
  };
}

export function buildAuthStatus(vault) {
  const oauth = vault.oauthClient || null;
  const tokens = vault.oauthTokens || null;
  return {
    hasClientJson: Boolean(oauth?.clientId),
    authorized: Boolean(tokens?.refreshToken || tokens?.accessToken),
    email: tokens?.email || "",
    clientIdMasked: oauth?.clientId ? maskSecret(oauth.clientId) : "",
    expiresAt: tokens?.expiresAt || 0,
  };
}

export function saveClientJsonToVault(rawJson) {
  const client = parseOAuthClientJson(rawJson);
  const vault = readVault();
  const changed = vault.oauthClient?.clientId !== client.clientId;
  vault.oauthClient = client;
  if (changed) delete vault.oauthTokens;
  writeVault(vault);
  return buildAuthStatus(vault);
}

export function clearOAuthSession() {
  const vault = readVault();
  delete vault.oauthTokens;
  writeVault(vault);
  return buildAuthStatus(vault);
}

export async function runInteractiveOAuthLogin() {
  const vault = readVault();
  const client = vault.oauthClient;
  if (!client?.clientId) {
    throw new Error("请先加载 Google OAuth 2.0 客户端 .json 文件");
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const expectedState = crypto.randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const errParam = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");

        if (errParam || !code || state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h3>Google 授权未完成，请返回工作台重试。</h3>");
          server.close();
          reject(new Error(errParam ? `Google 授权已取消 (${errParam})` : "授权状态校验未通过"));
          return;
        }

        const addr = server.address();
        const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;
        const tokenResp = await fetch(client.tokenUri, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        });

        const tokenData = await tokenResp.json();
        if (!tokenResp.ok || !tokenData.access_token) {
          throw new Error(tokenData.error_description || "换取访问令牌失败");
        }

        let email = "";
        try {
          const uResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (uResp.ok) {
            const uData = await uResp.json();
            email = uData.email || "";
          }
        } catch {
          // Non-fatal if userinfo fails
        }

        const latest = readVault();
        latest.oauthTokens = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || latest.oauthTokens?.refreshToken || "",
          expiresAt: Date.now() + Number(tokenData.expires_in || 3500) * 1000,
          email,
        };
        writeVault(latest);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:85vh;background:#f5f7f9;color:#111827}.box{background:#fff;padding:32px 40px;border-radius:14px;border:1px solid #d8e0e8;text-align:center}h2{margin:0 0 8px;color:#0e5a6d}p{margin:0;color:#4b5563}</style></head><body><div class="box"><h2>Google 账号授权成功</h2><p>${email ? `已连接邮箱：${email}，` : ""}现在可以关闭此标签页返回剧本工作台。</p></div></body></html>`,
        );
        server.close();
        resolve(buildAuthStatus(latest));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OAuth Error");
        server.close();
        reject(e);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const redirectUri = `http://127.0.0.1:${addr.port}/oauth2callback`;
      const authUrl = new URL(client.authUri);
      authUrl.searchParams.set("client_id", client.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", OAUTH_SCOPES);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", expectedState);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      openExternalUrl(authUrl.toString());
    });

    setTimeout(() => {
      if (server.listening) {
        server.close();
        reject(new Error("等待浏览器确认授权超时（3 分钟），请重新点击登录"));
      }
    }, 180_000).unref();
  });
}

export async function ensureValidAccessToken() {
  const vault = readVault();
  const client = vault.oauthClient;
  const tokens = vault.oauthTokens;
  if (!client || !tokens) {
    throw new Error("尚未登录 Google 账号，请先点击顶部「Google 授权」完成登录");
  }

  if (tokens.accessToken && tokens.expiresAt - Date.now() > 90_000) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new Error("Google 登录会话已过期，请重新点击登录授权");
  }

  const resp = await fetch(client.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error("刷新 Google 访问令牌失败，请重新点击登录授权");
  }

  tokens.accessToken = data.access_token;
  tokens.expiresAt = Date.now() + Number(data.expires_in || 3500) * 1000;
  vault.oauthTokens = tokens;
  writeVault(vault);
  return tokens.accessToken;
}
