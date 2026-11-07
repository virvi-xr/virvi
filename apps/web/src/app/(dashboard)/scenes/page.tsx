'use client'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import SceneEditorPage from './[sceneId]/client'
import { ArrowUpRightIcon, CheckIcon, CopyIcon, GridIcon, ListIcon, PlusIcon, ScenesIcon, UploadIcon } from '@/components/icons'
import { EmptyState, InlineDescription, PageHeader, SearchField, useStoredView, ViewToggle, Skeleton } from '@/components/ui'
import { filterScenes, placeholderHues, shortId } from '@/lib/scenes'
import { countLabel, plural } from '@/lib/format'
import { sceneListActions, TRIAL_SCENE_NOTE } from '@/lib/trial-scene'

type Scene = { id: string; name: string; description?: string | null; thumbnailUrl?: string | null; relationship?: string }
const RELATIONSHIP_LABEL: Record<string, string> = { cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' }
const VIEW_KEY = 'virvi.scenes.view'
/** PrimaryButton's look, on a link to the New Scene Wizard. */
const NEW_SCENE_CLASS = 'clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover'
/** The secondary buttons' look, on a link to Import. */
const IMPORT_CLASS = 'inline-flex items-center gap-1.5 rounded-md bg-gray-800 px-4 py-2.5 text-sm hover:bg-gray-700'
/** Only owners and co-hosts can change a scene's details. */
const canDescribe = (s: Scene) => !s.relationship || s.relationship === 'owner' || s.relationship === 'cohost'

export default function ScenesPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <ScenesContent />
    </Suspense>
  )
}

function ScenesContent() {
  const { token, user } = useAuth()
  const trial = !!user?.trial
  const actions = sceneListActions(trial)
  const api = useApi()
  const searchParams = useSearchParams()
  const selectedSceneId = searchParams.get('id')
  const [scenes, setScenes] = useState<Scene[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [query, setQuery] = useState('')
  const [view, chooseView] = useStoredView(VIEW_KEY, ['grid', 'list'], 'grid')

  useEffect(() => {
    if (!token) return
    api.getScenes().then(data => { setScenes(data.scenes); setLoading(false) }).catch(() => setLoading(false))
  }, [token])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const { scene } = await api.createScene(newName.trim())
    setScenes(prev => [scene, ...prev])
    setNewName('')
    setShowCreate(false)
  }

  const saveDescription = async (id: string, description: string) => {
    const { scene } = await api.updateScene(id, { description })
    setScenes(prev => prev.map(s => (s.id === id ? { ...s, description: scene.description } : s)))
  }

  // Show scene editor when ?id= is present
  if (selectedSceneId) {
    return (
      <div className="mx-auto max-w-7xl">
        <SceneEditorPage />
      </div>
    )
  }

  const shown = filterScenes(scenes, query)

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Scenes']}
        title="Scenes"
        count={loading ? undefined : countLabel(scenes.length)}
        subtitle="Manage your virtual worlds."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {actions.includes('blank') && (
              <button type="button" onClick={() => setShowCreate(!showCreate)} className="rounded-md bg-gray-800 px-4 py-2.5 text-sm hover:bg-gray-700">Blank scene</button>
            )}
            <Link href="/import" className={IMPORT_CLASS}><UploadIcon size={16} /> Import scene</Link>
            <Link href="/scenes/new" className={NEW_SCENE_CLASS}><PlusIcon size={16} /> New scene</Link>
          </div>
        }
      />

      {showCreate && actions.includes('blank') && (
        <form onSubmit={handleCreate} className="mb-6 flex flex-wrap gap-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="Blank scene name" autoFocus
            className="min-w-48 flex-1 rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400" />
          <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">Create</button>
          <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
        </form>
      )}

      {!loading && scenes.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={setQuery} placeholder="Search scenes..." label="Search scenes" />
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-gray-400">{plural(shown.length, 'scene')}</span>
            <ViewToggle value={view} onChange={chooseView} options={[['grid', GridIcon, 'Grid view'], ['list', ListIcon, 'List view']]} />
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" aria-hidden="true">
          {[0, 1].map(i => <div key={i} className="h-80 animate-pulse rounded-lg border border-gray-800 bg-gray-900" />)}
        </div>
      ) : scenes.length === 0 ? (
        <EmptyState icon={<ScenesIcon size={40} />} title="No scenes yet"
          body="A scene is one of your virtual worlds. Create one to start placing media and running events."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link href="/scenes/new" className={NEW_SCENE_CLASS}><PlusIcon size={16} /> New scene</Link>
              <Link href="/import" className={IMPORT_CLASS}><UploadIcon size={16} /> Import a scene you made</Link>
            </div>
          } />
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-gray-500">No scenes match “{query.trim()}”.</p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 min-[1900px]:grid-cols-3">
          {shown.map(scene => <SceneCard key={scene.id} scene={scene} trial={trial} onDescribe={saveDescription} />)}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
          {shown.map((scene, i) => <SceneRow key={scene.id} scene={scene} trial={trial} first={i === 0} />)}
        </div>
      )}
    </div>
  )
}

const sceneHref = (id: string) => `/scenes?id=${id}`

/** The scene's preview image, or a stable two-tone placeholder with its initial. */
function ScenePreview({ scene, className }: { scene: Scene; className: string }) {
  if (scene.thumbnailUrl) return <img src={scene.thumbnailUrl} alt="" className={`${className} object-cover`} />
  const [a, b] = placeholderHues(scene.id)
  return (
    <div className={`${className} relative flex items-center justify-center overflow-hidden`}
      style={{ background: `linear-gradient(135deg, hsl(${a} 45% 16%), hsl(${b} 55% 9%))` }}>
      <div className="absolute inset-0 opacity-[0.12]"
        style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)', backgroundSize: '28px 28px' }} />
      <span className="relative font-mono text-4xl font-semibold text-white/70">{scene.name.trim().charAt(0).toUpperCase() || '?'}</span>
    </div>
  )
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the id is still visible to select
    }
  }
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-gray-500">
      <span className="truncate" title={id}>ID: {shortId(id)}</span>
      <button onClick={copy} aria-label={copied ? 'Copied' : 'Copy scene ID'} className="shrink-0 rounded p-1 hover:bg-white/[0.05] hover:text-white">
        {copied ? <CheckIcon size={15} className="text-blue-300" /> : <CopyIcon size={15} />}
      </button>
    </span>
  )
}

function RoleBadge({ scene }: { scene: Scene }) {
  if (!scene.relationship || scene.relationship === 'owner') return null
  return <span className="rounded bg-gray-800 px-2 py-0.5 text-xs font-normal text-gray-400">{RELATIONSHIP_LABEL[scene.relationship] ?? scene.relationship}</span>
}

/** A trial's scenes are kept only while the trial lasts. */
function TrialNote() {
  return <p className="mt-1 text-xs text-amber-200/80">{TRIAL_SCENE_NOTE}</p>
}

function SceneCard({ scene, trial, onDescribe }: { scene: Scene; trial: boolean; onDescribe: (id: string, description: string) => Promise<void> }) {
  return (
    <article className="corner-notch relative flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 transition-colors hover:border-gray-700">
      <Link href={sceneHref(scene.id)} tabIndex={-1} aria-hidden="true"><ScenePreview scene={scene} className="h-52 w-full" /></Link>
      <div className="flex-1 px-6 pt-5 pb-4">
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          <Link href={sceneHref(scene.id)} className="hover:text-blue-300">{scene.name}</Link>
          <RoleBadge scene={scene} />
        </h2>
        {trial && <TrialNote />}
        <InlineDescription value={scene.description} canEdit={canDescribe(scene)} onSave={d => onDescribe(scene.id, d)}
          label="Scene description" placeholder="What happens in this scene?" />
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-gray-800 px-6 py-3.5">
        <CopyId id={scene.id} />
        <Link href={sceneHref(scene.id)} className="flex shrink-0 items-center gap-1.5 text-sm text-gray-200 hover:text-blue-300">
          Open scene <ArrowUpRightIcon size={16} />
        </Link>
      </footer>
    </article>
  )
}

function SceneRow({ scene, trial, first }: { scene: Scene; trial: boolean; first: boolean }) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${first ? '' : 'border-t border-gray-800'}`}>
      <Link href={sceneHref(scene.id)} tabIndex={-1} aria-hidden="true" className="shrink-0 overflow-hidden rounded">
        <ScenePreview scene={scene} className="h-12 w-20" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          <Link href={sceneHref(scene.id)} className="truncate hover:text-blue-300">{scene.name}</Link>
          <RoleBadge scene={scene} />
        </p>
        <p className="truncate text-sm text-gray-500">{scene.description || 'No description'}</p>
        {trial && <TrialNote />}
      </div>
      <div className="hidden md:block"><CopyId id={scene.id} /></div>
      <Link href={sceneHref(scene.id)} aria-label={`Open ${scene.name}`} className="shrink-0 rounded p-2 text-gray-400 hover:bg-white/[0.05] hover:text-blue-300">
        <ArrowUpRightIcon size={18} />
      </Link>
    </div>
  )
}
