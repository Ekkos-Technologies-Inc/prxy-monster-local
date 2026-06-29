# prxy vs Portkey

[Portkey Gateway](https://github.com/portkey-ai/gateway) (~12k stars) focuses on fast routing, guardrails, and 1,600+ model aliases.

## Overlap

- Multi-provider AI gateway
- Guardrails / policy hooks
- Self-hosted Apache 2.0 gateway

## prxy differentiation

| | Portkey | prxy |
|---|---------|------|
| Primary pitch | Speed + guardrails + model breadth | Compress → prove → learn |
| MCP/context optimization | — | Core product |
| Signed receipt per call | — | Cloud (Ed25519) |
| Agent outcome loop | — | Outcomes → patterns |
| Local air-gap MIT edition | Gateway OSS | Full `prxy-monster-local` |

## When prxy wins

- Claude Code / OpenClaw sessions choked by tool definitions and tool_result bloat
- You need audit-grade proof of what modules ran and how many tokens they saved
- You want patterns that ride into the next call without building a separate memory product

## When Portkey wins

- You need maximum model catalog coverage with a mature guardrail/router story today
- Your team is already standardized on Portkey’s config and observability hooks