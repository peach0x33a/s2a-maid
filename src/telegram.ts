export function createTelegramFetch(extraHeaders: HeadersInit): typeof fetch {
  const telegramFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
  return telegramFetch;
}

export async function downloadTelegramFile(
  apiRoot: string,
  token: string,
  extraHeaders: HeadersInit,
  filePath: string,
): Promise<Uint8Array> {
  const response = await createTelegramFetch(extraHeaders)(`${apiRoot}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
