import InvitePage from './client'

// One exported page for every invite link: the server serves /studio/invite/<token>/ from studio/invite/_/, and the
// page reads the token from the URL
export async function generateStaticParams() {
  return [{ token: '_' }]
}

export default function Page() {
  return <InvitePage />
}
