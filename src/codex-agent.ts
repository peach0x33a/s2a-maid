import sodium from "libsodium-wrappers";
import { mergeAndValidateAccount } from "./accounts";
import { createProxyFetch } from "./proxy";
import type { Account, JsonObject } from "./types";

const AUTH_BASE_URL = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

type UnknownRecord = Record<string, unknown>;

export class CodexAgentInputError extends Error {}

export interface AgentIdentityRecord {
  agent_runtime_id: string;
  agent_private_key: string;
  account_id: string;
  chatgpt_user_id: string;
  email: string | null;
  plan_type: string;
  chatgpt_account_is_fedramp: boolean;
  task_id: string;
}

export interface AgentIdentityAuthJson {
  auth_mode: "agentIdentity";
  OPENAI_API_KEY: null;
  agent_identity: AgentIdentityRecord;
}

export interface CodexAgentOAuthInput {
  kind: "oauth";
  source: string;
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
}

export interface ExistingCodexAgentInput {
  kind: "agent-identity";
  source: string;
  authJson: AgentIdentityAuthJson;
}

export type CodexAgentInput = CodexAgentOAuthInput | ExistingCodexAgentInput;

export interface CodexAgentConversion {
  source: string;
  authJson: AgentIdentityAuthJson;
}

export const createCodexAgentFetch = createProxyFetch;

export function agentIdentityToSub2ApiAccount(authJson: AgentIdentityAuthJson, fallbackName = "Codex Agent Identity"): Account {
  const identity = authJson.agent_identity;
  return {
    name: identity.email || fallbackName,
    platform: "openai",
    type: "oauth",
    credentials: {
      auth_mode: "agentIdentity",
      agent_runtime_id: identity.agent_runtime_id,
      agent_private_key: identity.agent_private_key,
      chatgpt_account_id: identity.account_id,
      chatgpt_user_id: identity.chatgpt_user_id,
      email: identity.email,
      plan_type: identity.plan_type,
      chatgpt_account_is_fedramp: identity.chatgpt_account_is_fedramp,
      task_id: identity.task_id,
    },
  };
}

export function buildFinalCodexAgentAccount(
  template: JsonObject,
  authJson: AgentIdentityAuthJson,
  selectedGroupId: string,
  fallbackName = "Codex Agent Identity",
): Account {
  const account = mergeAndValidateAccount(template, agentIdentityToSub2ApiAccount(authJson, fallbackName));
  const numericGroupId = Number(selectedGroupId);
  const normalizedGroupId = Number.isNaN(numericGroupId) ? selectedGroupId : numericGroupId;
  const existingGroupIds = Array.isArray(account.group_ids) ? account.group_ids : [];
  account.group_ids = [...existingGroupIds, normalizedGroupId].filter((id, index, all) =>
    all.findIndex((candidate) => String(candidate) === String(id)) === index
  );
  return account;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  const parsed = firstString(value);
  if (!parsed) throw new CodexAgentInputError(`Agent Identity 缺少 ${field}`);
  return parsed;
}

function tokenFields(record: UnknownRecord): Pick<CodexAgentOAuthInput, "accessToken" | "idToken" | "refreshToken"> | null {
  const tokens = asRecord(record.tokens);
  const token = asRecord(record.token);
  const credentials = asRecord(record.credentials);
  const accessToken = firstString(
    record.accessToken, record.access_token,
    tokens.accessToken, tokens.access_token,
    token.accessToken, token.access_token,
    credentials.accessToken, credentials.access_token,
  );
  if (!accessToken) return null;
  return {
    accessToken,
    idToken: firstString(
      record.idToken, record.id_token,
      tokens.idToken, tokens.id_token,
      token.idToken, token.id_token,
      credentials.idToken, credentials.id_token,
    ),
    refreshToken: firstString(
      record.refreshToken, record.refresh_token,
      tokens.refreshToken, tokens.refresh_token,
      token.refreshToken, token.refresh_token,
      credentials.refreshToken, credentials.refresh_token,
    ),
  };
}

function inputSource(record: UnknownRecord): string {
  if (typeof record.platform === "string" && isRecord(record.credentials)) return "S2A 账户";
  if (record.auth_mode === "chatgpt" || isRecord(record.tokens)) return "Codex OAuth auth.json";
  return "ChatGPT Web Session";
}

export function buildAgentIdentityAuthJson(identity: AgentIdentityRecord): AgentIdentityAuthJson {
  return {
    auth_mode: "agentIdentity",
    OPENAI_API_KEY: null,
    agent_identity: identity,
  };
}

function normalizeExistingIdentity(record: UnknownRecord): AgentIdentityAuthJson {
  const nested = asRecord(record.agent_identity);
  const identity = Object.keys(nested).length > 0 ? nested : record;
  if (Object.keys(identity).length === 0) throw new CodexAgentInputError("Agent Identity JSON 缺少 agent_identity");
  return buildAgentIdentityAuthJson({
    agent_runtime_id: requiredString(identity.agent_runtime_id, "agent_runtime_id"),
    agent_private_key: requiredString(identity.agent_private_key, "agent_private_key"),
    account_id: requiredString(firstString(identity.account_id, identity.chatgpt_account_id), "account_id/chatgpt_account_id"),
    chatgpt_user_id: requiredString(firstString(identity.chatgpt_user_id, identity.user_id), "chatgpt_user_id"),
    email: typeof identity.email === "string" ? identity.email : null,
    plan_type: firstString(identity.plan_type) ?? "unknown",
    chatgpt_account_is_fedramp: identity.chatgpt_account_is_fedramp === true,
    task_id: requiredString(identity.task_id, "task_id"),
  });
}

export function parseCodexAgentPayload(raw: string): CodexAgentInput[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CodexAgentInputError("Codex Agent 输入不是有效 JSON");
  }

  const inputs: CodexAgentInput[] = [];
  const visited = new Set<unknown>();
  const seenCredentials = new Set<string>();

  const visit = (item: unknown): void => {
    if ((!isRecord(item) && !Array.isArray(item)) || visited.has(item)) return;
    visited.add(item);
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item.auth_mode === "agentIdentity" || item.agent_identity !== undefined) {
      const authJson = normalizeExistingIdentity(item);
      const key = `identity:${authJson.agent_identity.agent_runtime_id}`;
      if (!seenCredentials.has(key)) {
        seenCredentials.add(key);
        inputs.push({ kind: "agent-identity", source: "Codex Agent Identity auth.json", authJson });
      }
      return;
    }
    const fields = tokenFields(item);
    if (fields) {
      const key = `oauth:${fields.accessToken}`;
      if (!seenCredentials.has(key)) {
        seenCredentials.add(key);
        inputs.push({ kind: "oauth", source: inputSource(item), ...fields });
      }
      return;
    }
    Object.values(item).forEach(visit);
  };

  visit(value);
  if (inputs.length === 0) {
    throw new CodexAgentInputError("未找到可转换的 accessToken、Codex OAuth tokens、S2A credentials 或 Agent Identity");
  }
  return inputs;
}

function decodeJwt(token: string): UnknownRecord {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new CodexAgentInputError("认证 token 不是有效 JWT");
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new CodexAgentInputError("认证 token 的 JWT payload 无效");
  }
}

function accessTokenExpiresSoon(token: string, nowSeconds = Date.now() / 1000): boolean {
  try {
    const claims = decodeJwt(token);
    return typeof claims.exp !== "number" || claims.exp <= nowSeconds + 60;
  } catch {
    return false;
  }
}

interface IdentityClaims {
  accountId: string;
  userId: string;
  email: string | null;
  planType: string;
  isFedramp: boolean;
}

function extractIdentityClaims(...tokens: Array<string | undefined>): IdentityClaims {
  for (const token of tokens) {
    if (!token) continue;
    let claims: UnknownRecord;
    try {
      claims = decodeJwt(token);
    } catch {
      continue;
    }
    const auth = asRecord(claims["https://api.openai.com/auth"]);
    const profile = asRecord(claims["https://api.openai.com/profile"]);
    const accountId = firstString(auth.chatgpt_account_id);
    const userId = firstString(auth.chatgpt_user_id, auth.user_id);
    if (!accountId || !userId) continue;
    return {
      accountId,
      userId,
      email: firstString(claims.email, profile.email) ?? null,
      planType: firstString(auth.chatgpt_plan_type) ?? "unknown",
      isFedramp: auth.chatgpt_account_is_fedramp === true,
    };
  }
  throw new CodexAgentInputError("认证 JSON 缺少 ChatGPT account/user identity claims");
}

async function responseJson(response: Response, operation: string): Promise<UnknownRecord> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw new CodexAgentInputError(`${operation}失败（HTTP ${response.status}）`);
  if (!isRecord(payload)) throw new CodexAgentInputError(`${operation}返回无效 JSON`);
  return payload;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(arrays.reduce((total, item) => total + item.length, 0));
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function sshPublicKey(publicKey: Uint8Array): string {
  const algorithm = new TextEncoder().encode("ssh-ed25519");
  const blob = concatBytes(uint32(algorithm.length), algorithm, uint32(publicKey.length), publicKey);
  return `ssh-ed25519 ${sodium.to_base64(blob, sodium.base64_variants.ORIGINAL)}`;
}

function pkcs8PrivateKey(privateKey: Uint8Array): string {
  return sodium.to_base64(concatBytes(PKCS8_PREFIX, privateKey.slice(0, 32)), sodium.base64_variants.ORIGINAL);
}

function registrationSignature(privateKey: Uint8Array, runtimeId: string, timestamp: string): string {
  const signature = sodium.crypto_sign_detached(new TextEncoder().encode(`${runtimeId}:${timestamp}`), privateKey);
  return sodium.to_base64(signature, sodium.base64_variants.ORIGINAL);
}

function decryptTaskId(encryptedTaskId: string, publicKey: Uint8Array, privateKey: Uint8Array): string {
  const curvePublic = sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey);
  const curvePrivate = sodium.crypto_sign_ed25519_sk_to_curve25519(privateKey);
  const ciphertext = sodium.from_base64(encryptedTaskId, sodium.base64_variants.ORIGINAL);
  const decrypted = sodium.crypto_box_seal_open(ciphertext, curvePublic, curvePrivate);
  if (!decrypted) throw new CodexAgentInputError("无法解密 Agent Identity task_id");
  const taskId = new TextDecoder().decode(decrypted);
  if (!taskId) throw new CodexAgentInputError("解密后的 Agent Identity task_id 为空");
  return taskId;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function refreshOAuth(refreshToken: string, fetcher: typeof fetch): Promise<{ accessToken: string; idToken?: string }> {
  const response = await fetcher(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const payload = await responseJson(response, "刷新 OAuth");
  return {
    accessToken: requiredString(payload.access_token, "refresh access_token"),
    idToken: firstString(payload.id_token),
  };
}

export async function convertCodexAgentInput(input: CodexAgentInput, fetcher: typeof fetch = fetch): Promise<CodexAgentConversion> {
  if (input.kind === "agent-identity") return { source: input.source, authJson: input.authJson };

  await sodium.ready;
  let accessToken = input.accessToken;
  let idToken = input.idToken;
  if (accessTokenExpiresSoon(accessToken)) {
    if (!input.refreshToken) throw new CodexAgentInputError("OAuth access token 已过期，且没有 refresh_token");
    const refreshed = await refreshOAuth(input.refreshToken, fetcher);
    accessToken = refreshed.accessToken;
    idToken = refreshed.idToken ?? idToken;
  }
  const claims = extractIdentityClaims(idToken, accessToken);
  const keyPair = sodium.crypto_sign_keypair();
  const registerHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "s2a-maid-codex-agent/1",
  };
  if (claims.isFedramp) registerHeaders["X-OpenAI-Fedramp"] = "true";
  const runtimeResponse = await fetcher(`${AUTH_BASE_URL}/api/accounts/v1/agent/register`, {
    method: "POST",
    headers: registerHeaders,
    body: JSON.stringify({
      abom: { agent_version: "s2a-maid-1", agent_harness_id: "codex-cli", running_location: "telegram-bot" },
      agent_public_key: sshPublicKey(keyPair.publicKey),
      capabilities: ["responsesapi"],
      ttl: null,
    }),
  });
  const runtime = await responseJson(runtimeResponse, "注册 Agent Identity");
  const runtimeId = requiredString(runtime.agent_runtime_id, "agent_runtime_id");
  const timestamp = utcTimestamp();
  const taskResponse = await fetcher(`${AUTH_BASE_URL}/api/accounts/v1/agent/${encodeURIComponent(runtimeId)}/task/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "s2a-maid-codex-agent/1" },
    body: JSON.stringify({ timestamp, signature: registrationSignature(keyPair.privateKey, runtimeId, timestamp) }),
  });
  const task = await responseJson(taskResponse, "注册 Agent Identity task");
  const taskId = firstString(task.task_id, task.taskId) ?? (() => {
    const encrypted = firstString(task.encrypted_task_id, task.encryptedTaskId);
    if (!encrypted) throw new CodexAgentInputError("task 注册响应缺少 task_id");
    return decryptTaskId(encrypted, keyPair.publicKey, keyPair.privateKey);
  })();

  return {
    source: input.source,
    authJson: buildAgentIdentityAuthJson({
      agent_runtime_id: runtimeId,
      agent_private_key: pkcs8PrivateKey(keyPair.privateKey),
      account_id: claims.accountId,
      chatgpt_user_id: claims.userId,
      email: claims.email,
      plan_type: claims.planType,
      chatgpt_account_is_fedramp: claims.isFedramp,
      task_id: taskId,
    }),
  };
}
