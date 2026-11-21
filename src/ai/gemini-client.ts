import type { GeminiModelId, KeyRotationStrategy } from "../types/config";
import {
  DAILY_KEY_QUOTA_LIMIT,
  getKeyUsageView,
  isKeyOverDailyLimit,
  recordKeyCallFailure,
  recordKeyCallSuccess,
} from "./key-usage-store";

export const SUPPORTED_GEMINI_MODELS: Array<{
  id: GeminiModelId;
  label: string;
}> = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash（强烈推荐 · 高智商高速，付费/Vertex 首选）",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro（Vertex 旗舰稳定版 · 复杂长句/倒装极准）",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview（高阶深度推理 · 疑难审校极强）",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon（最新一代旗舰大模型）",
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash（稳定高准度）",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash（Vertex 经典高速版）",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite（轻量省流版 · 免费 Key 默认）",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite（轻量备用版）",
  },
];

export interface GeminiCallInput {
  systemInstruction: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
}

export interface GeminiCallOptions {
  preferAlternateKey?: boolean;
  useReviewModel?: boolean;
  modelOverride?: string;
}

export interface GeminiClientOptions {
  apiKeys: string[];
  model: GeminiModelId;
  reviewModel?: GeminiModelId;
  paidUnlimited?: boolean;
  rotation: KeyRotationStrategy;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface KeyConnectivityReport {
  index: number;
  maskedKey: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  detail: string;
  callsToday: number;
  limit: number;
}

function maskKeyShort(k: string): string {
  const s = k.trim();
  if (s.length <= 10) return "***";
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function defaultTimeoutForModel(modelId: string): number {
  const m = (modelId || "").toLowerCase();
  if (m.includes("pro") || m.includes("argon")) return 90000;
  if (m.includes("flash") && !m.includes("lite")) return 60000;
  return 45000;
}

export class GeminiPoolExhaustedError extends Error {
  readonly status?: number;
  readonly isKeyOrQuotaError: boolean;

  constructor(message: string, status?: number, isKeyOrQuotaError = true) {
    super(message);
    this.name = "GeminiPoolExhaustedError";
    this.status = status;
    this.isKeyOrQuotaError = isKeyOrQuotaError;
  }
}

export class GeminiPoolClient {
  private keys: string[];
  private deadKeys = new Set<string>();
  private model: GeminiModelId;
  private reviewModel?: GeminiModelId;
  private paidUnlimited: boolean;
  private rotation: KeyRotationStrategy;
  private cursor = 0;
  private lastUsedKey: string | null = null;
  private fetchFn: typeof fetch;
  private isCustomFetch: boolean;
  private retryDelayMs?: number;
  private explicitTimeoutMs?: number;

  constructor(opts: GeminiClientOptions) {
    this.keys = opts.apiKeys.map((k) => k.trim()).filter(Boolean);
    this.model = (opts.model || "gemini-3.8-flash").trim() || "gemini-3.8-flash";
    this.reviewModel = opts.reviewModel?.trim() || undefined;
    this.paidUnlimited = Boolean(opts.paidUnlimited);
    this.rotation = opts.rotation;
    this.isCustomFetch = Boolean(opts.fetchFn);
    this.retryDelayMs = opts.retryDelayMs;
    this.explicitTimeoutMs = opts.timeoutMs;
    this.fetchFn = opts.fetchFn
      ? (input, init) => opts.fetchFn!(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  get hasKeys(): boolean {
    return this.keys.length > 0;
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get isPaidUnlimited(): boolean {
    return this.paidUnlimited;
  }

  get primaryModel(): GeminiModelId {
    return this.model;
  }

  get activeReviewModel(): GeminiModelId {
    return this.reviewModel || this.model;
  }

  private resolveTargetModel(callOpts?: GeminiCallOptions): string {
    if (callOpts?.modelOverride?.trim()) return callOpts.modelOverride.trim();
    if (callOpts?.useReviewModel && this.reviewModel) return this.reviewModel;
    return this.model;
  }

  private resolveTimeoutMs(targetModel: string): number {
    if (this.explicitTimeoutMs !== undefined) return this.explicitTimeoutMs;
    return defaultTimeoutForModel(targetModel);
  }

  async generateStructuredJson<T>(
    input: GeminiCallInput,
    callOpts?: GeminiCallOptions,
  ): Promise<T> {
    if (this.keys.length === 0) {
      throw new GeminiPoolExhaustedError(
        "未配置 Gemini API Key，请在右上角「设置 → API 密钥池」中添加密钥",
        401,
        true,
      );
    }

    const targetModel = this.resolveTargetModel(callOpts);
    const maxRounds = 3;
    let lastErr: unknown = null;
    let lastStatus: number | undefined;

    for (let round = 0; round < maxRounds; round += 1) {
      const validNotOverLimit = this.keys.filter(
        (k) => !this.deadKeys.has(k) && !isKeyOverDailyLimit(k, this.paidUnlimited),
      );
      const validAny = this.keys.filter((k) => !this.deadKeys.has(k));

      if (validNotOverLimit.length === 0 && validAny.length > 0) {
        throw new GeminiPoolExhaustedError(
          `所有可用 API Key 今日调用均已达 ${DAILY_KEY_QUOTA_LIMIT} 次上限，请新增密钥、开启付费不限额模式或明日自动重置`,
          429,
          true,
        );
      }

      const pool = validNotOverLimit.length > 0 ? validNotOverLimit : this.keys;
      if (this.deadKeys.size >= this.keys.length && round > 0) {
        break;
      }

      let start = 0;
      if (this.rotation === "round_robin") {
        start = this.cursor++ % pool.length;
        if (callOpts?.preferAlternateKey && pool.length > 1 && pool[start] === this.lastUsedKey) {
          start = this.cursor++ % pool.length;
        }
      } else if (callOpts?.preferAlternateKey && pool.length > 1) {
        const lastIdx = this.lastUsedKey ? pool.indexOf(this.lastUsedKey) : -1;
        start = lastIdx >= 0 ? (lastIdx + 1) % pool.length : ++this.cursor % pool.length;
      }

      let sawTransientRateLimit = false;

      for (let attempt = 0; attempt < pool.length; attempt += 1) {
        const key = pool[(start + attempt) % pool.length];
        if (this.deadKeys.has(key) && validNotOverLimit.length > 0) continue;

        this.lastUsedKey = key;
        const t0 = Date.now();
        try {
          const val = await this.callSingleKey<T>(key, input, targetModel);
          recordKeyCallSuccess(key, Date.now() - t0, this.paidUnlimited);
          return val;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          const stMatch = /HTTP\s+(\d{3})/.exec(msg);
          const code = stMatch ? Number(stMatch[1]) : undefined;
          lastStatus = code;

          recordKeyCallFailure(key, code, msg, this.paidUnlimited);

          if (
            code === 401 ||
            code === 403 ||
            /API_KEY_INVALID|API key not valid|requires billing/i.test(msg)
          ) {
            this.deadKeys.add(key);
          } else if (
            code === 429 ||
            code === 503 ||
            code === 504 ||
            /超时|timeout|aborted/i.test(msg)
          ) {
            if (!isKeyOverDailyLimit(key, this.paidUnlimited)) {
              sawTransientRateLimit = true;
            }
          }
        }
      }

      if (!sawTransientRateLimit || round === maxRounds - 1) {
        break;
      }

      const waitMs =
        this.retryDelayMs !== undefined
          ? this.retryDelayMs
          : this.isCustomFetch
            ? 5
            : round === 0
              ? 3500
              : 7000;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const errMsg =
      lastErr instanceof Error ? lastErr.message : "密钥池中所有 API Key 请求均失败";
    throw new GeminiPoolExhaustedError(
      `API 密钥池全部不可用或额度耗尽（${errMsg}）`,
      lastStatus,
      true,
    );
  }

  /**
   * Tests EVERY single API key in the pool individually (one by one) so dead/unbilled keys
   * are immediately exposed instead of being hidden behind 1 working key!
   */
  async testAllKeysIndividually(
    onProgress?: (report: KeyConnectivityReport, completed: number, total: number) => void,
  ): Promise<KeyConnectivityReport[]> {
    const reports: KeyConnectivityReport[] = [];
    const pingInput: GeminiCallInput = {
      systemInstruction: 'Return JSON {"ok": true}.',
      userPrompt: "ping",
      jsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    };

    for (let i = 0; i < this.keys.length; i += 1) {
      const key = this.keys[i];
      const t0 = Date.now();
      let report: KeyConnectivityReport;
      try {
        await this.callSingleKey<{ ok: boolean }>(key, pingInput, this.model);
        const latencyMs = Math.max(1, Date.now() - t0);
        recordKeyCallSuccess(key, latencyMs, this.paidUnlimited);
        const usage = getKeyUsageView(key, this.paidUnlimited);
        report = {
          index: i,
          maskedKey: maskKeyShort(key),
          ok: true,
          status: 200,
          latencyMs,
          detail: `可用 · ${this.model} (${latencyMs}ms)`,
          callsToday: usage.callsToday,
          limit: usage.limit,
        };
      } catch (err) {
        const latencyMs = Math.max(1, Date.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        const stMatch = /HTTP\s+(\d{3})/.exec(msg);
        const code = stMatch ? Number(stMatch[1]) : undefined;
        recordKeyCallFailure(key, code, msg, this.paidUnlimited);
        const usage = getKeyUsageView(key, this.paidUnlimited);
        report = {
          index: i,
          maskedKey: maskKeyShort(key),
          ok: false,
          status: code,
          latencyMs,
          detail: usage.lastError || msg.slice(0, 120),
          callsToday: usage.callsToday,
          limit: usage.limit,
        };
      }
      reports.push(report);
      onProgress?.(report, i + 1, this.keys.length);
    }

    return reports;
  }

  private async callSingleKey<T>(
    apiKey: string,
    input: GeminiCallInput,
    targetModel = this.model,
  ): Promise<T> {
    const isVertexKey = apiKey.startsWith("AQ.");
    const activeTimeoutMs = this.resolveTimeoutMs(targetModel);

    const buildBody = (maxTokens: number) => ({
      systemInstruction: {
        parts: [{ text: input.systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: input.userPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        responseSchema: input.jsonSchema,
      },
    });

    const callEndpointOnce = async (
      endpoint: string,
      headers: Record<string, string>,
      maxTokens: number,
    ) => {
      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(
            () => controller.abort(new Error(`Gemini 请求超时 (${activeTimeoutMs}ms)`)),
            activeTimeoutMs,
          )
        : null;
      let resp: Response;
      try {
        resp = await this.fetchFn(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(buildBody(maxTokens)),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (fetchErr) {
        if (controller?.signal.aborted) {
          return {
            ok: false as const,
            status: 504,
            detail: `请求超时 (${activeTimeoutMs}ms)`,
          };
        }
        throw fetchErr;
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!resp.ok) {
        const rawErr = await resp.text().catch(() => "");
        let detail = "";
        try {
          const j = JSON.parse(rawErr) as { error?: { message?: string; status?: string } };
          detail = j.error?.message || j.error?.status || rawErr.slice(0, 180);
        } catch {
          detail = rawErr.slice(0, 180);
        }
        return { ok: false as const, status: resp.status, detail };
      }
      const data = (await resp.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const rawText =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!rawText.trim()) {
        return { ok: false as const, status: 500, detail: "Gemini 返回空内容" };
      }
      return { ok: true as const, value: JSON.parse(rawText) as T };
    };

    const callEndpoint = async (endpoint: string, headers: Record<string, string>) => {
      const first = await callEndpointOnce(endpoint, headers, 16384);
      if (first.ok) return first;
      if (
        first.status === 400 &&
        /max_output_tokens|maxOutputTokens|invalid argument|token/i.test(first.detail || "token")
      ) {
        const fallback8k = await callEndpointOnce(endpoint, headers, 8192);
        if (fallback8k.ok) return fallback8k;
      }
      return first;
    };

    const encModel = encodeURIComponent(targetModel);
    const encKey = encodeURIComponent(apiKey);
    const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encModel}:generateContent`;
    const vertexV1Url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encModel}:generateContent?key=${encKey}`;
    const vertexBetaUrl = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${encModel}:generateContent?key=${encKey}`;

    if (!isVertexKey) {
      const r = await callEndpoint(aiStudioUrl, {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      });
      if (r.ok) return r.value;
      if (r.status === 404) {
        const vBeta = await callEndpoint(vertexBetaUrl, { "Content-Type": "application/json" });
        if (vBeta.ok) return vBeta.value;
      }
      throw new Error(`Gemini HTTP ${r.status}${r.detail ? `: ${r.detail}` : ""}`);
    }

    const v1Res = await callEndpoint(vertexV1Url, { "Content-Type": "application/json" });
    if (v1Res.ok) return v1Res.value;

    let lastVertexRes = v1Res;
    if (v1Res.status === 404 || v1Res.status === 400) {
      const vBetaRes = await callEndpoint(vertexBetaUrl, { "Content-Type": "application/json" });
      if (vBetaRes.ok) return vBetaRes.value;
      lastVertexRes = vBetaRes;
    }

    if (lastVertexRes.status === 403 || lastVertexRes.status === 404) {
      const sRes = await callEndpoint(aiStudioUrl, {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      });
      if (sRes.ok) return sRes.value;
    }

    const hint =
      /requires billing/i.test(lastVertexRes.detail)
        ? "（该 AQ. 密钥属于 Vertex AI，需开启 Google Cloud 结算；若要免费使用 Gemini Flash Lite，请改用 Google AI Studio 生成的 AIza... 密钥）"
        : "";
    throw new Error(`Gemini HTTP ${lastVertexRes.status}: ${lastVertexRes.detail}${hint}`);
  }
}
