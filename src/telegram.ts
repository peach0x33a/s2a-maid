import { createProxyFetch } from "./proxy";

export function createTelegramFetch(
  extraHeaders: HeadersInit,
  proxyUrl: string | null = null,
): typeof fetch {
  const outboundFetch = createProxyFetch(proxyUrl);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
    return outboundFetch(input, { ...init, headers });
  }) as typeof fetch;
}

export async function downloadTelegramFile(
  apiRoot: string,
  token: string,
  extraHeaders: HeadersInit,
  filePath: string,
  proxyUrl: string | null = null,
): Promise<Uint8Array> {
  const response = await createTelegramFetch(extraHeaders, proxyUrl)(`${apiRoot}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
