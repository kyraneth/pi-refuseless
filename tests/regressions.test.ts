import { it, expect, vi, afterEach } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { withRetryAfter } from "../src/retry.ts";
import { catalogModels } from "../src/catalog.ts";
import { CreditsReader } from "../src/credits.ts";
import { apiKeyAuth } from "../src/provider.ts";
import { registerThinking } from "../src/thinking.ts";
const model = catalogModels([
  {
    id: "test",
    abliterated: false,
    context_length: 1048576,
    reasoning_efforts: ["off", "low", "high", "max"],
    reasoning_default: "low",
  },
])[0];
const context = normalizeContext({
  messages: [{ role: "user", content: "OK", timestamp: 0 }],
});
const credits = (available: number) => ({
  available,
  balance: available,
  reserved: 0,
  key_limit: null,
  key_spent: 0,
});
const ok = () =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("server retry-after gates the next host attempt even with default zero SDK retries", async () => {
  vi.useFakeTimers();
  const api = withRetryAfter(openAICompletionsApi());
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "model_busy", message: "Busy" } }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "15" },
        },
      ),
    )
    .mockImplementationOnce(async () => ok());
  expect(
    (
      await api
        .streamSimple(model, context, { apiKey: "test-value", fetch })
        .result()
    ).stopReason,
  ).toBe("error");
  const second = api
    .streamSimple(model, context, { apiKey: "test-value", fetch })
    .result();
  await vi.advanceTimersByTimeAsync(14999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await second).stopReason).toBe("stop");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("abort cancels a server-directed wait without starting another network request", async () => {
  vi.useFakeTimers();
  const api = withRetryAfter(openAICompletionsApi());
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "model_warming", message: "Warming" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        },
      ),
    );
  await api
    .streamSimple(model, context, { apiKey: "test-value", fetch })
    .result();
  const controller = new AbortController();
  const result = api
    .streamSimple(model, context, {
      apiKey: "test-value",
      fetch,
      signal: controller.signal,
    })
    .result();
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await result).stopReason).toBe("aborted");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("an old-key in-flight read cannot repopulate cleared credit state or clear a new read", async () => {
  let resolveOld!: (r: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const fetch = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(new Response(JSON.stringify(credits(7))));
  vi.stubGlobal("fetch", fetch);
  const reader = new CreditsReader();
  const stale = reader.read("old-test-value");
  reader.clear();
  await reader.read("new-test-value");
  resolveOld(new Response(JSON.stringify(credits(99))));
  expect(await stale).toBeUndefined();
  expect(reader.value?.available).toBe(7);
});
it("an HTTP 200 HTML challenge cannot validate a key", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("<html>challenge</html>")),
  );
  await expect(
    apiKeyAuth.login!({
      signal: new AbortController().signal,
      notify() {},
      prompt: async () => "test-value",
    }),
  ).rejects.toThrow("Invalid Refuseless credits response");
});
it("first model pick uses catalog default; an explicit effective setting is preserved", async () => {
  const handlers: Record<string, any> = {};
  let settings: any = {};
  const setThinkingLevel = vi.fn();
  const pi: any = {
    on: (e: string, h: any) => (handlers[e] = h),
    getSettings: () => settings,
    getThinkingLevel: () => "high",
    setThinkingLevel,
  };
  registerThinking(pi);
  const ctx: any = {
    model,
    scopedModels: [],
    sessionManager: { getBranch: () => [] },
  };
  await handlers.model_select({ model, source: "set" }, ctx);
  expect(setThinkingLevel).toHaveBeenCalledWith("low");
  setThinkingLevel.mockClear();
  settings = { defaultThinkingLevel: "high" };
  await handlers.model_select({ model, source: "set" }, ctx);
  expect(setThinkingLevel).not.toHaveBeenCalled();
});
