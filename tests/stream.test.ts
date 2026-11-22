import { it, expect, vi, afterEach } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { catalogModels } from "../src/catalog.ts";
const model = catalogModels([
  {
    id: "test",
    abliterated: false,
    context_length: 1048576,
    reasoning_efforts: ["off", "low", "high", "max"],
    pricing: {
      input_per_m: 0.12,
      cached_input_per_m: 0.025,
      output_per_m: 0.45,
    },
  },
])[0];
const context = normalizeContext({
  messages: [{ role: "user", content: "OK", timestamp: 0 }],
});
const sse = (events: unknown[]) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const success = () =>
  sse([
    {
      id: "test",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "OK" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    },
  ]);
afterEach(() => vi.unstubAllGlobals());
it("delegated native adapter sends explicit off, clamps duplicates, and accounts cached tokens", async () => {
  for (const [requested, wire] of [
    [undefined, "off"],
    ["high", "high"],
    ["minimal", "low"],
    ["medium", "high"],
    ["xhigh", "max"],
  ] as const) {
    let payload: any;
    const stream = openAICompletionsApi().streamSimple(model, context, {
      apiKey: "test-value",
      reasoning: requested,
      fetch: async () => success(),
      onPayload: (p) => {
        payload = p;
      },
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(payload.reasoning_effort).toBe(wire);
    expect(payload.stream_options.include_usage).toBe(true);
    expect(result.usage.input).toBe(6);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cost.total).toBeCloseTo(
      (6 * 0.12 + 4 * 0.025 + 2 * 0.45) / 1e6,
      12,
    );
  }
});
it("native SSE error preserves insufficient_credits instead of treating it as success", async () => {
  const stream = openAICompletionsApi().streamSimple(model, context, {
    apiKey: "test-value",
    fetch: async () =>
      sse([
        {
          error: { code: "insufficient_credits", message: "Credits ran out." },
        },
      ]),
  });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toMatch(/insufficient_credits|Credits ran out/);
});
it("native HTTP errors retain Refuseless code and status", async () => {
  const stream = openAICompletionsApi().streamSimple(model, context, {
    apiKey: "test-value",
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "model_busy",
            message: "Model is busy.",
            type: "api_error",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "15" },
        },
      ),
  });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("429");
  expect(result.errorMessage).toContain("model_busy");
});
it("native retry path honors retry-after without a package retry loop", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "model_warming", message: "Warming." },
        }),
        {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        },
      ),
    )
    .mockImplementationOnce(async () => success());
  // Caller-requested one retry tests the host policy; package itself sets no retry count.
  const result = await openAICompletionsApi()
    .streamSimple(model, context, {
      apiKey: "test-value",
      fetch,
      maxRetries: 1,
    })
    .result();
  expect(result.stopReason).toBe("stop");
  expect(fetch).toHaveBeenCalledTimes(2);
});
