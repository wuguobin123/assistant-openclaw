import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

export const FeishuDmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .strict();

export const FeishuGroupEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    users: z.array(allowFromEntry).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const FeishuAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    verificationToken: z.string().optional(),
    encryptKey: z.string().optional(),
    botUserId: z.string().optional(),
    botOpenId: z.string().optional(),
    botName: z.string().optional(),
    allowBots: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
    groups: z.record(z.string(), FeishuGroupEntrySchema).optional(),
    dm: FeishuDmConfigSchema.optional(),
    markdown: MarkdownConfigSchema,
    domain: z.string().optional(),
    appType: z.enum(["self_build", "isv"]).optional(),
    tenantKey: z.string().optional(),
  })
  .strict();

export const FeishuConfigSchema = FeishuAccountConfigSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), FeishuAccountConfigSchema).optional(),
}).strict();

export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

export const feishuChannelConfigSchema = buildChannelConfigSchema(FeishuConfigSchema);
