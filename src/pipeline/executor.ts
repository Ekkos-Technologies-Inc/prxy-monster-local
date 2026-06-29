/**
 * Pipeline executor.
 *
 * Runs pre-modules sequentially (first-success-wins for short-circuits), then
 * the provider call, then post-modules in parallel as fire-and-forget side
 * effects (must not block the response to the client).
 *
 * Module errors are non-critical by default — we log and continue. A module
 * that *intentionally* wants to halt the pipeline must do so with
 * `{ continue: false, response }` from its `pre()`.
 */

import type { CanonicalResponse } from '../types/canonical.js';
import type { Logger, Module, RequestContext, ResponseContext } from '../types/sdk.js';
import { maybeRunCcrRetrieveLoop } from '../modules/ccr-retrieve.js';
import { maybeRunSteelBrowserLoop } from '../modules/steel-browser.js';

export interface ExecuteOptions {
  /** Which modules to run for this request. Empty array → no pipeline. */
  modules: Module[];
  /** Pre-built request context (storage, apiKey, logger, etc). */
  ctx: RequestContext;
  /** The provider call wrapped as a function so the executor controls when it runs. */
  callProvider: () => Promise<CanonicalResponse>;
  /** Optional override for log channel. Defaults to ctx.logger. */
  logger?: Logger;
}

export interface ExecutionResult {
  response: CanonicalResponse;
  /** Module that short-circuited the pipeline, if any. */
  shortCircuitedBy: string | null;
  /** Names of modules whose pre() ran without short-circuiting. */
  preRan: string[];
  /** Names of modules whose pre() threw. */
  preFailed: string[];
}

export async function executePipeline(opts: ExecuteOptions): Promise<ExecutionResult> {
  const { modules, ctx, callProvider } = opts;
  const log = opts.logger ?? ctx.logger;

  const preRan: string[] = [];
  const preFailed: string[] = [];
  let shortCircuitedBy: string | null = null;
  let response: CanonicalResponse | undefined;

  // Pre-modules — sequential, short-circuit on first { continue: false }
  for (const mod of modules) {
    if (!mod.pre) continue;
    try {
      const result = await mod.pre(ctx);
      preRan.push(mod.name);
      if (!result.continue) {
        shortCircuitedBy = mod.name;
        response = result.response;
        log.info(`pipeline short-circuited by ${mod.name}`);
        break;
      }
    } catch (err) {
      preFailed.push(mod.name);
      log.warn(`module ${mod.name} pre() failed; continuing`, err);
    }
  }

  // Provider call (skipped if short-circuited)
  if (!response) {
    response = await callProvider();

    if (modules.some((m) => m.name === 'ccr-retrieve')) {
      const loop = await maybeRunCcrRetrieveLoop({
        ctx,
        response,
        callProvider,
        config: {},
        logger: log,
      });
      response = loop.response;
      if (loop.loops > 0) {
        ctx.metadata.set('ccr-retrieve.auto_loops', loop.loops);
        ctx.metadata.set('ccr-retrieve.applied', true);
      }
    }

    if (modules.some((m) => m.name === 'steel-browser')) {
      const loop = await maybeRunSteelBrowserLoop({
        ctx,
        response,
        callProvider,
        config: {},
        logger: log,
      });
      response = loop.response;
      if (loop.loops > 0) {
        ctx.metadata.set('steel-browser.auto_loops', loop.loops);
        ctx.metadata.set('steel-browser.applied', true);
      }
    }
  }

  // Post-modules — fire-and-forget. We schedule them but don't await; the
  // caller has already gotten the response before this returns.
  const responseCtx: ResponseContext = {
    ...ctx,
    response,
    durationMs: Date.now() - ctx.startTime,
  };
  schedulePostHooks(modules, responseCtx, log);

  return { response, shortCircuitedBy, preRan, preFailed };
}

function schedulePostHooks(modules: Module[], ctx: ResponseContext, log: Logger): void {
  for (const mod of modules) {
    if (!mod.post) continue;
    Promise.resolve()
      .then(() => mod.post!(ctx))
      .catch((err) => {
        log.warn(`module ${mod.name} post() failed`, err);
      });
  }
}

/**
 * Convenience: build a RequestContext from the bits the handler has on hand.
 */
export function buildRequestContext(args: {
  request: RequestContext['request'];
  apiKey: RequestContext['apiKey'];
  storage: RequestContext['storage'];
  logger: RequestContext['logger'];
}): RequestContext {
  return {
    request: args.request,
    apiKey: args.apiKey,
    storage: args.storage,
    logger: args.logger,
    metadata: new Map(),
    startTime: Date.now(),
  };
}
