import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store } from "../src/database";
import { extractUsageWindows, lowQuotaWindows } from "../src/usage";

test("identifies low remaining quota from standard utilization windows", () => {
  const payload = { data: { windows: [
    { name: "five-hour", utilization: 95 },
    { name: "weekly", utilization: 80 },
  ] } };
  expect(extractUsageWindows(payload)).toEqual([
    { key: "five-hour", label: "5 小时窗口", utilization: 95, remainingPercent: 5 },
    { key: "weekly", label: "每周窗口", utilization: 80, remainingPercent: 20 },
  ]);
  expect(lowQuotaWindows(payload, 10).map((window) => window.key)).toEqual(["five-hour"]);
});

test("accepts fractional utilization values", () => {
  const windows = extractUsageWindows({ windows: [{ name: "five-hour", utilization: 0.95 }] });
  expect(windows[0]?.remainingPercent).toBeCloseTo(5);
});

test("deduplicates an account window and allows a new alert after recovery", () => {
  const path = `/tmp/s2a-maid-alert-test-${crypto.randomUUID()}.sqlite`;
  const store = new Store(path);
  try {
    expect(store.claimAlert("account-1", "five-hour")).toBe(true);
    expect(store.claimAlert("account-1", "five-hour")).toBe(false);
    expect(store.claimAlert("account-1", "weekly")).toBe(true);
    store.clearAlert("account-1", "five-hour");
    expect(store.claimAlert("account-1", "five-hour")).toBe(true);
  } finally {
    store.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      try { rmSync(`${path}${suffix}`); } catch { /* Some SQLite sidecar files are not created. */ }
    }
  }
});
