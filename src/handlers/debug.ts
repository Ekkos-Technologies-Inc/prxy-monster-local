/**
 * GET /debug — minimal local receipt viewer (last N calls + token savings).
 * GET /v1/calls — JSON API for the same data.
 */

import type { Request, Response } from 'express';

import { getStorage } from '../storage/adapter.js';

interface CallRow {
  id: string;
  created_at: number;
  path?: string;
  model?: string;
  provider?: string;
  short_circuited_by?: string | null;
  module_chain?: string[];
  metadata?: Record<string, unknown>;
  user_query?: string;
  response_excerpt?: string;
  input_tokens?: number;
  output_tokens?: number;
  tokens_saved?: number;
}

async function fetchRecentCalls(limit = 50): Promise<CallRow[]> {
  const storage = getStorage();
  const result = await storage.db
    .from('call_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  return (result.data ?? []) as CallRow[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function callsJsonHandler(_req: Request, res: Response): Promise<void> {
  const calls = await fetchRecentCalls(50);
  res.json({ calls, count: calls.length });
}

export async function debugPageHandler(_req: Request, res: Response): Promise<void> {
  const calls = await fetchRecentCalls(50);
  const totalSaved = calls.reduce((acc, c) => acc + (c.tokens_saved ?? 0), 0);

  const rows = calls
    .map((call) => {
      const chain = Array.isArray(call.module_chain)
        ? call.module_chain.join(' → ')
        : '—';
      const query = escapeHtml((call.user_query ?? '').slice(0, 120));
      const saved = call.tokens_saved ?? 0;
      const cache = call.short_circuited_by
        ? `<span class="hit">${escapeHtml(call.short_circuited_by)}</span>`
        : '<span class="dim">—</span>';
      const when = new Date(call.created_at).toLocaleString();
      return `<tr>
        <td class="mono dim">${when}</td>
        <td class="mono">${escapeHtml(call.model ?? '—')}</td>
        <td>${query || '<span class="dim">(empty)</span>'}</td>
        <td class="mono">${chain}</td>
        <td class="num">${saved > 0 ? `<span class="saved">−${saved}</span>` : '0'}</td>
        <td>${cache}</td>
        <td class="mono dim">${escapeHtml(call.id.slice(0, 8))}…</td>
      </tr>`;
    })
    .join('\n');

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>prxy local · call log</title>
  <style>
    :root { --bg:#0a0a0a; --line:#1a1a1a; --text:#eee; --muted:#888; --green:#84e61c; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
    .wrap { max-width:1200px; margin:0 auto; padding:28px 20px 48px; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0.04em; }
    .lead { color:var(--muted); margin:0 0 24px; max-width:720px; }
    .stats { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
    .stat { border:1px solid var(--line); padding:12px 16px; min-width:160px; }
    .stat strong { display:block; color:var(--green); font-size:22px; }
    table { width:100%; border-collapse:collapse; border:1px solid var(--line); }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:0.08em; }
    .mono { font-family:inherit; }
    .dim { color:var(--muted); }
    .saved { color:var(--green); font-weight:600; }
    .hit { color:var(--green); }
    .num { text-align:right; }
    a { color:var(--green); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Compress → prove → learn</h1>
    <p class="lead">Local call log — last ${calls.length} requests through prxy-monster-local. Token savings come from crusher + MCP + IPC metadata stamped per call. Submit outcomes with <code>POST /v1/outcomes</code> using <code>x-prxy-call-id</code>.</p>
    <div class="stats">
      <div class="stat"><strong>${calls.length}</strong>recent calls</div>
      <div class="stat"><strong>${totalSaved.toLocaleString()}</strong>tokens saved (sum)</div>
      <div class="stat"><strong><a href="/v1/calls">JSON</a></strong>machine-readable</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>When</th><th>Model</th><th>Query</th><th>Pipeline</th><th>Saved</th><th>Cache</th><th>Call id</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7" class="dim">No calls yet — point Claude Code or your SDK at this gateway.</td></tr>'}
      </tbody>
    </table>
    <p class="dim" style="margin-top:20px">Cloud receipts: <a href="https://receipts.prxy.monster">receipts.prxy.monster</a> · Docs: <a href="https://docs.prxy.monster/concepts/the-loop">the loop</a></p>
  </div>
</body>
</html>`);
}