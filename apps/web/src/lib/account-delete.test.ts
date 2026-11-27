import { describe, it, expect } from 'vitest'
import { deleteAccountRequest, DELETE_WORD } from './account-delete'

describe('deleteAccountRequest', () => {
  it('an account with a password sends the password, once typed', () => {
    expect(deleteAccountRequest(true, '')).toBeNull()
    expect(deleteAccountRequest(true, 'pw-1234')).toEqual({ password: 'pw-1234' })
  })

  it('an account without one sends the typed DELETE, and only exactly that', () => {
    expect(DELETE_WORD).toBe('DELETE')
    expect(deleteAccountRequest(false, '')).toBeNull()
    expect(deleteAccountRequest(false, 'delete')).toBeNull()
    expect(deleteAccountRequest(false, ' DELETE ')).toEqual({ confirm: 'DELETE' })
    expect(deleteAccountRequest(false, 'DELETE')).toEqual({ confirm: 'DELETE' })
  })
})
