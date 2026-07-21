import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store } from "../src/database";

test("sanitizes an existing template when it is read", () => {
  const path = `/tmp/s2a-maid-database-${crypto.randomUUID()}.sqlite`;
  const store = new Store(path);
  try {
    store.setTemplate({
      platform: "openai",
      type: "oauth",
      expires_at: 1785137558,
      proxy_id: 7,
      group_ids: [3],
      extra: {
        email: "person@example.com",
        source: "frcibly_k12",
        last_refresh: "2026-07-17T07:32:38Z",
        privacy_mode: "training_off",
      },
      credentials: { plan_type: "k12", access_token: "secret", model_mapping: { a: "b" } },
    });
    expect(store.getTemplate()).toEqual({
      platform: "openai",
      type: "oauth",
      proxy_id: 7,
      group_ids: [3],
      extra: { privacy_mode: "training_off" },
      credentials: { model_mapping: { a: "b" } },
    });
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});
