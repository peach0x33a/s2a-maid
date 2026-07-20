import { expect, test } from "bun:test";
import { isUsableAccount } from "../src/sub2api";

test("only active schedulable accounts contribute to quota totals", () => {
  expect(isUsableAccount({ id: 1, status: "active", schedulable: true })).toBe(true);
  expect(isUsableAccount({ id: 2, status: "active" })).toBe(true);
  expect(isUsableAccount({ id: 3, status: "active", schedulable: false })).toBe(false);
  expect(isUsableAccount({ id: 4, status: "error", schedulable: true })).toBe(false);
  expect(isUsableAccount({ id: 5, status: "paused" })).toBe(false);
  expect(isUsableAccount({ id: 6 })).toBe(false);
});
