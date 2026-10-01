import pino from 'pino';
import { loadConfig } from '../../config/configuration';
import { getRequestContext } from './request-context';

const cfg = loadConfig();

export const rootLogger = pino({
  level: cfg.logLevel,
  base: { service: 'seat-reservation-service', env: cfg.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['req.headers.authorization', 'headers.authorization', 'token'],
    censor: '[redacted]',
  },
});

/**
 * Every log line carries the correlation id of the request that produced it,
 * pulled from AsyncLocalStorage so call sites never have to thread it through.
 */
export const log = (bindings: Record<string, unknown> = {}) => {
  const ctx = getRequestContext();
  return rootLogger.child({
    ...(ctx ? { request_id: ctx.requestId, user_id: ctx.userId } : {}),
    ...bindings,
  });
};

export const nestLoggerAdapter = {
  log: (message: unknown, context?: string) =>
    rootLogger.info({ context }, String(message)),
  error: (message: unknown, trace?: string, context?: string) =>
    rootLogger.error({ context, trace }, String(message)),
  warn: (message: unknown, context?: string) =>
    rootLogger.warn({ context }, String(message)),
  debug: (message: unknown, context?: string) =>
    rootLogger.debug({ context }, String(message)),
  verbose: (message: unknown, context?: string) =>
    rootLogger.trace({ context }, String(message)),
  fatal: (message: unknown, context?: string) =>
    rootLogger.fatal({ context }, String(message)),
};
