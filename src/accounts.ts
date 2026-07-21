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
const ACCOUNT_SPECIFIC_EXTRA_FIELDS = new Set(["email", "name", "source", "last_refresh"]);

/** Extract only reusable account defaults; never persist account identity, credentials, expiry, or live usage snapshots. */
export function extractAccountTemplate(account: JsonObject): JsonObject {
  const template: JsonObject = {};
  for (const [key, value] of Object.entries(account)) {
    if ([
      "name", "credentials", "id", "group", "group_id", "group_ids", "groups", "account_groups",
      "proxy", "proxy_key", "proxy_id", "expires_at",
    ].includes(key)) continue;
    if (key === "extra" && isJsonObject(value)) {
      const extra: JsonObject = {};
      for (const [extraKey, extraValue] of Object.entries(value)) {
        if (!DYNAMIC_EXTRA_FIELDS.test(extraKey) && !ACCOUNT_SPECIFIC_EXTRA_FIELDS.has(extraKey)) {
          extra[extraKey] = clone(extraValue);
        }
      }
      if (Object.keys(extra).length > 0) template.extra = extra;
      continue;
    }
    template[key] = clone(value);
  }

  const groupIds = extractGroupIds(account);
  if (groupIds.length > 0) template.group_ids = groupIds;
  const proxyId = extractRelationId(account.proxy_id) ?? extractRelationId(account.proxy);
  if (proxyId !== undefined) template.proxy_id = proxyId;

  if (isJsonObject(account.credentials) && isJsonObject(account.credentials.model_mapping)) {
    template.credentials = { model_mapping: clone(account.credentials.model_mapping) };
  }
  return template;
}

export function mergeAndValidateAccount(template: JsonObject, account: JsonObject): Account {
  const templatePlatform = template.platform;
  if (typeof templatePlatform === "string" && templatePlatform.trim() !== "") {
    if (typeof account.platform !== "string" || account.platform.trim() === "") {
      throw new AccountInputError(`账户缺少有效的 platform；模板平台为 ${templatePlatform}`);
    }
    if (account.platform !== templatePlatform) {
      throw new AccountInputError(`账户平台 ${account.platform} 与模板平台 ${templatePlatform} 不一致，已拒绝导入`);
    }
  }
  const merged = deepMerge(template, account);
  if (!isJsonObject(merged)) throw new AccountInputError("账户必须是 JSON 对象");
  validateAccount(merged);
  return merged;
}

function extractGroupIds(account: JsonObject): JsonValue[] {
  const candidates: JsonValue[] = [];
  if (Array.isArray(account.group_ids)) candidates.push(...account.group_ids);
  else if (account.group_id !== undefined) candidates.push(account.group_id);
  const singleGroupId = extractGroupRelationId(account.group);
  if (singleGroupId !== undefined) candidates.push(singleGroupId);
  for (const key of ["groups", "account_groups"] as const) {
    const relations = account[key];
    if (!Array.isArray(relations)) continue;
    for (const relation of relations) {
      const id = extractGroupRelationId(relation);
      if (id !== undefined) candidates.push(id);
    }
  }
  return candidates.filter((value, index) =>
    (typeof value === "string" || typeof value === "number") &&
    candidates.findIndex((candidate) => String(candidate) === String(value)) === index
  );
}

function extractRelationId(value: JsonValue | undefined): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (isJsonObject(value) && (typeof value.id === "string" || typeof value.id === "number")) return value.id;
  return undefined;
}

function extractGroupRelationId(value: JsonValue | undefined): string | number | undefined {
  const id = extractRelationId(value);
  if (id !== undefined) return id;
  if (!isJsonObject(value)) return undefined;
  if (typeof value.group_id === "string" || typeof value.group_id === "number") return value.group_id;
  return extractRelationId(value.group);
}
