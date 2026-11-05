import type { Vec3 } from '@virvixr/shared'
import type { ScriptFetch } from './poller.js'

export type ApiFailure = 'lost' | 'no_access' | 'auth' | 'invalid' | 'server'
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: ApiFailure }

/** A transform in Virvi coordinates (Decentraland frame, rotation in degrees): no conversion happens here. */
export interface VirviTransform {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

/** One entry of the scene library (GET /api/scenes/:id/library). */
export interface LibraryEntry {
  id: string
  kind: 'media' | 'model'
  name: string
  url: string
  status: string
  [key: string]: unknown
}

/** One catalog model (GET /api/assets); cdnUrl is the model file. */
export interface CatalogEntry {
  id: string
  name: string
  cdnUrl?: string | null
  [key: string]: unknown
}

export interface VirviApiOptions {
  feedUrl: string
  fetch: ScriptFetch
  getPass: () => string | null
  /**
   * Called on a 401 (and when there is no pass): the owner renews the pass. Resolves true when a fresh pass is in
   * place, and the call is then retried once with it; false when it couldn't renew (the owner shows the link as
   * expired) and the call is 'auth'.
   */
  onAuthFailure: () => Promise<boolean>
}

/** The scene as the HUD needs it: its presets for the preset switcher. */
export interface SceneInfo {
  id: string
  activePresetId: string | null
  presets: Array<{ id: string; name: string }>
}

const CATALOG_PAGE = 24

/** The model's display name: its library name when given, else the file name in its URL; without the extension. */
function modelName(src: string, given?: string): string {
  let name = given?.trim() || src.split('?')[0].split('/').pop() || 'Model'
  if (!given?.trim()) {
    try {
      name = decodeURIComponent(name)
    } catch {
      /* keep the raw name */
    }
  }
  return name.replace(/\.glb$/i, '').trim().slice(0, 100) || 'Model'
}

/**
 * The Hyperfy HUD's edit client: Virvi's REST API with a scene pass. Every call resolves (never rejects) with
 * ok/value or a reason. An undefined fetch (network or CORS failure) is 'lost'; 401 calls onAuthFailure and, if
 * that renewed the pass, retries once, else (or on a second 401) is 'auth'; 403 is 'no_access'; other 4xx are
 * 'invalid'; 5xx are 'server'.
 */
export class VirviApi {
  constructor(private readonly opts: VirviApiOptions) {}

  /** PUT /api/instances/:id */
  saveTransform(instanceId: string, t: VirviTransform): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/instances/${encodeURIComponent(instanceId)}`, { position: t.position, rotation: t.rotation, scale: t.scale })
  }

  /** PUT /api/elements/:id { enabled } */
  setEnabled(elementId: string, enabled: boolean): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/elements/${encodeURIComponent(elementId)}`, { enabled })
  }

  /** PUT /api/scenes/:id { activePresetId } */
  setPreset(sceneId: string, presetId: string): Promise<ApiResult<unknown>> {
    return this.call('PUT', `/api/scenes/${encodeURIComponent(sceneId)}`, { activePresetId: presetId })
  }

  /** POST /api/elements/:id/live { enabled } */
  setLive(elementId: string, enabled: boolean): Promise<ApiResult<unknown>> {
    return this.call('POST', `/api/elements/${encodeURIComponent(elementId)}/live`, { enabled })
  }

  /** GET /api/scenes/:id (a scene pass sees the active preset and its own booking's). */
  async getScene(sceneId: string): Promise<ApiResult<SceneInfo>> {
    const r = await this.call<{ scene?: { id?: string; activePresetId?: string | null; presets?: Array<{ id: string; name?: string }> } }>(
      'GET',
      `/api/scenes/${encodeURIComponent(sceneId)}`,
    )
    if (!r.ok) return r
    const sc = r.value.scene
    if (!sc) return { ok: false, reason: 'server' }
    return {
      ok: true,
      value: {
        id: sc.id ?? sceneId,
        activePresetId: sc.activePresetId ?? null,
        presets: (sc.presets ?? []).map((p) => ({ id: p.id, name: p.name || 'Preset' })),
      },
    }
  }

  /** GET /api/scenes/:id/streams: the streams a video screen can play (LIV-53). */
  async listStreams(sceneId: string): Promise<ApiResult<Array<{ id: string; name: string; hlsPlaylistUrl: string; live: boolean; mine: boolean }>>> {
    const r = await this.call<{ streams?: Array<{ id: string; name: string; hlsPlaylistUrl: string; live: boolean; mine: boolean }> }>('GET', `/api/scenes/${encodeURIComponent(sceneId)}/streams`)
    return r.ok ? { ok: true, value: r.value.streams ?? [] } : r
  }

  /**
   * Sets a screen's live source (LIV-53). PUT /api/elements replaces properties whole, so this reads the element's
   * current properties from the scene first and writes them back with the new value. A screen that is gone is invalid.
   */
  setLiveSource(sceneId: string, elementId: string, url: string): Promise<ApiResult<unknown>> {
    return this.setProperties(sceneId, elementId, { liveSrc: url })
  }

  /** Sets (or with '' clears) a screen's off image (LIV-54); '' rather than dropped, so the change reaches the world. */
  setOffImage(sceneId: string, elementId: string, url: string): Promise<ApiResult<unknown>> {
    return this.setProperties(sceneId, elementId, { offImageSrc: url })
  }

  private async setProperties(sceneId: string, elementId: string, patch: Record<string, unknown>): Promise<ApiResult<unknown>> {
    const r = await this.call<{ scene?: { presets?: Array<{ elements?: Array<{ id: string; properties?: Record<string, unknown> | null }> }> } }>(
      'GET',
      `/api/scenes/${encodeURIComponent(sceneId)}`,
    )
    if (!r.ok) return r
    const el = (r.value.scene?.presets ?? []).flatMap((p) => p.elements ?? []).find((e) => e.id === elementId)
    if (!el) return { ok: false, reason: 'invalid' }
    return this.call('PUT', `/api/elements/${encodeURIComponent(elementId)}`, { properties: { ...(el.properties ?? {}), ...patch } })
  }

  /** DELETE /api/elements/:id/instances: every copy goes in one operation, the element stays (LIV-12). */
  async deleteInstances(elementId: string): Promise<ApiResult<{ deleted: number }>> {
    const r = await this.call<{ deleted?: number }>('DELETE', `/api/elements/${encodeURIComponent(elementId)}/instances`)
    return r.ok ? { ok: true, value: { deleted: r.value.deleted ?? 0 } } : r
  }

  /** GET /api/scenes/:id/library */
  async listLibrary(sceneId: string): Promise<ApiResult<LibraryEntry[]>> {
    const r = await this.call<{ items?: LibraryEntry[] }>('GET', `/api/scenes/${encodeURIComponent(sceneId)}/library`)
    return r.ok ? { ok: true, value: r.value.items ?? [] } : r
  }

  /** GET /api/assets?q=&limit= (public catalog; an empty query browses) */
  async listCatalog(query: string): Promise<ApiResult<{ assets: CatalogEntry[]; total: number }>> {
    const q = query.trim()
    const r = await this.call<{ assets?: CatalogEntry[]; total?: number }>('GET', `/api/assets?${q ? `q=${encodeURIComponent(q)}&` : ''}limit=${CATALOG_PAGE}`)
    return r.ok ? { ok: true, value: { assets: r.value.assets ?? [], total: r.value.total ?? 0 } } : r
  }

  /** POST /api/scenes/:id/library { assetItemId } */
  addFromCatalog(sceneId: string, item: { id: string }): Promise<ApiResult<unknown>> {
    return this.call('POST', `/api/scenes/${encodeURIComponent(sceneId)}/library`, { assetItemId: item.id })
  }

  /**
   * Places a model in a preset the way the dashboard does: POST /api/presets/:id/elements { type: 'model',
   * properties.modelSrc }, then POST /api/elements/:id/instances with the transform. If the instance can't be
   * made the new element is deleted again (DELETE /api/elements/:id) so no empty model is left behind.
   */
  async placeModel(presetId: string, src: string, t: VirviTransform, name?: string): Promise<ApiResult<{ elementId: string; instanceId: string }>> {
    const el = await this.call<{ element?: { id?: string } }>('POST', `/api/presets/${encodeURIComponent(presetId)}/elements`, {
      type: 'model',
      name: modelName(src, name),
      properties: { modelSrc: src },
    })
    if (!el.ok) return el
    const elementId = el.value.element?.id
    if (!elementId) return { ok: false, reason: 'server' }
    const inst = await this.call<{ instance?: { id?: string } }>('POST', `/api/elements/${encodeURIComponent(elementId)}/instances`, {
      position: t.position,
      rotation: t.rotation,
      scale: t.scale,
    })
    const instanceId = inst.ok ? inst.value.instance?.id : undefined
    if (!inst.ok || !instanceId) {
      await this.call('DELETE', `/api/elements/${encodeURIComponent(elementId)}`)
      return inst.ok ? { ok: false, reason: 'server' } : inst
    }
    return { ok: true, value: { elementId, instanceId } }
  }

  private async call<T = unknown>(method: string, path: string, body?: object): Promise<ApiResult<T>> {
    let renewed = false
    for (;;) {
      const r = await this.send<T>(method, path, body)
      if (r !== 'unauthorized') return r
      if (renewed || !(await this.renew())) return { ok: false, reason: 'auth' }
      renewed = true
    }
  }

  private async renew(): Promise<boolean> {
    try {
      return (await this.opts.onAuthFailure()) === true
    } catch {
      return false
    }
  }

  /** One request; 'unauthorized' for a 401 or no pass, so call() can renew and retry. */
  private async send<T>(method: string, path: string, body?: object): Promise<ApiResult<T> | 'unauthorized'> {
    const pass = this.opts.getPass()
    if (!pass) return 'unauthorized'
    const headers: Record<string, string> = { Authorization: `Bearer ${pass}` }
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res: Awaited<ReturnType<ScriptFetch>>
    try {
      res = await this.opts.fetch(`${this.opts.feedUrl}${path}`, init)
    } catch {
      res = undefined
    }
    if (!res) return { ok: false, reason: 'lost' }
    if (res.status === 401) return 'unauthorized'
    if (res.status === 403) return { ok: false, reason: 'no_access' }
    if (res.status >= 500) return { ok: false, reason: 'server' }
    if (!res.ok) return { ok: false, reason: 'invalid' }
    try {
      return { ok: true, value: (await res.json()) as T }
    } catch {
      return { ok: false, reason: 'server' }
    }
  }
}
