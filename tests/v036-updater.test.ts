import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isNewerVersion } from "../src/platform/updater";
import { APP_VERSION, REPO_NAME, REPO_OWNER } from "../src/platform/version";

const ROOT = resolve(__dirname, "..");

describe("v0.3.6 cryptographically signed Tauri v2 in-app updater", () => {
  it("keeps all 5 version manifests synchronized on 0.3.6", () => {
    const versionFile = readFileSync(resolve(ROOT, "VERSION"), "utf8").trim();
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { version: string };
    const cargoToml = readFileSync(resolve(ROOT, "src-tauri/Cargo.toml"), "utf8");

    expect(APP_VERSION).toBe(versionFile);
    expect(pkg.version).toBe(versionFile);
    expect(tauriConf.version).toBe(versionFile);
    expect(cargoToml).toContain(`version = "${versionFile}"`);
  });

  it("enforces Ed25519 pubkey, HTTPS GitHub endpoint, updater artifacts, and passive Windows mode", () => {
    const tauriConf = JSON.parse(
      readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      bundle: { createUpdaterArtifacts?: boolean };
      plugins?: {
        updater?: {
          pubkey?: string;
          endpoints?: string[];
          windows?: { installMode?: string };
        };
      };
    };

    expect(tauriConf.bundle.createUpdaterArtifacts).toBe(true);
    const updater = tauriConf.plugins?.updater;
    expect(updater).toBeDefined();
    expect(updater?.pubkey && updater.pubkey.length).toBeGreaterThan(80);
    // Decode base64 pubkey and verify it is a valid Minisign public key comment (never a private key!)
    const decodedPub = Buffer.from(updater!.pubkey!, "base64").toString("utf8");
    expect(decodedPub).toContain("minisign public key:");
    expect(decodedPub.toLowerCase()).not.toContain("encrypted secret key");

    const expectedEndpoint = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/latest.json`;
    expect(updater?.endpoints).toEqual([expectedEndpoint]);
    expect(updater?.windows?.installMode).toBe("passive");
  });

  it("wires Tauri updater & process plugins across capabilities, Rust backend, and GitHub release workflow", () => {
    const caps = JSON.parse(
      readFileSync(resolve(ROOT, "src-tauri/capabilities/default.json"), "utf8"),
    ) as { permissions: string[] };
    expect(caps.permissions).toContain("updater:default");
    expect(caps.permissions).toContain("process:default");

    const cargoToml = readFileSync(resolve(ROOT, "src-tauri/Cargo.toml"), "utf8");
    expect(cargoToml).toContain('tauri-plugin-updater = "2"');
    expect(cargoToml).toContain('tauri-plugin-process = "2"');

    const libRs = readFileSync(resolve(ROOT, "src-tauri/src/lib.rs"), "utf8");
    expect(libRs).toContain("tauri_plugin_updater::Builder::new().build()");
    expect(libRs).toContain("tauri_plugin_process::init()");

    const workflow = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    );
    expect(workflow).toContain("includeUpdaterJson: true");
  });

  it("compares semantic versions accurately", () => {
    expect(isNewerVersion("0.3.6", "0.2.6")).toBe(true);
    expect(isNewerVersion("v0.3.7", "0.3.6")).toBe(true);
    expect(isNewerVersion("0.3.6", "0.3.6")).toBe(false);
    expect(isNewerVersion("0.3.5", "0.3.6")).toBe(false);
  });
});
