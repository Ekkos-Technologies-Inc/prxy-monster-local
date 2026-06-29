/**
 * ccr-retrieve — fulfills prxy_retrieve tool calls from CCR blob storage.
 *
 * Pair with structured-crusher (ccr:true) + ccr-inject. Crushers store originals
 * at `{ccrPrefix}/{sha256}.txt`; this module retrieves them when the model
 * calls prxy_retrieve.
 *
 * Two fulfillment paths:
 *   1. pre() — client sent assistant tool_use blocks without tool_results;
 *      inject results before the provider call.
 *   2. Auto-loop (executor) — provider returned prxy_retrieve tool_use; gateway
 *      fulfills internally and calls the provider again (non-streaming only).
 *
 * Recommended order:
 *   structured-crusher (ccr:true), code-crusher, ccr-inject, ccr-retrieve, ipc, …
 */

import type { Logger, Module, RequestContext } from '../types/sdk.js';
import type { CanonicalMessage, CanonicalResponse, ContentBlock } from '../types/canonical.js';

export interface CcrRetrieveConfig {
  /** Tool name to fulfill. Default prxy_retrieve. */
  toolName?: string;
  /** Blob prefix matching structured-crusher ccrPrefix. Default ccr. */
  ccrPrefix?: string;
  /** Max internal provider round-trips for auto-fulfillment. Default 4. */
  maxAutoLoops?: number;
  /** Fulfill pending tool_use in pre(). Default true. */
  fulfillPending?: boolean;
  /** Auto-loop when provider returns only prxy_retrieve tool_use. Default true. */
  autoLoop?: boolean;
}

interface RetrieveInput {
  hash?: string;
  query?: string;
}

function parseRetrieveInput(input: unknown): RetrieveInput {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  return {
    hash: typeof o.hash === 'string' ? o.hash : undefined,
    query: typeof o.query === 'string' ? o.query : undefined,
  };
}

/** Apply optional substring filter when the stored payload is a JSON array. */
export function applyCcrQueryFilter(content: string, query: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const q = query.toLowerCase();
        const filtered = parsed.filter((item) =>
          JSON.stringify(item).toLowerCase().includes(q),
        );
        return JSON.stringify(filtered);
      }
    } catch {
      /* fall through */
    }
  }
  if (content.toLowerCase().includes(query.toLowerCase())) {
    return content
      .split('\n')
      .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
      .join('\n');
  }
  return content;
}

export async function retrieveCcrBlob(args: {
  storage: RequestContext['storage'];
  hash: string;
  prefix: string;
  query?: string;
}): Promise<string> {
  const key = `${args.prefix}/${args.hash}.txt`;
  const buf = await args.storage.blob.get(key);
  if (!buf) {
    return JSON.stringify({ error: 'not_found', hash: args.hash });
  }
  let content = buf.toString('utf8');
  if (args.query) {
    content = applyCcrQueryFilter(content, args.query);
  }
  return content;
}

function fulfilledToolIds(messages: CanonicalMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') ids.add(block.toolUseId);
    }
  }
  return ids;
}

function pendingRetrieveCalls(
  messages: CanonicalMessage[],
  toolName: string,
): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  const fulfilled = fulfilledToolIds(messages);
  const pending: Array<Extract<ContentBlock, { type: 'tool_use' }>> = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === toolName && !fulfilled.has(block.id)) {
        pending.push(block);
      }
    }
  }
  return pending;
}

function responseRetrieveCalls(
  response: CanonicalResponse,
  toolName: string,
): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  return response.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === toolName,
  );
}

function responseHasOnlyRetrieveTools(response: CanonicalResponse, toolName: string): boolean {
  const toolUses = response.content.filter((b) => b.type === 'tool_use');
  return (
    toolUses.length > 0 && toolUses.every((b) => b.type === 'tool_use' && b.name === toolName)
  );
}

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

async function buildToolResults(
  calls: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
  ctx: RequestContext,
  prefix: string,
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    const { hash, query } = parseRetrieveInput(call.input);
    const content = hash
      ? await retrieveCcrBlob({ storage: ctx.storage, hash, prefix, query })
      : JSON.stringify({ error: 'missing_hash' });
    results.push({
      type: 'tool_result',
      toolUseId: call.id,
      content,
    });
  }
  return results;
}

function appendAssistantAndToolResults(
  ctx: RequestContext,
  assistantContent: ContentBlock[],
  toolResults: ContentBlock[],
): void {
  ctx.request.messages.push({ role: 'assistant', content: assistantContent });
  ctx.request.messages.push({ role: 'user', content: toolResults });
}

function injectPendingToolResults(ctx: RequestContext, toolResults: ToolResultBlock[]): void {
  const last = ctx.request.messages[ctx.request.messages.length - 1];
  if (
    last?.role === 'user' &&
    Array.isArray(last.content) &&
    last.content.every((b) => b.type === 'tool_result')
  ) {
    last.content.push(...toolResults);
    return;
  }
  ctx.request.messages.push({ role: 'user', content: toolResults });
}

export async function fulfillPendingCcrRetrieves(
  ctx: RequestContext,
  config: CcrRetrieveConfig,
): Promise<number> {
  const toolName = config.toolName ?? 'prxy_retrieve';
  const prefix = config.ccrPrefix ?? 'ccr';
  const pending = pendingRetrieveCalls(ctx.request.messages, toolName);
  if (pending.length === 0) return 0;

  const results = await buildToolResults(pending, ctx, prefix);
  injectPendingToolResults(ctx, results);
  return pending.length;
}

export async function maybeRunCcrRetrieveLoop(args: {
  ctx: RequestContext;
  response: CanonicalResponse;
  callProvider: () => Promise<CanonicalResponse>;
  config: CcrRetrieveConfig;
  logger: Logger;
}): Promise<{ response: CanonicalResponse; loops: number }> {
  if (args.config.autoLoop === false) {
    return { response: args.response, loops: 0 };
  }

  const toolName = args.config.toolName ?? 'prxy_retrieve';
  const prefix = args.config.ccrPrefix ?? 'ccr';
  const maxLoops = args.config.maxAutoLoops ?? 4;
  let response = args.response;
  let loops = 0;

  while (
    loops < maxLoops &&
    response.stopReason === 'tool_use' &&
    responseHasOnlyRetrieveTools(response, toolName)
  ) {
    const calls = responseRetrieveCalls(response, toolName);
    if (calls.length === 0) break;

    const toolResults = await buildToolResults(calls, args.ctx, prefix);
    appendAssistantAndToolResults(args.ctx, response.content, toolResults);

    response = await args.callProvider();
    loops++;
    args.logger.info(`ccr-retrieve auto-loop iteration ${loops}`);
  }

  return { response, loops };
}

export function ccrRetrieve(config: CcrRetrieveConfig = {}): Module {
  const toolName = config.toolName ?? 'prxy_retrieve';
  const prefix = config.ccrPrefix ?? 'ccr';

  return {
    name: 'ccr-retrieve',
    version: '1.0.0',

    async pre(ctx) {
      if (config.fulfillPending === false) return { continue: true };

      const fulfilled = await fulfillPendingCcrRetrieves(ctx, config);
      if (fulfilled > 0) {
        ctx.metadata.set('ccr-retrieve.pending_fulfilled', fulfilled);
        ctx.metadata.set('ccr-retrieve.applied', true);
      }
      ctx.metadata.set('ccr-retrieve.tool', toolName);
      ctx.metadata.set('ccr-retrieve.prefix', prefix);
      return { continue: true };
    },
  };
}

