'use client'
// The New Scene Wizard (Virvi Studio): Where, Size, Assets, Arrange, Deploy in a column on the left,
// with the live 3D preview of the plot filling the right (above the steps on a phone).
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { useApi, type WizardCatalog, type WizardOptions } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { canAdvance, initialState, wizardReducer, type WizardState, type WizardStep } from '@/lib/wizard/state'
import { clearDraft, loadDraft, saveDraft } from '@/lib/wizard/draft'
import { emptyMemory, wizardErrorMessage, type RunMemory } from '@/lib/wizard/run'
import { plotLabel } from '@/lib/wizard/helpers'
import { PageHeader } from '@/components/ui'
import { CheckIcon } from '@/components/icons'
import { WhereStep, type NamesState } from '@/components/wizard/steps/WhereStep'
import { SizeStep } from '@/components/wizard/steps/SizeStep'
import { AssetsStep } from '@/components/wizard/steps/AssetsStep'
import { ArrangeStep } from '@/components/wizard/steps/ArrangeStep'
import { DeployStep } from '@/components/wizard/steps/DeployStep'
import { useRoomSetPreview } from '@/components/wizard/useRoomSetPreview'

const Preview3D = dynamic(() => import('@/components/wizard/Preview3D'), {
  ssr: false,
  loading: () => <div className="h-full min-h-[320px] w-full animate-pulse rounded-lg border border-gray-800 bg-gray-900" />,
})

const STEPS: Array<{ id: WizardStep; title: string }> = [
  { id: 'where', title: 'Where' },
  { id: 'size', title: 'Size' },
  { id: 'assets', title: 'Assets' },
  { id: 'arrange', title: 'Arrange' },
  { id: 'deploy', title: 'Deploy' },
]

function summary(step: WizardStep, s: WizardState): string {
  switch (step) {
    case 'where':
      return [s.name.trim(), s.roomSet && 'Room scan', s.destinations.dcl?.world ?? (s.dclLater && 'Decentraland'), s.destinations.hyperfy && 'Hyperfy', s.destinations.ar && 'Virvi AR'].filter(Boolean).join(' · ')
    case 'size':
      return s.plot ? `${plotLabel(s.plot)}${s.roomSet ? ', fits your scan' : ''}` : 'Guide plot'
    case 'assets':
      return `${s.items.length} ${s.items.length === 1 ? 'item' : 'items'}`
    case 'arrange':
      return 'Laid out'
    case 'deploy':
      return ''
  }
}

export default function NewScenePage() {
  const { token, user } = useAuth()
  const trial = !!user?.trial
  const api = useApi()
  // A draft kept in this browser picks up where it was left: this trial's, or the one its account brought along when it
  // signed up (lib/wizard/draft drops anyone else's). The page renders only once the session is read (the layout waits),
  // so this runs in the browser.
  const [state, dispatch] = useReducer(wizardReducer, initialState, (init) => (user ? loadDraft(Date.now(), user.id) : null) ?? init)
  const [catalog, setCatalog] = useState<WizardCatalog | null>(null)
  const [options, setOptions] = useState<WizardOptions | null>(null)
  const [loadError, setLoadError] = useState('')
  const [names, setNames] = useState<NamesState>({ status: 'loading' })
  const [replaceOk, setReplaceOk] = useState(false)
  const [contractBlocked, setContractBlocked] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [moveSpawn, setMoveSpawn] = useState(false)
  // While a run is going, and once it has made the scene, the earlier steps stay closed: Try again reuses
  // what was made. A run that failed before the scene existed leaves them open to fix what was refused.
  const [running, setRunning] = useState(false)
  const memory = useRef<RunMemory>(emptyMemory())
  const roomPreview = useRoomSetPreview(state.roomSet, dispatch)
  const locked = running || !!memory.current.sceneId

  // A trial's wizard lives in this browser until it signs up or deploys: kept half a second after the last change (not on
  // every drag step), and gone once a run has made the scene (the server has it then). Signing up hands it to the account;
  // signing out clears it (lib/auth). A save still waiting when the page goes is made then.
  const pendingSave = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (memory.current.sceneId) {
      pendingSave.current = null
      clearDraft()
      return
    }
    if (!trial || !user) {
      pendingSave.current = null
      return
    }
    const owner = user.id
    // Cancelled once it is no longer the waiting save (a newer one, or the scene now exists)
    const save = () => { if (pendingSave.current !== save) return; pendingSave.current = null; saveDraft(state, Date.now(), owner) }
    pendingSave.current = save
    const t = setTimeout(save, 500)
    return () => clearTimeout(t)
  }, [state, trial, user?.id])
  useEffect(() => {
    const flush = () => pendingSave.current?.()
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [])
  const onRunning = useCallback((on: boolean) => {
    setRunning(on)
    if (memory.current.sceneId) {
      pendingSave.current = null
      clearDraft()
    }
  }, [])

  const loadNames = useCallback(() => {
    setNames({ status: 'loading' })
    api.getDclNames()
      .then((r) => setNames({ status: 'ready', wallets: r.wallets }))
      .catch((err) => setNames({ status: 'error', message: wizardErrorMessage(err) }))
  }, [api.getDclNames])

  useEffect(() => {
    if (!token) return
    let stale = false
    Promise.all([api.getWizardCatalog(), api.getWizardOptions()])
      .then(([c, o]) => { if (!stale) { setCatalog(c); setOptions(o) } })
      .catch((err) => { if (!stale) setLoadError(wizardErrorMessage(err)) })
    // A trial has no linked wallets: it connects one at Deploy
    if (!trial) loadNames()
    return () => { stale = true }
  }, [token, trial])

  const at = STEPS.findIndex((s) => s.id === state.step)
  const { dcl, hyperfy, ar } = state.destinations
  // An account carrying a trial's "Decentraland World" picks the World here (or skips Decentraland)
  const whereReady = (trial || !state.dclLater) && (!dcl?.hasScene || replaceOk) && !contractBlocked && (!hyperfy || !!hyperfy.name.trim()) && (!ar || !!ar.name.trim())
  const ready = canAdvance(state) && (state.step !== 'where' || whereReady)
  const next = () => {
    setSelectedKey(null)
    dispatch({ type: 'goTo', step: STEPS[at + 1].id })
  }

  const body: Record<WizardStep, ReactNode> = {
    where: (
      <WhereStep state={state} dispatch={dispatch} names={names} reloadNames={loadNames} options={options}
        replaceOk={replaceOk} setReplaceOk={setReplaceOk} contractBlocked={contractBlocked} setContractBlocked={setContractBlocked} />
    ),
    size: <SizeStep state={state} dispatch={dispatch} />,
    assets: <AssetsStep state={state} dispatch={dispatch} catalog={catalog} />,
    arrange: <ArrangeStep state={state} dispatch={dispatch} roomPreview={roomPreview} selectedKey={selectedKey} setSelectedKey={setSelectedKey} moveSpawn={moveSpawn} setMoveSpawn={setMoveSpawn} />,
    deploy: <DeployStep state={state} dispatch={dispatch} options={options} memory={memory.current} onRunning={onRunning} names={names} />,
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={[{ label: 'Scenes', href: '/scenes' }, 'New scene']}
        title="New scene"
        subtitle="Pick where it goes, a plot and a few things to put on it. Virvi deploys it, then you jump in."
      />
      {loadError && <p className="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{loadError}</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <ol className="space-y-2">
          {STEPS.map((s, i) => {
            const done = i < at
            const current = i === at
            if (current) {
              return (
                <li key={s.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4" aria-current="step">
                  <h2 className="mb-3 flex items-center gap-2 font-semibold">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-400/15 font-mono text-xs text-blue-300">{i + 1}</span>
                    {s.title}
                  </h2>
                  {body[s.id]}
                  {s.id !== 'deploy' && (
                    <div className="mt-4 flex justify-end border-t border-gray-800 pt-3">
                      <button type="button" onClick={next} disabled={!ready}
                        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">
                        Next: {STEPS[i + 1].title}
                      </button>
                    </div>
                  )}
                </li>
              )
            }
            return (
              <li key={s.id}>
                <button type="button" disabled={!done || locked} onClick={() => dispatch({ type: 'goTo', step: s.id })}
                  className={`flex w-full items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2.5 text-left text-sm ${done && !locked ? 'hover:border-gray-700' : ''} ${done ? 'text-gray-200' : 'text-gray-600'}`}>
                  <span className="flex h-6 w-6 items-center justify-center">
                    {done ? <CheckIcon size={16} className="text-green-400" /> : <span className="font-mono text-xs">{i + 1}</span>}
                  </span>
                  <span className="font-medium">{s.title}</span>
                  {done && <span className="min-w-0 truncate text-gray-400">· {summary(s.id, state)}</span>}
                </button>
              </li>
            )
          })}
        </ol>
        <div className="order-first h-[50vh] min-h-[320px] lg:order-none lg:sticky lg:top-4 lg:h-[calc(100vh-12rem)] lg:min-h-[480px]">
          <Preview3D
            plot={state.plot}
            items={state.items}
            room={state.roomSet ? roomPreview.url : null}
            spawn={state.spawn}
            selectedKey={selectedKey}
            editable={state.step === 'arrange'}
            spawnEditable={moveSpawn}
            onMove={(key, x, z) => dispatch({ type: 'moveItem', key, x, z })}
            onRotate={(key) => dispatch({ type: 'rotateItem', key })}
            onSelect={setSelectedKey}
            onMoveSpawn={(x, z) => dispatch({ type: 'moveSpawn', x, z })}
          />
        </div>
      </div>
    </div>
  )
}
