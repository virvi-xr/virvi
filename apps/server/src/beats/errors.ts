/** A BEAT refusal with the HTTP status and a stable code the dashboard keys on (LIV-11). `details` are extra fields
 * the response carries next to `error` and `message` (say, below_minimum's minSupply). */
export class BeatError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message)
  }
}
