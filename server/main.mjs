import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  buildAuthStatus,
  clearOAuthSession,
  ensureValidAccessToken,
  openExternalUrl,
  runInteractiveOAuthLogin,
  saveClientJsonToVault,
} from "./oauth-bridge.mjs";
import { maskSecret, readVault, writeVault } from "./secret-store.mjs";

const SESSION_TOKEN = crypto.randomBytes(24).toString("hex");
const DIST_DIR = path.resolve(process.cwd(), "dist");

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function parseKeys(raw) {
  return String(raw || "")
    .split(/[\r\n,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 16);
}

async function dispatchApi(cmd, body) {
  if (cmd === "get_auth_status") {
    return buildAuthStatus(readVault());
  }
  if (cmd === "save_oauth_client_json") {
    return saveClientJsonToVault(String(body.rawJson || ""));
  }
  if (cmd === "start_oauth_login") {
    return runInteractiveOAuthLogin();
  }
  if (cmd === "logout_oauth") {
    return clearOAuthSession();
  }
  if (cmd === "get_valid_access_token") {
    return ensureValidAccessToken();
  }
  if (cmd === "get_gemini_key_summary") {
    const keys = readVault().geminiKeys || [];
    return { count: keys.length, maskedKeys: keys.map(maskSecret) };
  }
  if (cmd === "save_gemini_keys") {
    const keys = parseKeys(body.rawKeysText);
    const vault = readVault();
    vault.geminiKeys = keys;
    writeVault(vault);
    return { count: keys.length, maskedKeys: keys.map(maskSecret) };
  }
  if (cmd === "get_plain_gemini_keys") {
    return readVault().geminiKeys || [];
  }
  throw new Error(`未知接口命令: ${cmd}`);
}

function launchNativeLikeWindow(url) {
  if (process.argv.includes("--no-open")) return;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const bin of candidates) {
      if (fs.existsSync(bin)) {
        spawn(bin, [`--app=${url}`, "--window-size=1360,860"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        return;
      }
    }
  } else if (process.platform === "darwin") {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(chrome)) {
      spawn(chrome, [`--app=${url}`, "--window-size=1360,860"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    }
  }
  openExternalUrl(url);
}

async function startServer() {
  const isDev = process.argv.includes("--dev");
  let vite = null;
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/api/") && req.method === "POST") {
      if (req.headers["x-workbench-token"] !== SESSION_TOKEN) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "本地会话令牌不匹配，请刷新工作台页面" }));
        return;
      }

      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      try {
        const body = rawBody ? JSON.parse(rawBody) : {};
        const cmd = url.pathname.slice("/api/".length);
        const result = await dispatchApi(cmd, body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (vite) {
      vite.middlewares(req, res);
      return;
    }

    const relPath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const safePath = path.resolve(DIST_DIR, relPath);
    if (!safePath.startsWith(DIST_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
      const indexFile = path.join(DIST_DIR, "index.html");
      if (fs.existsSync(indexFile)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(indexFile));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_MAP[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(safePath));
  });

  const requestedPort = Number(process.env.PORT || 0);
  server.listen(requestedPort, "127.0.0.1", () => {
    const addr = server.address();
    const launchUrl = `http://127.0.0.1:${addr.port}/?wb_token=${SESSION_TOKEN}`;
    console.log(`剧本对应语系工作台已启动: ${launchUrl}`);
    launchNativeLikeWindow(launchUrl);
  });
}

startServer();
