import { Bot, InlineKeyboard, type Context } from "grammy";
import { AccountInputError, extractAccountTemplate, mergeAndValidateAccount, parseAccountPayloadDetailed } from "./accounts";
import { extractJsonFilesFromZip, isZipArchive } from "./archive";
import { buildFinalCodexAgentAccount, CodexAgentInputError, convertCodexAgentInput, parseCodexAgentPayload } from "./codex-agent";
import type { Store } from "./database";
import { runNetCheck } from "./netcheck";
import type { ProxyScope } from "./proxy";
import {
  accountStatusSummary,
  filterAccounts,
  formatManagedAccountName,
  isUsableAccount,
  parseAccountListCommand,
  sortAccounts,
  unavailableAccountReason,
  type ManagedGroup,
  type Sub2ApiClient,
} from "./sub2api";
import type { UsageMonitor } from "./monitor";
import { downloadTelegramFile } from "./telegram";
import { extractUsageWindows, usageWindowsForDisplay } from "./usage";
import {
  accountConversionTarget,
  formatAccountConversionNotice,
  formatAccountTemplate,
  parseAccountImportMode,
  parseOptionalGroupId,
  parseTemplateCommand,
  splitTelegramText,
} from "./messages";
import type { JsonObject } from "./types";

export interface BotDependencies {
  store: Store;
  sub2api: Sub2ApiClient;
  allowedChatIds: Set<number>;
  telegramApiBaseUrl: string;
  telegramBotToken: string;
  telegramApiHeaders: HeadersInit;
  telegramProxyUrl: string | null;
  codexAgentFetch: typeof fetch;
  monitor: UsageMonitor;
  proxyUrl: string | null;
  proxyScopes: Set<ProxyScope>;
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
    const command = parseAccountListCommand(ctx.match ?? "");
    if (!command) {
      await ctx.reply("参数无效。用法：/list [分组ID] [--all|--available|--unavailable] [--sort status|name|id]");
      return;
    }
    const groupId = command.groupId ?? dependencies.monitor.getGroupId();
    if (!groupId) {
      await ctx.reply("请指定分组 ID，或先使用 /group 选择监控分组。");
      return;
    }
    const filter = command.filter;
    try {
      const accounts = await dependencies.sub2api.listAccounts(groupId);
      const selected = sortAccounts(filterAccounts(accounts, filter), command.sort);
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
      const summary = filter === "available" ? "" : `\n\n总计：${accountStatusSummary(selected)}`;
      await replyLong(
        ctx,
        `分组 ${groupId} ${filterLabel}（显示 ${selected.length} 个；全部 ${accounts.length} 个，可用 ${usableCount} 个）：\n\n` +
        `${lines.join("\n")}${summary}`,
      );
    } catch (error) {
      console.error("Account listing failed:", error);
      await ctx.reply("暂时无法获取账户列表，请稍后重试。");
    }
  });

  bot.command("usage", async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    const requestedGroupId = parseOptionalGroupId(ctx.match ?? "");
    if (requestedGroupId === undefined) {
      await ctx.reply("参数无效。用法：/usage [分组ID]");
      return;
    }
    const groupId = requestedGroupId ?? dependencies.monitor.getGroupId();
    if (!groupId) {
      await ctx.reply("请指定分组 ID，或先使用 /group 选择监控分组。");
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
          const displayWindows = usageWindowsForDisplay(windows, account.last_used_at);
          const lines = displayWindows.length > 0
            ? displayWindows.map((window) => `${window.label}: 剩余 ${window.remainingPercent.toFixed(1)}%`)
            : ["暂无可识别用量窗口"];
          for (const window of displayWindows) {
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
      await ctx.reply("参数无效。使用 /template 查看当前模板，或使用 /template --new 设置新模板。");
      return;
    }
    if (action === "show") {
      const template = dependencies.store.getTemplate();
      if (!template) {
        await ctx.reply("尚未设置账户模板。使用 /template --new 上传现有的 S2A 账户文件。");
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
    const importMode = parseAccountImportMode(ctx.match ?? "");
    if (importMode === "invalid") {
      await ctx.reply("参数无效。使用 /acc 导入 S2A 账户，或使用 /acc --codex-agent（简写 -ca）转换并导入 Codex Agent Identity。");
      return;
    }
    dependencies.store.setMode(chat.id, ctx.from.id, importMode);
    if (importMode === "codex-agent") {
      await ctx.reply("请上传 Web Session、Codex auth.json、S2A 账户 JSON、现有 Agent Identity 或包含这些 JSON 的 ZIP。将转换为 Codex Agent Identity，并通过管理员 API 导入 Sub2API。");
      return;
    }
    await ctx.reply("请上传账户或登录文件，也可以上传包含 JSON 文件的 ZIP 压缩包。支持 S2A、ChatGPT Session、9router、Codex、AxonHub 和 Codex-Manager 格式。");
  });

  bot.command("cancel", async (ctx) => {
    const chat = ctx.chat;
    if (!isAllowedGroup(chat, dependencies.allowedChatIds) || !ctx.from) return;
    dependencies.store.clearMode(chat.id, ctx.from.id);
    await ctx.reply("已取消当前操作。");
  });

  bot.command("netcheck", async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    await ctx.reply("正在检测网络……");
    const results = await runNetCheck(dependencies.proxyUrl, dependencies.proxyScopes);
    const lines = results.map((r) => {
      const ip = r.ip ?? (r.error ? "—" : "—");
      const status = r.error ? `❌ ${r.error}` : "✅";
      return `${r.label} · ${ip} · ${r.latencyMs}ms ${status}`;
    });
    await ctx.reply(lines.join("\n"));
  });

  bot.command(["help", "start"], async (ctx) => {
    if (!isAllowedGroup(ctx.chat, dependencies.allowedChatIds)) return;
    await ctx.reply("可用命令：\n/template 查看账户模板\n/template --new 设置新模板\n/acc 导入 S2A 账户\n/acc --codex-agent（-ca）转换并导入 Codex Agent Identity\n/list [分组ID] [--all|--available|--unavailable] [--sort status|name|id] 查看账户\n/usage [分组ID] 查看可用账户用量\n/monitor 查看监控状态和不可用原因\n/group 选择监控分组\n/netcheck 检测网络连通性\n/cancel 取消当前操作\n\n/list 和 /usage 默认查询当前监听分组；指定分组 ID 只查询该分组，不会改变监听设置。");
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
      if (mode === "codex-agent") {
        const template = dependencies.store.getTemplate();
        if (!template) {
          await ctx.reply("尚未设置账户模板，请先使用 /template --new。Codex Agent Identity 导入会继承模板中的代理和其他静态设置。");
          return;
        }
        const selectedGroupId = dependencies.monitor.getGroupId();
        if (!selectedGroupId) {
          await ctx.reply("请先使用 /group 选择导入分组。Codex Agent Identity 会导入到当前选中的分组。");
          return;
        }
        const inputs = input.files.flatMap((file) => {
          try {
            return parseCodexAgentPayload(file.text);
          } catch (error) {
            if (input.isArchive && error instanceof CodexAgentInputError) {
              throw new CodexAgentInputError(`压缩包中的 ${file.name}：${error.message}`);
            }
            throw error;
          }
        });
        const finalAccounts = [];
        const noticeCounts = new Map<string, { source: string; target: ReturnType<typeof accountConversionTarget>; count: number }>();
        for (const [index, source] of inputs.entries()) {
          const converted = await convertCodexAgentInput(source, dependencies.codexAgentFetch);
          const account = buildFinalCodexAgentAccount(
            template,
            converted.authJson,
            selectedGroupId,
            `Codex Agent Identity ${index + 1}`,
          );
          finalAccounts.push(account);
          const target = accountConversionTarget(account);
          const key = `${source.source}\u0000${target}`;
          const existing = noticeCounts.get(key);
          noticeCounts.set(key, { source: source.source, target, count: (existing?.count ?? 0) + 1 });
        }
        const notices = [...noticeCounts.values()].map(({ source, target, count }) =>
          formatAccountConversionNotice(source, target, count)
        );
        await ctx.reply(notices.join("\n\n"));
        for (const [index, account] of finalAccounts.entries()) {
          await dependencies.sub2api.createAccount(account, `telegram-codex-agent-${ctx.update.update_id}-${index}`);
        }
        dependencies.store.clearMode(chat.id, ctx.from.id);
        await ctx.reply(`Codex Agent Identity 导入完成，共创建 ${inputs.length} 个账户。`);
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
      const conversionNotices = [...conversions].map(([format, count]) =>
        formatAccountConversionNotice(format, "S2A 账户格式", count)
      );
      if (input.isArchive) {
        await ctx.reply(`已解压 ${input.files.length} 个 JSON 文件，共读取 ${accounts.length} 条账户。`);
      }
      if (conversionNotices.length > 0) {
        await ctx.reply(conversionNotices.join("\n\n"));
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
        await ctx.reply("尚未设置账户模板，请先使用 /template --new。");
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
      const message = error instanceof AccountInputError || error instanceof CodexAgentInputError
        ? error.message
        : "账户导入失败，请检查文件内容、模板和 Sub2API 连接。";
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
    dependencies.telegramProxyUrl,
  );
  console.log(`Telegram document ${ctx.update.update_id}: downloaded ${data.byteLength} bytes`);
  const sourceName = message.document.file_name ?? "Telegram file";
  if (isZipArchive(data, sourceName)) {
    return { files: await extractJsonFilesFromZip(data), isArchive: true };
  }
  return { files: [{ name: sourceName, text: new TextDecoder().decode(data).replace(/^\uFEFF/, "") }], isArchive: false };
}
