import { beforeEach, describe, expect, it } from "vitest";
import {
  GeminiPoolClient,
   GeminiPoolExhaustedError,
  SUPPORTED_GEMINI_MODELS,
} from "../src/ai/gemini-client";
import {
  DAILY_KEY_QUOTA_LIMIT,
  getKeyUsageView,
  getTotalTodayCallsSummary,
  isKeyOverDailyLimit,
  recordKeyCallSuccess,
  resetTodayKeyUsage,
} from "../src/ai/key-usage-store";
import { resolvePunctuationRule } from "../src/catalog/lang-presets";
import { batchSplitTargetsWithAi } from "../src/engine/line-splitter";
import type { ScriptRow } from "../src/types/domain";

function makeRow(rowIndex: number, chinese: string, english: string): ScriptRow {
  return {
    rowIndex,
    rawCells: [],
    line: String(rowIndex + 1),
    inTime: "",
    outTime: "",
    character: "Speaker",
    chinese,
    english,
    targetLanguage: "No need to translate!",
    note: "",
    remark: "",
    sendRemark: "",
    filterCategory: "卷一・第一篇",
    needExtract: "需要摘",
  };
}

describe("v0.3.8 Vertex AI Pro/Flash models, dual-model review escalation & paid unlimited quota mode", () => {
  beforeEach(() => {
    resetTodayKeyUsage();
  });

  it("1. falls back from Vertex v1 to v1beta1 for AQ. keys on 404/400, sends maxOutputTokens: 16384, and auto-downgrades to 8192 on token-limit 400", async () => {
    expect(SUPPORTED_GEMINI_MODELS.map((m) => m.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-2.5-pro",
      "gemini-3.1-pro-preview",
      "gemini-4-argon",
      "gemini-3.6-flash",
      "gemini-2.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]);

    const vertexKey = "AQ.Ab8RN6MockPaidVertexKey000000001";
    const requestedUrls: string[] = [];
    const requestedMaxTokens: number[] = [];

    const client = new GeminiPoolClient({
      apiKeys: [vertexKey],
      model: "gemini-3.1-pro-preview",
      paidUnlimited: true,
      rotation: "round_robin",
      fetchFn: async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);
        const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
          generationConfig?: { maxOutputTokens?: number };
        };
        requestedMaxTokens.push(bodyObj.generationConfig?.maxOutputTokens ?? 0);

        // Simulate v1 endpoint returning 404 for preview model, while v1beta1 succeeds
        if (url.includes("/v1/publishers/google/models/")) {
          return new Response(
            JSON.stringify({ error: { message: "Model not found in v1", status: "NOT_FOUND" } }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const res = await client.generateStructuredJson<{ ok: boolean }>({
      systemInstruction: "Return ok",
      userPrompt: "ping",
      jsonSchema: { type: "object" },
    });

    expect(res.ok).toBe(true);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(requestedUrls[1]).toContain(
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(requestedMaxTokens).toEqual([16384, 16384]);

    // Test 16384 -> 8192 automatic fallback when an endpoint returns HTTP 400 on maxOutputTokens: 16384
    const tokenFallbackTokens: number[] = [];
    const legacyClient = new GeminiPoolClient({
      apiKeys: ["AIzaSyMockStudioKeyFor8kFallback01"],
      model: "gemini-2.5-flash",
      rotation: "round_robin",
      fetchFn: async (_input, init) => {
        const bodyObj = JSON.parse(String(init?.body ?? "{}")) as {
          generationConfig?: { maxOutputTokens?: number };
        };
        const maxTok = bodyObj.generationConfig?.maxOutputTokens ?? 0;
        tokenFallbackTokens.push(maxTok);
        if (maxTok > 8192) {
          return new Response(
            JSON.stringify({
              error: { message: "Invalid argument: max_output_tokens exceeds limit" },
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"fallbackOk":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const fbRes = await legacyClient.generateStructuredJson<{ fallbackOk: boolean }>({
      systemInstruction: "test",
      userPrompt: "ping",
      jsonSchema: { type: "object" },
    });
    expect(fbRes.fallbackOk).toBe(true);
    expect(tokenFallbackTokens).toEqual([16384, 8192]);
  });

  it("2. escalates from primary model (gemini-3.8-flash) to reviewModel (gemini-2.5-pro) on semantic reflection or token-span retry", async () => {
    const idRule = resolvePunctuationRule("印尼语");
    const rows2: ScriptRow[] = [
      makeRow(0, "“在最初的阶段，", '"In the early stage,'),
      makeRow(
        1,
        "每当现场技术团队遇到突发信号干扰时，整个系统都会自动启动备用通道。”",
        'whenever the field technical team encounters sudden signal interference, the system automatically activates backup channels."',
      ),
    ];
    const invertedLines2 = [
      "Pada tahap awal ketika tim teknis lapangan menghadapi gangguan sinyal mendadak,",
      "seluruh sistem secara otomatis mengaktifkan saluran cadangan.",
    ];
    const fullTarget = invertedLines2.join(" ");

    const calledModels: string[] = [];
    const dualModelClient = new GeminiPoolClient({
      apiKeys: [
        "AQ.Ab8RN6MockPaidVertexKey000000011",
        "AQ.Ab8RN6MockPaidVertexKey000000022",
      ],
      model: "gemini-3.8-flash",
      reviewModel: "gemini-2.5-pro",
      paidUnlimited: true,
      rotation: "round_robin",
      fetchFn: async (input) => {
        const url = String(input);
        const m = /\/models\/([^/:]+):generateContent/.exec(url);
        calledModels.push(decodeURIComponent(m?.[1] ?? ""));

        if (calledModels.length === 1) {
          // Pass 1 on primary model (gemini-3.8-flash): returns inverted lines that trigger soft length check
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          results: [{ id: "dual_blk", lines: invertedLines2 }],
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }

        // Pass 2 on escalated reviewModel (gemini-2.5-pro): semantic referee confirms inversion
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        rowAudits: [
                          { row: 1, semanticMatch: "adjacent_clause_inversion" },
                          { row: 2, semanticMatch: "adjacent_clause_inversion" },
                        ],
                        verdict: "accurate",
                        hasInversion: true,
                        reason: "Verified by Gemini 2.5 Pro",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const map = await batchSplitTargetsWithAi(
      [
        {
          id: "dual_blk",
          fallbackText: fullTarget,
          aiSourceText: fullTarget,
          sourceRows: rows2,
          isPartial: false,
        },
      ],
      idRule,
      dualModelClient,
    );

    expect(calledModels).toEqual(["gemini-3.8-flash", "gemini-2.5-pro"]);
    const split = map.get("dual_blk")!;
    expect(split.usedAi).toBe(true);
    expect(split.failed).toBe(false);
    expect(split.lines).toEqual(invertedLines2);
  });

  it("3. paidUnlimited: true bypasses the 500/day free cap while continuing to count callsToday accurately", async () => {
    const key = "AQ.Ab8RN6MockPaidUnlimitedKey000001";
    for (let i = 0; i < DAILY_KEY_QUOTA_LIMIT; i += 1) {
      recordKeyCallSuccess(key, 12, true);
    }

    // In free mode (paidUnlimited = false), 500 calls is over the daily limit
    expect(isKeyOverDailyLimit(key, false)).toBe(true);
    const freeClient = new GeminiPoolClient({
      apiKeys: [key],
      model: "gemini-3.5-flash-lite",
      paidUnlimited: false,
      rotation: "round_robin",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    await expect(
      freeClient.generateStructuredJson({
        systemInstruction: "test",
        userPrompt: "ping",
        jsonSchema: { type: "object" },
      }),
    ).rejects.toThrow(GeminiPoolExhaustedError);

    // In paid mode (paidUnlimited = true), calls 501..505 succeed and increment callsToday to 505 with status "ok"
    expect(isKeyOverDailyLimit(key, true)).toBe(false);
    const paidClient = new GeminiPoolClient({
      apiKeys: [key],
      model: "gemini-2.5-pro",
      paidUnlimited: true,
      rotation: "round_robin",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"paidOk":true}' }] } }],
          }),
          { status: 200 },
        ),
    });

    for (let extra = 1; extra <= 5; extra += 1) {
      const r = await paidClient.generateStructuredJson<{ paidOk: boolean }>({
        systemInstruction: "test",
        userPrompt: "ping",
        jsonSchema: { type: "object" },
      });
      expect(r.paidOk).toBe(true);
    }

    const view = getKeyUsageView(key, true);
    expect(view.callsToday).toBe(DAILY_KEY_QUOTA_LIMIT + 5);
    expect(view.lastStatus).toBe("ok");

    const sum = getTotalTodayCallsSummary(1, [key], true);
    expect(sum.totalCallsToday).toBe(505);
    expect(sum.paidUnlimited).toBe(true);
  });

  it("4. supports arbitrary custom Vertex / Gemini model IDs", async () => {
    let hitUrl = "";
    const customClient = new GeminiPoolClient({
      apiKeys: ["AQ.Ab8RN6MockCustomModelVertexKey01"],
      model: "gemini-2.5-pro-exp-custom",
      paidUnlimited: true,
      rotation: "round_robin",
      fetchFn: async (input) => {
        hitUrl = String(input);
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"custom":true}' }] } }],
          }),
          { status: 200 },
        );
      },
    });

    const out = await customClient.generateStructuredJson<{ custom: boolean }>({
      systemInstruction: "test",
      userPrompt: "ping",
      jsonSchema: { type: "object" },
    });
    expect(out.custom).toBe(true);
    expect(hitUrl).toContain("/models/gemini-2.5-pro-exp-custom:generateContent");
  });
});
