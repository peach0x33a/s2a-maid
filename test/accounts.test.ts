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

  test("extracts reusable defaults without credentials or live usage snapshots", () => {
    const template = extractAccountTemplate({
      name: "old-account",
      platform: "openai",
      type: "oauth",
      credentials: { access_token: "secret", model_mapping: { a: "b" } },
      concurrency: 20,
      group_ids: [3],
      extra: { privacy_mode: true, codex_5h_used_percent: 35, codex_7d_reset_at: "old" },
    });
    expect(template).toEqual({
      platform: "openai",
      type: "oauth",
      concurrency: 20,
      extra: { privacy_mode: true },
      credentials: { model_mapping: { a: "b" } },
    });
  });

  test("validates the merged result rather than partial import fields", () => {
    const account = mergeAndValidateAccount(
      { name: "template", platform: "openai", type: "oauth", credentials: { token: "template", refresh: "keep" } },
      { name: "import", credentials: { token: "import" } },
    );
    expect(account.credentials).toEqual({ token: "import", refresh: "keep" });
    expect(() => mergeAndValidateAccount({}, { name: "missing fields" })).toThrow(AccountInputError);
  });
});
