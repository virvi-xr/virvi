import { SUMMIT_NO_SOURCE, type AdminSummitSignup, type AdminSummitTotals, type SummitInPersonStatus } from '@virvixr/shared'
import { StatCard } from '@/components/analytics/StatCard'
import { tableHeadBand } from '@/components/ui'
import { JOIN_AS_LABELS, SUMMIT_OFFERINGS } from '@/lib/summit'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })
const offeringName = (id: string) => SUMMIT_OFFERINGS.find((o) => o.id === id)?.name ?? id

function details(s: AdminSummitSignup): string {
  if (s.joinAs === 'in_person') return `Party of ${s.partySize ?? 1} · ${s.inPersonStatus ?? 'requested'}`
  if (s.joinAs === 'watch_party') return s.expectedGuests ? `${s.city} · ${s.expectedGuests} guests` : (s.city ?? '—')
  return '—'
}

const button = 'rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50'

/** Admin: the Summit totals and sign-up list, newest first. In-person rows can be confirmed or declined. */
export function AdminSummit({ signups, totals, onDecide, busyId }: {
  signups: AdminSummitSignup[]
  totals: AdminSummitTotals
  onDecide: (id: string, status: SummitInPersonStatus) => void
  busyId: string | null
}) {
  const sources = Object.entries(totals.bySource).sort((a, b) => b[1] - a[1])
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Online" value={String(totals.byJoinAs.online)} />
        <StatCard label="In person" value={String(totals.byJoinAs.in_person)} hint={`${totals.byJoinAs.in_person} requests · ${totals.inPersonPeople} people`} />
        <StatCard label="Watch parties" value={String(totals.byJoinAs.watch_party)} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm text-gray-400">By interest</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 text-sm text-gray-200">
            {SUMMIT_OFFERINGS.map((o) => <li key={o.id}>{`${o.name}: ${totals.byInterest[o.id]}`}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm text-gray-400">By source</p>
          {sources.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">—</p>
          ) : (
            <ul className="mt-2 grid grid-cols-2 gap-1 text-sm text-gray-200">
              {sources.map(([k, n]) => <li key={k}>{`${k === SUMMIT_NO_SOURCE ? 'No ref' : k}: ${n}`}</li>)}
            </ul>
          )}
        </div>
      </div>

      {signups.length === 0 ? (
        <p className="text-gray-400">No one has signed up yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className={tableHeadBand}>
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Email</th>
                <th className="p-2">How</th>
                <th className="p-2">Details</th>
                <th className="p-2">Interests</th>
                <th className="p-2">Source</th>
                <th className="p-2">Signed up</th>
                <th className="p-2"><span className="sr-only">In-person place</span></th>
              </tr>
            </thead>
            <tbody>
              {signups.map((s) => (
                <tr key={s.id} className="border-t border-gray-800 align-top">
                  <td className="p-2">{s.name}</td>
                  <td className="p-2"><a href={`mailto:${s.email}`} className="text-blue-400 hover:text-blue-300 hover:underline">{s.email}</a></td>
                  <td className="p-2 whitespace-nowrap">{JOIN_AS_LABELS[s.joinAs]}</td>
                  <td className="p-2 whitespace-nowrap text-gray-300">{details(s)}</td>
                  <td className="p-2 text-gray-300">{s.interests.length ? s.interests.map(offeringName).join(', ') : '—'}</td>
                  <td className="p-2 text-gray-300">{s.source ?? '—'}</td>
                  <td className="p-2 whitespace-nowrap text-gray-400">{dateFmt.format(new Date(s.createdAt))}</td>
                  <td className="p-2 whitespace-nowrap">
                    {s.joinAs === 'in_person' && (
                      <span className="flex gap-2">
                        {s.inPersonStatus !== 'confirmed' && (
                          <button type="button" disabled={busyId === s.id} onClick={() => onDecide(s.id, 'confirmed')} className={`${button} border-accent text-accent hover:bg-gray-800`}>Confirm</button>
                        )}
                        {s.inPersonStatus !== 'declined' && (
                          <button type="button" disabled={busyId === s.id} onClick={() => onDecide(s.id, 'declined')} className={`${button} border-gray-700 text-gray-300 hover:bg-gray-800`}>Decline</button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
