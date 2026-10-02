/**
 * TypeORM's Postgres driver returns a bare row array for SELECT and INSERT,
 * but `[rows, rowCount]` for UPDATE and DELETE.
 *
 * Getting that wrong silently turns a `RETURNING` row count into 2, which is
 * exactly the kind of thing that makes a compare-and-swap guard pass when it
 * should have failed. Centralised here rather than repeated at every call
 * site, because it only has to be forgotten once.
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
