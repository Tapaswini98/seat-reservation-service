/** Postgres SQLSTATEs that mean "try again", not "you broke something". */
export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK_DETECTED = '40P01';
export const LOCK_NOT_AVAILABLE = '55P03';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
export const QUERY_CANCELED = '57014';

const RETRYABLE = new Set([
  SERIALIZATION_FAILURE,
  DEADLOCK_DETECTED,
  LOCK_NOT_AVAILABLE,
]);

export const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

export const isRetryable = (err: unknown): boolean => {
  const code = sqlState(err);
  return code !== undefined && RETRYABLE.has(code);
};

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  if (sqlState(err) !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return (err as { constraint?: string }).constraint === constraint;
};

/** Pool exhaustion surfaces as a timeout from node-postgres, not a SQLSTATE. */
export const isPoolTimeout = (err: unknown): boolean => {
  const message = (err as { message?: unknown } | null)?.message;
  return (
    typeof message === 'string' &&
    (message.includes('timeout exceeded when trying to connect') ||
      message.includes('Connection terminated due to connection timeout'))
  );
};

const CONNECTION_ERRNOS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * The database is unreachable, as opposed to busy. Distinguished from pool
 * exhaustion because the honest answer differs: a saturated pool clears in
 * milliseconds and deserves a 429, whereas an unreachable database means we
 * cannot safely decide anything and must say so.
 */
export const isConnectionFailure = (err: unknown): boolean => {
  const e = err as { code?: unknown; message?: unknown; errno?: unknown } | null;
  if (typeof e?.code === 'string' && CONNECTION_ERRNOS.has(e.code)) return true;
  if (typeof e?.message !== 'string') return false;
  return (
    e.message.includes('Connection terminated unexpectedly') ||
    e.message.includes('terminating connection due to administrator command') ||
    e.message.includes('the database system is starting up') ||
    e.message.includes('getaddrinfo') ||
    e.message.includes('connect ECONNREFUSED')
  );
};
