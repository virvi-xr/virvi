'use client'

import { useEffect, useState } from 'react'
import { AD_SHAPES } from '@virvixr/shared'
import type { AdminAd, AdReport, AdShape, LevelCounts } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi, fileToBase64, mediaContentType, uploadErrorMessage } from '@/lib/api'
import type { AdminAdSpace } from '@/lib/api'
import { shapeLabel, isHttpsUrl, clickRate, contentLabel, reviewBadge } from '@/lib/ads'
import { PageHeader, PrimaryButton, Skeleton, tableHeadBand, TableScroll } from '@/components/ui'
import { PlusIcon } from '@/components/icons'

const ERRORS: Record<string, string> = {
  click_url_must_be_https: 'The click URL must start with https://',
  house_ads_go_everywhere: 'House ads run everywhere, so they have no placements.',
  media_not_ready: 'That file is still processing. Try again in a moment.',
  ad_has_no_creatives: 'Add at least one creative before approving this ad.',
  reason_required: 'Give a reason for rejecting this ad.',
  audience_required: 'Choose who this ad is suitable for.',
  elements_must_be_ad_spaces: 'Ads can only be placed on ad spaces and on screens in an ads mode.',
}
const errorText = (e: any): string => ERRORS[e?.message] ?? e?.message ?? 'Something went wrong'

const TONES = { pending: 'text-yellow-400', ok: 'text-green-400', bad: 'text-red-400' } as const

const fmt = new Intl.NumberFormat('en-US')

/** Admin: create ads, attach creatives per shape, place them on ad spaces, and read the numbers. */
export default function AdminAdsPage() {
  const { user } = useAuth()
  const api = useApi()
  const [ads, setAds] = useState<AdminAd[] | null>(null)
  const [spaces, setSpaces] = useState<AdminAdSpace[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [backInReview, setBackInReview] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (user?.role !== 'admin') return
    api.getAdminAds().then((d) => setAds(d.ads), (e) => setError(errorText(e)))
    api.getAdminAdSpaces().then((d) => setSpaces(d.spaces), (e) => setError(errorText(e)))
  }, [user?.role])

  const markBackInReview = (id: string, prevStatus: AdminAd['review']['status'] | undefined, nextStatus: AdminAd['review']['status']) =>
    setBackInReview((prev) => {
      const next = new Set(prev)
      if (nextStatus !== 'pending') next.delete(id)
      else if (prevStatus && prevStatus !== 'pending') next.add(id)
      return next
    })

  const replaceAd = (ad: AdminAd) => {
    markBackInReview(ad.id, ads?.find((a) => a.id === ad.id)?.review.status, ad.review.status)
    setAds((prev) => prev?.map((a) => (a.id === ad.id ? ad : a)) ?? null)
  }

  /** A creative edit returns no ad, so reload the list to pick up the server's review status. */
  const reloadAfterEdit = async (id: string, prevStatus: AdminAd['review']['status']) => {
    try {
      const d = await api.getAdminAds()
      const fresh = d.ads.find((a) => a.id === id)
      if (fresh) markBackInReview(id, prevStatus, fresh.review.status)
      setAds(d.ads)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const pending = ads?.filter((a) => a.review.status === 'pending') ?? []

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Ads']}
        title="Ads"
        count={ads ? String(ads.length) : undefined}
        subtitle="Partner ads run on the spaces you place them on. House ads fill any space with no partner ad and pay nothing."
        actions={<PrimaryButton onClick={() => setCreating((v) => !v)}><PlusIcon size={16} />New ad</PrimaryButton>}
      />
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {creating && (
        <NewAdForm
          onCreated={(ad) => { setAds((prev) => [...(prev ?? []), ad]); setCreating(false); setOpenId(ad.id) }}
          onCancel={() => setCreating(false)}
        />
      )}
      {ads && <ReviewQueue ads={pending} onReviewed={replaceAd} />}
      {!ads ? (
        <Skeleton rows={2} className="h-12" />
      ) : ads.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">No ads yet.</p>
      ) : (
        <div className="space-y-3">
          {ads.map((ad) => (
            <AdCard key={ad.id} ad={ad} spaces={spaces} open={openId === ad.id} backInReview={backInReview.has(ad.id)} onEdited={reloadAfterEdit}
              onToggle={() => setOpenId(openId === ad.id ? null : ad.id)} onChange={replaceAd} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewQueue({ ads, onReviewed }: { ads: AdminAd[]; onReviewed: (ad: AdminAd) => void }) {
  return (
    <section className="mb-6 space-y-3">
      <h2 className="text-sm font-medium text-gray-300">Review queue ({ads.length})</h2>
      {ads.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing is waiting for review.</p>
      ) : (
        ads.map((ad) => <ReviewItem key={ad.id} ad={ad} onReviewed={onReviewed} />)
      )}
    </section>
  )
}

function ReviewItem({ ad, onReviewed }: { ad: AdminAd; onReviewed: (ad: AdminAd) => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{ad.name}</span>
          <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{ad.kind === 'house' ? 'House' : 'Partner'}</span>
        </div>
        <a href={ad.clickUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-blue-400 hover:text-blue-300">{ad.clickUrl}</a>
      </div>
      {ad.creatives.length === 0 ? (
        <p className="text-sm text-gray-500">No creatives yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {ad.creatives.map((c) => (
            <div key={c.id} className="space-y-1 rounded-lg border border-gray-800 bg-gray-950 p-2">
              <div className="flex h-24 items-center justify-center overflow-hidden rounded bg-gray-800">
                {c.kind === 'image'
                  ? <img src={c.url} alt={`${ad.name} ${c.shape}`} className="max-h-full max-w-full object-contain" />
                  : <video src={c.url} controls muted preload="metadata" className="max-h-full max-w-full object-contain" />}
              </div>
              <p className="text-xs text-gray-400">{shapeLabel(c.shape)} · {c.kind}</p>
            </div>
          ))}
        </div>
      )}
      <ReviewActions adId={ad.id} onReviewed={onReviewed} />
    </div>
  )
}

/** Approve (Family-friendly or Mature) or reject with a reason. Used for new ads in the queue and to review a decided ad again. */
function ReviewActions({ adId, onReviewed }: { adId: string; onReviewed: (ad: AdminAd) => void }) {
  const api = useApi()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (body: Parameters<typeof api.reviewAdminAd>[1]) => {
    setBusy(true)
    setError(null)
    try {
      const { ad: next } = await api.reviewAdminAd(adId, body)
      onReviewed(next)
    } catch (e: any) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const btn = 'rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => submit({ decision: 'approved', audience: 'family' })} className={btn}>Approve as Family-friendly</button>
        <button disabled={busy} onClick={() => submit({ decision: 'approved', audience: 'mature' })} className={btn}>Approve as Mature</button>
        <button disabled={busy} onClick={() => setRejecting((v) => !v)} className={btn}>Reject</button>
      </div>
      {rejecting && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            Reason for rejecting (required)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
              className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
          </label>
          <button disabled={busy || reason.trim() === ''} onClick={() => submit({ decision: 'rejected', reason: reason.trim() })} className={btn}>
            {busy ? 'Rejecting…' : 'Confirm reject'}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}

function NewAdForm({ onCreated, onCancel }: { onCreated: (ad: AdminAd) => void; onCancel: () => void }) {
  const api = useApi()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'house' | 'partner'>('partner')
  const [clickUrl, setClickUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() !== '' && isHttpsUrl(clickUrl)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { ad } = await api.createAdminAd({ name: name.trim(), kind, clickUrl })
      onCreated(ad)
    } catch (err: any) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-gray-500">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as 'house' | 'partner')}
            className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
            <option value="partner">Partner</option>
            <option value="house">House</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Click URL
        <input value={clickUrl} onChange={(e) => setClickUrl(e.target.value)} placeholder="https://"
          className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
        {clickUrl !== '' && !isHttpsUrl(clickUrl) && <span className="text-red-400">Must be a full https:// address.</span>}
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!valid || busy}
          className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
          {busy ? 'Creating…' : 'Create ad'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
      </div>
    </form>
  )
}

function AdCard({ ad, spaces, open, backInReview, onEdited, onToggle, onChange }: {
  ad: AdminAd
  backInReview: boolean
  onEdited: (id: string, prevStatus: AdminAd['review']['status']) => void
  spaces: AdminAdSpace[]
  open: boolean
  onToggle: () => void
  onChange: (ad: AdminAd) => void
}) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const paused = ad.status === 'paused'
  const badge = reviewBadge(ad.review)

  const toggleStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      const { ad: next } = await api.updateAdminAd(ad.id, { status: paused ? 'active' : 'paused' })
      onChange(next)
    } catch (e: any) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <button onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{ad.name}</span>
            <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{ad.kind === 'house' ? 'House' : 'Partner'}</span>
            {paused && <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-yellow-400">Paused</span>}
            <span className={`rounded bg-gray-800 px-2 py-0.5 text-xs ${TONES[badge.tone]}`}>{badge.text}</span>
            {backInReview && <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-yellow-400">Back in review</span>}
          </div>
          <div className="mt-1 truncate text-xs text-gray-500">
            {ad.creatives.length} creative{ad.creatives.length !== 1 ? 's' : ''}
            {ad.kind === 'partner' && ` · ${ad.placements.length} placement${ad.placements.length !== 1 ? 's' : ''}`} · {ad.clickUrl}
          </div>
        </button>
        <div className="flex gap-2">
          {ad.review.status !== 'pending' && (
            <button onClick={() => setReviewing((v) => !v)} aria-expanded={reviewing}
              className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600">Review again</button>
          )}
          <button onClick={toggleStatus} disabled={busy}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
      {ad.review.status === 'rejected' && ad.review.reason && <p className="px-4 pb-3 text-sm text-red-400">Rejected: {ad.review.reason}</p>}
      {error && <p className="px-4 pb-3 text-sm text-red-400">{error}</p>}
      {reviewing && ad.review.status !== 'pending' && (
        <div className="px-4 pb-4">
          <ReviewActions adId={ad.id} onReviewed={(next) => { setReviewing(false); onChange(next) }} />
        </div>
      )}
      {open && (
        <div className="space-y-6 border-t border-gray-800 p-4">
          <Creatives ad={ad} onChange={onChange} onEdited={() => onEdited(ad.id, ad.review.status)} />
          {ad.kind === 'partner' && <Placements ad={ad} spaces={spaces} onChange={onChange} />}
          <Report adId={ad.id} />
        </div>
      )}
    </div>
  )
}

function Creatives({ ad, onChange, onEdited }: { ad: AdminAd; onChange: (ad: AdminAd) => void; onEdited: () => void }) {
  const api = useApi()
  const [shape, setShape] = useState<AdShape>('16:9')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const { asset } = await api.uploadMedia(file.name, mediaContentType(file), await fileToBase64(file))
      const { creative } = await api.addAdminAdCreative(ad.id, asset.id, shape)
      onChange({ ...ad, creatives: [...ad.creatives, creative] })
      onEdited()
    } catch (err: any) {
      setError(ERRORS[err?.message] ?? uploadErrorMessage(err))
    } finally {
      setUploading(false)
      input.value = ''
    }
  }

  const remove = async (creativeId: string) => {
    setError(null)
    try {
      await api.deleteAdminAdCreative(ad.id, creativeId)
      onChange({ ...ad, creatives: ad.creatives.filter((c) => c.id !== creativeId) })
      onEdited()
    } catch (err: any) {
      setError(errorText(err))
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-gray-300">Creatives</h3>
      <p className="text-xs text-gray-500">An ad only shows in a space with its exact shape. Add one creative per shape you want to cover.</p>
      {ad.creatives.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {ad.creatives.map((c) => (
            <div key={c.id} className="space-y-1 rounded-lg border border-gray-800 bg-gray-950 p-2">
              <div className="flex h-24 items-center justify-center overflow-hidden rounded bg-gray-800">
                {c.kind === 'image'
                  ? <img src={c.url} alt={`${ad.name} ${c.shape}`} className="max-h-full max-w-full object-contain" />
                  : <video src={c.url} muted preload="metadata" className="max-h-full max-w-full object-contain" />}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{shapeLabel(c.shape)} · {c.kind}</span>
                <button onClick={() => remove(c.id)} className="text-gray-500 hover:text-red-400">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={shape} onChange={(e) => setShape(e.target.value as AdShape)} aria-label="Creative shape"
          className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
          {AD_SHAPES.map((s) => <option key={s} value={s}>{shapeLabel(s)}</option>)}
        </select>
        <label className={`cursor-pointer rounded bg-gray-700 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-600 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
          {uploading ? 'Uploading…' : 'Upload image or video'}
          <input type="file" accept="image/*,video/mp4,video/webm" onChange={upload} className="hidden" />
        </label>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  )
}

function Placements({ ad, spaces, onChange }: { ad: AdminAd; spaces: AdminAdSpace[]; onChange: (ad: AdminAd) => void }) {
  const api = useApi()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ad.placements))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = selected.size !== ad.placements.length || ad.placements.some((id) => !selected.has(id))

  // one group per scene preset, e.g. "Ship · Default (active)"
  const byPreset = new Map<string, AdminAdSpace[]>()
  for (const s of spaces) {
    const group = `${s.sceneName} · ${s.presetName}${s.activePreset ? ' (active)' : ''}`
    byPreset.set(group, [...(byPreset.get(group) ?? []), s])
  }
  const covered = new Set(ad.creatives.map((c) => c.shape))

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { ad: next } = await api.setAdminAdPlacements(ad.id, [...selected])
      onChange(next)
    } catch (err: any) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-gray-300">Placements</h3>
      {spaces.length === 0 ? (
        <p className="text-sm text-gray-500">No ad spaces exist yet. Add an Ad space in a scene, or switch a video screen to Ads.</p>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-gray-800 p-3">
          {[...byPreset].map(([group, list]) => (
            <div key={group}>
              <p className="mb-1 text-xs text-gray-500">{group}</p>
              {list.map((s) => (
                <label key={s.elementId} className="flex items-center gap-2 py-0.5 text-sm">
                  <input type="checkbox" checked={selected.has(s.elementId)} onChange={() => toggle(s.elementId)} className="accent-blue-500" />
                  <span>{s.name}</span>
                  <span className="text-xs text-gray-500">
                    {s.type === 'video' ? 'Screen' : 'Ad space'} · {s.shape ? shapeLabel(s.shape) : 'Unknown shape'} · {contentLabel(s.content)}
                  </span>
                  {ad.review.audience === 'mature' && s.content === 'family' && <span className="text-xs text-yellow-400">Won't show: family-friendly space</span>}
                  {s.shape && !covered.has(s.shape) && <span className="text-xs text-yellow-400">no creative for this shape</span>}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button onClick={save} disabled={!dirty || saving}
        className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save placements'}
      </button>
    </section>
  )
}

function Report({ adId }: { adId: string }) {
  const api = useApi()
  const [report, setReport] = useState<AdReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getAdminAdReport(adId).then(setReport, (e) => setError(errorText(e)))
  }, [adId])

  if (error) return <p className="text-sm text-red-400">{error}</p>
  if (!report) return <Skeleton rows={2} className="h-12" />
  const t = report.totals

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-gray-300">Report</h3>
      <p className="text-xs text-gray-500">
        Paid numbers count verified wallets, once per day per level. Unverified players and guests are shown separately and are not paid.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="In scene" value={fmt.format(t.scene)} sub={`${fmt.format(t.unverified.scene)} unverified`} />
        <Stat label="On screen (paid)" value={fmt.format(t.screen)} sub={`${fmt.format(t.unverified.screen)} unverified`} />
        <Stat label="Looked at" value={fmt.format(t.look)} sub={report.avgLookMs === null ? 'no look time yet' : `avg ${(report.avgLookMs / 1000).toFixed(1)}s`} />
        <Stat label="Clicks" value={fmt.format(t.click)} sub={`${fmt.format(t.unverified.click)} unverified`} />
        <Stat label="Click rate" value={clickRate(t)} sub="clicks ÷ on screen" />
      </div>
      {report.bySpace.length > 0 && (
        <CountsTable title="By space" rows={report.bySpace.map((r) => ({ key: r.elementId, label: `${r.sceneName}`, counts: r }))} />
      )}
      {report.byDay.length > 0 && (
        <CountsTable title="By day" rows={report.byDay.map((r) => ({ key: r.day, label: r.day, counts: r }))} />
      )}
    </section>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-xs text-gray-500">{sub}</p>
    </div>
  )
}

function CountsTable({ title, rows }: { title: string; rows: { key: string; label: string; counts: LevelCounts }[] }) {
  return (
    <TableScroll label="Delivery by day" className="rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead className={tableHeadBand}>
          <tr>
            <th className="p-2">{title}</th>
            <th className="p-2 text-right">In scene</th>
            <th className="p-2 text-right">On screen</th>
            <th className="p-2 text-right">Looked</th>
            <th className="p-2 text-right">Clicks</th>
            <th className="p-2 text-right">Click rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-gray-800">
              <td className="p-2">{r.label}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.scene)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.screen)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.look)}</td>
              <td className="p-2 text-right text-gray-400">{fmt.format(r.counts.click)}</td>
              <td className="p-2 text-right text-gray-400">{clickRate(r.counts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}
