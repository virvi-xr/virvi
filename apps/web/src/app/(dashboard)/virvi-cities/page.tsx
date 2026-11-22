'use client'
// The dashboard's Cities page: the Cities Virvi runs, and where to visit them.
import { PageHeader } from '@/components/ui'
import { CityList } from '@/components/cities/CityList'

export default function VirviCitiesPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader title="Cities" subtitle="Worlds run by Virvi, with apartments, stores and venues to look around." />
      <CityList />
      <p className="mt-4 text-sm text-gray-400"><a href="/cities/" className="underline underline-offset-2 hover:text-white">The Cities page</a> is there for anyone to read.</p>
    </div>
  )
}
