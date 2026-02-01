import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type { FeishuAccountConfig, FeishuConfig } from "./config-schema.js";

export type ResolvedFeishuAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: FeishuAccountConfig;
  configured: boolean;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.["feishu"] as FeishuConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listFeishuAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultFeishuAccountId(cfg: OpenClawConfig): string {
  const channel = cfg.channels?.["feishu"] as FeishuConfig | undefined;
  if (channel?.defaultAccount?.trim()) return channel.defaultAccount.trim();
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: OpenClawConfig, accountId: string): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.["feishu"] as FeishuConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as FeishuAccountConfig | undefined;
}

function mergeFeishuAccountConfig(cfg: OpenClawConfig, accountId: string): FeishuAccountConfig {
  const raw = (cfg.channels?.["feishu"] ?? {}) as FeishuConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as FeishuAccountConfig;
}

export function resolveFeishuAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.["feishu"] as FeishuConfig | undefined)?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const configured = Boolean(merged.appId?.trim() && merged.appSecret?.trim());

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    configured,
  };
}

export function listEnabledFeishuAccounts(cfg: OpenClawConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
