import { describe, expect, test } from "bun:test";
import { configPathFromArgs, parseConfig } from "../src/config";

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
    jwt: "ignored-jwt",
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
      sub2ApiAuth: { type: "api-key", value: "admin-key" },
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
      sub2api: { jwt: "jwt-token" },
      monitor: { group_id: "group-1" },
    });
    expect(config.telegramApiBaseUrl).toBe("https://api.telegram.org");
    expect(config.sub2ApiBaseUrl).toBe("http://127.0.0.1:8080");
    expect(config.sub2ApiAuth).toEqual({ type: "bearer", value: "jwt-token" });
    expect(config.usageCheckIntervalSeconds).toBe(300);
    expect(config.lowQuotaPercent).toBe(10);
    expect(config.databasePath).toBe("./s2a-maid.sqlite");
  });

  test("rejects missing credentials and invalid chat IDs", () => {
    expect(() => parseConfig({ ...validConfig, sub2api: {} })).toThrow("sub2api.admin_api_key or sub2api.jwt is required");
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
