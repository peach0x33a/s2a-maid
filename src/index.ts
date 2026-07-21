import { Bot } from "grammy";
import { registerBotHandlers } from "./bot";
import { configPathFromArgs, loadConfig } from "./config";
import { Store } from "./database";
import { UsageMonitor } from "./monitor";
import { Sub2ApiClient } from "./sub2api";
import { createTelegramFetch } from "./telegram";
import { APP_VERSION } from "./version";

console.log(`s2a-maid v${APP_VERSION}`);
const configPath = configPathFromArgs();
const config = loadConfig(configPath);
const store = new Store(config.databasePath);
const bot = new Bot(config.telegramBotToken, {
  client: {
    apiRoot: config.telegramApiBaseUrl,
    fetch: createTelegramFetch(config.telegramApiHeaders),
  },
});
const sub2api = new Sub2ApiClient(config.sub2ApiBaseUrl, config.sub2ApiAdminApiKey);
const monitor = new UsageMonitor(
  sub2api,
  { sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text) },
  store,
  store.getMonitorGroupId() ?? config.monitorGroupId,
  config.alertChatId,
  config.lowQuotaPercent,
  config.usageCheckIntervalSeconds,
);

bot.use(async (ctx, next) => {
  const chat = ctx.chat;
  if (chat) console.log(`Telegram update ${ctx.update.update_id}: chat=${chat.id} type=${chat.type}`);
  await next();
});

registerBotHandlers(bot, {
  store,
  sub2api,
  allowedChatIds: config.allowedChatIds,
  telegramApiBaseUrl: config.telegramApiBaseUrl,
  telegramBotToken: config.telegramBotToken,
  telegramApiHeaders: config.telegramApiHeaders,
  monitor,
});

bot.catch((error) => console.error("grammY handler failed:", error));
monitor.start();
console.log(`s2a-maid v${APP_VERSION} started with ${configPath}; monitoring group ${store.getMonitorGroupId() ?? config.monitorGroupId ?? "(not selected)"} every ${config.usageCheckIntervalSeconds}s`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  monitor.stop();
  await bot.stop();
  store.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await bot.start({ allowed_updates: ["message", "callback_query"] });
