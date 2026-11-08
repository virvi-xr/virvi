/** 3D Models' two views: All Models (public only) and My Models (yours, public and private). */
export type AssetView = 'all' | 'mine'
/** Within My Models: everything of yours, only Design Studio pieces, or only your uploads. */
export type MineKind = 'all' | 'studio' | 'uploads'

const KINDS: MineKind[] = ['all', 'studio', 'uploads']

/** The view in the page's link (`?view=mine&kind=studio`), so a refresh or a shared link keeps it. */
export function readAssetView(params: Pick<URLSearchParams, 'get'>): { view: AssetView; kind: MineKind } {
  if (params.get('view') !== 'mine') return { view: 'all', kind: 'all' }
  const kind = params.get('kind') as MineKind | null
  return { view: 'mine', kind: kind && KINDS.includes(kind) ? kind : 'all' }
}

export function assetViewHref(view: AssetView, kind: MineKind): string {
  if (view === 'all') return '/assets'
  return kind === 'all' ? '/assets?view=mine' : `/assets?view=mine&kind=${kind}`
}

/** The list request's filter for a view: All Models never includes private assets, even your own. */
export function assetListScope(view: AssetView, kind: MineKind): { scope: 'public' } | { mine: MineKind } {
  return view === 'all' ? { scope: 'public' } : { mine: kind }
}

export function visibilityLabel(asset: { isPublic?: boolean | null }): 'Public' | 'Private' {
  return asset.isPublic ? 'Public' : 'Private'
}
