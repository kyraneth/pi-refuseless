import { it, expect, vi, beforeEach, afterEach } from "vitest";
import extension from "../src/index.ts";
import { registerThinking } from "../src/thinking.ts";
import { catalogModels } from "../src/catalog.ts";
const model = catalogModels([
  {
    id: "test",
    abliterated: true,
    context_length: 1048576,
    reasoning_efforts: ["off", "low", "high", "max"],
    reasoning_default: "low",
    pricing: { input_per_m: 1, cached_input_per_m: 0, output_per_m: 2 },
  },
])[0];
beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-refuseless-test-agent");
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("REFUSELESS_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function harness() {
  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  let level = "high";
  const pi = {
    getSettings: () => ({}),
    registerProvider: vi.fn(),
    on: (e: string, h: Function) => {
      (handlers[e] ??= []).push(h);
    },
    registerCommand: (name: string, c: any) => (commands[name] = c),
    getThinkingLevel: () => level,
    setThinkingLevel: vi.fn((l) => {
      level = l;
    }),
  };
  const ctx: any = {
    model,
    cwd: "/tmp/pi-refuseless-tests",
    scopedModels: [],
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: {
      getApiKeyForProvider: vi.fn().mockResolvedValue("test-value"),
      getAll: () => [model],
    },
  };
  return {
    pi,
    ctx,
    commands,
    async emit(event: string, value: any = {}) {
      for (const h of handlers[event] ?? []) await h(value, ctx);
    },
  };
}
it("initial catalog default wins over implicit Pi medium→high, but reload/restore and explicit --thinking off win", async () => {
  const h = harness();
  registerThinking(h.pi as any);
  await h.emit("session_start", { reason: "startup" });
  expect(h.pi.setThinkingLevel).toHaveBeenCalledWith("low");
  h.pi.setThinkingLevel.mockClear();
  await h.emit("session_start", { reason: "reload" });
  expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  process.argv.push("--thinking", "off");
  try {
    await h.emit("session_start", { reason: "startup" });
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
  } finally {
    process.argv.splice(-2);
  }
  h.ctx.sessionManager.getBranch = () => [{ type: "message" }];
  await h.emit("session_start", { reason: "startup" });
  expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
});
it("command renders all balance fields, footer switches away, preflight warns without replacing/blocking payload", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            available: 0,
            balance: 1,
            reserved: 1,
            key_limit: null,
            key_spent: 2,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
  );
  const h = harness();
  await extension(h.pi as any);
  await h.emit("session_start", { reason: "startup" });
  expect(h.ctx.ui.setStatus).toHaveBeenCalledWith(
    "refuseless",
    "Refuseless $0.00",
  );
  await h.commands.refuseless.handler("", h.ctx);
  expect(
    h.ctx.ui.notify.mock.calls.some((c: any) => c[0].includes("key_spent: 2")),
  ).toBe(true);
  const payload = {
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 512,
  };
  await h.emit("before_provider_request", { payload });
  expect(
    h.ctx.ui.notify.mock.calls.some(
      (c: any) => c[1] === "warning" && c[0].includes("may be cut short"),
    ),
  ).toBe(true);
  expect(payload.max_tokens).toBe(512);
  h.ctx.model = { ...model, provider: "other" };
  await h.emit("model_select", { model: h.ctx.model, source: "set" });
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("refuseless", undefined);
});
it("logout clears footer and known balance before the next request", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            available: 0,
            balance: 0,
            reserved: 0,
            key_limit: null,
            key_spent: 2,
          }),
        ),
      ),
  );
  const h = harness();
  await extension(h.pi as any);
  await h.emit("session_start", { reason: "startup" });
  h.ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue(undefined);
  await h.emit("turn_end");
  expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("refuseless", undefined);
  h.ctx.ui.notify.mockClear();
  await h.emit("before_provider_request", {
    payload: { messages: [], max_tokens: 512 },
  });
  expect(h.ctx.ui.notify).not.toHaveBeenCalled();
});
