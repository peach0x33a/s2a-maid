import type { JsonObject } from "./types";

const TELEGRAM_SAFE_TEXT_LENGTH = 3900;

export type TemplateCommandAction = "show" | "new" | "invalid";
export type AccountImportMode = "accounts" | "codex-agent" | "invalid";

export function parseAccountImportMode(input: string): AccountImportMode {
  const argument = input.trim().toLowerCase();
  if (argument === "") return "accounts";
  if (argument === "--codex-agent" || argument === "-ca") return "codex-agent";
  return "invalid";
}

export function parseTemplateCommand(input: string): TemplateCommandAction {
  const argument = input.trim().toLowerCase();
  if (argument === "") return "show";
  if (argument === "--new") return "new";
  return "invalid";
}

export function parseOptionalGroupId(input: string): string | null | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length !== 1 || !/^\d+$/.test(tokens[0])) return undefined;
  return tokens[0];
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
