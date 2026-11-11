// Per-address limit for routes that check a password, reset token or wallet signature: slows credential guessing
// far below the global API limit. Set on each route's own config: a scope onRoute hook runs after
// @fastify/rate-limit's (registered on the root), so a scope-wide default never reaches the plugin.
export const CREDENTIAL_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const
