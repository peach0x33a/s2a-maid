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
  group_id?: string | number;
  group_ids?: Array<string | number>;
  group?: { id?: string | number };
}

export type Sub2ApiAuth =
  | { type: "api-key"; value: string }
  | { type: "bearer"; value: string };

export class Sub2ApiClient {
  constructor(private readonly baseUrl: string, private readonly auth: Sub2ApiAuth) {}

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
        ...(this.auth.type === "api-key"
          ? { "x-api-key": this.auth.value }
          : { authorization: `Bearer ${this.auth.value}` }),
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

function belongsToGroup(account: ManagedAccount, groupId: string): boolean {
  if (account.group_ids) return account.group_ids.some((id) => String(id) === groupId);
  const accountGroupId = account.group_id ?? account.group?.id;
  if (accountGroupId !== undefined) return String(accountGroupId) === groupId;
  return false;
}
