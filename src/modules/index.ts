/**
 * Built-in modules shipped with prxy-monster-local.
 *
 * v0.4.0 ships 15 modules: airgap, cost-guard, exact-cache, ipc, mcp-optimizer,
 * patterns, semantic-cache, router, prompt-optimizer, tool-cache, guardrails,
 * rehydrator, compaction-bridge, structured-crusher, code-crusher.
 *
 * Modules are exported two ways:
 *   - Named factory functions (preferred for direct imports + custom config)
 *   - As entries in `BUILTIN_MODULES`, keyed by canonical pipeline name (used
 *     by the loader to resolve `PRXY_PIPE` strings).
 */

import type { Module } from '../types/sdk.js';

import { airgap, type AirgapConfig } from './airgap.js';
import { compactionBridge, type CompactionBridgeConfig } from './compaction-bridge.js';
import { costGuard, type CostGuardConfig } from './cost-guard.js';
import { ccrInject, type CcrInjectConfig } from './ccr-inject.js';
import { ccrRetrieve, type CcrRetrieveConfig } from './ccr-retrieve.js';
import { steelBrowser, type SteelBrowserConfig } from './steel-browser.js';
import {
  structuredCrusher,
  type StructuredCrusherConfig,
  codeCrusher,
  type CodeCrusherConfig,
} from './crushers.js';
import { exactCache, type ExactCacheConfig } from './exact-cache.js';
import { guardrails, type GuardrailsConfig, type GuardrailBackend } from './guardrails.js';
import { ipc, type IpcConfig } from './ipc.js';
import { mcpOptimizer, type McpOptimizerConfig } from './mcp-optimizer.js';
import { patterns, type PatternsConfig } from './patterns.js';
import {
  promptOptimizer,
  type PromptOptimizerConfig,
  type CacheControlMode,
} from './prompt-optimizer.js';
import { rehydrator, type RehydratorConfig } from './rehydrator.js';
import { router, type RouterConfig, type RouterStrategy } from './router.js';
import { semanticCache, type SemanticCacheConfig } from './semantic-cache.js';
import { toolCache, type ToolCacheConfig } from './tool-cache.js';

export {
  airgap,
  ccrInject,
  ccrRetrieve,
  steelBrowser,
  codeCrusher,
  compactionBridge,
  costGuard,
  exactCache,
  guardrails,
  ipc,
  structuredCrusher,
  mcpOptimizer,
  patterns,
  promptOptimizer,
  rehydrator,
  router,
  semanticCache,
  toolCache,
};

export type {
  AirgapConfig,
  CcrInjectConfig,
  CcrRetrieveConfig,
  SteelBrowserConfig,
  CodeCrusherConfig,
  CompactionBridgeConfig,
  CostGuardConfig,
  ExactCacheConfig,
  StructuredCrusherConfig,
  GuardrailBackend,
  GuardrailsConfig,
  IpcConfig,
  McpOptimizerConfig,
  CacheControlMode,
  PatternsConfig,
  PromptOptimizerConfig,
  RehydratorConfig,
  RouterConfig,
  RouterStrategy,
  SemanticCacheConfig,
  ToolCacheConfig,
};

// Re-export helpers
export { compressMessages } from './ipc.js';
export { detectPatternFromConversation } from './patterns.js';
export { isAirgapInstalled, _uninstallAirgap } from './airgap.js';
export { scoreCompaction } from './compaction-bridge.js';

export type ModuleFactory = (config?: Record<string, unknown>) => Module;

/**
 * Registry of canonical pipeline names -> factory.
 * Hyphenated names (`mcp-optimizer`) match the strings used in `PRXY_PIPE`.
 *
 * Note: `usage-tracker` is NOT included — that module is cloud-only (it reports
 * to the hosted billing engine). Local users get `cost-guard` instead, which
 * gives the same per-request/day/month caps without phoning home.
 */
export const BUILTIN_MODULES: Record<string, ModuleFactory> = {
  airgap: (cfg) => airgap(cfg as AirgapConfig | undefined),
  'ccr-inject': (cfg) => ccrInject(cfg as CcrInjectConfig | undefined),
  'ccr-retrieve': (cfg) => ccrRetrieve(cfg as CcrRetrieveConfig | undefined),
  'steel-browser': (cfg) => steelBrowser(cfg as SteelBrowserConfig | undefined),
  'code-crusher': (cfg) => codeCrusher(cfg as CodeCrusherConfig | undefined),
  'compaction-bridge': (cfg) =>
    compactionBridge(cfg as CompactionBridgeConfig | undefined),
  'cost-guard': (cfg) => costGuard(cfg as CostGuardConfig | undefined),
  'exact-cache': (cfg) => exactCache(cfg as ExactCacheConfig | undefined),
  'structured-crusher': (cfg) =>
    structuredCrusher(cfg as StructuredCrusherConfig | undefined),
  guardrails: (cfg) => guardrails(cfg as GuardrailsConfig | undefined),
  ipc: (cfg) => ipc(cfg as IpcConfig | undefined),
  'mcp-optimizer': (cfg) => mcpOptimizer(cfg as McpOptimizerConfig | undefined),
  patterns: (cfg) => patterns(cfg as PatternsConfig | undefined),
  'prompt-optimizer': (cfg) => promptOptimizer(cfg as PromptOptimizerConfig | undefined),
  rehydrator: (cfg) => rehydrator(cfg as RehydratorConfig | undefined),
  router: (cfg) => router(cfg as RouterConfig | undefined),
  'semantic-cache': (cfg) => semanticCache(cfg as SemanticCacheConfig | undefined),
  'tool-cache': (cfg) => toolCache(cfg as ToolCacheConfig | undefined),
};

export const DEFAULT_PIPELINE =
  'mcp-optimizer,exact-cache,semantic-cache,structured-crusher,code-crusher,ipc,patterns';
