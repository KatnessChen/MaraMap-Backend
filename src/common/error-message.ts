/** Safe message extraction for a `catch (err: unknown)` — a thrown value is not guaranteed to be an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
