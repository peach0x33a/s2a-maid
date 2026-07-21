import { expect, test } from "bun:test";
import {
  accountPlanLabel,
  accountStatusSummary,
  filterAccounts,
  formatManagedAccountName,
  isUsableAccount,
  parseAccountListCommand,
  Sub2ApiClient,
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

test("labels supported account plans from credentials.plan_type", () => {
  expect(accountPlanLabel({ id: 1, credentials: { plan_type: "plus" }, extra: { source: "frcibly_k12" } })).toBe("PLUS");
  expect(accountPlanLabel({ id: 2, credentials: { plan_type: "k12" } })).toBe("K12");
  expect(accountPlanLabel({ id: 3, credentials: { plan_type: "team" } })).toBe("TEAM");
  expect(accountPlanLabel({ id: 4, credentials: { plan_type: "free" } })).toBe("FREE");
  expect(accountPlanLabel({ id: 5, credentials: {} })).toBeNull();
  expect(accountPlanLabel({ id: 6, extra: { plan_type: "plus" } })).toBeNull();
  expect(formatManagedAccountName({ id: 7, name: "alice", credentials: { plan_type: "team" } })).toBe("alice [TEAM]");
  expect(formatManagedAccountName({ id: 8, name: "bob" })).toBe("bob");
});

test("classifies unavailable account reasons", () => {
  expect(unavailableAccountReason({ id: 1, status: "error", error_message: "HTTP 401 Unauthorized" })).toBe("401 认证失败");
  expect(unavailableAccountReason({ id: 2, status: "error", error_message: "429 Too Many Requests" })).toBe("429 请求受限");
  expect(unavailableAccountReason({ id: 3, status: "active", schedulable: false, temp_unschedulable_reason: "rate_limit" })).toBe("429 请求受限");
  expect(unavailableAccountReason({ id: 4, status: "paused" })).toBe("账户已暂停");
  expect(unavailableAccountReason({ id: 5, status: "error", error_message: "refresh failed" })).toBe("账户错误：refresh failed");
});

test("summarizes usable and unavailable accounts by status code", () => {
  const accounts = [
    { id: 1, status: "active", schedulable: true },
    { id: 2, status: "active" },
    { id: 3, status: "error", error_message: "HTTP 401 Unauthorized" },
    { id: 4, status: "error", error_message: "Workspace deactivated (402)" },
    { id: 5, status: "error", error_message: "429 Too Many Requests" },
    { id: 6, status: "active", schedulable: false },
    { id: 7, status: "paused" },
  ];
  expect(accountStatusSummary(accounts)).toBe(
    "200 2 个，401 1 个，402 1 个，429 1 个，暂停 1 个，不可调度 1 个",
  );
});

test("loads every account page instead of stopping at the default first 20", async () => {
  const requestedPages: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const start = page === 1 ? 1 : 21;
      const count = page === 1 ? 20 : 9;
      const items = Array.from({ length: count }, (_, index) => ({
        id: start + index,
        name: `account-${start + index}`,
        status: "active",
        group_ids: [3],
      }));
      return Response.json({ data: { items, total: 29, page, page_size: 20, pages: 2 } });
    },
  });
  try {
    const client = new Sub2ApiClient(`http://127.0.0.1:${server.port}`, "test-key");
    const accounts = await client.listAccounts("3");
    expect(accounts).toHaveLength(29);
    expect(accounts.at(-1)?.id).toBe(29);
    expect(requestedPages).toEqual([1, 2]);
  } finally {
    server.stop(true);
  }
});

test("parses list group IDs and -- filters", () => {
  expect(parseAccountListCommand("")).toEqual({ groupId: null, filter: "all" });
  expect(parseAccountListCommand("7")).toEqual({ groupId: "7", filter: "all" });
  expect(parseAccountListCommand("7 --available")).toEqual({ groupId: "7", filter: "available" });
  expect(parseAccountListCommand("--unavailable 7")).toEqual({ groupId: "7", filter: "unavailable" });
  expect(parseAccountListCommand("all")).toBeNull();
  expect(parseAccountListCommand("--unknown")).toBeNull();
  expect(parseAccountListCommand("7 8")).toBeNull();
  expect(parseAccountListCommand("--all --available")).toBeNull();
});

test("applies account list filters", () => {
  const accounts = [
    { id: 1, status: "active" },
    { id: 2, status: "error" },
  ];
  expect(filterAccounts(accounts, "all").map((account) => account.id)).toEqual([1, 2]);
  expect(filterAccounts(accounts, "available").map((account) => account.id)).toEqual([1]);
  expect(filterAccounts(accounts, "unavailable").map((account) => account.id)).toEqual([2]);
});
