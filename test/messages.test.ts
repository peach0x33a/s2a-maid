import { expect, test } from "bun:test";
import { formatAccountTemplate, parseOptionalGroupId, parseTemplateCommand, splitTelegramText } from "../src/messages";

test("parses template command actions", () => {
  expect(parseTemplateCommand("")).toBe("show");
  expect(parseTemplateCommand("  --new  ")).toBe("new");
  expect(parseTemplateCommand("--NEW")).toBe("new");
  expect(parseTemplateCommand("new")).toBe("invalid");
  expect(parseTemplateCommand("replace")).toBe("invalid");
});

test("parses an optional group ID", () => {
  expect(parseOptionalGroupId("")).toBeNull();
  expect(parseOptionalGroupId("  7  ")).toBe("7");
  expect(parseOptionalGroupId("7 8")).toBeUndefined();
  expect(parseOptionalGroupId("--all")).toBeUndefined();
});

test("formats account template as readable JSON", () => {
  expect(formatAccountTemplate({ platform: "openai", concurrency: 2 })).toBe(
    '{\n  "platform": "openai",\n  "concurrency": 2\n}',
  );
});

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
