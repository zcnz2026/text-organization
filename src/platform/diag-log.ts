import { hostBridge } from "./bridge";

export interface DiagLogEntry {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  module: string;
  message: string;
  detail?: string;
}

const MAX_ENTRIES = 500;
const entries: DiagLogEntry[] = [];
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // listener errors must never break logging
    }
  }
}

export function sanitizeLogText(raw: string): string {
  return String(raw || "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[REDACTED_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/\bAQ\.[0-9A-Za-z._-]{20,}/g, "[REDACTED_API_KEY]")
    .slice(0, 3200);
}

function push(level: DiagLogEntry["level"], module: string, message: string, detail?: string): void {
  const entry: DiagLogEntry = {
    time: new Date().toISOString(),
    level,
    module,
    message: sanitizeLogText(message),
    detail: detail ? sanitizeLogText(detail) : undefined,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  notifyListeners();

  const line = `[${entry.time}] [${entry.level}] [${entry.module}] ${entry.message}${entry.detail ? ` | ${entry.detail}` : ""}`;
  hostBridge.appendDiagLog(line).catch(() => {
    // Logging must never break primary workflows
  });
}

export const diagLog = {
  info(module: string, message: string, detail?: string): void {
    push("INFO", module, message, detail);
  },
  warn(module: string, message: string, detail?: string): void {
    push("WARN", module, message, detail);
  },
  error(module: string, message: string, detail?: string): void {
    push("ERROR", module, message, detail);
  },
  getEntries(): readonly DiagLogEntry[] {
    return entries;
  },
  clear(): void {
    entries.length = 0;
    notifyListeners();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  exportText(): string {
    if (entries.length === 0) return "暂无运行诊断日志。";
    return entries
      .map((e) => `[${e.time}] [${e.level}] [${e.module}] ${e.message}${e.detail ? `\n  详情: ${e.detail}` : ""}`)
      .join("\n");
  },
  downloadLogFile(): void {
    const blob = new Blob([this.exportText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workbench-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
