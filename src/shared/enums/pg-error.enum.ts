/** Postgres SQLSTATEs this service reacts to by name rather than by message. */
export enum PgErrorCode {
  SerializationFailure = '40001',
  DeadlockDetected = '40P01',
  LockNotAvailable = '55P03',
  UniqueViolation = '23505',
  CheckViolation = '23514',
  QueryCanceled = '57014',
}

/** Node/libpq connection-level errnos that mean "the database is unreachable". */
export enum ConnectionErrno {
  ConnectionRefused = 'ECONNREFUSED',
  NotFound = 'ENOTFOUND',
  ConnectionReset = 'ECONNRESET',
  HostUnreachable = 'EHOSTUNREACH',
  NetworkUnreachable = 'ENETUNREACH',
  BrokenPipe = 'EPIPE',
  TimedOut = 'ETIMEDOUT',
}
