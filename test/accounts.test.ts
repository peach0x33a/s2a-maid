import { describe, expect, test } from "bun:test";
import { AccountInputError, deepMerge, extractAccountTemplate, mergeAndValidateAccount, parseAccountPayload } from "../src/accounts";

describe("account input", () => {
  test("deeply merges object fields while replacing arrays", () => {
    const merged = deepMerge(
      { credentials: { token: "template", nested: { keep: true, replace: "old" } }, tags: ["default"], priority: 1 },
      { credentials: { nested: { replace: "new" } }, tags: ["import"], priority: 2 },
    );
    expect(merged).toEqual({
      credentials: { token: "template", nested: { keep: true, replace: "new" } },
      tags: ["import"],
      priority: 2,
    });
  });

  test("accepts a Sub2API export object", () => {
    const accounts = parseAccountPayload(JSON.stringify({ exported_at: "2026-07-14", accounts: [{ name: "one" }] }));
    expect(accounts).toEqual([{ name: "one" }]);
  });

  test("accepts a single account and a direct array", () => {
    expect(parseAccountPayload('{"name":"one"}')).toEqual([{ name: "one" }]);
    expect(parseAccountPayload('[{"name":"one"},{"name":"two"}]')).toHaveLength(2);
  });

  test("rejects malformed account containers", () => {
    expect(() => parseAccountPayload('{"accounts":{}}')).toThrow(AccountInputError);
    expect(() => parseAccountPayload('["not an account"]')).toThrow(AccountInputError);
  });

  test("extracts reusable defaults including proxy and groups without account identity or expiry", () => {
    const template = extractAccountTemplate({
      id: 9,
      name: "old-account",
      platform: "openai",
      type: "oauth",
      credentials: { access_token: "secret", model_mapping: { a: "b" } },
      concurrency: 20,
      group_ids: [3, 4],
      proxy_id: 7,
      expires_at: 1785137558,
      auto_pause_on_expired: true,
      extra: {
        privacy_mode: "training_off",
        openai_compact_mode: "force_on",
        email: "person@example.com",
        name: "person@example.com",
        source: "frcibly_k12",
        last_refresh: "2026-07-17T07:32:38Z",
        codex_5h_used_percent: 35,
        codex_7d_reset_at: "old",
      },
    });
    expect(template).toEqual({
      platform: "openai",
      type: "oauth",
      concurrency: 20,
      group_ids: [3, 4],
      proxy_id: 7,
      auto_pause_on_expired: true,
      extra: { privacy_mode: "training_off", openai_compact_mode: "force_on" },
      credentials: { model_mapping: { a: "b" } },
    });
  });

  test("normalizes legacy group and proxy objects into reusable IDs", () => {
    expect(extractAccountTemplate({
      platform: "openai",
      type: "oauth",
      credentials: {},
      group_id: "5",
      account_groups: [{ group: { id: 6 } }],
      proxy: { id: 8, name: "private proxy" },
    })).toMatchObject({ group_ids: ["5", 6], proxy_id: 8 });
  });

  test("requires imports to declare the same platform as the template", () => {
    const template = { platform: "openai", type: "oauth", credentials: { refresh: "keep" } };
    const account = mergeAndValidateAccount(template, {
      name: "import",
      platform: "openai",
      credentials: { token: "import" },
    });
    expect(account.credentials).toEqual({ refresh: "keep", token: "import" });
    expect(() => mergeAndValidateAccount(template, { name: "missing platform", credentials: {} })).toThrow("缺少有效的 platform");
    expect(() => mergeAndValidateAccount(template, { name: "wrong", platform: "anthropic", credentials: {} })).toThrow("与模板平台 openai 不一致");
    expect(() => mergeAndValidateAccount({}, { name: "missing fields" })).toThrow(AccountInputError);
  });
});
