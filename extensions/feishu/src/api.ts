import * as lark from "@larksuiteoapi/node-sdk";

import type { ResolvedFeishuAccount } from "./accounts.js";

type FeishuSendTarget =
  | { receiveIdType: "chat_id"; receiveId: string }
  | { receiveIdType: "open_id"; receiveId: string }
  | { receiveIdType: "user_id"; receiveId: string };

function resolveReceiveTarget(raw: string): FeishuSendTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat:")) {
    return { receiveIdType: "chat_id", receiveId: trimmed.slice("chat:".length).trim() };
  }
  if (lower.startsWith("open_id:")) {
    return { receiveIdType: "open_id", receiveId: trimmed.slice("open_id:".length).trim() };
  }
  if (lower.startsWith("open:")) {
    return { receiveIdType: "open_id", receiveId: trimmed.slice("open:".length).trim() };
  }
  if (lower.startsWith("user:")) {
    return { receiveIdType: "user_id", receiveId: trimmed.slice("user:".length).trim() };
  }
  return { receiveIdType: "chat_id", receiveId: trimmed };
}

function resolveClientConfig(account: ResolvedFeishuAccount): {
  appId: string;
  appSecret: string;
  domain?: string;
  appType?: unknown;
} {
  const appId = account.config.appId?.trim() ?? "";
  const appSecret = account.config.appSecret?.trim() ?? "";
  const domain = account.config.domain?.trim() || undefined;
  const appType = account.config.appType?.trim().toLowerCase();
  const resolvedType =
    appType === "isv"
      ? (lark as { AppType?: { ISV?: unknown } }).AppType?.ISV
      : appType === "self_build"
        ? (lark as { AppType?: { SelfBuild?: unknown } }).AppType?.SelfBuild
        : undefined;
  return {
    appId,
    appSecret,
    ...(domain ? { domain } : {}),
    ...(resolvedType ? { appType: resolvedType } : {}),
  };
}

export function createFeishuClient(account: ResolvedFeishuAccount): lark.Client {
  const config = resolveClientConfig(account);
  return new lark.Client(config as ConstructorParameters<typeof lark.Client>[0]);
}

export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  to: string;
  text: string;
}): Promise<void> {
  const { account, to, text } = params;
  const target = resolveReceiveTarget(to);
  if (!target) throw new Error("Feishu target is empty");
  if (!target.receiveId) throw new Error("Feishu target missing receive_id");
  const client = createFeishuClient(account);
  const content = JSON.stringify({ text });
  const data = {
    receive_id: target.receiveId,
    msg_type: "text",
    content,
  } as const;

  const paramsInput = { receive_id_type: target.receiveIdType } as const;

  if (account.config.tenantKey?.trim()) {
    const withTenantKey = (lark as { withTenantKey?: (key: string) => unknown }).withTenantKey;
    if (withTenantKey) {
      await client.im.message.create({ params: paramsInput, data }, withTenantKey(account.config.tenantKey.trim()));
      return;
    }
  }

  await client.im.message.create({ params: paramsInput, data });
}
