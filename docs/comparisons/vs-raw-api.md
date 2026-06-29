# prxy vs calling the provider directly

Calling Anthropic/OpenAI/Bedrock directly is the baseline. prxy sits in front — one env var.

## What you keep

- Your provider API key
- Your provider bill (BYOK — prxy does not markup inference tokens)
- Same wire format (`/v1/messages`, `/v1/chat/completions`)

## What you gain

| Direct API | Through prxy |
|------------|--------------|
| Provider response + usage | Same + module pipeline |
| No cache across near-identical prompts | `exact-cache` / `semantic-cache` |
| Full MCP tool defs every turn | `mcp-optimizer` prunes per query |
| Raw 10k-row JSON tool results | Crushers fold before the model |
| Session amnesia after compaction | `compaction-bridge`, `ipc`, `patterns` |
| “Trust us, we saved tokens” | `x-prxy-tokens-saved` + `/debug` (local) or signed receipt (cloud) |

## Cost math

prxy bills **requests** on cloud (free tier: 1,000/mo). Provider still bills **tokens**.

The ROI is fewer input tokens per request — especially on agent workloads where tools dominate context.

## Try it without commitment

```bash
# Cloud sandbox — 5 real calls, 5 signed receipts
open https://prxy.monster/sandbox/

# Local — fully offline gateway
docker run -p 3099:3099 -e ANTHROPIC_API_KEY=sk-ant-xxx prxymonster/local
```

## Bench the delta

```bash
npx prxy-cli bench --fixture all
```

Share the fixture output — that's the before/after story raw API cannot tell.