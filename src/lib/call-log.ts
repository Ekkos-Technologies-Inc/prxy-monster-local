/**
 * Persist recent gateway calls for the /debug viewer and /v1/outcomes anchoring.
 */

import { randomUUID } from 'node:crypto';

import { findLastUserMessage, responseToText } from './messages.js';
import type { Module } from '../types/sdk.js';
import type { CanonicalResponse } from '../types/canonical.js';
import type { RequestContext } from '../types/sdk.js';

const MAX_CALL_LOG_ROWS = 200;

export function tokensSavedFromMetadata(metadata: Map<string, unknown>): number {
  let total = 0;
  for (const [key, value] of metadata) {
    if (key.endsWith('.tokens.saved') && typeof value === 'number') {
      total += value;
    }
  }
  return total;
}

function metadataToObject(metadata: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of metadata) {
    out[key] = value;
  }
  return out;
}

export interface RecordCallInput {
  ctx: RequestContext;
  response: CanonicalResponse;
  modules: Module[];
  path: string;
  shortCircuitedBy: string | null;
}

export async function recordCall(input: RecordCallInput): Promise<string> {
  const id = randomUUID();
  const tokensSaved = tokensSavedFromMetadata(input.ctx.metadata);
  const userQuery = findLastUserMessage(input.ctx.request.messages).slice(0, 2000);
  const responseExcerpt = responseToText(input.response).slice(0, 2000);

  await input.ctx.storage.db.from('call_log').insert({
    id,
    created_at: Date.now(),
    path: input.path,
    model: input.response.model ?? input.ctx.request.model,
    provider: input.ctx.request.provider,
    short_circuited_by: input.shortCircuitedBy,
    module_chain: input.modules.map((m) => m.name),
    metadata: metadataToObject(input.ctx.metadata),
    user_query: userQuery,
    response_excerpt: responseExcerpt,
    input_tokens: input.response.usage?.inputTokens ?? 0,
    output_tokens: input.response.usage?.outputTokens ?? 0,
    tokens_saved: tokensSaved,
  });

  await pruneCallLog(input.ctx);

  return id;
}

async function pruneCallLog(ctx: RequestContext): Promise<void> {
  try {
    const result = await ctx.storage.db
      .from('call_log')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(MAX_CALL_LOG_ROWS + 1);

    const rows = (result.data ?? []) as Array<{ id: string }>;
    if (rows.length <= MAX_CALL_LOG_ROWS) return;

    const stale = rows.slice(MAX_CALL_LOG_ROWS);
    for (const row of stale) {
      await ctx.storage.db.from('call_log').delete().eq('id', row.id);
    }
  } catch {
    // Non-critical — debug viewer degrades gracefully.
  }
}

export function attachPrxyHeaders(
  res: { setHeader: (name: string, value: string) => void },
  callId: string,
  metadata: Map<string, unknown>,
): void {
  res.setHeader('x-prxy-call-id', callId);
  const saved = tokensSavedFromMetadata(metadata);
  if (saved > 0) {
    res.setHeader('x-prxy-tokens-saved', String(saved));
  }
}