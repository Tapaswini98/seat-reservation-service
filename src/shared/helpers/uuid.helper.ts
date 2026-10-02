const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Guards every path id before it reaches Postgres. Without this a malformed
 * id produces `invalid input syntax for type uuid`, which is a 500 for what is
 * really a 404.
 */
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);
