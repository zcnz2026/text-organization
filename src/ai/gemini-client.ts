import type { GeminiModelId, KeyRotationStrategy } from "../types/config";

export const SUPPORTED_GEMINI_MODELS: Array<{
  id: GeminiModelId;
  label: string;
}> = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite（默认）" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
];

export interface GeminiCallInput {
  systemInstruction: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
}

export interface GeminiClientOptions {
  apiKeys: string[];
  model: GeminiModelId;
  rotation: KeyRotationStrategy;
  fetchFn?: typeof fetch;
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
  private rotation: KeyRotationStrategy;
  private cursor = 0;
  private fetchFn: typeof fetch;

  constructor(opts: GeminiClientOptions) {
    this.keys = opts.apiKeys.map((k) => k.trim()).filter(Boolean);
    this.model = opts.model;
    this.rotation = opts.rotation;
    this.fetchFn = opts.fetchFn
      ? (input, init) => opts.fetchFn!(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  get hasKeys(): boolean {
    return this.keys.length > 0;
  }

  async generateStructuredJson<T>(input: GeminiCallInput): Promise<T> {
    if (this.keys.length === 0) {
      throw new GeminiPoolExhaustedError("未配置 Gemini API Key，请在右上角「设置 → API 密钥池」中添加密钥", 401, true);
    }

    const activeKeys = this.keys.filter((k) => !this.deadKeys.has(k));
    const pool = activeKeys.length > 0 ? activeKeys : this.keys;

    const start =
      this.rotation === "round_robin"
        ? this.cursor++ % pool.length
        : 0;

    let lastErr: unknown = null;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < pool.length; attempt += 1) {
      const key = pool[(start + attempt) % pool.length];
      try {
        return await this.callSingleKey<T>(key, input);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const stMatch = /HTTP\s+(\d{3})/.exec(msg);
        const code = stMatch ? Number(stMatch[1]) : undefined;
        lastStatus = code;

        if (code === 401 || code === 403 || /API_KEY_INVALID|API key not valid/i.test(msg)) {
          this.deadKeys.add(key);
        } else if ((code === 429 || code === 503) && pool.length === 1) {
          // Single-key transient rate limit burst: wait briefly and retry once
          await new Promise((r) => setTimeout(r, 1200));
          try {
            return await this.callSingleKey<T>(key, input);
          } catch (retryErr) {
            lastErr = retryErr;
          }
        }
      }
    }

    const errMsg =
      lastErr instanceof Error ? lastErr.message : "密钥池中所有 API Key 请求均失败";
    throw new GeminiPoolExhaustedError(
      `API 密钥池全部不可用或额度耗尽（${errMsg}）`,
      lastStatus,
      true,
    );
  }

  private async callSingleKey<T>(
    apiKey: string,
    input: GeminiCallInput,
  ): Promise<T> {
    const isVertexKey = apiKey.startsWith("AQ.");
    const body = {
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
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: input.jsonSchema,
      },
    };

    const callEndpoint = async (endpoint: string, headers: Record<string, string>) => {
      const resp = await this.fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
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

    const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const vertexUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    if (!isVertexKey) {
      const r = await callEndpoint(aiStudioUrl, {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      });
      if (r.ok) return r.value;
      throw new Error(`Gemini HTTP ${r.status}${r.detail ? `: ${r.detail}` : ""}`);
    }

    // For AQ. keys: try AI Studio first if Vertex is blocked/unbilled, or Vertex then AI Studio
    const vRes = await callEndpoint(vertexUrl, { "Content-Type": "application/json" });
    if (vRes.ok) return vRes.value;
    if (vRes.status === 403 || vRes.status === 404) {
      const sRes = await callEndpoint(aiStudioUrl, {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      });
      if (sRes.ok) return sRes.value;
    }
    const hint =
      /requires billing/i.test(vRes.detail)
        ? "（该 AQ. 密钥属于 Vertex AI，需开启 Google Cloud 结算；若要免费使用 Gemini 3.5/3.1 Flash Lite，请改用 Google AI Studio 生成的 AIza... 密钥）"
        : "";
    throw new Error(`Gemini HTTP ${vRes.status}: ${vRes.detail}${hint}`);
  }
}
