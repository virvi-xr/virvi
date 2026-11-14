import BeatDetailPage from './client'

export async function generateStaticParams() {
  return [{ beatId: '_' }]
}

export default function Page() {
  return <BeatDetailPage />
}
