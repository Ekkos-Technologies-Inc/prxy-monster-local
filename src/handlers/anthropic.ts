/**
 * POST /v1/messages — Anthropic-compatible endpoint.
 *
 * Requests pass through the module pipeline. Pre-modules can short-circuit
 * (cache hit, cost guard) and post-modules fire as side effects. Streaming
 * responses skip the post hooks against the streamed provider call (the
 * response shape doesn't fit the post hook), but pre hooks still apply.
 */

import type { Request, Response } from 'express';

import {
  AnthropicMessagesRequestSchema,
  anthropicRequestToCanonical,
  canonicalChunkToAnthropicSSE,
  canonicalResponseToAnthropic,
} from '../lib/anthropic-shape.js';
import { GatewayError, sendError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { envKeyResolver, routeComplete, routeStream } from '../lib/router.js';
import { setSseHeaders, writeSseEvent } from '../lib/sse.js';
import { attachPrxyHeaders, recordCall } from '../lib/call-log.js';
import { buildRequestContext, executePipeline } from '../pipeline/executor.js';
import { loadPipeline } from '../pipeline/loader.js';
import { getStorage } from '../storage/adapter.js';
import type { CanonicalChunk, CanonicalResponse } from '../types/canonical.js';

export async function anthropicHandler(req: Request, res: Response): Promise<void> {
  const parsed = AnthropicMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(
      res,
      new GatewayError(
        400,
        'invalid_request',
        `Invalid request body: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      ),
    );
  }

  const canonical = anthropicRequestToCanonical(parsed.data);
  const apiKey = req.apiKey;
  if (!apiKey) {
    return sendError(
      res,
      new GatewayError(401, 'authentication_error', 'Missing API key context'),
    );
  }

  const override = req.header('x-prxy-pipe') ?? undefined;
  const modules = await loadPipeline(apiKey, { override });
  const storage = getStorage();

  if (!canonical.stream) {
    try {
      const ctx = buildRequestContext({
        request: canonical,
        apiKey,
        storage,
        logger,
      });

      const { response, shortCircuitedBy } = await executePipeline({
        modules,
        ctx,
        callProvider: () => routeComplete(canonical, envKeyResolver),
      });

      if (shortCircuitedBy) {
        res.setHeader('x-prxy-cache', shortCircuitedBy);
      }
      const callId = await recordCall({
        ctx,
        response,
        modules,
        path: '/v1/messages',
        shortCircuitedBy,
      });
      attachPrxyHeaders(res, callId, ctx.metadata);
      res.json(canonicalResponseToAnthropic(response));
    } catch (err) {
      logger.error({ err }, 'anthropic complete failed');
      sendError(res, err);
    }
    return;
  }

  // Streaming path — pre hooks run, post hooks against streams require
  // accumulation and aren't wired yet. Pre short-circuits still apply.
  const ctx = buildRequestContext({
    request: canonical,
    apiKey,
    storage,
    logger,
  });

  let shortCircuitResponse: CanonicalResponse | null = null;
  let shortCircuitBy: string | null = null;

  for (const mod of modules) {
    if (!mod.pre) continue;
    try {
      const result = await mod.pre(ctx);
      if (!result.continue) {
        shortCircuitResponse = result.response;
        shortCircuitBy = mod.name;
        break;
      }
    } catch (err) {
      logger.warn({ err, module: mod.name }, `pre hook failed for ${mod.name}`);
    }
  }

  setSseHeaders(res);
  if (shortCircuitBy) res.setHeader('x-prxy-cache', shortCircuitBy);

  if (shortCircuitResponse) {
    const synthetic = synthesizeStreamFromResponse(shortCircuitResponse);
    for (const chunk of synthetic) {
      const { event, data } = canonicalChunkToAnthropicSSE(chunk);
      writeSseEvent(res, event, data);
    }
    res.end();
    return;
  }

  try {
    const stream = routeStream(canonical, envKeyResolver);
    for await (const chunk of stream) {
      const { event, data } = canonicalChunkToAnthropicSSE(chunk);
      writeSseEvent(res, event, data);
    }
    res.end();
  } catch (err) {
    logger.error({ err }, 'anthropic stream failed mid-flight');
    if (!res.headersSent) {
      sendError(res, err);
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    writeSseEvent(res, 'error', {
      type: 'error',
      error: { type: 'provider_error', message },
    });
    res.end();
  }
}

function synthesizeStreamFromResponse(response: CanonicalResponse): CanonicalChunk[] {
  const chunks: CanonicalChunk[] = [
    {
      type: 'message_start',
      message: {
        id: response.id,
        model: response.model,
        role: response.role,
        content: [],
        usage: response.usage,
      },
    },
  ];

  response.content.forEach((block, index) => {
    if (block.type === 'text') {
      chunks.push({
        type: 'content_block_start',
        index,
        contentBlock: { type: 'text', text: '' },
      });
      chunks.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      chunks.push({ type: 'content_block_stop', index });
    } else {
      chunks.push({ type: 'content_block_start', index, contentBlock: block });
      chunks.push({ type: 'content_block_stop', index });
    }
  });

  chunks.push({
    type: 'message_delta',
    delta: { stopReason: response.stopReason },
    usage: response.usage,
  });
  chunks.push({ type: 'message_stop' });

  return chunks;
}
