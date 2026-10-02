import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { DeclineReason } from '../enums/reservation.enum';
import { DomainException } from './domain.exception';
import {
  isConnectionFailure,
  isPoolTimeout,
  isRetryable,
  sqlState,
} from '../helpers/pg-error.helper';
import { log } from '../logger/logger';
import { getRequestId } from '../logger/request-context';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  request_id?: string;
}

interface TranslatedError {
  status: number;
  body: ErrorResponseBody;
  severity: 'info' | 'warn' | 'error';
}

/**
 * The single place an outcome becomes a status code.
 *
 * The contract: a decline is a 4xx, and a 5xx means we genuinely broke. So
 * everything the domain raises on purpose is mapped here, and the two
 * infrastructure conditions that would otherwise leak as 500s during a burst
 * -- pool exhaustion and an exhausted lock-retry budget -- become 429, which
 * is honest (shed load) rather than alarming.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly metricsService: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = getRequestId();
    const route = routeOf(request);

    const { status, body, severity } = this.translate(exception, requestId);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      void reply.header('Retry-After', '5');
    }

    if (status >= 500) {
      this.metricsService.serverErrors.inc({ route });
      log({ route, status, err: serialiseError(exception) }).error(
        'unhandled error produced a 5xx',
      );
    } else if (severity === 'warn') {
      log({ route, status, code: body.error.code }).warn('request shed under load');
    }

    if (reply.sent) return;
    void reply.status(status).send(body);
  }

  private translate(exception: unknown, requestId?: string): TranslatedError {
    if (exception instanceof DomainException) {
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

    // Pool exhaustion and a retry budget blown on lock contention both mean
    // "over capacity", not "broken". 429 keeps the burst clean and honest.
    if (isPoolTimeout(exception) || isRetryable(exception)) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
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
    // is free. Returning 429 here would tell the client "retry, you might
    // win", which under a partition is the lie that produces a double-sell.
    if (isConnectionFailure(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        severity: 'error',
        body: {
          error: {
            code: DeclineReason.DEPENDENCY_UNAVAILABLE,
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
        error: {
          code: DeclineReason.INTERNAL_ERROR,
          message: 'Internal server error',
        },
        request_id: requestId,
      },
    };
  }
}

const codeForStatus = (status: number): string => {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return DeclineReason.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return DeclineReason.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return DeclineReason.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.TOO_MANY_REQUESTS:
      return DeclineReason.SERVICE_BUSY;
    default:
      return status >= 500 ? DeclineReason.INTERNAL_ERROR : 'request_failed';
  }
};

const routeOf = (request?: FastifyRequest): string =>
  (request as { routeOptions?: { url?: string } } | undefined)?.routeOptions?.url ??
  request?.url?.split('?')[0] ??
  'unknown';

const serialiseError = (err: unknown): Record<string, unknown> => {
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
