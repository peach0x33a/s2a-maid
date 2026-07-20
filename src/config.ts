import { readFileSync } from "node:fs";
import type { JsonObject } from "./types";

export interface Config {
  telegramBotToken: string;
  telegramApiBaseUrl: string;
  telegramApiHeaders: HeadersInit;
  allowedChatIds: Set<number>;
  alertChatId: number;
  sub2ApiBaseUrl: string;
  sub2ApiAdminApiKey: string;
  monitorGroupId: string | null;
  usageCheckIntervalSeconds: number;
  lowQuotaPercent: number;
  databasePath: string;
}

type UnknownRecord = Record<string, unknown>;

export function configPathFromArgs(args: string[] = Bun.argv.slice(2)): string {
  const inline = args.find((arg) => arg.startsWith("--config="));
  if (inline) {
    const path = inline.slice("--config=".length).trim();
    if (!path) throw new Error("--config requires a TOML file path");
    return path;
  }

  const index = args.indexOf("--config");
  if (index === -1) return "./config.toml";
  const path = args[index + 1]?.trim();
  if (!path || path.startsWith("--")) throw new Error("--config requires a TOML file path");
  return path;
}

export function loadConfig(path: string = configPathFromArgs()): Config {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read TOML config at ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw new Error(`Invalid TOML config at ${path}`, { cause: error });
  }
  return parseConfig(parsed);
}

export function parseConfig(value: unknown): Config {
  const root = requireRecord("config", value);
  const telegram = requireRecord("telegram", root.telegram);
  const sub2api = requireRecord("sub2api", root.sub2api);
  const monitor = requireRecord("monitor", root.monitor);
  const database = optionalRecord("database", root.database);
  const headers = optionalRecord("telegram.api_headers", telegram.api_headers);

  const allowedChatIds = requireArray("telegram.allowed_chat_ids", telegram.allowed_chat_ids)
    .map((id) => requireChatId("telegram.allowed_chat_ids", id));
  if (allowedChatIds.length === 0) {
    throw new Error("telegram.allowed_chat_ids must contain at least one group ID");
  }

  const apiKey = requireString("sub2api.admin_api_key", sub2api.admin_api_key);

  const threshold = optionalPositiveNumber("monitor.low_quota_percent", monitor.low_quota_percent, 10);
  if (threshold > 100) throw new Error("monitor.low_quota_percent must not exceed 100");

  return {
    telegramBotToken: requireString("telegram.bot_token", telegram.bot_token),
    telegramApiBaseUrl: optionalString("telegram.api_base_url", telegram.api_base_url, "https://api.telegram.org").replace(/\/$/, ""),
    telegramApiHeaders: stringRecord("telegram.api_headers", headers),
    allowedChatIds: new Set(allowedChatIds),
    alertChatId: requireChatId("telegram.alert_chat_id", telegram.alert_chat_id),
    sub2ApiBaseUrl: optionalString("sub2api.base_url", sub2api.base_url, "http://127.0.0.1:8080").replace(/\/$/, ""),
    sub2ApiAdminApiKey: apiKey,
    monitorGroupId: optionalString("monitor.group_id", monitor.group_id) || null,
    usageCheckIntervalSeconds: optionalPositiveNumber("monitor.interval_seconds", monitor.interval_seconds, 300),
    lowQuotaPercent: threshold,
    databasePath: optionalString("database.path", database.path, "./s2a-maid.sqlite"),
  };
}

function requireRecord(name: string, value: unknown): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} must be a TOML table`);
  return value;
}

function optionalRecord(name: string, value: unknown): UnknownRecord {
  if (value === undefined) return {};
  return requireRecord(name, value);
}

function requireArray(name: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(name: string, value: unknown, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.trim() || fallback;
}

function requireChatId(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a Telegram chat ID`);
  }
  return value;
}

function optionalPositiveNumber(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function stringRecord(name: string, value: UnknownRecord): Record<string, string> {
  if (!Object.values(value).every((item) => typeof item === "string")) {
    throw new Error(`${name} values must be strings`);
  }
  return value as Record<string, string>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
