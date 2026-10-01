import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { DeclineReason, DomainError } from '../errors/domain-error';
import {
  isConnectionFailure,
  isPoolTimeout,
  isRetryable,
  sqlState,
} from '../errors/pg-errors';
import { log } from '../logging/logger';
import { getRequestId } from '../logging/request-context';
import { MetricsService } from '../../metrics/metrics.service';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  request_id?: string;
}

/**
 * The single place an outcome becomes a status code.
 *
 * The contract we are holding to is: a decline is a 4xx, and a 5xx means we
 * genuinely broke. So anything the domain can produce on purpose is mapped
 * here, and the two infrastructure conditions that would otherwise leak as
 * 500s during a burst -- pool exhaustion and an exhausted lock retry -- are
 * mapped to 429 instead, which is honest (shed load) rather than alarming.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly metrics: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = getRequestId();
    const route = routeOf(request);

    const { status, body, severity } = this.translate(exception, requestId);

    if (status === 503) void reply.header('Retry-After', '5');

    if (status >= 500) {
      this.metrics.serverErrors.inc({ route });
      log({ route, status, err: serialise(exception) }).error(
        'unhandled error produced a 5xx',
      );
    } else if (severity === 'warn') {
      log({ route, status, code: body.error.code }).warn('request shed under load');
    }

    if (reply.sent) return;
    void reply.status(status).send(body);
  }

  private translate(
    exception: unknown,
    requestId: string | undefined,
  ): { status: number; body: ErrorBody; severity: 'info' | 'warn' | 'error' } {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        severity: 'info',
        body: {
          error: {
            code: exception.reason,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
          },
          request_id: requestId,
        },
      };
    }

    // Pool exhaustion and a retry budget blown on lock contention are both
    // "we are over capacity", not "we are broken". 429 keeps the burst clean.
    if (isPoolTimeout(exception) || isRetryable(exception)) {
      return {
        status: 429,
        severity: 'warn',
        body: {
          error: {
            code: DeclineReason.SERVICE_BUSY,
            message: 'Service is saturated, retry shortly',
            details: { sqlstate: sqlState(exception) ?? 'pool_timeout' },
          },
          request_id: requestId,
        },
      };
    }

    // The database is unreachable. This one stays a 5xx on purpose.
    //
    // The "no 5xx" bar is about declines: a seat that is gone, or a user over
    // their limit, is a business answer and must be a 4xx. A database we
    // cannot reach is not an answer at all -- we cannot know whether the seat
    // is free, and the only safe thing is to refuse. Returning 429 here would
    // tell the client "retry, you might win", which is a lie that under a
    // partition turns into a double-sell. 503 + Retry-After is the honest
    // code, and readiness has already failed closed so the load balancer
    // should be draining us anyway.
    if (isConnectionFailure(exception)) {
      return {
        status: 503,
        severity: 'error',
        body: {
          error: {
            code: 'dependency_unavailable',
            message: 'Database is unreachable; no reservation decision can be made',
          },
          request_id: requestId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message ?? exception.message);
      return {
        status,
        severity: status >= 500 ? 'error' : 'info',
        body: {
          error: {
            code: codeForStatus(status),
            message: Array.isArray(message) ? message.join('; ') : String(message),
            ...(Array.isArray(message) ? { details: { violations: message } } : {}),
          },
          request_id: requestId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      severity: 'error',
      body: {
        error: { code: 'internal_error', message: 'Internal server error' },
        request_id: requestId,
      },
    };
  }
}

const codeForStatus = (status: number): string => {
  switch (status) {
    case 400:
    case 422:
      return DeclineReason.VALIDATION_FAILED;
    case 401:
      return DeclineReason.UNAUTHENTICATED;
    case 403:
      return DeclineReason.FORBIDDEN;
    case 404:
      return 'not_found';
    case 429:
      return DeclineReason.SERVICE_BUSY;
    default:
      return status >= 500 ? 'internal_error' : 'request_failed';
  }
};

const routeOf = (request: FastifyRequest | undefined): string => {
  const templated = (request as { routeOptions?: { url?: string } } | undefined)
    ?.routeOptions?.url;
  return templated ?? request?.url?.split('?')[0] ?? 'unknown';
};

const serialise = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
    };
  }
  return { value: String(err) };
};
