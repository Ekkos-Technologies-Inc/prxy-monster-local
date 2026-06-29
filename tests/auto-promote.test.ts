import { describe, expect, it } from 'vitest';

import {
  autoPromoteEnabled,
  autoPromoteMinScore,
  maybeAutoPromotePattern,
} from '../src/lib/auto-promote.js';
import { makeContext } from './_helpers.js';

describe('auto-promote', () => {
  it('promotes high-confidence succeeded outcomes by default', async () => {
    const prev = process.env.PRXY_AUTO_PROMOTE_PATTERNS;
    delete process.env.PRXY_AUTO_PROMOTE_PATTERNS;

    const ctx = makeContext();
    const result = await maybeAutoPromotePattern({
      storage: ctx.storage,
      userId: 'local-user',
      call: {
        id: 'call-1',
        user_query: 'Fix auth redirect loop',
        response_excerpt: 'Set SameSite=None on the session cookie.',
      },
      outcome: {
        outcome: 'succeeded',
        source: 'agent_runner',
        score: 0.95,
      },
    });

    expect(result.promoted).toBe(true);
    expect(result.patternId).toBeTruthy();

    const rows = await ctx.storage.db.from('patterns').select('*');
    expect((rows.data as unknown[]).length).toBeGreaterThan(0);

    if (prev === undefined) delete process.env.PRXY_AUTO_PROMOTE_PATTERNS;
    else process.env.PRXY_AUTO_PROMOTE_PATTERNS = prev;
  });

  it('respects PRXY_AUTO_PROMOTE_PATTERNS=false', async () => {
    process.env.PRXY_AUTO_PROMOTE_PATTERNS = 'false';
    const ctx = makeContext();
    const result = await maybeAutoPromotePattern({
      storage: ctx.storage,
      userId: 'local-user',
      call: {
        id: 'call-2',
        user_query: 'q',
        response_excerpt: 'a',
      },
      outcome: { outcome: 'succeeded', source: 'agent_runner', score: 1 },
    });
    expect(result.promoted).toBe(false);
    delete process.env.PRXY_AUTO_PROMOTE_PATTERNS;
  });

  it('exposes score threshold helper', () => {
    expect(autoPromoteEnabled()).toBe(true);
    expect(autoPromoteMinScore()).toBeGreaterThan(0);
  });
});