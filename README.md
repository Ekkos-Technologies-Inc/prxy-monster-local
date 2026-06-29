# prxy-monster-local

**Compress → prove → learn** — the open-source middleware between your agent and the model.

One env var. Crushers and caches shrink context **before** the model sees it. Every response stamps `x-prxy-tokens-saved` and `x-prxy-call-id`. Positive outcomes auto-promote into **patterns** on the next call (local mode — no reviewer required).

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/Ekkos-Technologies-Inc/prxy-monster-local/actions/workflows/ci.yml/badge.svg)](https://github.com/Ekkos-Technologies-Inc/prxy-monster-local/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/prxymonster/local)](https://hub.docker.com/r/prxymonster/local)
[![Homepage](https://img.shields.io/badge/homepage-prxy.monster-84e61c)](https://prxy.monster)
[![Docs](https://img.shields.io/badge/docs-the%20loop-84e61c)](https://docs.prxy.monster/concepts/the-loop)

---

## Claude Code in 60 seconds

```bash
docker run -p 3099:3099 -v ~/.prxy:/data \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  prxymonster/local
```

```bash
export ANTHROPIC_BASE_URL=http://localhost:3099
export ANTHROPIC_API_KEY=sk-ant-xxx   # your real Anthropic key
claude
```

| Before | After prxy |
|--------|------------|
| ~67k tokens of MCP defs load every turn | `mcp-optimizer` prunes to what the query needs |
| Bulky JSON/file tool results refill context | `structured-crusher` + `code-crusher` fold them |
| Session resets wipe useful fixes | `patterns` injects what worked last time |
| No proof of savings | `http://localhost:3099/debug` shows tokens saved per call |

Full walkthrough: [prxy-monster-examples/claude-code-setup](https://github.com/Ekkos-Technologies-Inc/prxy-monster-examples/tree/main/examples/claude-code-setup)

---

## Prove it — shareable bench

```bash
npx prxy-cli bench --fixture mcp-heavy
# → 142,000 → 48,200 tokens (−66% · MCP fixture)

npx prxy-cli bench --fixture json-tools
# → structured-crusher + code-crusher on synthetic tool_result payloads
```

Numbers are **reproducible** (fixed fixtures, stub embeddings). Post the output — that's the star-worthy screenshot.

---

## The loop (local)

```
compress  →  prove  →  learn  →  (next call)
```

1. **Compress** — default pipeline:
   ```
   mcp-optimizer → exact-cache → semantic-cache → structured-crusher → code-crusher → ipc → patterns
   ```
2. **Prove** — open `http://localhost:3099/debug` or read response headers:
   ```
   x-prxy-call-id: <uuid>
   x-prxy-tokens-saved: 8420
   ```
3. **Learn** — attach an outcome; high-confidence successes auto-promote to patterns:
   ```bash
   curl -X POST http://localhost:3099/v1/outcomes \
     -H "Content-Type: application/json" \
     -d '{
       "call_id": "<from x-prxy-call-id>",
       "outcome": "succeeded",
       "source": "agent_runner",
       "score": 0.95
     }'
   ```

Cloud uses human reviewers; **local auto-promotes by default** (`PRXY_AUTO_PROMOTE_PATTERNS=true`). Docs: [The loop](https://docs.prxy.monster/concepts/the-loop)

---

## Quick start — Docker

```bash
docker run -p 3099:3099 -v ~/.prxy:/data \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  prxymonster/local
```

```bash
export ANTHROPIC_BASE_URL=http://localhost:3099
export ANTHROPIC_API_KEY=sk-ant-xxx
```

## Quick start — from source

```bash
git clone https://github.com/Ekkos-Technologies-Inc/prxy-monster-local
cd prxy-monster-local
cp .env.example .env
npm install && npm run build && npm test && npm start
```

Gateway: `http://localhost:3099` · Debug UI: `http://localhost:3099/debug`

## Quick start — docker compose

```bash
cp .env.example .env
docker compose up -d
```

---

## What you get

- **MCP optimizer** — embed-and-prune ~120 tools down to what the query needs
- **Structured + code crushers** — fold JSON tool results and file bodies
- **Semantic + exact cache** — skip repeat provider calls
- **IPC + compaction-bridge + rehydrator** — long sessions without silent amnesia
- **Patterns** — inject + forge learned fixes (auto-promote in local)
- **17 composable modules** — toggle via `PRXY_PIPE` or `x-prxy-pipe` header
- **Multi-provider** — Anthropic, OpenAI, Google, Groq, AWS Bedrock
- **Air-gap mode** — block all outbound except your provider
- **Zero telemetry** — nothing phones home

Module catalog → [docs/modules.md](docs/modules.md) · Recipes → [docs/pipelines.md](docs/pipelines.md)

## vs the alternatives

| | LiteLLM | Portkey | Raw API | **prxy** |
|---|:---:|:---:|:---:|:---:|
| Multi-provider proxy | ✅ | ✅ | — | ✅ |
| MCP tool pruning | — | — | — | ✅ |
| Context crushers | — | — | — | ✅ |
| Per-call token savings proof | — | — | — | ✅ |
| Outcome → pattern loop | — | — | — | ✅ |
| MIT self-host | ✅ | ✅ | — | ✅ |

Details → [docs/comparisons/](docs/comparisons/)

## Configuration

Copy [`.env.example`](.env.example). Highlights:

```bash
# Default pipeline (crushers included)
PRXY_PIPE=mcp-optimizer,exact-cache,semantic-cache,structured-crusher,code-crusher,ipc,patterns

# Local learn loop (default: on)
PRXY_AUTO_PROMOTE_PATTERNS=true
PRXY_AUTO_PROMOTE_MIN_SCORE=0.8
```

## Cloud vs local

| | Cloud [prxy.monster](https://prxy.monster) | Local (this repo) |
|---|---|---|
| Setup | One env var | One Docker command |
| Receipts | Ed25519 + public ledger | Call log + `/debug` |
| Pattern promotion | Human reviewer | Auto-promote (configurable) |
| Billing | Free → $20+/mo | Free forever (MIT) |
| Air-gap | No | Yes |

Same modules, same pipeline shape, different storage.

## Examples & ecosystem

- [Claude Code setup](https://github.com/Ekkos-Technologies-Inc/prxy-monster-examples/tree/main/examples/claude-code-setup)
- [OpenClaw setup](https://github.com/Ekkos-Technologies-Inc/prxy-monster-examples/tree/main/examples/openclaw-setup)
- [Steel web research agent](https://github.com/Ekkos-Technologies-Inc/prxy-monster-examples/tree/main/examples/steel-research-agent)
- [Module marketplace](https://modules.prxy.monster) · [Public receipts](https://receipts.prxy.monster)

## Contributing

Issues and PRs welcome → [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE).