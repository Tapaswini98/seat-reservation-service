import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../../config/configuration';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { log } from '../logger/logger';
import { enterRequestContext } from '../logger/request-context';

const REQUEST_ID_HEADER = 'x-request-id';
const STARTED_AT = Symbol('startedAt');

type TimedRequest = FastifyRequest & { [STARTED_AT]?: bigint };

/**
 * Request instrumentation lives in Fastify hooks rather than a Nest
 * interceptor on purpose: `onResponse` fires for every single reply,
 * including ones produced by the exception filter, by Fastify's own 404
 * handler and by schema validation. An interceptor only sees requests that
 * reach a handler, which is exactly the wrong coverage when the thing being
 * proven is "zero 5xx across the whole burst".
 */
export const registerFastifyHooks = (
  app: FastifyInstance,
  metricsService: MetricsService,
): void => {
  const config = loadConfig();
  const sampleRate = Math.max(1, config.logSampleRate);
  let served = 0;

  app.addHook('onRequest', (request: TimedRequest, reply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId =
      (typeof incoming === 'string' && incoming.slice(0, 128)) || randomUUID();

    request[STARTED_AT] = process.hrtime.bigint();
    void reply.header(REQUEST_ID_HEADER, requestId);
    enterRequestContext({ requestId });
    done();
  });

  app.addHook('onResponse', (request: TimedRequest, reply: FastifyReply, done) => {
    const route = routeOf(request);
    const method = request.method ?? 'GET';
    const status = reply.statusCode;
    const labels = { method, route, status: String(status) };

    const startedAt = request[STARTED_AT];
    const seconds = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1e9 : 0;

    metricsService.httpRequests.inc(labels);
    metricsService.httpDuration.observe(labels, seconds);

    served += 1;
    // Declines are the interesting part of a burst, so every non-2xx is
    // logged in full. Successes are sampled: at 20k requests per second the
    // logger becomes the bottleneck and the signal is drowned regardless.
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
