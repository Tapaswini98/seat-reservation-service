import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config/configuration';
import { log } from './logging/logger';
import { enterRequestContext } from './logging/request-context';
import { MetricsService } from '../metrics/metrics.service';

const REQUEST_ID_HEADER = 'x-request-id';
const START_SYMBOL = Symbol('startedAt');

type TimedRequest = FastifyRequest & { [START_SYMBOL]?: bigint };

/**
 * Request instrumentation lives in Fastify hooks rather than a Nest
 * interceptor on purpose: `onResponse` fires for every single reply, including
 * ones produced by the exception filter, by Fastify's own 404 handler and by
 * schema validation. An interceptor only sees requests that reach a handler,
 * which is exactly the wrong coverage when the thing you are trying to prove is
 * "zero 5xx across the whole burst".
 */
export const registerHooks = (app: FastifyInstance, metrics: MetricsService): void => {
  const cfg = loadConfig();
  const sampleRate = Math.max(1, cfg.logSampleRate);
  let served = 0;

  app.addHook('onRequest', (request: TimedRequest, reply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId =
      (typeof incoming === 'string' && incoming.slice(0, 128)) || randomUUID();

    request[START_SYMBOL] = process.hrtime.bigint();
    void reply.header(REQUEST_ID_HEADER, requestId);
    // Propagates to every await in the request, so no call site has to thread
    // the correlation id through its arguments.
    enterRequestContext({ requestId });
    done();
  });

  app.addHook('onResponse', (request: TimedRequest, reply: FastifyReply, done) => {
    const route = routeOf(request);
    const method = request.method ?? 'GET';
    const status = reply.statusCode;
    const labels = { method, route, status: String(status) };

    const startedAt = request[START_SYMBOL];
    const seconds = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1e9 : 0;

    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(labels, seconds);

    served += 1;
    // Declines are the interesting part of a burst, so every non-2xx is logged
    // in full. Successes are sampled: at 20k requests per second the logger
    // becomes the bottleneck and the signal is drowned regardless.
    if (status >= 400 || served % sampleRate === 0) {
      log({
        method,
        route,
        status,
        duration_ms: +(seconds * 1000).toFixed(2),
      })[status >= 500 ? 'error' : 'info']('request completed');
    }
    done();
  });
};

const routeOf = (request: FastifyRequest): string =>
  (request as { routeOptions?: { url?: string } }).routeOptions?.url ??
  request.url?.split('?')[0] ??
  'unknown';
