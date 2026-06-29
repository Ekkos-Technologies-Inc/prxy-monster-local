import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRUSH_MARKER,
  codeCrusher,
  crushJson,
  foldCodeBodies,
  structuredCrusher,
} from '../../src/modules/crushers.js';
import type { CanonicalMessage, ContentBlock } from '../../src/types/canonical.js';
import { makeContext, makeRequest } from '../_helpers.js';

const CRUSH_OPTS = { maxArrayItems: 8, maxStringChars: 500, dropEmpty: true };
const FOLD_OPTS = { foldBodiesOverLines: 4, keepDocstrings: true };

function toolResultMsg(content: string): CanonicalMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 't1', content } as ContentBlock],
  };
}

// ---------------------------------------------------------------------------
// crushJson (pure reducer)
// ---------------------------------------------------------------------------

describe('crushJson', () => {
  it('head/tail samples long arrays and inserts an omission marker', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = crushJson(input, CRUSH_OPTS) as unknown[];
    expect(out.length).toBe(9); // 4 head + marker + 4 tail
    expect(out[0]).toBe(0);
    expect(out[8]).toBe(19);
    expect(out[4]).toEqual({ [CRUSH_MARKER]: '12 of 20 items omitted' });
  });

  it('truncates over-long leaf strings with a char count', () => {
    const out = crushJson('x'.repeat(600), CRUSH_OPTS) as string;
    expect(out.startsWith('x'.repeat(500))).toBe(true);
    expect(out.endsWith('…(+100 chars)')).toBe(true);
  });

  it('drops empty object fields when dropEmpty is set', () => {
    const out = crushJson({ a: 1, b: null, c: '', d: [], e: {} }, CRUSH_OPTS);
    expect(out).toEqual({ a: 1 });
  });

  it('is deterministic — same input yields identical output', () => {
    const input = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, blank: '' })) };
    expect(JSON.stringify(crushJson(input, CRUSH_OPTS))).toBe(
      JSON.stringify(crushJson(input, CRUSH_OPTS)),
    );
  });
});

// ---------------------------------------------------------------------------
// structuredCrusher (module)
// ---------------------------------------------------------------------------

describe('structuredCrusher module', () => {
  const bigJson = JSON.stringify({
    results: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      empty: null,
      blurb: 'z'.repeat(800),
    })),
  });

  it('crushes a large JSON tool_result, stays valid JSON, and saves tokens', async () => {
    const mod = structuredCrusher();
    const ctx = makeContext(makeRequest({ messages: [toolResultMsg(bigJson)] }));
    await mod.pre!(ctx);

    const block = (ctx.request.messages[0].content as ContentBlock[])[0];
    const text = block.type === 'tool_result' ? (block.content as string) : '';
    const parsed = JSON.parse(text); // throws if invalid
    expect(parsed[CRUSH_MARKER]).toBe(true);
    expect(ctx.metadata.get('structured-crusher.blocks')).toBe(1);
    expect(ctx.metadata.get('structured-crusher.tokens.saved')).toBeGreaterThan(0);
  });

  it('leaves user/system prose byte-exact by default (compliance gate)', async () => {
    const mod = structuredCrusher();
    const prose = `Patient SSN 123-45-6789, ${'context '.repeat(200)}`;
    const ctx = makeContext(
      makeRequest({
        system: 'You are a careful assistant.',
        messages: [{ role: 'user', content: prose }],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.messages[0].content).toBe(prose);
    expect(ctx.request.system).toBe('You are a careful assistant.');
    expect(ctx.metadata.get('structured-crusher.blocks')).toBe(0);
  });

  it('skips tool_result blocks below minBlockTokens', async () => {
    // Threshold set well above the ~20k-token payload so the block is skipped.
    const mod = structuredCrusher({ minBlockTokens: 1_000_000 });
    const ctx = makeContext(makeRequest({ messages: [toolResultMsg(bigJson)] }));
    await mod.pre!(ctx);
    expect(ctx.metadata.get('structured-crusher.blocks')).toBe(0);
  });

  it('is idempotent — a second pass makes no further change', async () => {
    const mod = structuredCrusher();
    const ctx = makeContext(makeRequest({ messages: [toolResultMsg(bigJson)] }));
    await mod.pre!(ctx);
    const afterFirst = JSON.stringify(ctx.request.messages);
    await mod.pre!(ctx);
    const afterSecond = JSON.stringify(ctx.request.messages);
    expect(afterSecond).toBe(afterFirst);
    expect(ctx.metadata.get('structured-crusher.blocks')).toBe(0);
  });

  it('performs zero network I/O (airgap guarantee)', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const mod = structuredCrusher();
      const ctx = makeContext(makeRequest({ messages: [toolResultMsg(bigJson)] }));
      await mod.pre!(ctx);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// foldCodeBodies (pure) + codeCrusher (module)
// ---------------------------------------------------------------------------

describe('foldCodeBodies', () => {
  it('folds a brace-language body, keeping signature and closing brace', () => {
    const src = [
      'function add(a, b) {',
      '  const x = a + b;',
      '  const y = x * 2;',
      '  const z = y - 1;',
      '  const w = z / 3;',
      '  const v = w + 100;',
      '  return v;',
      '}',
    ].join('\n');
    const out = foldCodeBodies(src, 'ts', FOLD_OPTS);
    expect(out).toContain('function add(a, b) {');
    expect(out).toContain('}');
    expect(out).toContain('lines elided');
    expect(out).not.toContain('const w = z / 3;');
  });

  it('folds a Python body by indentation, keeping the def line', () => {
    const src = [
      'def foo():',
      '    a = 1',
      '    b = 2',
      '    c = 3',
      '    d = 4',
      '    e = 5',
      '    return e',
    ].join('\n');
    const out = foldCodeBodies(src, 'python', FOLD_OPTS);
    expect(out).toContain('def foo():');
    expect(out).toContain('# … ');
    expect(out).not.toContain('c = 3');
  });

  it('keeps a leading docstring line outside the fold', () => {
    const src = [
      'def foo():',
      '    """summary line."""',
      '    a = 1',
      '    b = 2',
      '    c = 3',
      '    d = 4',
      '    e = 5',
    ].join('\n');
    const out = foldCodeBodies(src, 'python', FOLD_OPTS);
    expect(out).toContain('"""summary line."""');
    expect(out).toContain('# … ');
  });

  it('is deterministic', () => {
    const src = 'function f() {\n' + '  x();\n'.repeat(10) + '}';
    expect(foldCodeBodies(src, 'js', FOLD_OPTS)).toBe(foldCodeBodies(src, 'js', FOLD_OPTS));
  });
});

describe('codeCrusher module', () => {
  const bigFn =
    'function compute() {\n' +
    Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i} * 2;`).join('\n') +
    '\n  return 0;\n}';

  it('folds code in a tool_result and records savings', async () => {
    const mod = codeCrusher({ minBlockTokens: 0 });
    const ctx = makeContext(makeRequest({ messages: [toolResultMsg(bigFn)] }));
    await mod.pre!(ctx);

    const block = (ctx.request.messages[0].content as ContentBlock[])[0];
    const text = block.type === 'tool_result' ? (block.content as string) : '';
    expect(text).toContain('function compute() {');
    expect(text).toContain('lines elided');
    expect(ctx.metadata.get('code-crusher.regions')).toBeGreaterThan(0);
    expect(ctx.metadata.get('code-crusher.tokens.saved')).toBeGreaterThan(0);
  });

  it('does not fold whole prose text blocks (only fenced regions)', async () => {
    const mod = codeCrusher({ minBlockTokens: 0, targets: ['text'] });
    const prose = `Here is a long explanation. ${'word '.repeat(400)}`;
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: prose }] }] }),
    );
    await mod.pre!(ctx);
    const block = (ctx.request.messages[0].content as ContentBlock[])[0];
    expect(block.type === 'text' ? block.text : '').toBe(prose);
    expect(ctx.metadata.get('code-crusher.regions')).toBe(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
