import type { Model } from "@earendil-works/pi-ai";
import { getJson } from "./api.ts";
export interface Credits {
  available: number;
  balance: number;
  reserved: number;
  key_limit: number | null;
  key_spent: number;
}
export function validateCredits(value: unknown): Credits {
  const c = value as Credits | undefined;
  if (
    !c ||
    ![c.available, c.balance, c.reserved, c.key_spent].every(Number.isFinite) ||
    !(c.key_limit === null || Number.isFinite(c.key_limit))
  )
    throw new Error(
      "Invalid Refuseless credits response; expected credit balances, not a gateway page.",
    );
  return c;
}
// API limit: 60 credits reads/minute/key (docs.refuseless.com/api/credits).
// One in-flight read and >=1 second spacing. Failed reads also consume a slot.
export class CreditsReader {
  value?: Credits;
  private lastRead = -Infinity;
  private inFlight?: Promise<Credits | undefined>;
  private generation = 0;
  async read(key: string, signal?: AbortSignal): Promise<Credits | undefined> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastRead <= 60_000 / 60) return this.value;
    this.lastRead = Date.now();
    const generation = this.generation;
    this.inFlight = (async () => {
      const value = validateCredits(await getJson("/credits", key, signal));
      if (generation !== this.generation) return undefined;
      this.value = value;
      return value;
    })();
    try {
      return await this.inFlight;
    } finally {
      if (generation === this.generation) this.inFlight = undefined;
    }
  }
  clear() {
    this.generation++;
    this.value = undefined;
    this.lastRead = -Infinity;
    this.inFlight = undefined;
  }
}
export function pricingText(model?: Model<any>): string {
  if (model?.provider !== "refuseless")
    return "Current model is not Refuseless.";
  const c = model.cost;
  return (
    `${model.name}\nUSD / 1M tokens: input ${c.input}, cached input ${c.cacheRead}, output ${c.output}; cache write ${c.cacheWrite}` +
    (c.tiers
      ?.map(
        (t) =>
          `\nAbove ${t.inputTokensAbove} prompt tokens (whole request): input ${t.input}, cached ${t.cacheRead}, output ${t.output}`,
      )
      .join("") ?? "")
  );
}
export function creditsText(c: Credits, model?: Model<any>): string {
  return `Refuseless credits (USD)\navailable: ${c.available}\nbalance: ${c.balance}\nreserved: ${c.reserved}\nkey_limit: ${c.key_limit ?? "unlimited"}\nkey_spent: ${c.key_spent}\n\n${pricingText(model)}`;
}
export function estimateHold(
  payload: Record<string, unknown>,
  model: Model<any>,
): number {
  // Deliberately conservative text estimate: UTF-8 bytes, one token per byte, includes tool schemas.
  // Not a tokenizer/guarantee; image token counts are unknown. The server estimates independently.
  const prompt = new TextEncoder().encode(
    JSON.stringify(
      { messages: payload.messages, tools: payload.tools },
      (key, value) => (key === "image_url" ? "[image tokens unknown]" : value),
    ),
  ).length;
  const output = Number(
    payload.max_tokens ?? payload.max_completion_tokens ?? model.maxTokens,
  );
  let rates = model.cost;
  for (const tier of [...(model.cost.tiers ?? [])].sort(
    (a, b) => a.inputTokensAbove - b.inputTokensAbove,
  ))
    if (prompt > tier.inputTokensAbove) rates = tier;
  return (prompt * rates.input + output * rates.output) / 1e6;
}
