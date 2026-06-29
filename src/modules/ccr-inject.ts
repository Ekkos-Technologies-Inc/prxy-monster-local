/**
 * ccr-inject — injects the prxy_retrieve tool for CCR (Compress-Cache-Retrieve).
 *
 * Pair with structured-crusher / code-crusher when `ccr: true` is set on those
 * modules. Crushers stamp `__prxy_ccr` hashes on crushed payloads; the model can
 * call prxy_retrieve to pull the original from blob storage.
 *
 * Recommended order:
 *   structured-crusher (ccr:true), code-crusher, ccr-inject, ipc, …
 */

import type { CanonicalTool } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface CcrInjectConfig {
  /** Tool name exposed to the model. Default prxy_retrieve. */
  toolName?: string;
}

const DEFAULT_TOOL: CanonicalTool = {
  name: 'prxy_retrieve',
  description:
    'Retrieve original uncompressed content that prxy CCR stored before crushing. ' +
    'Pass the hash from a __prxy_crushed payload (__prxy_ccr field).',
  inputSchema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'CCR content hash from the crushed payload marker.',
      },
      query: {
        type: 'string',
        description: 'Optional substring filter when searching within cached JSON arrays.',
      },
    },
    required: ['hash'],
  },
};

export function ccrInject(config: CcrInjectConfig = {}): Module {
  const toolName = config.toolName ?? 'prxy_retrieve';

  return {
    name: 'ccr-inject',
    version: '1.0.0',

    async pre(ctx) {
      const tool: CanonicalTool = {
        ...DEFAULT_TOOL,
        name: toolName,
      };

      const existing = ctx.request.tools ?? [];
      if (existing.some((t) => t.name === toolName)) {
        return { continue: true };
      }

      ctx.request.tools = [...existing, tool];
      ctx.metadata.set('ccr-inject.tool', toolName);
      ctx.metadata.set('ccr-inject.applied', true);
      return { continue: true };
    },
  };
}