import { Database } from "bun:sqlite";
import { extractAccountTemplate } from "./accounts";
import type { JsonObject } from "./types";

export type InputMode = "template" | "accounts" | "codex-agent";

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS input_modes (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS quota_alerts (
      account_id TEXT NOT NULL,
      window_key TEXT NOT NULL,
      alerted_at TEXT NOT NULL,
      PRIMARY KEY (account_id, window_key)
    )`);
  }

  close(): void {
    this.db.close();
  }

  getMonitorGroupId(): string | null {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE name = 'monitor_group_id'").get();
    return row?.value ?? null;
  }

  setMonitorGroupId(groupId: string): void {
    this.db.query("INSERT INTO settings (name, value) VALUES ('monitor_group_id', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .run(groupId);
  }

  getTemplate(): JsonObject | null {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM settings WHERE name = 'template'").get();
    if (!row) return null;
    const stored = JSON.parse(row.value) as JsonObject;
    const sanitized = extractAccountTemplate(stored);
    if (JSON.stringify(sanitized) !== JSON.stringify(stored)) this.setTemplate(sanitized);
    return sanitized;
  }

  setTemplate(template: JsonObject): void {
    this.db.query("INSERT INTO settings (name, value) VALUES ('template', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(template));
  }

  setMode(chatId: number, userId: number, mode: InputMode): void {
    this.db.query("INSERT INTO input_modes (chat_id, user_id, mode) VALUES (?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET mode = excluded.mode")
      .run(String(chatId), String(userId), mode);
  }

  getMode(chatId: number, userId: number): InputMode | null {
    const row = this.db.query<{ mode: InputMode }, [string, string]>("SELECT mode FROM input_modes WHERE chat_id = ? AND user_id = ?")
      .get(String(chatId), String(userId));
    return row?.mode ?? null;
  }

  clearMode(chatId: number, userId: number): void {
    this.db.query("DELETE FROM input_modes WHERE chat_id = ? AND user_id = ?").run(String(chatId), String(userId));
  }

  claimAlert(accountId: string, windowKey: string): boolean {
    const result = this.db.query("INSERT OR IGNORE INTO quota_alerts (account_id, window_key, alerted_at) VALUES (?, ?, ?)")
      .run(accountId, windowKey, new Date().toISOString());
    return result.changes > 0;
  }

  clearAlert(accountId: string, windowKey: string): void {
    this.db.query("DELETE FROM quota_alerts WHERE account_id = ? AND window_key = ?").run(accountId, windowKey);
  }
}
