import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathFromArgs, loadConfig, parseConfig } from "../src/config";

const validConfig = {
  telegram: {
    bot_token: "telegram-token",
    api_base_url: "https://telegram.example/",
    allowed_chat_ids: [-1001234567890],
    alert_chat_id: -1001234567890,
    api_headers: { "X-Proxy-Token": "secret" },
  },
  sub2api: {
    base_url: "http://sub2api.example/",
    admin_api_key: "admin-key",
  },
  proxy: {
    url: "socks5h://proxy-user:proxy-password@proxy.example:1080",
    scope: ["sub2api", "telegram", "openai", "other", "openai"],
  },
  monitor: {
    group_id: "group-1",
    interval_seconds: 60,
    low_quota_percent: 15,
  },
  database: { path: "/tmp/s2a-maid.sqlite" },
};

describe("TOML config", () => {
  test("maps tables into runtime configuration", () => {
    const config = parseConfig(validConfig);
    expect(config).toMatchObject({
      telegramBotToken: "telegram-token",
      telegramApiBaseUrl: "https://telegram.example",
      telegramApiHeaders: { "X-Proxy-Token": "secret" },
      alertChatId: -1001234567890,
      sub2ApiBaseUrl: "http://sub2api.example",
      sub2ApiAdminApiKey: "admin-key",
      proxyUrl: "socks5h://proxy-user:proxy-password@proxy.example:1080",
      proxyScopes: new Set(["sub2api", "telegram", "openai", "other"]),
      monitorGroupId: "group-1",
      usageCheckIntervalSeconds: 60,
      lowQuotaPercent: 15,
      databasePath: "/tmp/s2a-maid.sqlite",
    });
    expect(config.allowedChatIds).toEqual(new Set([-1001234567890]));
  });

  test("applies optional defaults", () => {
    const config = parseConfig({
      telegram: {
        bot_token: "telegram-token",
        allowed_chat_ids: [-1001234567890],
        alert_chat_id: -1001234567890,
      },
      sub2api: { admin_api_key: "admin-key" },
      monitor: { group_id: "group-1" },
    });
    expect(config.telegramApiBaseUrl).toBe("https://api.telegram.org");
    expect(config.sub2ApiBaseUrl).toBe("http://127.0.0.1:8080");
    expect(config.sub2ApiAdminApiKey).toBe("admin-key");
    expect(config.proxyUrl).toBeNull();
    expect(config.proxyScopes).toEqual(new Set());
    expect(config.usageCheckIntervalSeconds).toBe(300);
    expect(config.lowQuotaPercent).toBe(10);
    expect(config.databasePath).toBe("./s2a-maid.sqlite");
  });

  test("resolves a relative database path beside the config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "s2a-maid-config-"));
    const configPath = join(directory, "config.toml");
    writeFileSync(configPath, `
[telegram]
bot_token = "telegram-token"
allowed_chat_ids = [-1001234567890]
alert_chat_id = -1001234567890
[sub2api]
admin_api_key = "admin-key"
[monitor]
group_id = ""
[database]
path = "./state.sqlite"
`);
    try {
      expect(loadConfig(configPath).databasePath).toBe(join(directory, "state.sqlite"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts HTTP, HTTPS, SOCKS5, and SOCKS5H proxy URLs", () => {
    for (const protocol of ["http", "https", "socks5", "socks5h"]) {
      const config = parseConfig({
        ...validConfig,
        proxy: { url: `${protocol}://proxy.example:1080`, scope: ["openai"] },
      });
      expect(config.proxyUrl).toBe(`${protocol}://proxy.example:1080`);
    }
  });

  test("rejects missing credentials, invalid chat IDs, and invalid scoped proxy settings", () => {
    expect(() => parseConfig({ ...validConfig, sub2api: {} })).toThrow("sub2api.admin_api_key is required");
    expect(() => parseConfig({
      ...validConfig,
      proxy: { url: "ftp://proxy.example:21", scope: ["openai"] },
    })).toThrow("proxy.url must use http://, https://, socks5://, or socks5h://");
    expect(() => parseConfig({
      ...validConfig,
      proxy: { url: "not-a-url", scope: ["openai"] },
    })).toThrow("proxy.url must be a valid URL");
    expect(() => parseConfig({
      ...validConfig,
      proxy: { url: "http://proxy.example:8080", scope: "openai" },
    })).toThrow("proxy.scope must be an array");
    expect(() => parseConfig({
      ...validConfig,
      proxy: { url: "http://proxy.example:8080", scope: ["database"] },
    })).toThrow("proxy.scope only supports sub2api, telegram, openai, other");
    expect(() => parseConfig({
      ...validConfig,
      proxy: { url: "", scope: ["openai"] },
    })).toThrow("proxy.url is required when proxy.scope is not empty");
    expect(() => parseConfig({
      ...validConfig,
      telegram: { ...validConfig.telegram, allowed_chat_ids: ["-1001234567890"] },
    })).toThrow("telegram.allowed_chat_ids must be a Telegram chat ID");
  });

  test("selects the default or explicit config path", () => {
    expect(configPathFromArgs([])).toBe("./config.toml");
    expect(configPathFromArgs(["--config", "/etc/s2a-maid.toml"])).toBe("/etc/s2a-maid.toml");
    expect(configPathFromArgs(["--config=custom.toml"])).toBe("custom.toml");
    expect(() => configPathFromArgs(["--config"])).toThrow("--config requires a TOML file path");
  });
});
