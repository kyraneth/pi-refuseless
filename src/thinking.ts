import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RefuselessModel } from "./catalog.ts";

function hasConfiguredLevel(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const s = pi.getSettings();
  if (
    s.defaultThinkingLevel !== undefined ||
    s.modelThinkingLevels?.[`${ctx.model?.provider}/${ctx.model?.id}`] !==
      undefined
  )
    return true;
  return ctx.scopedModels.some(
    (s) =>
      s.model.id === ctx.model?.id &&
      s.model.provider === ctx.model?.provider &&
      s.thinkingLevel !== undefined,
  );
}
function cliLevelWasSet(): boolean {
  return process.argv.some(
    (a) =>
      a === "--thinking" ||
      a.startsWith("--thinking=") ||
      /:(off|minimal|low|medium|high|xhigh|max)(,|$)/.test(a),
  );
}
export function registerThinking(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    const m = ctx.model as RefuselessModel | undefined;
    if (m?.provider !== "refuseless" || !m.reasoningDefault) return;
    const branch = ctx.sessionManager.getBranch();
    // Pi appends one implicit thinking entry even for a fresh session. Additional entries
    // represent a later selection, including branches that have not sent a message yet.
    if (
      branch.some((e) => e.type === "message" || e.type === "custom") ||
      branch.filter((e) => e.type === "thinking_level_change").length > 1
    )
      return;
    if (cliLevelWasSet() || hasConfiguredLevel(pi, ctx)) return;
    pi.setThinkingLevel(m.reasoningDefault);
  });
  pi.on("model_select", (event, ctx) => {
    const m = event.model as RefuselessModel;
    if (
      event.source === "restore" ||
      m.provider !== "refuseless" ||
      !m.reasoningDefault
    )
      return;
    if (
      event.previousModel &&
      getSupportedThinkingLevels(event.previousModel).some((l) => l !== "off")
    )
      return;
    if (cliLevelWasSet() || hasConfiguredLevel(pi, ctx)) return;
    if (
      !event.previousModel ||
      pi.getThinkingLevel() === clampThinkingLevel(m, "off")
    )
      pi.setThinkingLevel(m.reasoningDefault);
  });
}
