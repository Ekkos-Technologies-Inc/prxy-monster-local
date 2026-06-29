/**
 * steel-browser — Steel.dev scrape tools for PRXY agents.
 *
 * Injects `steel_scrape` so models can fetch web pages via Steel's scrape API.
 * Fulfills tool calls in pre() (client round-trip) and auto-loops on non-streaming
 * provider responses (same pattern as ccr-retrieve).
 *
 * Pair with structured-crusher / code-crusher so large page dumps stay bounded.
 *
 * Requires STEEL_API_KEY in the gateway process env, or `apiKey` in module config.
 *
 * Recommended pipeline:
 *   steel-browser, mcp-optimizer, structured-crusher, code-crusher, ipc, patterns
 *
 * @see https://docs.steel.dev/
 */

import type { Logger, Module, RequestContext } from '../types/sdk.js';
import type { CanonicalMessage, CanonicalResponse, CanonicalTool, ContentBlock } from '../types/canonical.js';

const STEEL_SCRAPE_URL = 'https://api.steel.dev/v1/scrape';
const DEFAULT_TOOL = 'steel_scrape';

export type SteelScrapeFormat = 'markdown' | 'html' | 'cleaned_html' | 'readability';

export interface SteelBrowserConfig {
  /** Steel API key. Falls back to STEEL_API_KEY env. */
  apiKey?: string;
  /** Injected tool name. Default steel_scrape. */
  toolName?: string;
  /** Default content format returned to the model. Default markdown. */
  defaultFormat?: SteelScrapeFormat;
  /** Truncate tool_result text longer than this many chars. Default 120_000. */
  maxResultChars?: number;
  /** Inject steel_scrape into ctx.request.tools. Default true. */
  injectTool?: boolean;
  /** Fulfill pending steel_scrape in pre(). Default true. */
  fulfillPending?: boolean;
  /** Auto-loop when provider returns only steel_scrape tool_use. Default true. */
  autoLoop?: boolean;
  /** Max internal provider round-trips. Default 3. */
  maxAutoLoops?: number;
  /** Custom fetch (tests). */
  fetchFn?: typeof fetch;
}

interface ScrapeInput {
  url?: string;
  format?: SteelScrapeFormat;
}

interface SteelScrapeResponse {
  content?: Partial<Record<SteelScrapeFormat, string>>;
  metadata?: { status_code?: number; title?: string };
  links?: string[];
  error?: string;
}

const SCRAPE_TOOL_SCHEMA: CanonicalTool['inputSchema'] = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Absolute URL to scrape via Steel (https://...).',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'html', 'cleaned_html', 'readability'],
      description: 'Content shape to return. Default markdown.',
    },
  },
  required: ['url'],
};

function resolveApiKey(config: SteelBrowserConfig): string | undefined {
  return config.apiKey ?? process.env.STEEL_API_KEY;
}

function parseScrapeInput(input: unknown): ScrapeInput {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const format = o.format;
  const valid: SteelScrapeFormat[] = ['markdown', 'html', 'cleaned_html', 'readability'];
  return {
    url: typeof o.url === 'string' ? o.url : undefined,
    format:
      typeof format === 'string' && valid.includes(format as SteelScrapeFormat)
        ? (format as SteelScrapeFormat)
        : undefined,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…(+${text.length - maxChars} chars truncated by steel-browser)`;
}

export async function steelScrape(args: {
  url: string;
  apiKey: string;
  format?: SteelScrapeFormat;
  fetchFn?: typeof fetch;
}): Promise<SteelScrapeResponse> {
  const fetchImpl = args.fetchFn ?? fetch;
  const res = await fetchImpl(STEEL_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'steel-api-key': args.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: args.url }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      error: `steel_http_${res.status}`,
      content: { markdown: `Steel scrape failed (${res.status}): ${body.slice(0, 500)}` },
    };
  }

  const json = (await res.json()) as {
    content?: Partial<Record<SteelScrapeFormat, string>>;
    metadata?: { status_code?: number; title?: string };
    links?: string[];
    result?: {
      content?: Partial<Record<SteelScrapeFormat, string>>;
      metadata?: { status_code?: number; title?: string };
      links?: string[];
    };
  };

  const payload = json.result ?? json;
  return {
    content: payload.content,
    metadata: payload.metadata,
    links: payload.links,
  };
}

function formatScrapeResult(
  scrape: SteelScrapeResponse,
  format: SteelScrapeFormat,
  maxChars: number,
): string {
  if (scrape.error && !scrape.content) {
    return JSON.stringify({ error: scrape.error });
  }
  const content = scrape.content ?? {};
  const text =
    content[format] ??
    content.markdown ??
    content.readability ??
    content.cleaned_html ??
    content.html ??
    '';
  const envelope = {
    format,
    title: scrape.metadata?.title ?? null,
    status_code: scrape.metadata?.status_code ?? null,
    link_count: scrape.links?.length ?? 0,
    body: truncate(text, maxChars),
  };
  return JSON.stringify(envelope);
}

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

async function buildScrapeResults(
  calls: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
  config: SteelBrowserConfig,
): Promise<ToolResultBlock[]> {
  const apiKey = resolveApiKey(config);
  const defaultFormat = config.defaultFormat ?? 'markdown';
  const maxChars = config.maxResultChars ?? 120_000;
  const results: ToolResultBlock[] = [];

  for (const call of calls) {
    const { url, format } = parseScrapeInput(call.input);
    if (!apiKey) {
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: JSON.stringify({ error: 'missing_steel_api_key' }),
        isError: true,
      });
      continue;
    }
    if (!url) {
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: JSON.stringify({ error: 'missing_url' }),
        isError: true,
      });
      continue;
    }

    try {
      const scrape = await steelScrape({
        url,
        apiKey,
        format: format ?? defaultFormat,
        fetchFn: config.fetchFn,
      });
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: formatScrapeResult(scrape, format ?? defaultFormat, maxChars),
      });
    } catch (err) {
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: JSON.stringify({
          error: 'steel_scrape_failed',
          message: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      });
    }
  }

  return results;
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

function pendingSteelCalls(
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

function responseSteelCalls(
  response: CanonicalResponse,
  toolName: string,
): Array<Extract<ContentBlock, { type: 'tool_use' }>> {
  return response.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === toolName,
  );
}

function responseHasOnlySteelTools(response: CanonicalResponse, toolName: string): boolean {
  const toolUses = response.content.filter((b) => b.type === 'tool_use');
  return (
    toolUses.length > 0 && toolUses.every((b) => b.type === 'tool_use' && b.name === toolName)
  );
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

function appendAssistantAndToolResults(
  ctx: RequestContext,
  assistantContent: ContentBlock[],
  toolResults: ToolResultBlock[],
): void {
  ctx.request.messages.push({ role: 'assistant', content: assistantContent });
  ctx.request.messages.push({ role: 'user', content: toolResults });
}

export async function fulfillPendingSteelScrapes(
  ctx: RequestContext,
  config: SteelBrowserConfig,
): Promise<number> {
  const toolName = config.toolName ?? DEFAULT_TOOL;
  const pending = pendingSteelCalls(ctx.request.messages, toolName);
  if (pending.length === 0) return 0;
  const results = await buildScrapeResults(pending, config);
  injectPendingToolResults(ctx, results);
  ctx.metadata.set('steel-browser.scrapes', pending.length);
  return pending.length;
}

export async function maybeRunSteelBrowserLoop(args: {
  ctx: RequestContext;
  response: CanonicalResponse;
  callProvider: () => Promise<CanonicalResponse>;
  config: SteelBrowserConfig;
  logger: Logger;
}): Promise<{ response: CanonicalResponse; loops: number }> {
  if (args.config.autoLoop === false) {
    return { response: args.response, loops: 0 };
  }

  const toolName = args.config.toolName ?? DEFAULT_TOOL;
  const maxLoops = args.config.maxAutoLoops ?? 3;
  let response = args.response;
  let loops = 0;

  while (
    loops < maxLoops &&
    response.stopReason === 'tool_use' &&
    responseHasOnlySteelTools(response, toolName)
  ) {
    const calls = responseSteelCalls(response, toolName);
    if (calls.length === 0) break;

    const toolResults = await buildScrapeResults(calls, args.config);
    appendAssistantAndToolResults(args.ctx, response.content, toolResults);

    const scrapeCount = Number(args.ctx.metadata.get('steel-browser.scrapes') ?? 0);
    args.ctx.metadata.set('steel-browser.scrapes', scrapeCount + calls.length);

    response = await args.callProvider();
    loops++;
    args.logger.info(`steel-browser auto-loop iteration ${loops}`);
  }

  return { response, loops };
}

export function steelBrowser(config: SteelBrowserConfig = {}): Module {
  const toolName = config.toolName ?? DEFAULT_TOOL;
  const injectTool = config.injectTool ?? true;

  return {
    name: 'steel-browser',
    version: '1.0.0',

    async pre(ctx) {
      if (injectTool) {
        const tool: CanonicalTool = {
          name: toolName,
          description:
            'Fetch a web page via Steel (https://docs.steel.dev). Returns title, status, ' +
            'and page body as markdown/html. Use for research when you need live web content.',
          inputSchema: SCRAPE_TOOL_SCHEMA,
        };
        const existing = ctx.request.tools ?? [];
        if (!existing.some((t) => t.name === toolName)) {
          ctx.request.tools = [...existing, tool];
          ctx.metadata.set('steel-browser.tool_injected', true);
        }
      }

      if (config.fulfillPending !== false) {
        const fulfilled = await fulfillPendingSteelScrapes(ctx, config);
        if (fulfilled > 0) {
          ctx.metadata.set('steel-browser.pending_fulfilled', fulfilled);
          ctx.metadata.set('steel-browser.applied', true);
        }
      }

      ctx.metadata.set('steel-browser.tool', toolName);
      return { continue: true };
    },
  };
}