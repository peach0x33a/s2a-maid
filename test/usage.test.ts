import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store } from "../src/database";
import { extractUsageWindows, lowQuotaWindows, usageWindowsForDisplay } from "../src/usage";

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

test("hides an unused five-hour window after recent activity consumed seven-day quota", () => {
  const windows = extractUsageWindows({ data: {
    five_hour: { utilization: 0 },
    seven_day: { utilization: 3 },
  } });
  const now = new Date("2026-07-21T23:30:00+08:00");
  expect(usageWindowsForDisplay(windows, "2026-07-21T23:04:53+08:00", now).map((window) => window.label))
    .toEqual(["7 天窗口"]);
  expect(usageWindowsForDisplay(windows, "2026-07-21T17:00:00+08:00", now)).toEqual(windows);
  expect(usageWindowsForDisplay(windows, null, now)).toEqual(windows);
});

test("keeps the five-hour window when it has usage", () => {
  const windows = extractUsageWindows({ data: {
    five_hour: { utilization: 1 },
    seven_day: { utilization: 3 },
  } });
  expect(usageWindowsForDisplay(windows, "2026-07-21T23:04:53+08:00", new Date("2026-07-21T23:30:00+08:00")))
    .toEqual(windows);
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
