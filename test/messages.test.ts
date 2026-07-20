import { expect, test } from "bun:test";
import { splitTelegramText } from "../src/messages";

test("splits long Telegram messages without losing content", () => {
  const text = Array.from({ length: 20 }, (_, index) => `line-${index}-${"x".repeat(15)}`).join("\n");
  const chunks = splitTelegramText(text, 80);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
  expect(chunks.join("\n")).toBe(text);
});

test("splits a single oversized line", () => {
  const chunks = splitTelegramText("x".repeat(205), 100);
  expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 5]);
});
