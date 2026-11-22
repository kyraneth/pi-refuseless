import type {
  Model,
  ModelThinkingLevel,
  ThinkingLevelMap,
  ModelCost,
} from "@earendil-works/pi-ai";

export type Entry = {
  id: string;
  abliterated: boolean;
  vision?: boolean;
  context_length?: number;
  reasoning_efforts?: string[];
  reasoning_default?: string;
  pricing?: Rates & {
    currency?: string;
    long_context?: Rates & { threshold: number };
  };
};
type Rates = {
  input_per_m: number;
  cached_input_per_m: number;
  output_per_m: number;
};
export type RefuselessModel = Model<"openai-completions"> & {
  reasoningDefault?: ModelThinkingLevel;
  abliterated: boolean;
  maxTokensSource: string;
};
export const LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export function costRates(r?: Rates): ModelCost {
  return {
    input: r?.input_per_m ?? 0,
    cacheRead: r?.cached_input_per_m ?? 0,
    output: r?.output_per_m ?? 0,
    cacheWrite: 0,
  };
}
export function displayName(id: string, abliterated: boolean): string {
  const words = id.replace(/-abliterated(?=-|$)/g, "").split("-");
  const names: Record<string, string> = {
    glm: "GLM",
    deepseek: "DeepSeek",
    minimax: "MiniMax",
    kimi: "Kimi",
  };
  return (
    words
      .map(
        (w) =>
          names[w] ??
          (/^v?\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)),
      )
      .join(" ") + (abliterated ? " (refusal-removed weights)" : "")
  );
}
function validEntry(e: Entry): boolean {
  if (
    !e ||
    typeof e.id !== "string" ||
    !e.id ||
    !Number.isInteger(e.context_length) ||
    e.context_length! <= 0 ||
    typeof e.abliterated !== "boolean"
  )
    return false;
  if (
    e.reasoning_efforts !== undefined &&
    (!Array.isArray(e.reasoning_efforts) ||
      !e.reasoning_efforts.every((v) =>
        ["off", "low", "high", "max"].includes(v),
      ))
  )
    return false;
  const rates = (r: Rates) =>
    r &&
    [r.input_per_m, r.cached_input_per_m, r.output_per_m].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    );
  if (
    e.pricing &&
    ((e.pricing.currency && e.pricing.currency !== "USD") || !rates(e.pricing))
  )
    return false;
  const t = e.pricing?.long_context;
  return !t || (rates(t) && Number.isInteger(t.threshold) && t.threshold >= 0);
}
export function catalogModels(entries: Entry[]): RefuselessModel[] {
  if (!Array.isArray(entries))
    throw new Error("Refuseless catalog response has no data array.");
  // An incomplete/new model must not hide the rest of an account's valid catalog.
  return entries.filter(validEntry).map((e) => {
    const offered = new Set(e.reasoning_efforts ?? []);
    const thinkingLevelMap = Object.fromEntries(
      LEVELS.map((level) => [
        level,
        offered.has(level) && ["off", "low", "high", "max"].includes(level)
          ? level
          : null,
      ]),
    ) as ThinkingLevelMap;
    const cost = costRates(e.pricing);
    if (e.pricing?.long_context)
      cost.tiers = [
        {
          ...costRates(e.pricing.long_context),
          inputTokensAbove: e.pricing.long_context.threshold,
        },
      ];
    return {
      type: "chat",
      provider: "refuseless",
      api: "openai-completions",
      baseUrl: "https://api.refuseless.com/v1",
      id: e.id,
      name: displayName(e.id, e.abliterated),
      abliterated: e.abliterated,
      input: e.vision ? ["text", "image"] : ["text"],
      contextWindow: e.context_length!,
      cost,
      // Refuseless's official Pi example: https://docs.refuseless.com/sdks.md.
      // Catalog omits output limits. Live probes only found a gateway validation ceiling of 1,000,000,
      // NOT a checkpoint output limit; do not advertise that as model capacity.
      maxTokens: Math.min(131_072, e.context_length!),
      maxTokensSource:
        "Documented fallback: docs.refuseless.com/sdks.md Pi example (131072), not a measured checkpoint limit",
      reasoning: [...offered].some((x) => ["low", "high", "max"].includes(x)),
      thinkingLevelMap,
      ...(offered.has(e.reasoning_default ?? "")
        ? { reasoningDefault: e.reasoning_default as ModelThinkingLevel }
        : {}),
      // System role is the portable baseline; live system-role, usage, off/high and tool-history checks in evidence.
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        thinkingFormat: "openai",
        maxTokensField: "max_tokens",
      },
    };
  });
}
