import { expect, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { registerBotHandlers, type BotDependencies } from "../src/bot";

test("usage totals exclude a five-hour window hidden from the account report", async () => {
  const commandHandlers = new Map<string, (ctx: Context) => Promise<void>>();
  const bot = {
    command(commands: string | string[], handler: (ctx: Context) => Promise<void>) {
      for (const command of Array.isArray(commands) ? commands : [commands]) commandHandlers.set(command, handler);
    },
    callbackQuery() {},
    on() {},
  } as unknown as Bot;
  const dependencies = {
    allowedChatIds: new Set([-1001]),
    sub2api: {
      async listAccounts() {
        return [{
          id: 85,
          name: "22-plus-nosms-1",
          status: "active",
          schedulable: true,
          last_used_at: new Date(Date.now() - 60_000).toISOString(),
        }];
      },
      async getUsage() {
        return { data: {
          five_hour: { utilization: 0 },
          seven_day: { utilization: 100 },
        } };
      },
      async listGroups() {
        return [{ id: "gpt", name: "gpt" }];
      },
    },
    monitor: {
      getGroupId: () => "gpt",
    },
  } as unknown as BotDependencies;
  registerBotHandlers(bot, dependencies);

  const replies: string[] = [];
  const handler = commandHandlers.get("usage");
  expect(handler).toBeDefined();
  await handler!({
    chat: { id: -1001, type: "group", title: "Test" },
    match: "",
    reply: async (text: string) => {
      replies.push(text);
      return {} as never;
    },
  } as unknown as Context);

  const report = replies.join("\n");
  expect(report).toContain("7 天窗口: 剩余 0.0%");
  expect(report).not.toContain("5 小时窗口: 剩余");
  expect(report).toContain("7 天窗口: 合计剩余 0.0%（1 个可用账户）");
  expect(report).not.toContain("5 小时窗口: 合计剩余");
});
