import type { JsonObject } from "./types";

const TELEGRAM_SAFE_TEXT_LENGTH = 3900;

export type TemplateCommandAction = "show" | "new" | "invalid";

export function parseTemplateCommand(input: string): TemplateCommandAction {
  const argument = input.trim().toLowerCase();
  if (argument === "") return "show";
  if (argument === "new") return "new";
  return "invalid";
}

export function formatAccountTemplate(template: JsonObject): string {
  return JSON.stringify(template, null, 2);
}

/** Split long Telegram text at line boundaries while preserving all content. */
export function splitTelegramText(text: string, maxLength = TELEGRAM_SAFE_TEXT_LENGTH): string[] {
  if (maxLength <= 0) throw new Error("maxLength must be positive");
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= maxLength) {
      current = line;
      continue;
    }
    for (let offset = 0; offset < line.length; offset += maxLength) {
      const part = line.slice(offset, offset + maxLength);
      if (part.length === maxLength) chunks.push(part);
      else current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
