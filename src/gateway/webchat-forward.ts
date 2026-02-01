import crypto from "node:crypto";

import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

type FeishuWebhookConfig = {
  enabled?: boolean;
  webhook?: string;
  secret?: string;
  keyword?: string;
};

type WebchatNotifyConfig = {
  enabled?: boolean;
  feishu?: FeishuWebhookConfig;
};

type LoggerLike = {
  warn: (message: string) => void;
};

const isWebchatChannel = (channel?: string | null) =>
  normalizeMessageChannel(channel) === "webchat";

export async function forwardWebchatFinal(params: {
  cfg: OpenClawConfig;
  text: string;
  sessionKey?: string;
  sessionChannel?: string | null;
  log?: LoggerLike;
}): Promise<void> {
  const notify: WebchatNotifyConfig | undefined = params.cfg.gateway?.webchat?.notify;
  if (!notify?.enabled) return;
  if (!isWebchatChannel(params.sessionChannel)) return;

  const feishu = notify.feishu;
  if (!feishu || feishu.enabled === false) return;
  const webhook = feishu.webhook?.trim();
  if (!webhook) {
    params.log?.warn(
      `webchat forward skipped: missing Feishu webhook (session ${params.sessionKey ?? "n/a"})`,
    );
    return;
  }

  const baseText = params.text.trim();
  if (!baseText) return;
  const text = feishu.keyword ? `${feishu.keyword} ${baseText}` : baseText;

  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: { text },
  };
  const secret = feishu.secret?.trim();
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
    payload.timestamp = timestamp;
    payload.sign = sign;
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Feishu webhook HTTP ${res.status}`);
  }
  if (json?.code && json.code !== 0) {
    throw new Error(`Feishu webhook error: ${json.msg ?? "unknown"}`);
  }
}
