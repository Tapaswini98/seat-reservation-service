/**
 * TypeORM's Postgres driver returns a bare row array for SELECT and INSERT,
 * but `[rows, rowCount]` for UPDATE and DELETE. Getting that wrong silently
 * turns a `RETURNING` row count into 2, which is precisely the kind of thing
 * that makes a compare-and-swap guard pass when it should have failed, so the
 * unwrapping is centralised here rather than repeated at each call site.
 */
export const rowsOf = <T>(result: unknown): T[] => {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
};
