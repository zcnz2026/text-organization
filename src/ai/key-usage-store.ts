export const DAILY_KEY_QUOTA_LIMIT = 500;

const STORAGE_KEY = "wb_gemini_daily_key_usage_v1";

export type KeyHealthStatus =
  | "untested"
  | "ok"
  | "rate_limited"
  | "quota_full"
  | "invalid"
  | "error";

export interface PerKeyDailyRecord {
  callsToday: number;
  successToday: number;
  lastStatus: KeyHealthStatus;
  lastError?: string;
  lastLatencyMs?: number;
  updatedAt: number;
}

interface PersistedDailyUsage {
  day: string;
  byFingerprint: Record<string, PerKeyDailyRecord>;
}

export interface KeyUsageView {
  fingerprint: string;
  callsToday: number;
  successToday: number;
  limit: number;
  remaining: number;
  lastStatus: KeyHealthStatus;
  lastError?: string;
  lastLatencyMs?: number;
}

function getLocalDayString(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Non-reversible 53-bit dual-hash fingerprint so plaintext API keys are NEVER stored in localStorage.
 */
export function keyFingerprint(rawKey: string): string {
  const str = rawKey.trim();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `k_${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

let memoryFallback: PersistedDailyUsage = {
  day: getLocalDayString(),
  byFingerprint: {},
};

function loadStore(): PersistedDailyUsage {
  const today = getLocalDayString();
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedDailyUsage;
        if (parsed && parsed.day === today && parsed.byFingerprint) {
          memoryFallback = parsed;
          return parsed;
        }
      }
    }
  } catch {
    // ignore storage errors
  }
  if (memoryFallback.day !== today) {
    memoryFallback = { day: today, byFingerprint: {} };
    saveStore(memoryFallback);
  }
  return memoryFallback;
}

function saveStore(data: PersistedDailyUsage): void {
  memoryFallback = data;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch {
    // ignore storage errors
  }
}

function ensureRecord(data: PersistedDailyUsage, fp: string): PerKeyDailyRecord {
  if (!data.byFingerprint[fp]) {
    data.byFingerprint[fp] = {
      callsToday: 0,
      successToday: 0,
      lastStatus: "untested",
      updatedAt: Date.now(),
    };
  }
  return data.byFingerprint[fp];
}

export function recordKeyCallSuccess(apiKey: string, latencyMs?: number): void {
  const data = loadStore();
  const rec = ensureRecord(data, keyFingerprint(apiKey));
  rec.callsToday += 1;
  rec.successToday += 1;
  rec.lastStatus = rec.callsToday >= DAILY_KEY_QUOTA_LIMIT ? "quota_full" : "ok";
  rec.lastError = undefined;
  if (latencyMs !== undefined) rec.lastLatencyMs = Math.max(1, Math.round(latencyMs));
  rec.updatedAt = Date.now();
  saveStore(data);
}

export function recordKeyCallFailure(
  apiKey: string,
  httpStatus: number | undefined,
  errorDetail: string,
): void {
  const data = loadStore();
  const rec = ensureRecord(data, keyFingerprint(apiKey));
  rec.updatedAt = Date.now();
  const shortErr = (errorDetail || "").slice(0, 140);

  if (httpStatus === 401 || httpStatus === 403 || /API_KEY_INVALID|API key not valid|requires billing/i.test(shortErr)) {
    rec.lastStatus = "invalid";
    rec.lastError = /requires billing/i.test(shortErr)
      ? "HTTP 403 未开启结算（AQ. 密钥需绑卡，建议换 AIza 密钥）"
      : `HTTP ${httpStatus || 403} 密钥无效或无权限`;
  } else if (httpStatus === 429) {
    rec.callsToday += 1;
    const isDailyExhausted = /per\s*day|daily|GenerateRequestsPerDay/i.test(shortErr) || rec.callsToday >= DAILY_KEY_QUOTA_LIMIT;
    rec.lastStatus = isDailyExhausted ? "quota_full" : "rate_limited";
    rec.lastError = isDailyExhausted
      ? "HTTP 429 今日配额已满"
      : "HTTP 429 每分钟请求过快（自动轮换等待中）";
  } else {
    rec.callsToday += 1;
    rec.lastStatus = "error";
    rec.lastError = httpStatus ? `HTTP ${httpStatus}: ${shortErr}` : shortErr || "网络或服务异常";
  }
  saveStore(data);
}

export function isKeyOverDailyLimit(apiKey: string): boolean {
  const data = loadStore();
  const rec = data.byFingerprint[keyFingerprint(apiKey)];
  if (!rec) return false;
  return rec.callsToday >= DAILY_KEY_QUOTA_LIMIT || rec.lastStatus === "quota_full";
}

export function getKeyUsageView(apiKey: string): KeyUsageView {
  const data = loadStore();
  const fp = keyFingerprint(apiKey);
  const rec = data.byFingerprint[fp];
  const callsToday = rec?.callsToday ?? 0;
  return {
    fingerprint: fp,
    callsToday,
    successToday: rec?.successToday ?? 0,
    limit: DAILY_KEY_QUOTA_LIMIT,
    remaining: Math.max(0, DAILY_KEY_QUOTA_LIMIT - callsToday),
    lastStatus: rec?.lastStatus ?? "untested",
    lastError: rec?.lastError,
    lastLatencyMs: rec?.lastLatencyMs,
  };
}

export function getTotalTodayCallsSummary(
  keyCount: number,
  activeKeys?: string[],
): {
  totalCallsToday: number;
  totalCapacity: number;
  day: string;
} {
  const data = loadStore();
  const totalCallsToday = activeKeys
    ? activeKeys.reduce((sum, k) => {
        const rec = data.byFingerprint[keyFingerprint(k)];
        return sum + (rec?.callsToday || 0);
      }, 0)
    : Object.values(data.byFingerprint).reduce(
        (sum, r) => sum + (r.callsToday || 0),
        0,
      );
  return {
    totalCallsToday,
    totalCapacity: Math.max(0, activeKeys ? activeKeys.length : keyCount) * DAILY_KEY_QUOTA_LIMIT,
    day: data.day,
  };
}

export function resetTodayKeyUsage(): void {
  saveStore({
    day: getLocalDayString(),
    byFingerprint: {},
  });
}
