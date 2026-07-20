import { expect, test } from "bun:test";
import { formatLowQuotaAlert } from "../src/monitor";

test("formats low quota alerts with real line breaks", () => {
  const text = formatLowQuotaAlert("Caruccipeha27", "42", "7 天窗口", 9);
  expect(text).toBe("低余额告警\n账户：Caruccipeha27 (42)\n窗口：7 天窗口\n剩余：9.0%");
  expect(text).not.toContain("\\n");
});
