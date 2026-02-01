---
summary: "Feishu Open Platform bot via long connection"
read_when:
  - You want to connect OpenClaw to Feishu
  - You need Feishu long connection setup steps
---
# Feishu

OpenClaw connects to Feishu through the Open Platform long connection mode using the
server side SDK. This mode does not require a public callback URL.

## What you need

- A Feishu self build app with bot capability enabled
- App ID and App Secret
- The message event permission for `im.message.receive_v1`

## Setup

1) Create or open your Feishu app in the Open Platform console.
2) Enable the bot capability and add the message event permissions.
3) In Event Subscriptions, select long connection mode.
4) Copy the App ID and App Secret.
5) Update `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxxx"
    }
  }
}
```

6) Start the gateway and send a message to the bot.

## Configuration notes

- Long connection mode does not require a callback URL, verification token, or encrypt key.
- For group chats, use `channels.feishu.groups` to allowlist specific chats.
- For DMs, set `channels.feishu.dm.policy` and `channels.feishu.dm.allowFrom`.
