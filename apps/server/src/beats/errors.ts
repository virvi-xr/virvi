/** A BEAT refusal with the HTTP status and a stable code the dashboard keys on (LIV-11). */
export class BeatError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}
