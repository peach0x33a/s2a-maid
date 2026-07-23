import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

export const PROXY_SCOPES = ["sub2api", "telegram", "openai", "other"] as const;
export const PROXY_PROTOCOLS = ["http:", "https:", "socks5:", "socks5h:"] as const;

export type ProxyScope = typeof PROXY_SCOPES[number];

export function createProxyFetch(proxyUrl: string | null): typeof fetch {
  if (!proxyUrl) return fetch;
  const protocol = new URL(proxyUrl).protocol;

  // Bun's native fetch proxy option is the only reliable way in Bun.
  // node-fetch + agent (https-proxy-agent / socks-proxy-agent) ignores
  // the agent entirely in Bun's Node.js compat layer.
  if (protocol === "http:" || protocol === "https:") {
    return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetch(input, { ...init, proxy: proxyUrl })) as typeof fetch;
  }

  // SOCKS: node-fetch + socks-proxy-agent (same caveat — may not work in Bun)
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
