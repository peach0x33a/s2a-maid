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
  last_used_at?: string | null;
  group_id?: string | number;
  group_ids?: Array<string | number>;
  group?: { id?: string | number };
  credentials?: Record<string, unknown>;
  extra?: Record<string, unknown>;
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
    const pageSize = 200;
    const accounts: ManagedAccount[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        group_id: groupId,
        page: String(page),
        page_size: String(pageSize),
      });
      const payload = await this.request<unknown>(`/api/v1/admin/accounts?${query}`);
      const records = unwrapArray(payload).filter(isManagedAccount);
      accounts.push(...records);

      const pagination = paginationFrom(payload);
      if (pagination.pages !== null) {
        if (page >= pagination.pages) break;
        continue;
      }
      if (pagination.total !== null) {
        if (accounts.length >= pagination.total || records.length === 0) break;
        continue;
      }
      if (records.length < pageSize) break;
    }
    return accounts.filter((account) => belongsToGroup(account, groupId));
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

function paginationFrom(value: unknown): { total: number | null; pages: number | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { total: null, pages: null };
  const record = value as Record<string, unknown>;
  const total = typeof record.total === "number" && Number.isFinite(record.total) ? record.total : null;
  const pages = typeof record.pages === "number" && Number.isFinite(record.pages) ? record.pages : null;
  return { total, pages };
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

export function accountPlanLabel(account: ManagedAccount): "PLUS" | "K12" | "TEAM" | "FREE" | null {
  const planType = account.credentials?.plan_type;
  if (typeof planType !== "string") return null;
  const normalized = planType.trim().toUpperCase();
  return ["PLUS", "K12", "TEAM", "FREE"].includes(normalized)
    ? normalized as "PLUS" | "K12" | "TEAM" | "FREE"
    : null;
}

export function formatManagedAccountName(account: ManagedAccount): string {
  const plan = accountPlanLabel(account);
  return `${account.name ?? "未命名"}${plan ? ` [${plan}]` : ""}`;
}

export type AccountListFilter = "all" | "available" | "unavailable";
export type AccountListSort = "status" | "name" | "id";

export interface AccountListCommand {
  groupId: string | null;
  filter: AccountListFilter;
  sort: AccountListSort;
}

export function parseAccountListCommand(value: string): AccountListCommand | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  let groupId: string | null = null;
  let filter: AccountListFilter = "all";
  let sort: AccountListSort = "status";
  let hasFilter = false;
  let hasSort = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const normalized = token.toLowerCase();
    if (["--all", "--available", "--unavailable"].includes(normalized)) {
      if (hasFilter) return null;
      filter = normalized.slice(2) as AccountListFilter;
      hasFilter = true;
      continue;
    }
    if (normalized === "--sort" || normalized.startsWith("--sort=")) {
      if (hasSort) return null;
      const value = normalized === "--sort" ? tokens[++index]?.toLowerCase() : normalized.slice("--sort=".length);
      if (value !== "status" && value !== "name" && value !== "id") return null;
      sort = value;
      hasSort = true;
      continue;
    }
    if (!/^\d+$/.test(token) || groupId !== null) return null;
    groupId = token;
  }
  return { groupId, filter, sort };
}

export function filterAccounts(accounts: ManagedAccount[], filter: AccountListFilter): ManagedAccount[] {
  if (filter === "available") return accounts.filter(isUsableAccount);
  if (filter === "unavailable") return accounts.filter((account) => !isUsableAccount(account));
  return accounts;
}

export function sortAccounts(accounts: ManagedAccount[], sort: AccountListSort): ManagedAccount[] {
  return [...accounts].sort((left, right) => {
    if (sort === "id") return compareAccountIds(left.id, right.id);
    const nameOrder = (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "base" });
    if (sort === "name") return nameOrder || compareAccountIds(left.id, right.id);
    return statusCategoryOrder(accountStatusCategory(left)) - statusCategoryOrder(accountStatusCategory(right))
      || nameOrder
      || compareAccountIds(left.id, right.id);
  });
}

function compareAccountIds(left: string | number, right: string | number): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

export function accountStatusSummary(accounts: ManagedAccount[]): string {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    const category = accountStatusCategory(account);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => statusCategoryOrder(left) - statusCategoryOrder(right) || left.localeCompare(right))
    .map(([category, count]) => `${category} ${count} 个`)
    .join("，");
}

function accountStatusCategory(account: ManagedAccount): string {
  if (isUsableAccount(account)) return "200";
  const detail = [account.error_message, account.temp_unschedulable_reason]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(" ");
  const explicitCode = detail.match(/(?:^|\D)([45]\d\d)(?:\D|$)/)?.[1];
  if (explicitCode) return explicitCode;
  const normalized = detail.toLowerCase();
  if (/unauthorized|invalid[_ ]?token|authentication/.test(normalized)) return "401";
  if (/forbidden|permission denied/.test(normalized)) return "403";
  if (/too many requests|rate[_ -]?limit/.test(normalized) || account.rate_limited_at) return "429";
  if (/upstream|server error|bad gateway|service unavailable/.test(normalized)) return "5xx";
  if (account.status === "paused") return "暂停";
  if (account.schedulable === false) return "不可调度";
  if (account.status === "error") return "其他错误";
  return account.status ? `状态 ${account.status}` : "状态未知";
}

function statusCategoryOrder(category: string): number {
  if (/^\d{3}$/.test(category)) return Number(category);
  const order: Record<string, number> = { "5xx": 599, "暂停": 600, "不可调度": 601, "其他错误": 602, "状态未知": 604 };
  return order[category] ?? 603;
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
