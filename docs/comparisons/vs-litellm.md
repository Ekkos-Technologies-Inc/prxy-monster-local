# prxy vs LiteLLM

[LiteLLM](https://github.com/BerriAI/litellm) (~52k GitHub stars) is the default answer for “one proxy, 100+ models.” prxy is complementary — not a drop-in replacement.

## What LiteLLM does well

- Unified OpenAI-format API across many providers
- Virtual keys, spend tracking, admin UI
- Deploy buttons (Render, Railway, AWS, GCP)
- Python SDK + proxy server

## What prxy adds that LiteLLM does not

| Capability | LiteLLM | prxy |
|------------|---------|------|
| MCP tool pruning | — | `mcp-optimizer` (~33% avg tool-token reduction on fixtures) |
| JSON/code crushers on tool results | — | `structured-crusher`, `code-crusher` |
| Per-module `tokens.saved` on every call | — | Response headers + `/debug` (local) or signed receipt (cloud) |
| Outcome → pattern compounding loop | — | `POST /v1/outcomes` → patterns |
| Cryptographic receipts (cloud) | — | Ed25519 + public JWKS |
| Module marketplace | — | VS Code-extension model for middleware |

## When to use which

- **LiteLLM** — you need the broadest provider matrix and a familiar Python ops story.
- **prxy** — your agent burns context on MCP/tools, you want provable savings, or you want memory that compounds from verified outcomes.

## Use both

Run LiteLLM for provider routing; point a team’s Claude Code / OpenClaw stack at prxy for compression + learn. prxy does not need to win the provider-count race to win the agent-economics layer.

## Bench comparison

```bash
npx prxy-cli bench --fixture mcp-heavy
```

Post the output next to your LiteLLM baseline — different axes (compression vs routing breadth).