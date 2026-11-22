import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { refuselessProvider } from "./provider.ts";
import { CreditsReader, creditsText, estimateHold } from "./credits.ts";
import { registerThinking } from "./thinking.ts";

export default async function refuseless(pi: ExtensionAPI) {
  pi.registerProvider(await refuselessProvider());
  registerThinking(pi);
  const credits = new CreditsReader();
  let currentKey: string | undefined;
  async function refresh(ctx: ExtensionContext) {
    if (ctx.model?.provider !== "refuseless") {
      ctx.ui.setStatus("refuseless", undefined);
      return;
    }
    const key = await ctx.modelRegistry.getApiKeyForProvider("refuseless");
    if (key !== currentKey) {
      credits.clear();
      currentKey = key;
    }
    if (!key) {
      ctx.ui.setStatus("refuseless", undefined);
      return;
    }
    try {
      const c = await credits.read(key, ctx.signal);
      if (key !== currentKey) return;
      ctx.ui.setStatus(
        "refuseless",
        c
          ? `Refuseless $${c.available.toFixed(2)}`
          : "Refuseless credits unavailable",
      );
    } catch {
      ctx.ui.setStatus(
        "refuseless",
        credits.value
          ? `Refuseless $${credits.value.available.toFixed(2)} (stale)`
          : "Refuseless credits unavailable",
      );
    }
  }
  pi.on("session_start", async (_e, ctx) => {
    await refresh(ctx);
  });
  pi.on("model_select", async (_e, ctx) => {
    await refresh(ctx);
  });
  pi.on("turn_end", async (_e, ctx) => {
    await refresh(ctx);
  });
  pi.on("agent_start", async (_e, ctx) => {
    warned = false;
    await refresh(ctx);
  });
  let warned = false;
  pi.registerCommand("refuseless", {
    description: "Show Refuseless credits and current model pricing",
    async handler(_args, ctx) {
      const key = await ctx.modelRegistry.getApiKeyForProvider("refuseless");
      if (!key) {
        credits.clear();
        currentKey = undefined;
        ctx.ui.setStatus("refuseless", undefined);
        ctx.ui.notify(
          "Refuseless: /login → Refuseless API key first.",
          "warning",
        );
        return;
      }
      if (key !== currentKey) {
        credits.clear();
        currentKey = key;
      }
      try {
        const c = await credits.read(key, ctx.signal);
        if (key !== currentKey) return;
        if (c) {
          ctx.ui.notify(creditsText(c, ctx.model), "info");
          await refresh(ctx);
        } else
          ctx.ui.notify(
            "Refuseless credits read is rate-limited; try again shortly.",
            "warning",
          );
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "refuseless" || !credits.value || warned)
      return;
    const hold = estimateHold(
      event.payload as Record<string, unknown>,
      ctx.model,
    );
    if (credits.value.available < hold) {
      warned = true;
      ctx.ui.notify(
        `Refuseless: available $${credits.value.available.toFixed(2)} is below the estimated worst-case hold $${hold.toFixed(2)}. Reply may be cut short; check /refuseless or top up. This is an estimate, not a tokenizer (image tokens are unknown).`,
        "warning",
      );
    }
  });
  pi.on("message_end", (event, ctx) => {
    const m = event.message;
    if (
      m.role === "assistant" &&
      m.provider === "refuseless" &&
      m.stopReason === "error" &&
      /insufficient_credits|\b402\b/.test(m.errorMessage ?? "")
    ) {
      // The adapter already exposes HTTP status/code and SSE errors. Add actionable guidance only.
      ctx.ui.notify(
        "Refuseless insufficient_credits: top up at https://refuseless.com and check /refuseless.",
        "error",
      );
    }
  });
}
