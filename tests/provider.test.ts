import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  createModels,
} from "@earendil-works/pi-ai";
import { catalogModels, displayName, type Entry } from "../src/catalog.ts";
import { apiKeyAuth, refuselessProvider } from "../src/provider.ts";
import { CreditsReader, creditsText, estimateHold } from "../src/credits.ts";
import { getJson } from "../src/api.ts";
const entry: Entry = {
  id: "deepseek-v4.1-flash-abliterated",
  abliterated: true,
  vision: true,
  context_length: 1048576,
  reasoning_efforts: ["off", "low", "high", "max"],
  reasoning_default: "low",
  pricing: {
    currency: "USD",
    input_per_m: 0.12,
    cached_input_per_m: 0.025,
    output_per_m: 0.45,
    long_context: {
      threshold: 200000,
      input_per_m: 0.24,
      cached_input_per_m: 0.05,
      output_per_m: 0.9,
    },
  },
};
const credits = {
  available: 2,
  balance: 3,
  reserved: 1,
  key_limit: null,
  key_spent: 0.1,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-refuseless-test-agent");
  vi.stubEnv("REFUSELESS_API_KEY", "");
  vi.stubEnv("PI_OFFLINE", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("catalog", () => {
  it("maps modalities, names, pricing and documented limits", () => {
    const m = catalogModels([entry])[0];
    expect(m.input).toEqual(["text", "image"]);
    expect(m.name).toBe("DeepSeek v4.1 Flash (refusal-removed weights)");
    expect(m.cost.cacheRead).toBe(0.025);
    expect(m.maxTokensSource).toContain("Documented fallback");
    expect(m.maxTokens).toBe(131072);
  });
  it("uses flag rather than id for refusal-removal indication", () => {
    expect(displayName("glm-5.3-abliterated", false)).toBe("GLM 5.3");
    expect(displayName("ordinary", true)).toContain("refusal-removed");
  });
  it("uses null+native clamping: clean cycle, no duplicate levels", () => {
    const m = catalogModels([entry])[0];
    expect(getSupportedThinkingLevels(m)).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(
      ["minimal", "medium", "xhigh"].map((l) =>
        clampThinkingLevel(m, l as any),
      ),
    ).toEqual(["low", "high", "max"]);
    expect(m.thinkingLevelMap?.off).toBe("off");
  });
  it("never offers off on a model that rejects it", () => {
    const m = catalogModels([
      { ...entry, reasoning_efforts: ["low", "high", "max"] },
    ])[0];
    expect(getSupportedThinkingLevels(m)).toEqual(["low", "high", "max"]);
    expect(clampThinkingLevel(m, "off")).toBe("low");
  });
  it("maps missing price to zeros and skips incomplete/malformed entries without hiding valid models", () => {
    expect(
      catalogModels([{ ...entry, pricing: undefined, vision: false }])[0].cost,
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(
      catalogModels([{ ...entry, context_length: undefined }, entry]),
    ).toHaveLength(1);
    expect(
      catalogModels([
        { ...entry, pricing: { ...entry.pricing!, input_per_m: NaN } },
        entry,
      ]),
    ).toHaveLength(1);
    expect(
      catalogModels([{ ...entry, reasoning_efforts: "low" as any }, entry]),
    ).toHaveLength(1);
  });
  it("native calculateCost tiers charge the whole request only strictly above threshold, cached input included", () => {
    const m = catalogModels([entry])[0];
    for (const total of [200000, 200001]) {
      const usage = {
        input: total - 100,
        cacheRead: 100,
        cacheWrite: 0,
        output: 10,
        totalTokens: total + 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const cost = calculateCost(m, usage);
      const factor = total > 200000 ? 2 : 1;
      expect(cost.total).toBeCloseTo(
        (((total - 100) * 0.12 + 100 * 0.025 + 10 * 0.45) * factor) / 1e6,
        12,
      );
    }
  });
});
describe("native auth", () => {
  it("prompts secret, trims and validates for free before returning a credential", async () => {
    const fetch = vi.fn().mockResolvedValue(response(credits));
    vi.stubGlobal("fetch", fetch);
    const prompt = vi.fn().mockResolvedValue("  test-value  ");
    const c = await apiKeyAuth.login!({
      prompt,
      notify: vi.fn(),
      signal: new AbortController().signal,
    });
    expect(c.key).toBe("test-value");
    expect(prompt.mock.calls[0][0].type).toBe("secret");
    expect(fetch.mock.calls[0][0]).toMatch(/\/credits$/);
  });
  it("rejects blank before network and 401 before returning a credential", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response(
          {
            error: {
              code: "invalid_key",
              message: "do not echo arbitrary body",
            },
          },
          401,
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const i = {
      prompt: vi.fn().mockResolvedValue(" "),
      notify: vi.fn(),
      signal: new AbortController().signal,
    };
    await expect(apiKeyAuth.login!(i)).rejects.toThrow("empty");
    expect(fetch).not.toHaveBeenCalled();
    i.prompt.mockResolvedValue("invalid-test-value");
    await expect(apiKeyAuth.login!(i)).rejects.toThrow("401 invalid_key");
  });
  it("stored key wins over env fallback", async () => {
    const ctx = {
      env: vi.fn().mockResolvedValue("env-value"),
      fileExists: vi.fn(),
    };
    const r = await apiKeyAuth.resolve({
      ctx,
      credential: { type: "api_key", key: "stored-value" },
      signal: new AbortController().signal,
    });
    expect(r?.auth.apiKey).toBe("stored-value");
    expect(ctx.env).not.toHaveBeenCalled();
  });
  it("native login failure does not persist; logout deletes credential", async () => {
    let stored: any;
    const models = createModels({
      credentials: {
        read: async () => stored,
        list: async () => [],
        delete: async () => {
          stored = undefined;
        },
        modify: async (_id, fn) => (stored = await fn(stored)),
      },
    });
    models.setProvider(await refuselessProvider());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(credits)));
    await models.login("refuseless", "api_key", {
      prompt: async () => "test-value",
      notify() {},
    });
    expect(stored.type).toBe("api_key");
    await models.logout("refuseless");
    expect(stored).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response({ error: { code: "invalid_key" } }, 401)),
    );
    await expect(
      models.login("refuseless", "api_key", {
        prompt: async () => "invalid",
        notify() {},
      }),
    ).rejects.toThrow("401");
    expect(stored).toBeUndefined();
  });
});
describe("credits and request advice", () => {
  it("coalesces reads and respects API 60/minute even after failures", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response(credits));
    vi.stubGlobal("fetch", fetch);
    const r = new CreditsReader();
    await Promise.all([r.read("test-value"), r.read("test-value")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await r.read("test-value");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    fetch.mockResolvedValueOnce(
      response({ error: { code: "rate_limit_exceeded" } }, 429),
    );
    await expect(r.read("test-value")).rejects.toThrow("429");
    await r.read("test-value");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("includes balance fields, prices and nonblocking estimated hold", () => {
    const m = catalogModels([entry])[0];
    expect(creditsText(credits, m)).toMatch(/key_limit: unlimited/);
    expect(creditsText(credits, m)).toContain("cached input 0.025");
    expect(
      estimateHold(
        { messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
        m,
      ),
    ).toBeGreaterThan((100 * 0.45) / 1e6);
  });
  it("adds 402 guidance without reflecting auth response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(
            {
              error: {
                code: "insufficient_credits",
                message: "sensitive body",
              },
            },
            402,
          ),
        ),
    );
    await expect(getJson("/credits", "test-value")).rejects.toThrow(
      "/refuseless",
    );
  });
});
describe("catalog persistence/startup", () => {
  it("primes first env startup and publishes through native store; restores offline without fetch", async () => {
    vi.stubEnv("REFUSELESS_API_KEY", "test-value");
    const fetch = vi.fn().mockResolvedValue(response({ data: [entry] }));
    vi.stubGlobal("fetch", fetch);
    const p = await refuselessProvider();
    let persisted: any;
    const signal = new AbortController().signal;
    await p.refreshModels!({
      allowNetwork: false,
      signal,
      publish: async (pub) => {
        if (pub.persist) persisted = pub.persist;
        pub.update?.();
        return true;
      },
    });
    expect(p.getModels()[0].id).toBe(entry.id);
    expect(persisted.models[0].cost.input).toBe(0.12);
    await p.refreshModels!({
      stored: { models: [], checkedAt: 1 },
      allowNetwork: false,
      signal,
      publish: async (pub) => {
        pub.update?.();
        return true;
      },
    });
    expect(p.getModels()).toEqual([]);
    vi.stubEnv("PI_OFFLINE", "1");
    const offline = await refuselessProvider();
    await offline.refreshModels!({
      stored: persisted,
      allowNetwork: false,
      signal,
      publish: async (pub) => {
        pub.update?.();
        return true;
      },
    });
    expect(offline.getModels()[0].input).toContain("image");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("publishes the primed catalog when the native store denies writes", async () => {
    vi.stubEnv("REFUSELESS_API_KEY", "test-value");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ data: [entry] })));
    const provider = await refuselessProvider();
    const write = vi.fn().mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const models = createModels({
      modelsStore: {
        read: async () => ({ models: [], checkedAt: 1 }),
        write,
        delete: vi.fn(),
      },
    });
    models.setProvider(provider);

    const result = await models.refresh({ allowNetwork: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.errors.size).toBe(0);
    expect(provider.getModels().map((model) => model.id)).toEqual([entry.id]);
  });
  it("live empty catalog replaces stale list; failed fetch retains restored models", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const p = await refuselessProvider();
    const signal = new AbortController().signal;
    const stored = { models: catalogModels([entry]), checkedAt: 1 };
    const publish = async (pub: any) => {
      pub.update?.();
      return true;
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ data: [] })));
    await p.refreshModels!({
      stored,
      allowNetwork: true,
      credential: { type: "api_key", key: "test-value" },
      signal,
      publish,
    });
    expect(p.getModels()).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      p.refreshModels!({
        stored,
        allowNetwork: true,
        credential: { type: "api_key", key: "test-value" },
        signal,
        publish,
      }),
    ).rejects.toThrow("offline");
    expect(p.getModels()).toHaveLength(1);
  });
});
