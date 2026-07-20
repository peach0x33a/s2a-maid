import type { Account, JsonObject, JsonValue } from "./types";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function parseJwtPayload(token: string | undefined): UnknownRecord {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

function openAiSection(payload: UnknownRecord, name: "auth" | "profile"): UnknownRecord {
  return asRecord(payload[`https://api.openai.com/${name}`]);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1e11 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function unixSeconds(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function timestampFromUnixSeconds(value: unknown): string | undefined {
  const seconds = unixSeconds(value);
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

function expiresIn(expiresAt: string | undefined, now: Date): number | undefined {
  if (!expiresAt) return undefined;
  const milliseconds = new Date(expiresAt).getTime();
  return Number.isNaN(milliseconds) ? undefined : Math.max(0, Math.floor((milliseconds - now.getTime()) / 1000));
}

function emailKey(email: string | undefined): string | undefined {
  return email?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || undefined;
}

function stripUnavailable(value: unknown): JsonValue | undefined {
  if (Array.isArray(value)) {
    return value.map(stripUnavailable).filter((item): item is JsonValue => item !== undefined);
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = stripUnavailable(item);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function accessTokenFrom(value: UnknownRecord): string | undefined {
  const tokens = asRecord(value.tokens);
  const token = asRecord(value.token);
  const credentials = asRecord(value.credentials);
  return firstNonEmpty(
    value.accessToken, value.access_token,
    tokens.accessToken, tokens.access_token,
    token.accessToken, token.access_token,
    credentials.accessToken, credentials.access_token,
  );
}

function refreshTokenFrom(value: UnknownRecord): string | undefined {
  const tokens = asRecord(value.tokens);
  const token = asRecord(value.token);
  const credentials = asRecord(value.credentials);
  return firstNonEmpty(
    value.refreshToken, value.refresh_token,
    tokens.refreshToken, tokens.refresh_token,
    token.refreshToken, token.refresh_token,
    credentials.refreshToken, credentials.refresh_token,
  );
}

function idTokenFrom(value: UnknownRecord): string | undefined {
  const tokens = asRecord(value.tokens);
  const token = asRecord(value.token);
  const credentials = asRecord(value.credentials);
  return firstNonEmpty(
    value.idToken, value.id_token,
    tokens.idToken, tokens.id_token,
    token.idToken, token.id_token,
    credentials.idToken, credentials.id_token,
  );
}

function sessionTokenFrom(value: UnknownRecord): string | undefined {
  return firstNonEmpty(value.sessionToken, value.session_token, asRecord(value.tokens).session_token);
}

function hasIdentity(value: UnknownRecord): boolean {
  const tokens = asRecord(value.tokens);
  const meta = asRecord(value.meta);
  const providerSpecificData = asRecord(value.providerSpecificData);
  return isRecord(value.user) || Boolean(firstNonEmpty(
    value.email, value.name, value.label, meta.label,
    tokens.accountId, tokens.account_id, tokens.chatgptAccountId, tokens.chatgpt_account_id,
    providerSpecificData.chatgptAccountId, providerSpecificData.chatgpt_account_id,
    value.id,
  ));
}

function isSub2ApiAccount(value: UnknownRecord): boolean {
  return typeof value.platform === "string" && typeof value.type === "string" && isRecord(value.credentials);
}

export function collectSessionRecords(value: unknown): UnknownRecord[] {
  const found: UnknownRecord[] = [];
  const visited = new Set<unknown>();

  const visit = (item: unknown): void => {
    if (!isRecord(item) && !Array.isArray(item)) return;
    if (visited.has(item)) return;
    visited.add(item);
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (isSub2ApiAccount(item)) return;
    if (accessTokenFrom(item) && hasIdentity(item)) {
      found.push(item);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (key !== "accessToken" && key !== "access_token" && key !== "sessionToken") visit(child);
    }
  };

  visit(value);
  return found;
}

export function convertSessionToSub2Api(record: UnknownRecord, sourceName = "ChatGPT Session", now = new Date()): Account {
  const tokens = asRecord(record.tokens);
  const token = asRecord(record.token);
  const credentials = asRecord(record.credentials);
  const user = asRecord(record.user);
  const account = asRecord(record.account);
  const meta = asRecord(record.meta);
  const providerSpecificData = asRecord(record.providerSpecificData);

  const accessToken = accessTokenFrom(record);
  if (!accessToken) throw new Error("session 缺少 accessToken");

  const refreshToken = refreshTokenFrom(record);
  const idToken = idTokenFrom(record);
  const sessionToken = sessionTokenFrom(record);
  const payload = parseJwtPayload(accessToken);
  const idPayload = parseJwtPayload(idToken);
  const auth = openAiSection(payload, "auth");
  const idAuth = openAiSection(idPayload, "auth");
  const profile = openAiSection(payload, "profile");
  const hasRefreshToken = Boolean(refreshToken);
  const accessTokenExpiresAt = hasRefreshToken ? undefined : unixSeconds(payload.exp);
  const expiresAt = hasRefreshToken ? undefined : firstNonEmpty(
    timestampFromUnixSeconds(payload.exp),
    normalizeTimestamp(record.expires), normalizeTimestamp(record.expiresAt),
    normalizeTimestamp(record.expired), normalizeTimestamp(record.expires_at),
  );
  const email = firstNonEmpty(
    user.email, record.email, meta.label, record.label, credentials.email,
    providerSpecificData.email, profile.email, idPayload.email, payload.email,
  );
  const accountId = firstNonEmpty(
    account.id, record.account_id,
    tokens.accountId, tokens.account_id, record.chatgptAccountId, record.chatgpt_account_id,
    meta.chatgptAccountId, meta.chatgpt_account_id, tokens.chatgptAccountId, tokens.chatgpt_account_id,
    providerSpecificData.chatgptAccountId, providerSpecificData.chatgpt_account_id,
    credentials.chatgpt_account_id, auth.chatgpt_account_id, idAuth.chatgpt_account_id,
    record.provider === "codex" ? record.id : undefined,
  );
  const userId = firstNonEmpty(
    user.id, record.user_id, record.chatgptUserId,
    providerSpecificData.chatgptUserId, providerSpecificData.chatgpt_user_id,
    auth.chatgpt_user_id, auth.user_id, idAuth.chatgpt_user_id, idAuth.user_id,
  );
  const planType = firstNonEmpty(
    account.planType, account.plan_type, record.planType, record.plan_type,
    providerSpecificData.chatgptPlanType, providerSpecificData.chatgpt_plan_type,
    credentials.plan_type, auth.chatgpt_plan_type, idAuth.chatgpt_plan_type,
  );
  const name = firstNonEmpty(email, sourceName, "ChatGPT Account")!;
  const source = detectSource(record);

  return stripUnavailable({
    name,
    platform: "openai",
    type: "oauth",
    expires_at: accessTokenExpiresAt,
    auto_pause_on_expired: accessTokenExpiresAt ? true : undefined,
    concurrency: 10,
    priority: 1,
    credentials: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      session_token: sessionToken,
      account_id: accountId,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      workspace_id: firstNonEmpty(record.workspaceId, record.workspace_id, meta.workspaceId, meta.workspace_id),
      email,
      expires_at: expiresAt,
      expires_in: expiresIn(expiresAt, now),
      plan_type: planType,
    },
    extra: {
      email,
      email_key: emailKey(email),
      name,
      auth_provider: firstNonEmpty(record.authProvider, record.auth_provider),
      source,
      last_refresh: now.toISOString(),
    },
  }) as Account;
}

export type SessionFormat = "ChatGPT Web Session" | "9router OAuth" | "Codex auth.json" | "AxonHub auth.json" | "Codex-Manager JSON";

export function detectSessionFormat(record: UnknownRecord): SessionFormat {
  const provider = firstNonEmpty(record.provider)?.toLowerCase();
  const authType = firstNonEmpty(record.authType, record.auth_type)?.toLowerCase();
  const meta = asRecord(record.meta);
  if (provider === "codex" && authType === "oauth") return "9router OAuth";
  if (isRecord(record.providerSpecificData)) return "9router OAuth";
  if (isRecord(record.meta) && (meta.workspace_id !== undefined || meta.chatgpt_account_id !== undefined)) return "Codex-Manager JSON";
  if (record.auth_mode === "chatgpt" && isRecord(record.tokens)) {
    return firstNonEmpty(record.axonhub_note, record.axonhub_refresh_token_placeholder) ? "AxonHub auth.json" : "Codex auth.json";
  }
  if (isRecord(record.tokens) && record.last_refresh !== undefined) return "Codex auth.json";
  return "ChatGPT Web Session";
}

function detectSource(record: UnknownRecord): string {
  const sources: Record<SessionFormat, string> = {
    "ChatGPT Web Session": "chatgpt_web_session",
    "9router OAuth": "9router",
    "Codex auth.json": "codex",
    "AxonHub auth.json": "axonhub",
    "Codex-Manager JSON": "codex_manager",
  };
  return sources[detectSessionFormat(record)];
}

export function convertSessionPayload(value: unknown, sourceName?: string, now = new Date()): Account[] {
  return collectSessionRecords(value).map((record) => convertSessionToSub2Api(record, sourceName, now));
}
