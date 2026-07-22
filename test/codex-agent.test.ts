import { expect, test } from "bun:test";
import {
  buildAgentIdentityAuthJson,
  buildFinalCodexAgentAccount,
  convertCodexAgentInput,
  parseCodexAgentPayload,
} from "../src/codex-agent";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const identity = {
  agent_runtime_id: "agent-runtime-1",
  agent_private_key: "private-key",
  account_id: "account-1",
  chatgpt_user_id: "user-1",
  email: "person@example.com",
  plan_type: "plus",
  chatgpt_account_is_fedramp: false,
  task_id: "task-1",
};

test("normalizes existing Agent Identity into the final minimal artifact", () => {
  const [input] = parseCodexAgentPayload(JSON.stringify({
    auth_mode: "agentIdentity",
    OPENAI_API_KEY: null,
    agent_identity: identity,
    tokens: { access_token: "must-not-survive" },
  }));
  expect(input).toEqual({
    kind: "agent-identity",
    source: "Codex Agent Identity auth.json",
    authJson: buildAgentIdentityAuthJson(identity),
  });
  expect(JSON.stringify(input)).not.toContain("must-not-survive");
});

test("normalizes Agent Identity credentials from an S2A export account", () => {
  const [input] = parseCodexAgentPayload(JSON.stringify({
    exported_at: "2026-01-01T00:00:00Z",
    proxies: [{ proxy_key: "portable-proxy-key" }],
    accounts: [{
      name: "exported-account",
      platform: "openai",
      type: "oauth",
      credentials: {
        auth_mode: "agentIdentity",
        agent_runtime_id: "agent-runtime-2",
        agent_private_key: "private-key-2",
        chatgpt_account_id: "account-2",
        chatgpt_user_id: "user-2",
        email: "exported@example.com",
        plan_type: "plus",
        task_id: "task-2",
        model_mapping: { old: "old" },
      },
      proxy_key: "portable-proxy-key",
    }],
  }));
  expect(input).toMatchObject({
    kind: "agent-identity",
    authJson: {
      auth_mode: "agentIdentity",
      agent_identity: {
        agent_runtime_id: "agent-runtime-2",
        account_id: "account-2",
        chatgpt_user_id: "user-2",
        task_id: "task-2",
      },
    },
  });
  expect(JSON.stringify(input)).not.toContain("portable-proxy-key");
  expect(JSON.stringify(input)).not.toContain("model_mapping");
  if (input?.kind !== "agent-identity") throw new Error("expected Agent Identity input");
  const account = buildFinalCodexAgentAccount({
    platform: "openai",
    type: "oauth",
    proxy_id: 9,
    group_ids: [2],
    concurrency: 20,
    priority: 1,
    credentials: { model_mapping: { current: "current" } },
  }, input.authJson, "7");
  expect(account).toMatchObject({
    proxy_id: 9,
    group_ids: [2, 7],
    concurrency: 20,
    priority: 1,
    credentials: {
      agent_runtime_id: "agent-runtime-2",
      model_mapping: { current: "current" },
    },
  });
  expect(JSON.stringify(account)).not.toContain("portable-proxy-key");
  expect(JSON.stringify(account)).not.toContain('"old":"old"');
});

test("builds the final S2A Agent Identity account and applies template settings", () => {
  const account = buildFinalCodexAgentAccount({
    platform: "openai",
    type: "oauth",
    proxy_id: 7,
    group_ids: [3],
    concurrency: 20,
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
    credentials: { model_mapping: { "gpt-5.4": "gpt-5.4" } },
    extra: { openai_long_context_billing_enabled: false },
  }, buildAgentIdentityAuthJson(identity), "4");
  expect(account).toEqual({
    name: "person@example.com",
    platform: "openai",
    type: "oauth",
    proxy_id: 7,
    group_ids: [3, 4],
    concurrency: 20,
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
    credentials: {
      auth_mode: "agentIdentity",
      agent_runtime_id: "agent-runtime-1",
      agent_private_key: "private-key",
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
      email: "person@example.com",
      plan_type: "plus",
      chatgpt_account_is_fedramp: false,
      task_id: "task-1",
      model_mapping: { "gpt-5.4": "gpt-5.4" },
    },
    extra: { openai_long_context_billing_enabled: false },
  });
});

test("discovers Web, Codex OAuth, and S2A credential records", () => {
  const inputs = parseCodexAgentPayload(JSON.stringify([
    { accessToken: "web-token" },
    { auth_mode: "chatgpt", tokens: { access_token: "codex-token", id_token: "id-token" } },
    { platform: "openai", type: "oauth", credentials: { access_token: "s2a-token", refresh_token: "refresh" } },
  ]));
  expect(inputs.map((input) => input.source)).toEqual([
    "ChatGPT Web Session",
    "Codex OAuth auth.json",
    "S2A 账户",
  ]);
});

test("refreshes expired OAuth with form encoding", async () => {
  const expired = jwt({ exp: 1 });
  const fresh = jwt({
    exp: 1_893_456_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_user_id: "user-1" },
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: fresh, id_token: fresh });
    if (url.endsWith("/agent/register")) return Response.json({ agent_runtime_id: "agent-runtime-1" });
    if (url.endsWith("/task/register")) return Response.json({ task_id: "task-1" });
    return Response.json({}, { status: 500 });
  }) as typeof fetch;
  await convertCodexAgentInput({
    kind: "oauth",
    source: "Codex OAuth auth.json",
    accessToken: expired,
    refreshToken: "refresh-token",
  }, fakeFetch);
  const refresh = requests[0];
  expect(new Headers(refresh.init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
  expect(String(refresh.init?.body)).toContain("grant_type=refresh_token");
  expect(String(refresh.init?.body)).toContain("refresh_token=refresh-token");
});

test("converts OAuth into Agent Identity without retaining OAuth credentials", async () => {
  const accessToken = jwt({
    exp: 1_893_456_000,
    email: "person@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
      chatgpt_plan_type: "plus",
    },
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/agent/register")) return Response.json({ agent_runtime_id: "agent-runtime-1" });
    if (url.endsWith("/task/register")) return Response.json({ task_id: "task-1" });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;

  const result = await convertCodexAgentInput({
    kind: "oauth",
    source: "ChatGPT Web Session",
    accessToken,
    refreshToken: "refresh-token",
  }, fakeFetch);

  expect(result.authJson).toMatchObject({
    auth_mode: "agentIdentity",
    OPENAI_API_KEY: null,
    agent_identity: {
      agent_runtime_id: "agent-runtime-1",
      account_id: "account-1",
      chatgpt_user_id: "user-1",
      email: "person@example.com",
      plan_type: "plus",
      task_id: "task-1",
    },
  });
  expect(result.authJson.agent_identity.agent_private_key).toStartWith("MC4CAQAwBQYDK2VwBCIE");
  expect(JSON.stringify(result.authJson)).not.toContain(accessToken);
  expect(JSON.stringify(result.authJson)).not.toContain("refresh-token");
  expect(requests).toHaveLength(2);
});
