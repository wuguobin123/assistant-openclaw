import * as lark from "@larksuiteoapi/node-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk";

import { sendFeishuText } from "./api.js";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";

export type FeishuRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type FeishuEventSenderId = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
};

type FeishuEventSender = {
  sender_type?: string;
  sender_id?: FeishuEventSenderId;
};

type FeishuEventMessage = {
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  msg_type?: string;
  content?: unknown;
  mentions?: unknown[];
  root_id?: string;
  parent_id?: string;
};

type FeishuMessageEvent = {
  message?: FeishuEventMessage;
  sender?: FeishuEventSender;
  event_time?: string | number;
};

type FeishuCoreRuntime = ReturnType<typeof getFeishuRuntime>;

const activeClients = new Map<string, lark.WSClient>();

function logVerbose(core: FeishuCoreRuntime, runtime: FeishuRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[feishu] ${message}`);
  }
}

function normalizeUserId(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

function resolveSenderId(sender?: FeishuEventSender): string {
  const senderId = sender?.sender_id ?? {};
  return (
    senderId.open_id?.trim() || senderId.user_id?.trim() || senderId.union_id?.trim() || ""
  );
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
        if (text) return text;
      } catch {
        // fall through to raw content
      }
    }
    return trimmed;
  }
  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (text) return text;
  }
  return "";
}

function extractMentionInfo(params: {
  mentions: unknown[] | undefined;
  rawContent: string;
  botOpenId?: string;
  botUserId?: string;
  botName?: string;
}): { hasAnyMention: boolean; wasMentioned: boolean; canDetectMention: boolean } {
  const { mentions, rawContent, botOpenId, botUserId, botName } = params;
  const list = Array.isArray(mentions) ? mentions : [];
  const hasAnyMention = list.length > 0 || rawContent.includes("<at ");
  const targets = new Set(
    [botOpenId?.trim(), botUserId?.trim(), botName?.trim()].filter(Boolean) as string[],
  );
  let wasMentioned = false;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const idRecord =
      record.id && typeof record.id === "object" ? (record.id as Record<string, unknown>) : null;
    const openId = idRecord && typeof idRecord.open_id === "string" ? idRecord.open_id.trim() : "";
    const userId = idRecord && typeof idRecord.user_id === "string" ? idRecord.user_id.trim() : "";
    if (targets.has(name) || targets.has(openId) || targets.has(userId)) {
      wasMentioned = true;
      break;
    }
  }
  if (!wasMentioned && botUserId) {
    const marker = `user_id=\\"${botUserId}\\"`;
    if (rawContent.includes(marker)) {
      wasMentioned = true;
    }
  }
  const canDetectMention = list.length > 0 || rawContent.includes("<at ");
  return { hasAnyMention, wasMentioned, canDetectMention };
}

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      allow?: boolean;
      enabled?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false, fallback: undefined };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const candidates = [groupId, groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

function isSenderAllowed(senderId: string, allowFrom: string[]) {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = normalizeUserId(senderId);
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === normalizedSenderId) return true;
    if (normalized.replace(/^(feishu|lark|user|open_id):/i, "") === normalizedSenderId) {
      return true;
    }
    return false;
  });
}

async function processMessageWithPipeline(params: {
  event: FeishuMessageEvent;
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  runtime: FeishuRuntimeEnv;
  core: FeishuCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink } = params;
  const message = event.message;
  if (!event || !message) return;

  const chatId = message.chat_id?.trim() ?? "";
  if (!chatId) return;
  const chatType = message.chat_type?.toLowerCase().trim() ?? "";
  const isGroup = chatType !== "p2p";

  const sender = event.sender;
  const senderId = resolveSenderId(sender);
  const senderType = sender?.sender_type?.toLowerCase().trim();

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (senderType === "bot") {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId && senderId === account.config.botOpenId?.trim()) {
      logVerbose(core, runtime, "skip bot-authored message (bot open_id)");
      return;
    }
  }

  const rawContent = typeof message.content === "string" ? message.content : "";
  const messageText = extractMessageText(message.content);
  const rawBody = messageText.trim();
  if (!rawBody) return;

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupConfigResolved = resolveGroupConfig({
    groupId: chatId,
    groupName: null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `drop group message (groupPolicy=disabled, chat=${chatId})`);
      return;
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed = Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(
          core,
          runtime,
          `drop group message (groupPolicy=allowlist, no allowlist, chat=${chatId})`,
        );
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop group message (not allowlisted, chat=${chatId})`);
        return;
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(core, runtime, `drop group message (chat disabled, chat=${chatId})`);
      return;
    }

    if (groupUsers.length > 0) {
      const ok = isSenderAllowed(senderId, groupUsers.map((v) => String(v)));
      if (!ok) {
        logVerbose(core, runtime, `drop group message (sender not allowed, ${senderId})`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("feishu").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const commandAllowFrom = isGroup ? groupUsers.map((v) => String(v)) : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const mentionInfo = extractMentionInfo({
      mentions: message.mentions,
      rawContent,
      botOpenId: account.config.botOpenId,
      botUserId: account.config.botUserId,
      botName: account.config.botName,
    });
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "feishu",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: mentionInfo.canDetectMention,
      wasMentioned: mentionInfo.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionInfo.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      commandAuthorized: commandAuthorized === true,
    });
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (mentionGate.shouldSkip) {
      logVerbose(core, runtime, `drop group message (mention required, chat=${chatId})`);
      return;
    }
  }

  if (!isGroup) {
    if (dmPolicy === "disabled" || account.config.dm?.enabled === false) {
      logVerbose(core, runtime, `Blocked Feishu DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "feishu",
            id: senderId,
          });
          if (created) {
            logVerbose(core, runtime, `feishu pairing request sender=${senderId}`);
            try {
              await sendFeishuText({
                account,
                to: `open_id:${senderId}`,
                text: core.channel.pairing.buildPairingReply({
                  channel: "feishu",
                  idLine: `Your Feishu user id: ${senderId}`,
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(core, runtime, `pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized Feishu sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `feishu: drop control command from ${senderId}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  const fromLabel = isGroup ? `chat:${chatId}` : senderId || "user:unknown";
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const eventTimestamp =
    typeof event.event_time === "string"
      ? Date.parse(event.event_time)
      : typeof event.event_time === "number"
        ? event.event_time
        : undefined;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: fromLabel,
    timestamp: eventTimestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupEntry?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `feishu:${senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderId || undefined,
    SenderId: senderId,
    SenderUsername: senderId || undefined,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: message.message_id,
    MessageSidFull: message.message_id,
    ReplyToId: message.root_id ?? message.parent_id,
    ReplyToIdFull: message.root_id ?? message.parent_id,
    GroupSpace: isGroup ? chatId : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    OriginatingChannel: "feishu",
    OriginatingTo: `feishu:${chatId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`feishu: failed updating session meta: ${String(err)}`);
    });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (!payload.text?.trim()) return;
        await sendFeishuText({
          account,
          to: `chat:${chatId}`,
          text: payload.text,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

function resolveWsClientConfig(account: ResolvedFeishuAccount): {
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

function createEventDispatcher(params: {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  runtime: FeishuRuntimeEnv;
  core: FeishuCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): lark.EventDispatcher {
  const encryptKey = params.account.config.encryptKey?.trim();
  const dispatcher = new lark.EventDispatcher(encryptKey ? { encryptKey } : {});
  dispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      try {
        await processMessageWithPipeline({
          event: data as FeishuMessageEvent,
          account: params.account,
          config: params.config,
          runtime: params.runtime,
          core: params.core,
          statusSink: params.statusSink,
        });
      } catch (err) {
        params.runtime.error?.(`feishu event handler failed: ${String(err)}`);
      }
    },
  });
  return dispatcher;
}

export async function startFeishuMonitor(params: {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  runtime: FeishuRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<() => void> {
  const { account, config, runtime, abortSignal, statusSink } = params;
  const core = getFeishuRuntime();
  const clientConfig = resolveWsClientConfig(account);
  if (!clientConfig.appId || !clientConfig.appSecret) {
    throw new Error("Feishu appId/appSecret are required for long connection mode");
  }

  const dispatcher = createEventDispatcher({ account, config, runtime, core, statusSink });
  const wsClient = new lark.WSClient(clientConfig as ConstructorParameters<typeof lark.WSClient>[0]);
  activeClients.set(account.accountId, wsClient);

  const startResult = wsClient.start({ eventDispatcher: dispatcher }) as Promise<void> | void;
  if (startResult && typeof (startResult as Promise<void>).catch === "function") {
    (startResult as Promise<void>).catch((err) => {
      runtime.error?.(`[${account.accountId}] Feishu WSClient start failed: ${String(err)}`);
    });
  }

  const stopClient = () => {
    const existing = activeClients.get(account.accountId);
    if (existing) {
      const maybeStop = (existing as { stop?: () => void }).stop;
      if (typeof maybeStop === "function") {
        maybeStop();
      }
      activeClients.delete(account.accountId);
    }
  };

  abortSignal.addEventListener("abort", stopClient, { once: true });
  return () => {
    abortSignal.removeEventListener("abort", stopClient);
    stopClient();
  };
}
