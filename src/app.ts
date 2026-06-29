/**
 * Express app factory — exported separately from `server.ts` so tests can mount
 * the app via supertest without listening on a real port.
 */

import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { anthropicHandler } from './handlers/anthropic.js';
import { callsJsonHandler, debugPageHandler } from './handlers/debug.js';
import { healthHandler } from './handlers/health.js';
import { openaiHandler } from './handlers/openai.js';
import { outcomesHandler } from './handlers/outcomes.js';
import { pipelineHandler } from './handlers/pipeline.js';
import { sendError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/ratelimit.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (req, res) => {
        if (req.url === '/health') return 'debug';
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Public
  app.get('/health', healthHandler);
  app.get('/debug', debugPageHandler);
  app.get('/v1/calls', callsJsonHandler);

  // Authed gateway endpoints
  app.get('/v1/pipeline', authMiddleware, pipelineHandler);
  app.post('/v1/outcomes', authMiddleware, outcomesHandler);
  app.post('/v1/messages', authMiddleware, rateLimitMiddleware, anthropicHandler);
  app.post('/v1/chat/completions', authMiddleware, rateLimitMiddleware, openaiHandler);

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { type: 'not_found', message: `No handler for ${req.method} ${req.path}` },
    });
  });

  // Final error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    sendError(res, err);
  });

  return app;
}
