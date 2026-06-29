/**
 * crushers — content-type-aware context compression.
 *
 * Two modules that shrink the request BEFORE it reaches the provider, on a
 * different axis than `ipc` (which compresses by recency). These compress by
 * content type wherever it appears:
 *
 *   - `structuredCrusher` — collapses large JSON in tool_result blocks
 *     (long arrays head/tail-sampled, deep strings truncated, empty fields
 *     dropped). Inspired by Headroom's "SmartCrusher", reimplemented natively
 *     in TS so it needs NO model download and NO network — preserving the
 *     airgap guarantee (`airgap.ts`).
 *
 *   - `codeCrusher` — folds function/method bodies in source code (tool_result
 *     file reads, fenced code), keeping signatures + structure. Inspired by
 *     Headroom's "CodeCompressor", but heuristic + dependency-free (no AST
 *     parser, no WASM grammar fetched at runtime).
 *
 * COMPLIANCE STANCE (privacy-first product): both modules default to touching
 * ONLY `tool_result` blocks — machine output. User/system prose is left
 * byte-exact unless explicitly opted in. The gate is by BLOCK TYPE, not message
 * role: in the Anthropic canonical format tool results ride inside user-role
 * messages, so role-gating would be wrong.
 *
 * LOSSY ⇒ VISIBLE: every crushed JSON payload carries a `__prxy_crushed`
 * marker; every folded code body leaves an `… N lines elided` comment. No
 * silent drops. Recommended pipeline ordering (crushers run AFTER cache lookup
 * so cache keys hash the original, BEFORE ipc so ipc only summarizes leftovers):
 *
 *   semantic-cache,exact-cache,structured-crusher,code-crusher,ipc,prompt-optimizer
 */

import { estimateRequestTokens, estimateTextTokens } from '../lib/tokens.js';
import { sha256 } from '../lib/embed.js';
import type { CanonicalMessage, ContentBlock } from '../types/canonical.js';
import type { Module, StorageAdapter } from '../types/sdk.js';

// ---------------------------------------------------------------------------
// structuredCrusher
// ---------------------------------------------------------------------------

/** Marker key stamped on crushed payloads. Doubles as the idempotence guard. */
export const CRUSH_MARKER = '__prxy_crushed';

/** CCR blob key referenced by prxy_retrieve. */
export const CCR_MARKER = '__prxy_ccr';

export interface StructuredCrusherConfig {
  /** Skip blocks smaller than this (token estimate). Default 200. */
  minBlockTokens?: number;
  /** Keep at most this many array items (head/tail sampled). Default 8. */
  maxArrayItems?: number;
  /** Truncate leaf strings longer than this many chars. Default 500. */
  maxStringChars?: number;
  /** Drop null / "" / [] / {} object fields. Default true. */
  dropEmpty?: boolean;
  /** Which block types to crush. Default ['tool_result'] (compliance-safe). */
  targets?: Array<'tool_result' | 'tool_use'>;
  /** Also crush JSON found in plain text blocks. COMPLIANCE GATE. Default false. */
  crushUserSystem?: boolean;
  /** Wrap crushed payloads in a {__prxy_crushed:true,data} marker. Default true. */
  marker?: boolean;
  /** Store originals in blob storage before crushing (CCR). Default false. */
  ccr?: boolean;
  /** Blob prefix for CCR originals. Default ccr. */
  ccrPrefix?: string;
}

interface CrushOpts {
  maxArrayItems: number;
  maxStringChars: number;
  dropEmpty: boolean;
}

const MAX_DEPTH = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Pure, deterministic JSON reducer. Same input + opts → identical output.
 * Exported for direct testing.
 */
export function crushJson(value: unknown, opts: CrushOpts, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return value;

  if (typeof value === 'string') {
    if (value.length > opts.maxStringChars) {
      const kept = value.slice(0, opts.maxStringChars);
      return `${kept}…(+${value.length - opts.maxStringChars} chars)`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > opts.maxArrayItems) {
      const head = Math.ceil(opts.maxArrayItems / 2);
      const tail = Math.floor(opts.maxArrayItems / 2);
      const omitted = value.length - opts.maxArrayItems;
      return [
        ...value.slice(0, head).map((v) => crushJson(v, opts, depth + 1)),
        { [CRUSH_MARKER]: `${omitted} of ${value.length} items omitted` },
        ...(tail > 0 ? value.slice(value.length - tail) : []).map((v) =>
          crushJson(v, opts, depth + 1),
        ),
      ];
    }
    return value.map((v) => crushJson(v, opts, depth + 1));
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (opts.dropEmpty && isEmptyValue(v)) continue;
      out[k] = crushJson(v, opts, depth + 1);
    }
    return out;
  }

  // number | boolean | null — already minimal
  return value;
}

/**
 * Crush a string IF it is JSON and crushing actually saves bytes. Returns the
 * new string, or null to signal "leave the original untouched".
 */
interface CcrStore {
  storage: StorageAdapter;
  prefix: string;
}

async function tryCrushJsonString(
  s: string,
  opts: CrushOpts,
  marker: boolean,
  ccr?: CcrStore,
): Promise<string | null> {
  const trimmed = s.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Idempotence: already-crushed payloads carry the marker — don't re-wrap.
  if (isPlainObject(parsed) && parsed[CRUSH_MARKER] === true) return null;

  const crushed = crushJson(parsed, opts);
  const wrapped: Record<string, unknown> = marker
    ? { [CRUSH_MARKER]: true, data: crushed }
    : (crushed as Record<string, unknown>);

  if (ccr && marker) {
    const hash = sha256(s);
    await ccr.storage.blob.put(`${ccr.prefix}/${hash}.txt`, Buffer.from(s, 'utf8'));
    wrapped[CCR_MARKER] = hash;
  }

  const out = JSON.stringify(marker ? wrapped : crushed);

  // Only adopt if it's an actual win — wrapping can cost more than it saves on
  // already-small payloads.
  if (out.length >= s.length) return null;
  return out;
}

/** Crush the JSON inside a tool_result block (string or nested text blocks). */
async function crushToolResult(
  block: Extract<ContentBlock, { type: 'tool_result' }>,
  opts: CrushOpts,
  marker: boolean,
  minBlockTokens: number,
  ccr?: CcrStore,
): Promise<number> {
  let n = 0;
  if (typeof block.content === 'string') {
    if (estimateTextTokens(block.content) < minBlockTokens) return 0;
    const out = await tryCrushJsonString(block.content, opts, marker, ccr);
    if (out !== null) {
      block.content = out;
      n++;
    }
    return n;
  }
  for (const c of block.content) {
    if (c.type === 'text' && estimateTextTokens(c.text) >= minBlockTokens) {
      const out = await tryCrushJsonString(c.text, opts, marker, ccr);
      if (out !== null) {
        c.text = out;
        n++;
      }
    }
  }
  return n;
}

export function structuredCrusher(config: StructuredCrusherConfig = {}): Module {
  const minBlockTokens = config.minBlockTokens ?? 200;
  const targets = config.targets ?? ['tool_result'];
  const crushUserSystem = config.crushUserSystem ?? false;
  const marker = config.marker ?? true;
  const opts: CrushOpts = {
    maxArrayItems: config.maxArrayItems ?? 8,
    maxStringChars: config.maxStringChars ?? 500,
    dropEmpty: config.dropEmpty ?? true,
  };
  const ccrEnabled = config.ccr ?? false;
  const ccrPrefix = config.ccrPrefix ?? 'ccr';

  return {
    name: 'structured-crusher',
    version: '1.0.0',

    async pre(ctx) {
      const before = estimateRequestTokens(ctx.request);
      let blocks = 0;
      const ccr: CcrStore | undefined = ccrEnabled
        ? { storage: ctx.storage, prefix: ccrPrefix }
        : undefined;

      for (const msg of ctx.request.messages) {
        if (typeof msg.content === 'string') continue;
        for (const block of msg.content) {
          if (block.type === 'tool_result' && targets.includes('tool_result')) {
            blocks += await crushToolResult(block, opts, marker, minBlockTokens, ccr);
          } else if (block.type === 'tool_use' && targets.includes('tool_use')) {
            const serialized = JSON.stringify(block.input ?? {});
            if (estimateTextTokens(serialized) >= minBlockTokens) {
              const crushed = crushJson(block.input, opts);
              if (JSON.stringify(crushed).length < serialized.length) {
                block.input = crushed;
                blocks++;
              }
            }
          } else if (block.type === 'text' && crushUserSystem) {
            if (estimateTextTokens(block.text) >= minBlockTokens) {
              const out = await tryCrushJsonString(block.text, opts, marker, ccr);
              if (out !== null) {
                block.text = out;
                blocks++;
              }
            }
          }
        }
      }

      const after = estimateRequestTokens(ctx.request);
      ctx.metadata.set('structured-crusher.blocks', blocks);
      ctx.metadata.set('structured-crusher.tokens.before', before);
      ctx.metadata.set('structured-crusher.tokens.after', after);
      ctx.metadata.set('structured-crusher.tokens.saved', before - after);
      if (ccrEnabled) ctx.metadata.set('structured-crusher.ccr', true);
      if (blocks > 0) ctx.metadata.set('structured-crusher.applied', true);

      return { continue: true };
    },
  };
}

// ---------------------------------------------------------------------------
// codeCrusher
// ---------------------------------------------------------------------------

export interface CodeCrusherConfig {
  /** Skip blocks smaller than this (token estimate). Default 300. */
  minBlockTokens?: number;
  /** Only fold bodies longer than this many lines. Default 4. */
  foldBodiesOverLines?: number;
  /** Keep a leading docstring/comment line of each folded body. Default true. */
  keepDocstrings?: boolean;
  /** Which block types to scan. Default ['tool_result'] (compliance-safe). */
  targets?: Array<'tool_result' | 'text'>;
}

interface FoldOpts {
  foldBodiesOverLines: number;
  keepDocstrings: boolean;
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''")
  );
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** Brace-language body folding (JS/TS/Go/Rust/Java/C++). Naive depth count. */
function foldByBraces(lines: string[], opts: FoldOpts): string {
  const out: string[] = [];
  let depth = 0;
  let run: string[] = [];
  let runIndent = '';

  const flush = (): void => {
    if (run.length > opts.foldBodiesOverLines) {
      out.push(`${runIndent}// … ${run.length} lines elided`);
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    const startDepth = depth;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const trimmed = line.trim();
    const isClosingBoundary = trimmed.startsWith('}');
    const foldable = startDepth >= 1 && !isClosingBoundary && trimmed !== '';

    if (foldable && opts.keepDocstrings && run.length === 0 && isCommentLine(trimmed)) {
      flush();
      out.push(line); // keep the leading docstring line outside the fold
    } else if (foldable) {
      if (run.length === 0) runIndent = leadingWhitespace(line);
      run.push(line);
    } else {
      flush();
      out.push(line);
    }

    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  flush();
  return out.join('\n');
}

/** Indentation-based body folding (Python). */
function foldByIndent(lines: string[], opts: FoldOpts): string {
  const out: string[] = [];
  let run: string[] = [];
  let runIndent = '';
  const isSig = (t: string): boolean => /^(async\s+def|def|class)\b/.test(t);

  const flush = (): void => {
    if (run.length > opts.foldBodiesOverLines) {
      out.push(`${runIndent}# … ${run.length} lines elided`);
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    const foldable = indent > 0 && trimmed !== '' && !isSig(trimmed);

    if (foldable && opts.keepDocstrings && run.length === 0 && isCommentLine(trimmed)) {
      flush();
      out.push(line);
    } else if (foldable) {
      if (run.length === 0) runIndent = leadingWhitespace(line);
      run.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/**
 * Fold function/method bodies in a code string, keeping signatures and block
 * structure. `lang` hints the language; empty string auto-detects (braces →
 * brace folding, otherwise Python indentation). Pure + deterministic.
 */
export function foldCodeBodies(code: string, lang: string, opts: FoldOpts): string {
  const lines = code.split('\n');
  if (lines.length <= opts.foldBodiesOverLines) return code;
  const isPython =
    /^(py|python|py3)$/i.test(lang) || (!/[{}]/.test(code) && /:\s*$/m.test(code));
  return isPython ? foldByIndent(lines, opts) : foldByBraces(lines, opts);
}

function looksLikeCode(text: string): boolean {
  return (
    /[{}]/.test(text) ||
    /^\s*(async\s+def|def|class|function|import|export|const|let|var|public|private|fn|func)\b/m.test(
      text,
    )
  );
}

const FENCE_RE = /```([\w+#-]*)\n([\s\S]*?)```/g;

/**
 * Fold code inside a string. If it has ``` fences, fold each fenced region;
 * otherwise (when allowWhole) fold the entire string if it looks like code.
 * Returns the possibly-rewritten string + how many regions were folded.
 */
function foldMaybeCode(
  text: string,
  opts: FoldOpts,
  allowWhole: boolean,
): { text: string; count: number } {
  if (text.includes('```')) {
    let count = 0;
    const replaced = text.replace(FENCE_RE, (whole, lang: string, body: string) => {
      const folded = foldCodeBodies(body, lang, opts);
      if (folded.length < body.length) {
        count++;
        return `\`\`\`${lang}\n${folded}\`\`\``;
      }
      return whole;
    });
    return { text: replaced, count };
  }

  if (allowWhole && looksLikeCode(text)) {
    const folded = foldCodeBodies(text, '', opts);
    if (folded.length < text.length) return { text: folded, count: 1 };
  }
  return { text, count: 0 };
}

export function codeCrusher(config: CodeCrusherConfig = {}): Module {
  const minBlockTokens = config.minBlockTokens ?? 300;
  const targets = config.targets ?? ['tool_result'];
  const opts: FoldOpts = {
    foldBodiesOverLines: config.foldBodiesOverLines ?? 4,
    keepDocstrings: config.keepDocstrings ?? true,
  };

  return {
    name: 'code-crusher',
    version: '1.0.0',

    async pre(ctx) {
      const before = estimateRequestTokens(ctx.request);
      let folded = 0;

      const foldText = (text: string, allowWhole: boolean): string => {
        if (estimateTextTokens(text) < minBlockTokens) return text;
        const r = foldMaybeCode(text, opts, allowWhole);
        folded += r.count;
        return r.text;
      };

      for (const msg of ctx.request.messages) {
        if (typeof msg.content === 'string') continue;
        for (const block of msg.content) {
          if (block.type === 'tool_result' && targets.includes('tool_result')) {
            if (typeof block.content === 'string') {
              block.content = foldText(block.content, true);
            } else {
              for (const c of block.content) {
                if (c.type === 'text') c.text = foldText(c.text, true);
              }
            }
          } else if (block.type === 'text' && targets.includes('text')) {
            // In prose, only fold inside fences — never the whole block.
            block.text = foldText(block.text, false);
          }
        }
      }

      const after = estimateRequestTokens(ctx.request);
      ctx.metadata.set('code-crusher.regions', folded);
      ctx.metadata.set('code-crusher.tokens.before', before);
      ctx.metadata.set('code-crusher.tokens.after', after);
      ctx.metadata.set('code-crusher.tokens.saved', before - after);
      if (folded > 0) ctx.metadata.set('code-crusher.applied', true);

      return { continue: true };
    },
  };
}

// Re-export the canonical message type for tests that build blocks by hand.
export type { CanonicalMessage };
