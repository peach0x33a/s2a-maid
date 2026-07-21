import { Bot, InlineKeyboard, type Context } from "grammy";
import { AccountInputError, extractAccountTemplate, mergeAndValidateAccount, parseAccountPayloadDetailed } from "./accounts";
import { extractJsonFilesFromZip, isZipArchive } from "./archive";
import type { Store } from "./database";
import {
  filterAccounts,
  formatManagedAccountName,
  isUsableAccount,
  parseAccountListFilter,
  unavailableAccountReason,
  type ManagedGroup,
  type Sub2ApiClient,
} from "./sub2api";
import type { UsageMonitor } from "./monitor";
import { downloadTelegramFile } from "./telegram";
import { extractUsageWindows } from "./usage";
import { formatAccountTemplate, parseTemplateCommand, splitTelegramText } from "./messages";
import type { JsonObject } from "./types";

export interface BotDependencies {
  store: Store;
  sub2api: Sub2ApiClient;
  allowedChatIds: Set<number>;
  telegramApiBaseUrl: string;
  telegramBotToken: string;
  telegramApiHeaders: HeadersInit;
  monitor: UsageMonitor;
}

export function registerBotHandlers(bot: Bot, dependencies: BotDependencies): void {
  bot.command("monitor", async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    const status = dependencies.monitor.getStatus();
    if (!status.groupId) {
      await ctx.reply("请先使用 /group 选择监控分组。");
      return;
    }
    const groups = await dependencies.sub2api.listGroups();
    const group = groups.find((item) => String(item.id) === status.groupId);
    const checked = status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString("zh-CN") : "尚未检查";
    const unavailableDetails = status.unavailableAccounts.length > 0
      ? `\n\n不可用账户（${status.unavailableAccounts.length} 个）：\n${status.unavailableAccounts.map((account) =>
        `- ${account.displayName} (ID: ${account.id})：${account.reason}`
      ).join("\n")}`
      : "";
    await replyLong(
      ctx,
      `监控正常。\n\n` +
      `分组：${group?.name ?? status.groupId} (ID: ${status.groupId})\n` +
      `现在：${status.running ? "正在检查" : "等下一轮"}\n` +
      `每 ${status.intervalSeconds} 秒检查一次\n` +
      `剩余低于 ${status.threshold}% 时提醒\n` +
      `上次检查：${checked}\n` +
      `账户：${status.totalAccounts} 个，其中 ${status.usableAccounts} 个可用\n` +
      `${formatGroupLimits(group)}\n` +
      `${status.lastError ? `最近一次报错：${status.lastError}\n` : ""}` +
      `${unavailableDetails}\n\n` +
      "只检查状态正常、可以调度的账户。报错或暂停的账户会跳过。",
    );
  });

  bot.command("list", async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    const groupId = dependencies.monitor.getGroupId();
    if (!groupId) {
      await ctx.reply("请先使用 /group 选择监控分组。");
      return;
    }
    try {
      const filter = parseAccountListFilter(ctx.match ?? "");
      if (!filter) {
        await ctx.reply("参数无效。可用参数：all、available、unavailable（或：全部、可用、不可用）。");
        return;
      }
      const accounts = await dependencies.sub2api.listAccounts(groupId);
      const selected = filterAccounts(accounts, filter);
      if (selected.length === 0) {
        const label = filter === "available" ? "可用" : filter === "unavailable" ? "不可用" : "";
        await ctx.reply(`分组 ${groupId} 中暂无${label}账户。`);
        return;
      }
      const lines = selected.map((account, index) => {
        if (isUsableAccount(account)) {
          return `${index + 1}. ${formatManagedAccountName(account)} (ID: ${account.id}) · 可用`;
        }
        return `${index + 1}. ${formatManagedAccountName(account)} (ID: ${account.id}) · ${unavailableAccountReason(account) ?? "不可用"}`;
      });
      const usableCount = accounts.filter(isUsableAccount).length;
      const filterLabel = filter === "available" ? "可用账户" : filter === "unavailable" ? "不可用账户" : "全部账户";
      await replyLong(
        ctx,
        `分组 ${groupId} ${filterLabel}（显示 ${selected.length} 个；全部 ${accounts.length} 个，可用 ${usableCount} 个）：\n\n${lines.join("\n")}`,
      );
    } catch (error) {
      console.error("Account listing failed:", error);
      await ctx.reply("暂时无法获取账户列表，请稍后重试。");
    }
  });

  bot.command("usage", async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    const groupId = dependencies.monitor.getGroupId();
    if (!groupId) {
      await ctx.reply("请先使用 /group 选择监控分组。");
      return;
    }
    try {
      const accounts = await dependencies.sub2api.listAccounts(groupId);
      if (accounts.length === 0) {
        await ctx.reply(`分组 ${groupId} 中暂无账户。`);
        return;
      }
      const usableAccounts = accounts.filter(isUsableAccount);
      const excludedCount = accounts.length - usableAccounts.length;
      if (usableAccounts.length === 0) {
        await ctx.reply(`分组 ${groupId} 中没有可用账户。${excludedCount > 0 ? ` 已排除 ${excludedCount} 个不可用账户，可使用 /monitor 查看原因。` : ""}`);
        return;
      }
      const results: string[] = [];
      const totals = new Map<string, { label: string; remaining: number; accounts: number }>();
      for (const account of usableAccounts) {
        try {
          const windows = extractUsageWindows(await dependencies.sub2api.getUsage(account.id));
          const lines = windows.length > 0
            ? windows.map((window) => `${window.label}: 剩余 ${window.remainingPercent.toFixed(1)}%`)
            : ["暂无可识别用量窗口"];
          for (const window of windows) {
            const total = totals.get(window.key) ?? { label: window.label, remaining: 0, accounts: 0 };
            total.remaining += window.remainingPercent;
            total.accounts += 1;
            totals.set(window.key, total);
          }
          results.push(`• ${formatManagedAccountName(account)} (ID: ${account.id})\n  ${lines.join("\n  ")}`);
        } catch (error) {
          console.error(`Usage query failed for account ${account.id}:`, error);
          results.push(`• ${formatManagedAccountName(account)} (ID: ${account.id})【查询失败，不计入总额度】`);
        }
      }
      const totalLines = [...totals.values()].map((total) =>
        `${total.label}: 合计剩余 ${total.remaining.toFixed(1)}%（${total.accounts} 个可用账户）`
      );
      const group = (await dependencies.sub2api.listGroups()).find((item) => String(item.id) === groupId);
      const limits = group ? formatGroupLimits(group) : "分组配置额度：未知";
      await replyLong(
        ctx,
        `分组 ${group?.name ?? groupId} 用量：\n\n` +
        `${results.join("\n\n")}\n\n` +
        `分组总额度：\n${totalLines.length > 0 ? totalLines.join("\n") : "没有可计入的用量数据"}\n${limits}\n\n` +
        `${excludedCount > 0 ? `已排除 ${excludedCount} 个不可用账户，使用 /monitor 查看原因。\n` : ""}` +
        "总额度只统计状态正常且可调度的账户。每个满额账户按 100% 计算。",
      );
    } catch (error) {
      console.error("Usage listing failed:", error);
      await ctx.reply("暂时无法获取账户用量，请稍后重试。");
    }
  });

  bot.command(["group", "groups"], async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    try {
      const groups = await dependencies.sub2api.listGroups();
      if (groups.length === 0) {
        await ctx.reply("Sub2API 中暂无可用分组。");
        return;
      }
      await ctx.reply("请选择要监控的 Sub2API 分组：", { reply_markup: groupKeyboard(groups) });
    } catch (error) {
      console.error("Group listing failed:", error);
      await ctx.reply("暂时无法获取分组列表，请稍后重试。");
    }
  });

  bot.callbackQuery(/^monitor-group:(.+)$/, async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) {
      await ctx.answerCallbackQuery({ text: "当前群组未获授权", show_alert: true });
      return;
    }
    const groupId = ctx.match[1];
    dependencies.store.setMonitorGroupId(groupId);
    dependencies.monitor.setGroupId(groupId);
    await ctx.answerCallbackQuery({ text: "监控分组已更新" });
    await ctx.editMessageText(`已开始监控分组 ${groupId}。`);
  });

  bot.command("template", async (ctx) => {
    const chat = ctx.chat;
    if (!isAllowedGroup(chat, dependencies.allowedChatIds) || !ctx.from) return;
    const action = parseTemplateCommand(ctx.match ?? "");
    if (action === "invalid") {
      await ctx.reply("参数无效。使用 /template 查看当前模板，或使用 /template new 设置新模板。");
      return;
    }
    if (action === "show") {
      const template = dependencies.store.getTemplate();
      if (!template) {
        await ctx.reply("尚未设置账户模板。使用 /template new 上传现有的 S2A 账户文件。");
        return;
      }
      await replyLong(ctx, `当前账户模板：\n\n${formatAccountTemplate(template)}`);
      return;
    }
    dependencies.store.setMode(chat.id, ctx.from.id, "template");
    await ctx.reply("请上传现有的 S2A 账户文件。将使用第一条账户生成新模板，并覆盖当前模板。");
  });

  bot.command("acc", async (ctx) => {
    const chat = ctx.chat;
    if (!isAllowedGroup(chat, dependencies.allowedChatIds) || !ctx.from) return;
    dependencies.store.setMode(chat.id, ctx.from.id, "accounts");
    await ctx.reply("请上传账户或登录文件，也可以上传包含 JSON 文件的 ZIP 压缩包。支持 S2A、ChatGPT Session、9router、Codex、AxonHub 和 Codex-Manager 格式。");
  });

  bot.command("cancel", async (ctx) => {
    const chat = ctx.chat;
    if (!isAllowedGroup(chat, dependencies.allowedChatIds) || !ctx.from) return;
    dependencies.store.clearMode(chat.id, ctx.from.id);
    await ctx.reply("已取消当前操作。");
  });

  bot.command(["help", "start"], async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    await ctx.reply("可用命令：\n/template 查看账户模板\n/template new 设置新模板\n/acc 导入账户\n/list [all|available|unavailable] 查看账户\n/usage 查看可用账户用量\n/monitor 查看监控状态和不可用原因\n/group 选择监控分组\n/cancel 取消当前操作");
  });

  bot.on("message", async (ctx) => {
    const chat = ctx.chat;
    if (!isAllowedGroup(chat, dependencies.allowedChatIds) || !ctx.from) return;
    const mode = dependencies.store.getMode(chat.id, ctx.from.id);
    if (!mode) return;

    try {
      if (ctx.message && "document" in ctx.message && ctx.message.document) {
        console.log(`Telegram document ${ctx.update.update_id}: name=${ctx.message.document.file_name ?? "(unnamed)"} size=${ctx.message.document.file_size ?? "unknown"}`);
        await ctx.reply("已收到文件，正在识别格式……");
      }
      const input = await readAccountInput(ctx, dependencies);
      if (!input) {
        await ctx.reply("请发送 JSON 文本、JSON 文件或 ZIP 压缩包。");
        return;
      }
      const accounts: JsonObject[] = [];
      const conversions = new Map<string, number>();
      let nativeAccounts = 0;
      for (const file of input.files) {
        try {
          const parsed = parseAccountPayloadDetailed(file.text, file.name);
          accounts.push(...parsed.accounts);
          nativeAccounts += parsed.nativeAccounts;
          for (const [format, count] of Object.entries(parsed.conversions)) {
            conversions.set(format, (conversions.get(format) ?? 0) + count);
          }
        } catch (error) {
          if (input.isArchive && error instanceof AccountInputError) {
            throw new AccountInputError(`压缩包中的 ${file.name}：${error.message.trim()}`);
          }
          throw error;
        }
      }
      const conversionLines = [...conversions].map(([format, count]) =>
        `${format} → S2A 账户格式${count > 1 ? `（${count} 条）` : ""}`
      );
      if (input.isArchive) {
        await ctx.reply(`已解压 ${input.files.length} 个 JSON 文件，共读取 ${accounts.length} 条账户。`);
      }
      if (conversionLines.length > 0) {
        await ctx.reply(`识别完成，正在转换：\n${conversionLines.join("\n")}`);
      } else if (nativeAccounts > 0 && !input.isArchive) {
        await ctx.reply(`已读取 ${nativeAccounts} 条 S2A 账户。`);
      }
      if (mode === "template") {
        const template = extractAccountTemplate(accounts[0]);
        dependencies.store.setTemplate(template);
        dependencies.store.clearMode(chat.id, ctx.from.id);
        await replyLong(ctx, `账户模板已保存：\n\n${formatAccountTemplate(template)}`);
        return;
      }

      const template = dependencies.store.getTemplate();
      if (!template) {
        await ctx.reply("尚未设置账户模板，请先使用 /template new。");
        return;
      }
      const merged = accounts.map((account) => {
        const result = mergeAndValidateAccount(template, account);
        const groupId = dependencies.monitor.getGroupId();
        if (groupId) {
          const selectedGroupId = Number.isNaN(Number(groupId)) ? groupId : Number(groupId);
          const existingGroupIds = Array.isArray(result.group_ids) ? result.group_ids : [];
          result.group_ids = [...existingGroupIds, selectedGroupId].filter((id, index, all) =>
            all.findIndex((candidate) => String(candidate) === String(id)) === index
          );
        }
        return result;
      });
      for (const [index, account] of merged.entries()) {
        await dependencies.sub2api.createAccount(account, `telegram-update-${ctx.update.update_id}-${index}`);
      }
      dependencies.store.clearMode(chat.id, ctx.from.id);
      await ctx.reply(`账户创建完成，共创建 ${merged.length} 个账户。`);
    } catch (error) {
      const message = error instanceof AccountInputError ? error.message : "账户导入失败，请检查文件内容、模板和 Sub2API 连接。";
      console.error("Account input failed:", error);
      await ctx.reply(message);
    }
  });
}

async function replyLong(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) await ctx.reply(chunk);
}

function formatGroupLimits(group: ManagedGroup | undefined): string {
  if (!group) return "Sub2API 分组限额：暂不可用";
  const daily = group.daily_limit_usd ?? 0;
  const weekly = group.weekly_limit_usd ?? 0;
  const monthly = group.monthly_limit_usd ?? 0;
  if (daily === 0 && weekly === 0 && monthly === 0) return "Sub2API 分组限额：未设置";
  return `Sub2API 分组限额：每日 $${daily} / 每周 $${weekly} / 每月 $${monthly}`;
}

function groupKeyboard(groups: ManagedGroup[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const group of groups) {
    const label = `${group.name ?? `分组 ${group.id}`}${group.platform ? ` (${group.platform})` : ""}`;
    keyboard.text(label.slice(0, 64), `monitor-group:${group.id}`).row();
  }
  return keyboard;
}

function isAllowedGroup(chat: Context["chat"], allowedChatIds: Set<number>): boolean {
  if (!chat) return false;
  return (chat.type === "group" || chat.type === "supergroup") && allowedChatIds.has(chat.id);
}

interface AccountInputFile {
  name: string;
  text: string;
}

interface AccountInput {
  files: AccountInputFile[];
  isArchive: boolean;
}

async function readAccountInput(ctx: Context, dependencies: BotDependencies): Promise<AccountInput | null> {
  const message = ctx.message;
  if (!message) return null;
  if ("text" in message && typeof message.text === "string") {
    return { files: [{ name: "Telegram text", text: message.text }], isArchive: false };
  }
  if (!("document" in message) || !message.document) return null;

  console.log(`Telegram getFile ${ctx.update.update_id}: requesting metadata`);
  const file = await ctx.api.getFile(message.document.file_id);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  console.log(`Telegram getFile ${ctx.update.update_id}: metadata received`);
  const data = await downloadTelegramFile(
    dependencies.telegramApiBaseUrl,
    dependencies.telegramBotToken,
    dependencies.telegramApiHeaders,
    file.file_path,
  );
  console.log(`Telegram document ${ctx.update.update_id}: downloaded ${data.byteLength} bytes`);
  const sourceName = message.document.file_name ?? "Telegram file";
  if (isZipArchive(data, sourceName)) {
    return { files: await extractJsonFilesFromZip(data), isArchive: true };
  }
  return { files: [{ name: sourceName, text: new TextDecoder().decode(data).replace(/^\uFEFF/, "") }], isArchive: false };
}
