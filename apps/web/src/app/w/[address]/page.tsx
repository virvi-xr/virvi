import WalletBeatsClient from './client'

export async function generateStaticParams() {
  return [{ address: '_' }]
}

// The static export has one page for every address, so the built-in title and description stay generic.
export const metadata = {
  title: 'BEATs held by a wallet',
  description: 'BEATs held by a wallet',
}

export default function Page() {
  return <WalletBeatsClient />
}
