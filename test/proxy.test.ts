import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { createProxyFetch, proxyForScope, type ProxyScope } from "../src/proxy";
import { createTelegramFetch } from "../src/telegram";

test("selects the configured proxy only for enabled array scopes", () => {
  const scopes = new Set<ProxyScope>(["telegram", "openai", "other"]);
  expect(proxyForScope("http://proxy.example:8080", scopes, "telegram")).toBe("http://proxy.example:8080");
  expect(proxyForScope("http://proxy.example:8080", scopes, "openai")).toBe("http://proxy.example:8080");
  expect(proxyForScope("http://proxy.example:8080", scopes, "other")).toBe("http://proxy.example:8080");
  expect(proxyForScope("http://proxy.example:8080", scopes, "sub2api")).toBeNull();
  expect(proxyForScope(null, scopes, "openai")).toBeNull();
});

test("returns global fetch when proxy is null", () => {
  expect(createProxyFetch(null)).toBe(fetch);
});

test("routes requests through SOCKS5 and SOCKS5H proxies", async () => {
  const target = Bun.serve({ port: 0, fetch: () => new Response("SOCKS_OK") });
  const proxy = createSocks5TestServer();
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => resolve());
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("SOCKS test server did not bind");
  try {
    for (const protocol of ["socks5", "socks5h"]) {
      const proxiedFetch = createProxyFetch(`${protocol}://127.0.0.1:${address.port}`);
      const response = await proxiedFetch(`http://127.0.0.1:${target.port}`);
      expect(await response.text()).toBe("SOCKS_OK");
    }
  } finally {
    proxy.close();
    target.stop(true);
  }
});

test("Telegram fetch injects extra headers without losing request options", async () => {
  const requests: RequestInit[] = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {});
    return Response.json({ ok: true });
  }) as typeof fetch;
  // patch globalThis.fetch temporarily
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const telegramFetch = createTelegramFetch(
      { Authorization: "Bearer telegram-proxy-token" },
    );
    await telegramFetch("https://api.telegram.org/bot/test", { headers: { "X-Request": "yes" } });
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("authorization")).toBe("Bearer telegram-proxy-token");
    expect(headers.get("x-request")).toBe("yes");
  } finally {
    globalThis.fetch = orig;
  }
});

function createSocks5TestServer() {
  return createServer((client) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let upstream: Socket | null = null;
    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || buffer.length < 5) return;
      const addressType = buffer[3];
      let offset = 4;
      let host: string;
      if (addressType === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(offset, offset + 4)].join(".");
        offset += 4;
      } else if (addressType === 3) {
        const length = buffer[offset++];
        if (buffer.length < offset + length + 2) return;
        host = buffer.subarray(offset, offset + length).toString();
        offset += length;
      } else {
        client.destroy();
        return;
      }
      const port = buffer.readUInt16BE(offset);
      offset += 2;
      const pending = buffer.subarray(offset);
      buffer = Buffer.alloc(0);
      stage = 2;
      upstream = createConnection({ host, port }, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (pending.length) upstream?.write(pending);
        client.pipe(upstream!);
        upstream!.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
    client.on("error", () => upstream?.destroy());
  });
}
