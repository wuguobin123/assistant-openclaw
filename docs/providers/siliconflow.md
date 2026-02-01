---
summary: "Configure SiliconFlow OpenAI-compatible models"
read_when:
  - You want to use SiliconFlow models with OpenClaw
  - You need the model ref and base URL
  - You want to move your previous model to fallbacks
---
# SiliconFlow

SiliconFlow offers OpenAI-compatible chat completions. Configure a provider in
`models.providers` and select the model by `provider/model`.

Model ref for Kimi K2.5 Pro: `siliconflow/Pro/moonshotai/Kimi-K2.5`.

If you are switching from another primary model, move that model into
`agents.defaults.model.fallbacks`.

## Config snippet

```json5
{
  env: { SILICONFLOW_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "siliconflow/Pro/moonshotai/Kimi-K2.5",
        fallbacks: ["moonshot/kimi-k2.5"]
      },
      models: {
        "siliconflow/Pro/moonshotai/Kimi-K2.5": { alias: "Kimi K2.5 Pro" },
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" }
      }
    }
  },
  models: {
    mode: "merge",
    providers: {
      siliconflow: {
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "${SILICONFLOW_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Pro/moonshotai/Kimi-K2.5",
            name: "Kimi K2.5 Pro",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.55, output: 3, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 262144
          }
        ]
      }
    }
  }
}
```

## Notes

- Replace the fallback entry with your previous primary model.
- If you enable an allowlist via `agents.defaults.models`, include every model you plan to use.
