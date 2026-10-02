import pino from 'pino';
import { loadConfig } from '../../config/configuration';
import { getRequestContext } from './request-context';

const config = loadConfig();

export const rootLogger = pino({
  level: config.logLevel,
  base: { service: 'seat-reservation-service', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['req.headers.authorization', 'headers.authorization', 'token'],
    censor: '[redacted]',
  },
});

/**
 * Every log line carries the correlation id of the request that produced it,
 * read from AsyncLocalStorage so no call site has to thread it through its
 * arguments.
 */
export const log = (bindings: Record<string, unknown> = {}) => {
  const context = getRequestContext();
  return rootLogger.child({
    ...(context ? { request_id: context.requestId, user_id: context.userId } : {}),
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
