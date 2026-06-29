/**
 * POST /v1/outcomes — anchor a learning signal on a local call_log row.
 *
 * Positive outcomes with sufficient confidence auto-promote into patterns
 * when PRXY_AUTO_PROMOTE_PATTERNS is enabled (default: true in local).
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { autoPromoteMinScore, hashNotes, maybeAutoPromotePattern } from '../lib/auto-promote.js';
import { GatewayError, sendError } from '../lib/errors.js';
import { getStorage } from '../storage/adapter.js';

const OUTCOME_VALUES = [
  'succeeded',
  'partially_solved',
  'failed',
  'no_progress',
  'regressed',
  'user_satisfied',
  'user_unsatisfied',
  'tool_chain_succeeded',
  'tool_chain_failed',
  'review_pending',
  'out_of_scope',
] as const;

const SOURCE_VALUES = [
  'self_report',
  'human_reviewer',
  'webhook',
  'automated_test',
  'agent_runner',
] as const;

const SubmitOutcomeSchema = z.object({
  call_id: z.string().min(1),
  outcome: z.enum(OUTCOME_VALUES),
  source: z.enum(SOURCE_VALUES),
  score: z.number().min(0).max(1).optional().nullable(),
  labels: z.array(z.string()).optional(),
  notes: z.string().max(4000).optional(),
});

export async function outcomesHandler(req: Request, res: Response): Promise<void> {
  const parsed = SubmitOutcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(
      res,
      new GatewayError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    );
  }

  const apiKey = req.apiKey;
  if (!apiKey) {
    return sendError(
      res,
      new GatewayError(401, 'authentication_error', 'Missing API key context'),
    );
  }

  const storage = getStorage();
  const body = parsed.data;

  const callResult = await storage.db
    .from('call_log')
    .select('*')
    .eq('id', body.call_id)
    .limit(1);

  const callRows = (callResult.data ?? []) as Array<Record<string, unknown>>;
  const call = (callRows[0] ?? null) as
    | {
        id: string;
        user_query?: string;
        response_excerpt?: string;
        metadata?: Record<string, unknown>;
      }
    | null;

  if (!call) {
    return sendError(
      res,
      new GatewayError(404, 'not_found', `No call_log row for call_id ${body.call_id}`),
    );
  }

  const outcomeId = randomUUID();
  const notesHash = body.notes ? hashNotes(body.notes) : null;

  await storage.db.from('outcomes').insert({
    id: outcomeId,
    call_id: body.call_id,
    outcome: body.outcome,
    source: body.source,
    score: body.score ?? null,
    labels: body.labels ?? [],
    notes_hash: notesHash,
    created_at: Date.now(),
  });

  const promotion = await maybeAutoPromotePattern({
    storage,
    userId: apiKey.userId,
    call,
    outcome: {
      outcome: body.outcome,
      source: body.source,
      score: body.score,
      labels: body.labels,
    },
  });

  res.status(201).json({
    id: outcomeId,
    call_id: body.call_id,
    outcome: body.outcome,
    source: body.source,
    score: body.score ?? null,
    labels: body.labels ?? [],
    notes_hash: notesHash,
    auto_promote: {
      enabled: promotion.promoted || promotion.reason !== 'auto_promote_disabled',
      promoted: promotion.promoted,
      pattern_id: promotion.patternId ?? null,
      reason: promotion.reason ?? null,
      min_score: autoPromoteMinScore(),
    },
  });
}