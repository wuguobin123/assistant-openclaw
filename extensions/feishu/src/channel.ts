import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
} from "openclaw/plugin-sdk";

import { sendFeishuText } from "./api.js";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  type ResolvedFeishuAccount,
} from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { startFeishuMonitor } from "./monitor.js";
import { getFeishuRuntime } from "./runtime.js";

const meta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu (Open Platform)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "Feishu Open Platform events + bot replies.",
  aliases: ["lark"],
  order: 65,
} as const;

function normalizeFeishuTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^(feishu|lark):/i, "");
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    media: false,
    reactions: false,
    threads: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: ["channels.feishu"] },
  configSchema: buildChannelConfigSchema(FeishuConfigSchema),
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...(cfg.channels?.feishu ?? {}),
          accounts: {
            ...((cfg.channels?.feishu as { accounts?: Record<string, unknown> })?.accounts ?? {}),
            [accountId]: {
              ...(((cfg.channels?.feishu as { accounts?: Record<string, unknown> })?.accounts ?? {})[
                accountId
              ] as Record<string, unknown>),
              enabled,
            },
          },
        },
      },
    }),
    deleteAccount: ({ cfg, accountId }) => {
      const next = { ...cfg } as OpenClawConfig;
      const nextChannels = { ...cfg.channels } as Record<string, unknown>;
      const feishu = (nextChannels.feishu ?? {}) as Record<string, unknown>;
      const accounts = { ...(feishu.accounts as Record<string, unknown>) };
      delete accounts[accountId];
      if (Object.keys(accounts).length > 0) {
        feishu.accounts = accounts;
        nextChannels.feishu = feishu;
      } else {
        delete nextChannels.feishu;
      }
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      mode: "long",
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveFeishuAccount({ cfg, accountId }).config.dm?.allowFrom?.map((v) => String(v)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  pairing: {
    idLabel: "feishuUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|lark|user|open_id):/i, ""),
    notifyApproval: async ({ id, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      await sendFeishuText({ account, to: `open_id:${id}`, text: "Your pairing request has been approved!" });
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        policyPath: "channels.feishu.dm.policy",
        allowFromPath: "channels.feishu.dm.allowFrom",
        approveHint: formatPairingApproveHint("feishu"),
        normalizeEntry: (raw) => raw.replace(/^(feishu|lark|user|open_id):/i, "").trim(),
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeFeishuTarget,
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        if (!trimmed) return false;
        if (/^(chat|user|open_id|open):/i.test(trimmed)) return true;
        return /^[a-z0-9_\-]+$/i.test(trimmed);
      },
      hint: "<chat_id|chat:CHAT_ID|open_id:OPEN_ID|user:USER_ID>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, accountId }) => {
      const core = getFeishuRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveFeishuAccount({ cfg, accountId: aid });
      if (!account.configured) {
        throw new Error(`Feishu account ${aid} is not configured`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "feishu",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      await sendFeishuText({ account, to, text: message });
      return { channel: "feishu", to };
    },
    sendMedia: async () => {
      throw new Error("Feishu media messages are not supported.");
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      mode: "long",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Feishu long connection`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        mode: "long",
      });
      const unregister = await startFeishuMonitor({
        account,
        config: ctx.cfg as OpenClawConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
