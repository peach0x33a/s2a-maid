import type { Store } from "./database";
import { isUsableAccount, type Sub2ApiClient } from "./sub2api";
import { extractUsageWindows } from "./usage";

export interface AlertNotifier {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface MonitorStatus {
  groupId: string | null;
  running: boolean;
  threshold: number;
  intervalSeconds: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  totalAccounts: number;
  usableAccounts: number;
}

export class UsageMonitor {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private totalAccounts = 0;
  private usableAccounts = 0;

  constructor(
    private readonly sub2api: Sub2ApiClient,
    private readonly telegram: AlertNotifier,
    private readonly store: Store,
    private groupId: string | null,
    private readonly alertChatId: number,
    private readonly threshold: number,
    private readonly intervalSeconds: number,
  ) {}

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  setGroupId(groupId: string): void {
    this.groupId = groupId;
    void this.check();
  }

  getGroupId(): string | null {
    return this.groupId;
  }

  getStatus(): MonitorStatus {
    return {
      groupId: this.groupId,
      running: this.running,
      threshold: this.threshold,
      intervalSeconds: this.intervalSeconds,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      totalAccounts: this.totalAccounts,
      usableAccounts: this.usableAccounts,
    };
  }

  async check(): Promise<void> {
    if (this.running || !this.groupId) return;
    this.running = true;
    try {
      const accounts = await this.sub2api.listAccounts(this.groupId);
      const usable = accounts.filter(isUsableAccount);
      this.totalAccounts = accounts.length;
      this.usableAccounts = usable.length;
      this.lastError = null;
      for (const account of usable) {
        try {
          await this.checkAccount(account);
        } catch (error) {
          console.error(`Usage check failed for account ${account.id}:`, error);
        }
      }
      this.lastCheckedAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastCheckedAt = new Date().toISOString();
      console.error("Usage monitor failed:", error);
    } finally {
      this.running = false;
    }
  }

  private async checkAccount(account: { id: string | number; name?: string }): Promise<void> {
    const accountId = String(account.id);
    const payload = await this.sub2api.getUsage(account.id);
    for (const window of extractUsageWindows(payload)) {
      if (window.remainingPercent >= this.threshold) {
        this.store.clearAlert(accountId, window.key);
        continue;
      }
      if (!this.store.claimAlert(accountId, window.key)) continue;

      const name = account.name ?? accountId;
      await this.telegram.sendMessage(
        this.alertChatId,
        `低余额告警\\n账户: ${name} (${accountId})\\n窗口: ${window.label}\\n剩余: ${window.remainingPercent.toFixed(1)}%`,
      );
    }
  }
}
