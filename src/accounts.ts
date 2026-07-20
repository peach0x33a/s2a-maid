import { isJsonObject } from "./config";
import { collectSessionRecords, convertSessionPayload, detectSessionFormat, type SessionFormat } from "./session-converter";
import type { Account, JsonObject, JsonValue } from "./types";

export class AccountInputError extends Error {}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepMerge<T extends JsonValue>(defaults: T, overrides: JsonValue): T {
  if (isJsonObject(defaults) && isJsonObject(overrides)) {
    const merged: JsonObject = clone(defaults);
    for (const [key, value] of Object.entries(overrides)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : clone(value);
    }
    return merged as T;
  }
  return clone(overrides) as T;
}

export interface ParsedAccountPayload {
  accounts: JsonObject[];
  conversions: Partial<Record<SessionFormat, number>>;
  nativeAccounts: number;
}

export function parseAccountPayloadDetailed(raw: string, sourceName?: string): ParsedAccountPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountInputError("这个文件不是有效的 JSON，检查一下再发。 ");
  }

  const rootItems = Array.isArray(parsed)
    ? parsed
    : isJsonObject(parsed) && "accounts" in parsed
      ? Array.isArray(parsed.accounts) ? parsed.accounts : (() => { throw new AccountInputError("accounts 应该是数组。"); })()
      : [parsed];
  if (rootItems.length === 0) throw new AccountInputError("文件里没有账户。");
  if (!rootItems.every(isJsonObject)) throw new AccountInputError("每条账户都应该是 JSON 对象。");

  const accounts: JsonObject[] = [];
  const conversions: Partial<Record<SessionFormat, number>> = {};
  let nativeAccounts = 0;
  for (const item of rootItems) {
    if (isSub2ApiAccount(item)) {
      accounts.push(item);
      nativeAccounts += 1;
      continue;
    }
    const records = collectSessionRecords(item);
    if (records.length === 0) {
      accounts.push(item);
      continue;
    }
    for (const record of records) {
      const format = detectSessionFormat(record);
      conversions[format] = (conversions[format] ?? 0) + 1;
    }
    accounts.push(...convertSessionPayload(item, sourceName));
  }
  return { accounts, conversions, nativeAccounts };
}

export function parseAccountPayload(raw: string, sourceName?: string): JsonObject[] {
  return parseAccountPayloadDetailed(raw, sourceName).accounts;
}

function isSub2ApiAccount(value: JsonObject): boolean {
  return typeof value.platform === "string" && typeof value.type === "string" && isJsonObject(value.credentials);
}

export function validateAccount(value: JsonObject): asserts value is Account {
  const stringFields = ["name", "platform", "type"] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new AccountInputError(`账户缺少有效的 ${field}`);
    }
  }
  if (!isJsonObject(value.credentials)) {
    throw new AccountInputError("账户缺少 credentials 对象");
  }
}

const DYNAMIC_EXTRA_FIELDS = /(^|_)(usage|used|utilization|reset|resets|remaining|quota|window)(_|$)/i;

/** Extract only reusable account defaults; never persist credentials or live usage snapshots. */
export function extractAccountTemplate(account: JsonObject): JsonObject {
  const template: JsonObject = {};
  for (const [key, value] of Object.entries(account)) {
    if (["name", "credentials", "id", "group_id", "group_ids", "groups", "account_groups", "proxy_key", "proxy_id"].includes(key)) continue;
    if (key === "extra" && isJsonObject(value)) {
      const extra: JsonObject = {};
      for (const [extraKey, extraValue] of Object.entries(value)) {
        if (!DYNAMIC_EXTRA_FIELDS.test(extraKey)) extra[extraKey] = clone(extraValue);
      }
      if (Object.keys(extra).length > 0) template.extra = extra;
      continue;
    }
    template[key] = clone(value);
  }

  if (isJsonObject(account.credentials) && isJsonObject(account.credentials.model_mapping)) {
    template.credentials = { model_mapping: clone(account.credentials.model_mapping) };
  }
  return template;
}

export function mergeAndValidateAccount(template: JsonObject, account: JsonObject): Account {
  const merged = deepMerge(template, account);
  if (!isJsonObject(merged)) throw new AccountInputError("账户必须是 JSON 对象");
  validateAccount(merged);
  return merged;
}
