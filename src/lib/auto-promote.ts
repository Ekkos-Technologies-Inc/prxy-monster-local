/**
 * Local-mode pattern auto-promotion from verified outcomes.
 *
 * Cloud keeps human reviewers; local defaults to promoting high-confidence
 * positive outcomes into the patterns table so solo devs see the learn loop
 * without operating lair.
 */

import { createHash, randomUUID } from 'node:crypto';

import { getEmbedding } from './embed.js';
import type { StorageAdapter } from '../types/sdk.js';

const POSITIVE_OUTCOMES = new Set([
  'succeeded',
  'partially_solved',
  'user_satisfied',
  'tool_chain_succeeded',
]);

export interface CallLogRow {
  id: string;
  user_query?: string;
  response_excerpt?: string;
  metadata?: Record<string, unknown>;
  labels?: string[];
}

export interface OutcomeInput {
  outcome: string;
  source: string;
  score?: number | null;
  labels?: string[];
}

export function autoPromoteEnabled(): boolean {
  const raw = process.env.PRXY_AUTO_PROMOTE_PATTERNS;
  return raw === undefined || raw === '' || raw === '1' || raw.toLowerCase() === 'true';
}

export function autoPromoteMinScore(): number {
  const raw = process.env.PRXY_AUTO_PROMOTE_MIN_SCORE;
  const n = raw ? Number.parseFloat(raw) : 0.8;
  return Number.isFinite(n) ? n : 0.8;
}

export async function maybeAutoPromotePattern(args: {
  storage: StorageAdapter;
  userId: string;
  call: CallLogRow;
  outcome: OutcomeInput;
}): Promise<{ promoted: boolean; patternId?: string; reason?: string }> {
  if (!autoPromoteEnabled()) {
    return { promoted: false, reason: 'auto_promote_disabled' };
  }

  if (!POSITIVE_OUTCOMES.has(args.outcome.outcome)) {
    return { promoted: false, reason: 'outcome_not_positive' };
  }

  const score = args.outcome.score ?? (args.outcome.outcome === 'succeeded' ? 1 : 0.85);
  if (score < autoPromoteMinScore()) {
    return { promoted: false, reason: 'score_below_threshold' };
  }

  const problem = (args.call.user_query ?? '').trim();
  const solution = (args.call.response_excerpt ?? '').trim();
  if (!problem || !solution) {
    return { promoted: false, reason: 'missing_call_context' };
  }

  const forgedTitle =
    typeof args.call.metadata?.['patterns.forged'] === 'string'
      ? (args.call.metadata['patterns.forged'] as string)
      : undefined;

  const title =
    forgedTitle ??
    (problem.length > 72 ? `${problem.slice(0, 69)}…` : problem);

  const tags = [
    ...(args.outcome.labels ?? []),
    'auto-promoted',
    `source:${args.outcome.source}`,
  ];

  const embedding = await getEmbedding(problem, args.storage);
  const patternId = randomUUID();

  await args.storage.db.from('patterns').insert({
    id: patternId,
    user_id: args.userId,
    title,
    problem,
    solution,
    tags,
    embedding,
    success_rate: Math.min(1, Math.max(0, score)),
    applied_count: 0,
    created_at: Date.now(),
  });

  return { promoted: true, patternId };
}

export function hashNotes(notes: string): string {
  return createHash('sha256').update(notes, 'utf8').digest('hex');
}