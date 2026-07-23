import { createProxyFetch, type ProxyScope } from "./proxy";

export interface NetCheckResult {
  label: string;
  ip: string | null;
  latencyMs: number;
  error: string | null;
}

export async function runNetCheck(
  proxyUrl: string | null,
  proxyScopes: ReadonlySet<ProxyScope>,
): Promise<NetCheckResult[]> {
  const results: NetCheckResult[] = [];

  results.push(await checkEndpoint(null, "直连"));

  for (const scope of proxyScopes) {
    results.push(await checkEndpoint(proxyUrl, `代理 (${scope})`));
  }

  return results;
}

async function checkEndpoint(proxyUrl: string | null, label: string): Promise<NetCheckResult> {
  const fetcher = createProxyFetch(proxyUrl);
  const start = performance.now();
  try {
    const response = await fetcher("http://ddns.oray.com/checkip");
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - start);
    const match = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(text);
    return { label, ip: match ? match[0] : null, latencyMs, error: null };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    return { label, ip: null, latencyMs, error: String(error) };
  }
}
