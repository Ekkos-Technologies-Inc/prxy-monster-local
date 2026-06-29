# Contributing to prxy-monster-local

Thank you for considering a contribution.

## Quick start

```bash
git clone https://github.com/Ekkos-Technologies-Inc/prxy-monster-local
cd prxy-monster-local
cp .env.example .env
npm install
npm run build
npm test
npm run dev
```

The local gateway runs on `:3099`.

## Code structure

```
prxy-monster-local/
├── src/
│   ├── server.ts             # Express entrypoint
│   ├── app.ts                # Express factory (so tests can mount it)
│   ├── cli.ts                # `prxy` CLI tool
│   ├── handlers/             # /v1/messages, /v1/chat/completions, /health, /v1/pipeline
│   ├── middleware/           # auth + (no-op) ratelimit
│   ├── pipeline/             # loader + executor
│   ├── modules/              # 7 built-in modules + index registry
│   ├── providers/            # Anthropic + OpenAI clients (Google/Groq stubs)
│   ├── storage/              # LocalAdapter: SQLite + filesystem + KV + migrations
│   ├── lib/                  # logger, errors, sse, tokens, cost, embed, shape converters
│   └── types/                # canonical types + Module / Storage SDK interfaces (inlined)
├── tests/
│   ├── modules/              # one test file per module
│   ├── storage/parity.test.ts
│   ├── pipeline.test.ts
│   ├── auth.test.ts
│   └── integration.test.ts
├── docs/                     # modules.md, pipelines.md, airgap.md
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

## What lives here vs prxy.monster (cloud)

| Lives here (public OSS) | Lives in prxy.monster (private) |
|---|---|
| Local gateway server | Cloud gateway server |
| SQLite storage adapter | Postgres + R2 + Upstash adapters |
| All local-compatible modules + the `airgap` module | Cloud-only modules: `usage-tracker`, sync, collective |
| Inlined Module SDK | `@prxy/module-sdk` workspace package (will be published to npm) |
| Docker single-image build | Multi-app monorepo, Cloud Run deploys |
| MIT licensed | Closed source |

The Module SDK contract is currently inlined under `src/types/sdk.ts`. A
follow-up release will publish it to npm so both repos consume the same
package; modules written here will work on cloud without changes.

## Pull request guidelines

1. **One change per PR.** Small, focused.
2. **Tests required** for any module change. Pattern: one file under
   `tests/modules/<module>.test.ts` per module, exercising `pre()` / `post()`
   independently against the `FakeStorage` helper.
3. **Docs updated** when adding features. New module? Add a row to
   [docs/modules.md](docs/modules.md).
4. **No telemetry.** Ever. This repo is privacy-first by design.
5. **No cloud dependencies.** This is the local edition. SQLite, in-memory,
   filesystem only. No Postgres, no Stripe, no Upstash, no R2.
6. **Keep `npm` only.** No pnpm workspace setup — single project.

## Module submissions

Want to publish a community module that other people can drop in? Don't put it
in this repo. Publish it to npm under your own scope, then list it in the
[community modules registry](https://github.com/Ekkos-Technologies-Inc/prxy-monster-modules-registry)
once that's live.

## Issues

- **Bug reports**: include OS, Node version (or Docker version), what command
  you ran, expected vs actual.
- **Feature requests**: explain the use case, not just the feature.
- **Security issues**: email security@ekkos.dev — do not file public issues.

## License

By contributing, you agree your work is released under the MIT license (same
as the project).
