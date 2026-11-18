import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SECRET_DIR = path.resolve(process.cwd(), ".local-secrets");
const VAULT_FILE = path.join(SECRET_DIR, "vault.dat");
const KEYCHAIN_SERVICE = "com.zcnz2026.text-organization";
const KEYCHAIN_ACCOUNT = "vault";

function ensureDir() {
  if (!fs.existsSync(SECRET_DIR)) {
    fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  }
}

function dpapiProtect(plainText) {
  const b64In = Buffer.from(plainText, "utf8").toString("base64");
  const ps = `
    Add-Type -AssemblyName System.Security;
    $bytes = [Convert]::FromBase64String('${b64In}');
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Convert]::ToBase64String($enc)
  `;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
  }).trim();
}

function dpapiUnprotect(b64Cipher) {
  const clean = b64Cipher.replace(/[^A-Za-z0-9+/=]/g, "");
  const ps = `
    Add-Type -AssemblyName System.Security;
    $enc = [Convert]::FromBase64String('${clean}');
    $dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Text.Encoding]::UTF8.GetString($dec)
  `;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
  });
}

export function readVault() {
  try {
    if (process.platform === "darwin") {
      const hex = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
    }

    if (!fs.existsSync(VAULT_FILE)) return {};
    const raw = fs.readFileSync(VAULT_FILE, "utf8").trim();
    if (!raw) return {};

    if (process.platform === "win32") {
      return JSON.parse(dpapiUnprotect(raw));
    }

    const keyFile = path.join(SECRET_DIR, "master.key");
    if (!fs.existsSync(keyFile)) return {};
    const key = fs.readFileSync(keyFile);
    const [ivHex, tagHex, dataHex] = raw.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return JSON.parse(dec.toString("utf8"));
  } catch {
    return {};
  }
}

export function writeVault(dataObj) {
  const json = JSON.stringify(dataObj);
  if (process.platform === "darwin") {
    const hex = Buffer.from(json, "utf8").toString("hex");
    execFileSync("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      hex,
    ]);
    return;
  }

  ensureDir();
  if (process.platform === "win32") {
    fs.writeFileSync(VAULT_FILE, dpapiProtect(json), { mode: 0o600 });
    return;
  }

  const keyFile = path.join(SECRET_DIR, "master.key");
  let key;
  if (fs.existsSync(keyFile)) {
    key = fs.readFileSync(keyFile);
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(
    VAULT_FILE,
    `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`,
    { mode: 0o600 },
  );
}

export function maskSecret(s) {
  const t = (s || "").trim();
  if (t.length <= 10) return "****";
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}
