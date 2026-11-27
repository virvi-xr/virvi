/** What an account without a password types to confirm deleting it. */
export const DELETE_WORD = 'DELETE'

export type DeleteAccountBody = { password: string } | { confirm: typeof DELETE_WORD }

/**
 * The body for `DELETE /api/auth/account`: an account with a password confirms with it; one without (Google, Discord,
 * Apple, a wallet, a code) types DELETE. Null until the confirmation is complete.
 */
export function deleteAccountRequest(hasPassword: boolean, input: string): DeleteAccountBody | null {
  if (hasPassword) return input ? { password: input } : null
  return input.trim() === DELETE_WORD ? { confirm: DELETE_WORD } : null
}
