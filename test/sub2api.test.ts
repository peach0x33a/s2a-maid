import { expect, test } from "bun:test";
import {
  filterAccounts,
  isUsableAccount,
  parseAccountListFilter,
  unavailableAccountReason,
} from "../src/sub2api";

test("only active schedulable accounts contribute to quota totals", () => {
  expect(isUsableAccount({ id: 1, status: "active", schedulable: true })).toBe(true);
  expect(isUsableAccount({ id: 2, status: "active" })).toBe(true);
  expect(isUsableAccount({ id: 3, status: "active", schedulable: false })).toBe(false);
  expect(isUsableAccount({ id: 4, status: "error", schedulable: true })).toBe(false);
  expect(isUsableAccount({ id: 5, status: "paused" })).toBe(false);
  expect(isUsableAccount({ id: 6 })).toBe(false);
});

test("classifies unavailable account reasons", () => {
  expect(unavailableAccountReason({ id: 1, status: "error", error_message: "HTTP 401 Unauthorized" })).toBe("401 认证失败");
  expect(unavailableAccountReason({ id: 2, status: "error", error_message: "429 Too Many Requests" })).toBe("429 请求受限");
  expect(unavailableAccountReason({ id: 3, status: "active", schedulable: false, temp_unschedulable_reason: "rate_limit" })).toBe("429 请求受限");
  expect(unavailableAccountReason({ id: 4, status: "paused" })).toBe("账户已暂停");
  expect(unavailableAccountReason({ id: 5, status: "error", error_message: "refresh failed" })).toBe("账户错误：refresh failed");
});

test("parses and applies account list filters", () => {
  const accounts = [
    { id: 1, status: "active" },
    { id: 2, status: "error" },
  ];
  expect(parseAccountListFilter("")).toBe("all");
  expect(parseAccountListFilter("可用")).toBe("available");
  expect(parseAccountListFilter("unavailable")).toBe("unavailable");
  expect(parseAccountListFilter("unknown")).toBeNull();
  expect(filterAccounts(accounts, "all").map((account) => account.id)).toEqual([1, 2]);
  expect(filterAccounts(accounts, "available").map((account) => account.id)).toEqual([1]);
  expect(filterAccounts(accounts, "unavailable").map((account) => account.id)).toEqual([2]);
});
