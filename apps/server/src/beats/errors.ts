/** A BEAT refusal with the HTTP status and a stable code the dashboard keys on (LIV-11). `details` are extra fields
 * the response carries next to `error` and `message` (say, below_minimum's minSupply). */
export class BeatError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message)
  }
}

/**
 * The constraint a unique violation (Postgres 23505) ran into ('' when the driver didn't name it), or null for any other
 * error. The driver's error may come bare or wrapped by drizzle in `cause`.
 */
export function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null | undefined
  if ((err?.code ?? err?.cause?.code) !== '23505') return null
  return err?.constraint_name ?? err?.cause?.constraint_name ?? ''
}
