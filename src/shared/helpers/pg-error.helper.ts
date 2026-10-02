import { ConnectionErrno, PgErrorCode } from '../enums/pg-error.enum';

const RETRYABLE = new Set<string>([
  PgErrorCode.SerializationFailure,
  PgErrorCode.DeadlockDetected,
  PgErrorCode.LockNotAvailable,
]);

const CONNECTION_ERRNOS = new Set<string>(Object.values(ConnectionErrno));

export const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Postgres states that mean "contention, try again", not "you broke something". */
export const isRetryable = (err: unknown): boolean => {
  const code = sqlState(err);
  return code !== undefined && RETRYABLE.has(code);
};

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  if (sqlState(err) !== PgErrorCode.UniqueViolation) return false;
  if (!constraint) return true;
  return (err as { constraint?: string }).constraint === constraint;
};

/** Pool exhaustion surfaces as a driver timeout, not as a SQLSTATE. */
export const isPoolTimeout = (err: unknown): boolean => {
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    (message.includes('timeout exceeded when trying to connect') ||
      message.includes('Connection terminated due to connection timeout'))
  );
};

/**
 * The database is unreachable, as opposed to busy. Distinguished from pool
 * exhaustion because the honest answer differs: a saturated pool clears in
 * milliseconds and deserves a 429, whereas an unreachable database means we
 * cannot safely decide anything and must say so with a 503.
 */
export const isConnectionFailure = (err: unknown): boolean => {
  const error = err as { code?: unknown; message?: unknown } | null;
  if (typeof error?.code === 'string' && CONNECTION_ERRNOS.has(error.code)) {
    return true;
  }
  if (typeof error?.message !== 'string') return false;
  return (
    error.message.includes('Connection terminated unexpectedly') ||
    error.message.includes('terminating connection due to administrator command') ||
    error.message.includes('the database system is starting up') ||
    error.message.includes('getaddrinfo') ||
    error.message.includes('connect ECONNREFUSED')
  );
};
