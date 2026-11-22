import { createProvider, type ApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { BASE_URL, USER_AGENT, getJson } from "./api.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { catalogModels, type Entry } from "./catalog.ts";
import { validateCredits } from "./credits.ts";
import { withRetryAfter } from "./retry.ts";

export const apiKeyAuth: ApiKeyAuth = {
  name: "Refuseless API key",
  async login(interaction) {
    const key = (
      await interaction.prompt({
        type: "secret",
        message: "Refuseless API key",
        signal: interaction.signal,
      })
    ).trim();
    if (!key) throw new Error("Refuseless API key cannot be empty.");
    validateCredits(await getJson("/credits", key, interaction.signal));
    return { type: "api_key", key };
  },
  async resolve({ ctx, credential }) {
    const key = (
      credential?.key ?? (await ctx.env("REFUSELESS_API_KEY"))
    )?.trim();
    return key
      ? {
          auth: { apiKey: key },
          source: credential?.key ? "API key" : "REFUSELESS_API_KEY",
        }
      : undefined;
  },
};
export async function refuselessProvider() {
  // Pi 1.5.2 restores registered providers cache-only before initial model selection.
  // Prime the native provider during its awaited factory, then publish through Pi's store.
  // Read credentials only from the selected agent dir; never write/copy them ourselves.
  let key = process.env.REFUSELESS_API_KEY?.trim();
  try {
    const stored = JSON.parse(
      await readFile(join(getAgentDir(), "auth.json"), "utf8"),
    ).refuseless;
    if (stored?.type === "api_key" && typeof stored.key === "string")
      key = stored.key.trim() || key;
  } catch {
    /* Pi reports credential-store errors; an explicit env fallback still works. */
  }
  let primed: ReturnType<typeof catalogModels> | undefined;
  if (
    key &&
    !["1", "true", "yes"].includes(
      (process.env.PI_OFFLINE ?? "").toLowerCase(),
    ) &&
    !process.argv.includes("--offline")
  ) {
    try {
      const body = (await getJson("/models", key)) as { data: Entry[] };
      primed = catalogModels(body.data);
    } catch {
      /* Native stored catalog remains usable when the service is unreachable. */
    }
  }
  const provider = createProvider({
    id: "refuseless",
    name: "Refuseless",
    baseUrl: BASE_URL,
    headers: { "User-Agent": USER_AGENT },
    auth: { apiKey: apiKeyAuth },
    models: [],
    api: withRetryAfter(openAICompletionsApi()),
    async fetchModels(context) {
      const key =
        context.credential?.type === "api_key"
          ? context.credential.key
          : undefined;
      if (!key) return context.stored?.models ?? [];
      const body = (await getJson(
        "/models",
        key,
        context.signal,
        context.baseUrl ?? BASE_URL,
      )) as { data?: Entry[] };
      if (!Array.isArray(body?.data))
        throw new Error("Refuseless catalog response has no data array.");
      return catalogModels(body.data);
    },
  });
  const primedAt = Date.now();
  const refresh = provider.refreshModels!;
  provider.refreshModels = async (context) => {
    // Reuse createProvider's transactional restore/persist behavior with the already fetched data.
    if (
      primed !== undefined &&
      !context.allowNetwork &&
      (context.stored?.checkedAt ?? 0) <= primedAt
    ) {
      const snapshot = primed;
      await refresh({
        ...context,
        stored: { models: snapshot, checkedAt: primedAt },
        allowNetwork: false,
        publish: async (publication) => {
          let accepted: boolean;
          try {
            accepted = await context.publish({
              ...publication,
              persist: { models: snapshot, checkedAt: primedAt },
            });
          } catch (error) {
            // Pi persists before applying the update. A read-only store must
            // not prevent a child from using the catalog it just fetched.
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS")
              throw error;
            accepted = await context.publish(publication);
          }
          if (accepted) primed = undefined;
          return accepted;
        },
      });
    } else await refresh(context);
  };
  return provider;
}
