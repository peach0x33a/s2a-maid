import type { UsageWindow } from "./types";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function extractUsageWindows(payload: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const visited = new Set<unknown>();

  const visit = (value: unknown, path: string): void => {
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    if (isRecord(value)) {
      const rawUtilization = numeric(value.utilization);
      if (rawUtilization !== null) {
        // Sub2API exposes utilization as a percentage in the 0–100 range, including fractional percentages.
        const utilization = rawUtilization;
        const rawLabel = stringValue(value.name) ?? stringValue(value.label) ?? stringValue(value.window)
          ?? stringValue(value.period) ?? path;
        const label = friendlyUsageLabel(rawLabel, path);
        const key = stringValue(value.id) ?? stringValue(value.key) ?? rawLabel;
        if (utilization >= 0 && utilization <= 100) {
          windows.push({ key, label, utilization, remainingPercent: 100 - utilization });
        }
      }
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      return;
    }
    value.forEach((child, index) => visit(child, `${path}[${index}]`));
  };

  visit(payload, "usage");
  return windows;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function friendlyUsageLabel(label: string, path: string): string {
  const value = `${label} ${path}`.toLowerCase();
  if (/(^|[._-])five[_ -]?hour(\b|[._-])/.test(value)) return "5 小时窗口";
  if (/(^|[._-])seven[_ -]?day(\b|[._-])/.test(value)) return "7 天窗口";
  if (/(^|[._-])weekly?(\b|[._-])/.test(value)) return "每周窗口";
  if (/(^|[._-])daily?(\b|[._-])/.test(value)) return "每日窗口";
  return label.startsWith("usage.") ? label.slice("usage.".length) : label;
}

export function usageWindowsForDisplay(
  windows: UsageWindow[],
  lastUsedAt: string | null | undefined,
  now = new Date(),
): UsageWindow[] {
  const fiveHour = windows.find((window) => window.label === "5 小时窗口");
  const sevenDay = windows.find((window) => window.label === "7 天窗口");
  if (!fiveHour || !sevenDay || fiveHour.utilization !== 0 || sevenDay.utilization <= 0 || !lastUsedAt) return windows;
  const lastUsedTime = Date.parse(lastUsedAt);
  const age = now.getTime() - lastUsedTime;
  if (!Number.isFinite(lastUsedTime) || age < 0 || age >= 5 * 60 * 60 * 1000) return windows;
  return windows.filter((window) => window !== fiveHour);
}

export function lowQuotaWindows(payload: unknown, threshold: number): UsageWindow[] {
  return extractUsageWindows(payload).filter((window) => window.remainingPercent < threshold);
}
