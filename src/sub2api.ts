import type { Account } from "./types";

export interface ManagedGroup {
  id: string | number;
  name?: string;
  platform?: string;
  status?: string;
  subscription_type?: string;
  daily_limit_usd?: number;
  weekly_limit_usd?: number;
  monthly_limit_usd?: number;
  account_count?: number;
}

export interface ManagedAccount {
  id: string | number;
  name?: string;
  platform?: string;
  type?: string;
  status?: string;
  schedulable?: boolean;
  error_message?: string | null;
  temp_unschedulable_reason?: string | null;
  rate_limited_at?: string | null;
  rate_limit_reset_at?: string | null;
  group_id?: string | number;
  group_ids?: Array<string | number>;
  group?: { id?: string | number };
}

export class Sub2ApiClient {
  constructor(private readonly baseUrl: string, private readonly adminApiKey: string) {}

  async createAccount(account: Account, idempotencyKey: string): Promise<void> {
    await this.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: account,
    });
  }

  async listGroups(): Promise<ManagedGroup[]> {
    const payload = await this.request<unknown>("/api/v1/admin/groups");
    const value = unwrapData(payload);
    const records = value && typeof value === "object" && !Array.isArray(value) && "items" in value
      ? value.items
      : value;
    if (!Array.isArray(records)) throw new Error("Sub2API group list response does not contain an item array");
    return records.filter(isManagedGroup);
  }

  async listAccounts(groupId: string): Promise<ManagedAccount[]> {
    const payload = await this.request<unknown>(`/api/v1/admin/accounts?group_id=${encodeURIComponent(groupId)}`);
    const records = unwrapArray(payload);
    return records.filter(isManagedAccount).filter((account) => belongsToGroup(account, groupId));
  }

  async getUsage(accountId: string | number): Promise<unknown> {
    return this.request(`/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}/usage`);
  }

  private async request<T>(path: string, init: { method?: string; headers?: HeadersInit; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-api-key": this.adminApiKey,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // The HTTP status below provides the useful diagnostic for non-JSON errors.
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : text.slice(0, 300);
      throw new Error(`Sub2API ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${message}`);
    }
    return unwrapData(payload) as T;
  }
}

function unwrapData(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value
    ? value.data
    : value;
}

function unwrapArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["items", "accounts", "results"]) {
      const candidate = value[key as keyof typeof value];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  throw new Error("Sub2API account list response does not contain an account array");
}

function isManagedGroup(value: unknown): value is ManagedGroup {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value
    && (typeof value.id === "string" || typeof value.id === "number");
}

function isManagedAccount(value: unknown): value is ManagedAccount {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value
    && (typeof value.id === "string" || typeof value.id === "number");
}

export function isUsableAccount(account: ManagedAccount): boolean {
  return account.status === "active" && account.schedulable !== false;
}

export type AccountListFilter = "all" | "available" | "unavailable";

export function parseAccountListFilter(value: string): AccountListFilter | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "all" || normalized === "全部") return "all";
  if (["available", "usable", "可用"].includes(normalized)) return "available";
  if (["unavailable", "unusable", "不可用"].includes(normalized)) return "unavailable";
  return null;
}

export function filterAccounts(accounts: ManagedAccount[], filter: AccountListFilter): ManagedAccount[] {
  if (filter === "available") return accounts.filter(isUsableAccount);
  if (filter === "unavailable") return accounts.filter((account) => !isUsableAccount(account));
  return accounts;
}

export function unavailableAccountReason(account: ManagedAccount): string | null {
  if (isUsableAccount(account)) return null;

  const detail = [account.error_message, account.temp_unschedulable_reason]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ");
  const normalized = detail.toLowerCase();

  if (/\b401\b|unauthorized|invalid[_ ]?token|authentication/.test(normalized)) return "401 认证失败";
  if (/\b403\b|forbidden|permission denied/.test(normalized)) return "403 权限不足";
  if (/\b429\b|too many requests|rate[_ -]?limit/.test(normalized) || account.rate_limited_at) return "429 请求受限";
  if (/\b5\d\d\b|upstream|server error|bad gateway|service unavailable/.test(normalized)) return "上游服务异常";
  if (account.status === "paused") return "账户已暂停";
  if (account.status === "error") return detail ? `账户错误：${shortReason(detail)}` : "账户错误";
  if (account.schedulable === false) return detail ? `不可调度：${shortReason(detail)}` : "不可调度";
  if (account.status) return `状态：${account.status}`;
  return "状态未知";
}

function shortReason(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function belongsToGroup(account: ManagedAccount, groupId: string): boolean {
  if (account.group_ids) return account.group_ids.some((id) => String(id) === groupId);
  const accountGroupId = account.group_id ?? account.group?.id;
  if (accountGroupId !== undefined) return String(accountGroupId) === groupId;
  return false;
}
