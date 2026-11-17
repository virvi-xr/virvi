/**
 * Text for a log line with every URL cut to its origin: RPC providers put their keys in the path (Alchemy:
 * /v2/<key>), and ethers copies the request URL into its error messages. `http://host:port` stays readable.
 */
export function logSafe(text: string): string {
  return text.replace(/\b(https?|wss?):\/\/[^\s"'<>)\]}]+/gi, (url) => {
    try {
      const u = new URL(url)
      const bare = `${u.protocol}//${u.host}`
      return u.pathname === '/' && !u.search && !u.hash ? bare : `${bare}/…`
    } catch {
      return '[url]'
    }
  })
}
