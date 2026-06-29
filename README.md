# prxy-monster-local

> The open-source local edition of [prxy.monster](https://prxy.monster).
> A composable AI gateway you run on your own hardware. Zero data leaves your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/Ekkos-Technologies-Inc/prxy-monster-local/actions/workflows/ci.yml/badge.svg)](https://github.com/Ekkos-Technologies-Inc/prxy-monster-local/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/prxymonster/local)](https://hub.docker.com/r/prxymonster/local)

---

## What this is

A standalone Node.js service you run locally. It puts a smart middleware layer
in front of your LLM API calls — caching, MCP tool pruning, pattern memory,
cost guards, optional air-gap. Same module shape as cloud `prxy.monster`, but
everything runs on your machine: SQLite, in-memory cache, local filesystem.
Nothing ever phones home.

## Quick start — Docker

```bash
docker run -p 3099:3099 -v ~/.prxy:/data \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  prxymonster/local
```

Point your app at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:3099
export ANTHROPIC_API_KEY=sk-ant-xxx   # your real Anthropic key
```

Done. Your LLM calls now route through prxy-monster-local.

## Quick start — from source

```bash
git clone https://github.com/Ekkos-Technologies-Inc/prxy-monster-local
cd prxy-monster-local
cp .env.example .env                  # edit and add your provider keys
npm install
npm run build
npm test
npm start
```

The gateway listens on `http://localhost:3099` by default.

## Quick start — docker compose

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f
```

There's also a `Makefile` if you prefer `make up` / `make down` / `make logs`.

## What you get

- **Multi-provider** — Anthropic + OpenAI + Google (Gemini) + Groq + AWS Bedrock, all wire-compatible through one canonical request shape. Bedrock unlocks Claude / Llama / Titan / Mistral / Cohere through your AWS account (uses the SDK default credential chain — IAM role on EC2/ECS/App Runner, or env vars).
- **Smart routing** — `router` module picks the cheapest model that fits your budget, or learns from outcomes (q-learning) which model handles each query type best.
- **MCP optimization** — embed-and-prune tools by relevance. Cuts the
  67k-tokens-of-MCP-tools problem to whatever's actually needed.
- **Semantic + exact + tool-result caching** — sha256 hash for identical requests, vector
  similarity for near-duplicates, observation-mode caching for MCP tool calls.
- **Pattern learning** — Golden Loop. Forges patterns from `the issue was X /
  fix is Y` markers and injects relevant ones into future requests.
- **Inter-Prompt Compression** — older messages get summarized once you cross
  a context utilization threshold. Keeps long conversations going.
- **Context rehydration** — `rehydrator` pulls archived turns back when the user says "remember when…", "earlier we…", "go back to…". `compaction-bridge` survives Claude Code's auto-compaction by detecting fresh-looking requests that reference prior work and re-injecting the recent state.
- **Prompt-cache optimization** — `prompt-optimizer` stamps Anthropic `cache_control` markers and orders tools deterministically so the prefix cache eats your static prompt.
- **Cost guards** — hard USD caps per request / per day / per month.
- **Guardrails** — regex PII redaction (email/SSN/card/phone), profanity blocks, custom block patterns.
- **Air-gap mode** — block all outbound network calls except to your provider.

See [docs/modules.md](docs/modules.md) for the full module catalog and
[docs/pipelines.md](docs/pipelines.md) for ready-made pipeline recipes.

## Where data lives

```
$PRXY_DATA_DIR/                # default: ./data (or /data inside Docker)
├── prxy.db                    # SQLite — patterns, semantic_cache, sessions
├── prxy.db-wal                # SQLite WAL
├── blobs/                     # filesystem blob store
└── evictions/                 # IPC archived conversation tails
```

Nothing else. No telemetry. No phone-home. Audit the source.

## Authentication

prxy-monster-local is single-user / single-machine by default. Two modes:

- **Open** (default): `LOCAL_API_KEY` is unset. Any caller can hit the gateway.
- **Bearer**: set `LOCAL_API_KEY=prxy_local_choose_a_long_random_string`.
  Requests must send `Authorization: Bearer <that-key>`.

The cloud edition's signup / Argon2 / DB-backed auth flow doesn't ship here —
that's a multi-tenant feature.

## Configuration

Every knob is an env var. Copy [`.env.example`](.env.example) to `.env` and
fill in what you need. Highlights:

- `PORT`, `HOST` — listening
- `LOCAL_API_KEY` — optional Bearer auth
- `PRXY_DATA_DIR` — where SQLite lives
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`
- `AWS_REGION` (+ optional `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) — AWS Bedrock provider; SDK default credential chain when keys are omitted
- `VOYAGE_API_KEY` (optional) — better embeddings than the offline stub
- `PRXY_PIPE` — comma-separated module list (or `PRXY_PIPE_FILE` for YAML)
- `BLOB_BACKEND` — `fs` (default) or `s3`. The S3 backend is for "local-mode-on-AWS" deploys where blobs need to survive instance churn. Set `S3_BUCKET` + `AWS_REGION`; credentials via the SDK default chain.

## Pipeline recipes

```bash
# Privacy-first: block all outbound except provider
PRXY_PIPE=airgap,ipc,patterns,semantic-cache

# Cost-first: hard budgets + cache identical requests
PRXY_PIPE=cost-guard,exact-cache,mcp-optimizer,patterns

# Default: smart context + cache + memory
PRXY_PIPE=mcp-optimizer,semantic-cache,patterns
```

Per-request override via `x-prxy-pipe` header. Full list in
[docs/pipelines.md](docs/pipelines.md).

## CLI

```bash
npm run prxy -- patterns list           # show learned patterns
npm run prxy -- patterns clear          # delete all patterns
npm run prxy -- cache clear             # wipe semantic_cache
npm run prxy -- export --out backup.json
npm run prxy -- import backup.json
npm run prxy -- migrate                 # apply pending SQL migrations
```

## Cloud vs local

| | Cloud (prxy.monster) | Local (this repo) |
|---|---|---|
| Setup | One env var | One Docker command |
| Memory location | Our infrastructure | Your machine |
| Cross-device sync | Yes | No |
| Collective patterns | Yes | No |
| Air-gap capable | No | Yes |
| Billing / Stripe | Yes | None — no payment surface |
| Agent wallet payments (MPP) | Yes | Cloud only — self-hosters bring their own provider keys |
| Dashboard UI | Yes | None — REST + logs only |
| Price | Free → $20+/mo | Free, forever (MIT) |

Same modules, same pipeline shape, different storage backend.

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
The OpenAI / Anthropic / Google / Groq provider clients are reference shapes
if you want to add another provider.

## Documentation

- Module catalog → [docs/modules.md](docs/modules.md)
- Pipeline recipes → [docs/pipelines.md](docs/pipelines.md)
- airgap privacy model → [docs/airgap.md](docs/airgap.md)
- Cloud + local site → [docs.prxy.monster](https://docs.prxy.monster)

## License

MIT — see [LICENSE](LICENSE).
