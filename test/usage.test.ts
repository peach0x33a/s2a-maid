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

test("treats fractional utilization values as percentages", () => {
  const windows = extractUsageWindows({ windows: [{ name: "five-hour", utilization: 0.95 }] });
  expect(windows[0]?.remainingPercent).toBeCloseTo(99.05);
});

test("treats utilization 1 as one percent rather than a full fractional ratio", () => {
  const windows = extractUsageWindows({ windows: [{ name: "seven-day", utilization: 1 }] });
  expect(windows).toEqual([
    { key: "seven-day", label: "7 天窗口", utilization: 1, remainingPercent: 99 },
  ]);
  expect(lowQuotaWindows({ windows: [{ name: "seven-day", utilization: 1 }] }, 10)).toEqual([]);
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
