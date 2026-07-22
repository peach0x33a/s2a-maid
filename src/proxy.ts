import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

export const PROXY_SCOPES = ["sub2api", "telegram", "openai", "other"] as const;
export const PROXY_PROTOCOLS = ["http:", "https:", "socks5:", "socks5h:"] as const;

export type ProxyScope = typeof PROXY_SCOPES[number];

export function createProxyFetch(proxyUrl: string | null, baseFetch: typeof fetch = fetch): typeof fetch {
  if (!proxyUrl) return baseFetch;
  const protocol = new URL(proxyUrl).protocol;
  if (protocol === "http:" || protocol === "https:") {
    return ((input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) =>
      baseFetch(input, { ...init, proxy: proxyUrl })) as typeof fetch;
  }

  const agent = new SocksProxyAgent(proxyUrl);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    const response = await nodeFetch(url, {
      ...init,
      agent,
      body: init?.body as NodeFetchRequestInit["body"],
    } as NodeFetchRequestInit);
    return response as unknown as Response;
  }) as typeof fetch;
}

export function proxyForScope(
  proxyUrl: string | null,
  scopes: ReadonlySet<ProxyScope>,
  scope: ProxyScope,
): string | null {
  return proxyUrl && scopes.has(scope) ? proxyUrl : null;
}
