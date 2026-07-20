import { expect, test } from "bun:test";
import { mergeAndValidateAccount, parseAccountPayload, parseAccountPayloadDetailed } from "../src/accounts";
import { convertSessionToSub2Api } from "../src/session-converter";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("converts a ChatGPT web session into a minimal Sub2API OAuth account", () => {
  const accessToken = jwt({
    exp: 1_893_456_000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
      chatgpt_plan_type: "plus",
    },
  });
  const account = convertSessionToSub2Api({
    user: { email: "person@example.com" },
    accessToken,
  }, "session.json", new Date("2026-01-01T00:00:00.000Z"));

  expect(account).toMatchObject({
    name: "person@example.com",
    platform: "openai",
    type: "oauth",
    expires_at: 1_893_456_000,
    auto_pause_on_expired: true,
    credentials: {
      access_token: accessToken,
      chatgpt_account_id: "account-1",
      chatgpt_user_id: "user-1",
      email: "person@example.com",
      plan_type: "plus",
    },
    extra: { source: "chatgpt_web_session" },
  });
  expect(account.credentials.model_mapping).toBeUndefined();
});

test("preserves refresh, id, session, workspace, and account tokens from Codex auth formats", () => {
  const account = convertSessionToSub2Api({
    auth_mode: "chatgpt",
    last_refresh: "2026-07-20T00:00:00.000Z",
    tokens: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      account_id: "account-1",
    },
    meta: { workspace_id: "workspace-1", chatgpt_account_id: "account-1", label: "codex@example.com" },
  });
  expect(account).toMatchObject({
    credentials: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      account_id: "account-1",
      chatgpt_account_id: "account-1",
      workspace_id: "workspace-1",
    },
    extra: { source: "codex_manager" },
  });
});

test("recognizes 9router OAuth records and preserves provider metadata", () => {
  const account = convertSessionToSub2Api({
    provider: "codex",
    authType: "oauth",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    providerSpecificData: {
      chatgptAccountId: "router-account",
      chatgptUserId: "router-user",
      chatgptPlanType: "plus",
    },
  });
  expect(account).toMatchObject({
    credentials: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      chatgpt_account_id: "router-account",
      chatgpt_user_id: "router-user",
      plan_type: "plus",
    },
    extra: { source: "9router" },
  });
});

test("preserves native token fields from AxonHub-shaped auth JSON", () => {
  const account = convertSessionToSub2Api({
    auth_mode: "chatgpt",
    last_refresh: "2026-07-20T00:00:00.000Z",
    tokens: { access_token: "access-token", refresh_token: "refresh-token", id_token: "id-token" },
    user: { email: "axon@example.com" },
    axonhub_note: "source marker",
  });
  expect(account).toMatchObject({
    credentials: { access_token: "access-token", refresh_token: "refresh-token", id_token: "id-token" },
    extra: { source: "axonhub" },
  });
});

test("a refreshable session does not inherit access-token expiry", () => {
  const account = convertSessionToSub2Api({
    email: "refreshable@example.com",
    accessToken: jwt({ exp: 1_893_456_000 }),
    refreshToken: "refresh-token",
  });

  expect(account.expires_at).toBeUndefined();
  expect(account.auto_pause_on_expired).toBeUndefined();
  expect(account.credentials.expires_at).toBeUndefined();
});

test("session import has no model mapping unless the saved template provides one", () => {
  const session = {
    user: { email: "person@example.com" },
    accessToken: jwt({ exp: 1_893_456_000 }),
  };
  const converted = parseAccountPayload(JSON.stringify(session))[0]!;
  expect(converted.credentials).toEqual(expect.objectContaining({ access_token: session.accessToken }));
  expect(converted).not.toHaveProperty("credentials.model_mapping");

  const merged = mergeAndValidateAccount({
    name: "template",
    platform: "openai",
    type: "oauth",
    credentials: { model_mapping: { "gpt-5": "gpt-5" } },
  }, converted);
  expect(merged.credentials.model_mapping).toEqual({ "gpt-5": "gpt-5" });
});

test("keeps native Sub2API account files unchanged instead of converting them as sessions", () => {
  const native = {
    name: "native",
    platform: "openai",
    type: "oauth",
    credentials: { access_token: jwt({ exp: 1_893_456_000 }), model_mapping: { "gpt-5": "gpt-5" } },
  };
  expect(parseAccountPayload(JSON.stringify({ accounts: [native] }))).toEqual([native]);
  expect(parseAccountPayload(JSON.stringify([native]))).toEqual([native]);
});

test("converts session records nested in an accounts array", () => {
  const accessToken = jwt({ exp: 1_893_456_000 });
  const accounts = parseAccountPayload(JSON.stringify({
    accounts: [{ user: { email: "nested@example.com" }, accessToken }],
  }));
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({
    name: "nested@example.com",
    credentials: { access_token: accessToken },
  });
});

test("reports source formats for explicit S2A conversion notices", () => {
  const detailed = parseAccountPayloadDetailed(JSON.stringify([
    { user: { email: "web@example.com" }, accessToken: "web-access" },
    {
      provider: "codex",
      authType: "oauth",
      accessToken: "router-access",
      providerSpecificData: { chatgptAccountId: "router-account" },
    },
    {
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-access", account_id: "codex-account" },
      last_refresh: "2026-07-20T00:00:00Z",
    },
  ]));
  expect(detailed.accounts).toHaveLength(3);
  expect(detailed.conversions).toEqual({
    "ChatGPT Web Session": 1,
    "9router OAuth": 1,
    "Codex auth.json": 1,
  });
  expect(detailed.nativeAccounts).toBe(0);
});

test("keeps non-session account objects when an array also contains sessions", () => {
  const accessToken = jwt({ exp: 1_893_456_000 });
  const partialAccount = { name: "template override", priority: 3 };
  const accounts = parseAccountPayload(JSON.stringify([
    partialAccount,
    { user: { email: "session@example.com" }, accessToken },
  ]));
  expect(accounts).toHaveLength(2);
  expect(accounts[0]).toEqual(partialAccount);
  expect(accounts[1]).toMatchObject({ credentials: { access_token: accessToken } });
});
