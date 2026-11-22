import type {
  FetchFunction,
  ProviderStreams,
  StreamOptions,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** Keep the server's not-before time across Pi agent-level attempts as well as SDK retries.
 * Pi 1.5.2 defaults provider retries to zero and agent retries ignore retry-after.
 * This adds NO attempts or retry policy; the next host-authorized request simply waits.
 */
export function withRetryAfter(api: ProviderStreams): ProviderStreams {
  const deadlines = new Map<string, number>();
  function transport(
    modelId: string,
    fetch: FetchFunction = globalThis.fetch,
    signal?: AbortSignal,
  ): FetchFunction {
    return async (input, init) => {
      const requestSignal = init?.signal ?? signal;
      const delay = (deadlines.get(modelId) ?? 0) - Date.now();
      if (delay > 0)
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            requestSignal?.removeEventListener("abort", abort);
            resolve();
          }, delay);
          if (requestSignal?.aborted) abort();
          else requestSignal?.addEventListener("abort", abort, { once: true });
        });
      if ((deadlines.get(modelId) ?? 0) <= Date.now())
        deadlines.delete(modelId);
      const response = await fetch(input, init);
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        if (header) {
          const seconds = Number(header);
          const deadline = Number.isFinite(seconds)
            ? Date.now() + seconds * 1000
            : Date.parse(header);
          if (Number.isFinite(deadline) && deadline > Date.now())
            deadlines.set(modelId, deadline);
        }
      }
      return response;
    };
  }
  return {
    stream: (m, c, o) =>
      api.stream(m, c, {
        ...o,
        fetch: transport(m.id, o?.fetch, o?.signal),
      } as StreamOptions),
    streamSimple: (m, c, o) =>
      api.streamSimple(m, c, {
        ...o,
        fetch: transport(m.id, o?.fetch, o?.signal),
      } as SimpleStreamOptions),
  };
}
