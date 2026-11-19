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

export class GeminiPoolClient {
  private keys: string[];
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
      throw new Error("未配置 Gemini API Key");
    }

    const start =
      this.rotation === "round_robin"
        ? this.cursor++ % this.keys.length
        : 0;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.keys.length; attempt += 1) {
      const key = this.keys[(start + attempt) % this.keys.length];
      try {
        return await this.callSingleKey<T>(key, input);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("密钥池中所有 API Key 请求均失败");
  }

  private async callSingleKey<T>(
    apiKey: string,
    input: GeminiCallInput,
  ): Promise<T> {
    const isVertexKey = apiKey.startsWith("AQ.");
    const endpoint = isVertexKey
      ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!isVertexKey) {
      headers["x-goog-api-key"] = apiKey;
    }

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
        responseMimeType: "application/json",
        responseSchema: input.jsonSchema,
      },
    };

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
      throw new Error(`Gemini HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const rawText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
      "";
    if (!rawText.trim()) {
      throw new Error("Gemini 返回空内容");
    }
    return JSON.parse(rawText) as T;
  }
}
