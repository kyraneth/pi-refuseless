export const BASE_URL = "https://api.refuseless.com/v1";
export const USER_AGENT = "pi-refuseless/0.1.1";

export function errorText(
  status: number,
  code: string,
  message: string,
): string {
  const help =
    status === 401
      ? " Check your key with /login → Refuseless API key."
      : status === 402 || code === "insufficient_credits"
        ? " Top up at https://refuseless.com and check /refuseless."
        : status === 429
          ? " Rate-limited; allow the server's retry-after interval before trying again."
          : status === 403
            ? " Gateway/WAF denied the request; check API access and User-Agent."
            : status >= 500
              ? " Refuseless is temporarily unavailable; retry after service recovery."
              : "";
  return `Refuseless HTTP ${status} ${code}: ${message}${help}`;
}

export async function getJson(
  path: string,
  key: string,
  signal?: AbortSignal,
  baseUrl = BASE_URL,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
    signal,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    // Do not echo arbitrary server messages: an auth gateway could echo credentials.
    const code =
      typeof body?.error?.code === "string"
        ? body.error.code.replace(/[^a-z0-9_-]/gi, "")
        : "request_failed";
    throw new Error(
      errorText(
        response.status,
        code,
        response.status === 401
          ? "Invalid, expired or revoked API key."
          : "API request failed.",
      ),
    );
  }
  return body;
}
