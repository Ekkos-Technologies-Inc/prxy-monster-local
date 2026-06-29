import { describe, expect, it } from 'vitest';

import { recordCall, tokensSavedFromMetadata } from '../src/lib/call-log.js';
import { mcpOptimizer } from '../src/modules/mcp-optimizer.js';
import { makeContext, makeRequest } from './_helpers.js';

describe('call-log', () => {
  it('sums tokens.saved metadata keys', () => {
    const metadata = new Map<string, unknown>([
      ['structured-crusher.tokens.saved', 1200],
      ['code-crusher.tokens.saved', 300],
      ['mcp.tokens.saved', 50],
    ]);
    expect(tokensSavedFromMetadata(metadata)).toBe(1550);
  });

  it('records a call_log row with module chain', async () => {
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );

    const mod = mcpOptimizer({ minToolsToOptimize: 999 });
    await mod.pre!(ctx);

    const callId = await recordCall({
      ctx,
      response: {
        id: 'r1',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      modules: [mod],
      path: '/v1/messages',
      shortCircuitedBy: null,
    });

    expect(callId).toMatch(/^[0-9a-f-]{36}$/i);

    const result = await ctx.storage.db.from('call_log').select('*').eq('id', callId).limit(1);
    const row = (result.data as Array<Record<string, unknown>>)[0];
    expect(row.user_query).toContain('hello');
    expect(row.module_chain).toContain('mcp-optimizer');
  });
});