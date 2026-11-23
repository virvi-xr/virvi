/** A giveaway refusal with the HTTP status and a stable code the dashboard keys on (LIV-194). `details` are extra fields
 * the response carries next to `error` and `message`. */
export class GiveawayError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message)
  }
}
