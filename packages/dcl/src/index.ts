/**
 * Virvi Smart Item for Decentraland SDK 7
 *
 * Drop this into any Decentraland scene to connect it to Virvi.
 * Handles Virvi initialization, element rendering, HUD activation,
 * and analytics — all configurable via the Creator Hub UI.
 *
 * The smart item now supports a full setup flow:
 * - If sceneId is set: connects directly to that scene
 * - If no sceneId: shows the HUD setup flow (auth → create/pick scene → connect)
 *
 * Usage as a Smart Item:
 *   Drag "Virvi Manager" from the asset catalog, set sceneId, deploy.
 *
 * Usage from code:
 *   import { VirviSmartItem } from '@virvixr/dcl'
 *   const item = new VirviSmartItem()
 *   item.init({ inventory })
 *   item.spawn(entity, { sceneId: 'your-scene-id' }, channel)
 */

import { VisibilityComponent } from '@dcl/sdk/ecs'
import { createVirvi } from '@virvixr/adapter-dcl'
import type { Virvi } from '@virvixr/core'
import type { VirviInitConfig } from '@virvixr/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VirviSmartItemProps {
  sceneId: string
  serverUrl: string
  showBeacon: boolean
  enableHud: boolean
  enableAnalytics: boolean
  autoConnect: boolean
  env: 'dev' | 'staging' | 'prod'
}

interface IInventory {
  [key: string]: any
}

interface IChannel {
  id: string
  handleAction: (id: string, handler: (opts: { sender: string; [key: string]: any }) => void) => void
  sendActions: (actions: any) => void
  request: <T>(id: string, body?: any) => Promise<T>
  reply: <T>(id: string, handler: (requester: string) => T) => void
}

type Entity = any

// ---------------------------------------------------------------------------
// Virvi Smart Item
// ---------------------------------------------------------------------------

export class VirviSmartItem {
  private virvi: Virvi | null = null
  private connecting = false
  private connected = false

  /**
   * Called once when the scene starts, before any instances spawn.
   */
  init(_args: { inventory: IInventory }) {
    // No global initialization needed
  }

  /**
   * Called once for each instance of the smart item placed in the scene.
   */
  spawn(host: Entity, props: VirviSmartItemProps, channel: IChannel) {
    const {
      sceneId,
      serverUrl = 'https://virvi.io',
      showBeacon = false,
      enableHud = true,
      enableAnalytics = true,
      autoConnect = true,
      env = 'prod',
    } = props

    // Hide the beacon model unless explicitly shown
    if (!showBeacon) {
      VisibilityComponent.createOrReplace(host, { visible: false })
    }

    // Auto-connect on scene load — works with or without sceneId
    if (autoConnect) {
      this.connect(sceneId, serverUrl, env, enableHud, enableAnalytics)
    }

    // Register action handlers for inter-item communication
    channel.handleAction('connect', () => {
      this.connect(sceneId, serverUrl, env, enableHud, enableAnalytics)
    })

    channel.handleAction('disconnect', () => {
      this.disconnect()
    })

    channel.handleAction('toggleHud', () => {
      if (this.virvi?.hud) {
        this.virvi.sendMessage('virvi:hud:toggle')
      }
    })

    // Makes a preset live for everyone (same route as the dashboard and HUD). It works for a signed-in host, co-host
    // or editor; the server refuses anyone else, which is logged rather than shown.
    channel.handleAction('switchPreset', (opts: any) => {
      const presetId = opts?.presetId || opts?.values?.presetId
      if (presetId && this.virvi) {
        void this.virvi.httpClient.activatePreset(String(presetId)).catch((err: unknown) => {
          console.log('[Virvi] switchPreset failed:', err instanceof Error ? err.message : String(err))
        })
      }
    })

    channel.handleAction('triggerGiveaway', (opts: any) => {
      const giveawayId = opts?.giveawayId || opts?.values?.giveawayId
      if (giveawayId && this.virvi) {
        this.virvi.sendMessage('virvi:giveaway:trigger', { giveawayId })
      }
    })

    channel.handleAction('sendMessage', (opts: any) => {
      const messageId = opts?.messageId || opts?.values?.messageId
      const data = opts?.data || opts?.values?.data
      if (messageId && this.virvi) {
        let parsed = data
        if (typeof data === 'string') {
          try { parsed = JSON.parse(data) } catch { /* use raw string */ }
        }
        this.virvi.sendMessage(messageId, parsed)
      }
    })

    channel.handleAction('recordAction', (opts: any) => {
      const actionName = opts?.actionName || opts?.values?.actionName
      if (actionName && this.virvi) {
        this.virvi.recordAction(actionName)
      }
    })

    // Reply to state requests from other smart items
    channel.reply<{ connected: boolean; sceneId: string }>('getState', () => ({
      connected: this.connected,
      sceneId: sceneId || this.virvi?.sceneId || '',
    }))

    console.log(`[Virvi Smart Item] Ready. Scene: ${sceneId || '(auto-setup)'}, Server: ${serverUrl}, Auto-connect: ${autoConnect}`)
  }

  /**
   * Connect to Virvi and initialize all scene elements.
   * If no sceneId is provided, the HUD will guide the user through setup.
   */
  private async connect(
    sceneId: string,
    serverUrl: string,
    env: 'dev' | 'staging' | 'prod',
    enableHud: boolean,
    enableAnalytics: boolean,
  ) {
    if (this.connecting || this.connected) {
      console.log('[Virvi Smart Item] Already connected or connecting')
      return
    }

    this.connecting = true
    console.log(`[Virvi Smart Item] Connecting to ${serverUrl}...`)

    try {
      const config: Partial<VirviInitConfig> & { enableHud?: boolean } = {
        env,
        enableHud,
        // Only set sceneId if actually provided (empty string = no scene)
        ...(sceneId ? { sceneId } : {}),
        ...(serverUrl && serverUrl !== 'https://virvi.io' ? {
          apiUrl: serverUrl,
          wssUrl: serverUrl.replace(/^http/, 'ws'),
        } : {}),
      }

      this.virvi = await createVirvi(config)
      this.connected = true
      this.connecting = false

      const storage = this.virvi.storage
      const elementCounts = {
        videos: Object.keys(storage.videos.configs).length,
        images: Object.keys(storage.images.configs).length,
        models: Object.keys(storage.models.configs).length,
        sounds: Object.keys(storage.sounds.configs).length,
        widgets: Object.keys(storage.widgets.configs).length,
      }

      console.log(`[Virvi Smart Item] Connected! Scene: ${this.virvi.sceneId}, Elements:`, JSON.stringify(elementCounts))

      if (enableAnalytics) {
        this.virvi.recordAction('virvi:smart_item:connected')
      }
    } catch (err) {
      this.connecting = false
      this.connected = false
      console.error('[Virvi Smart Item] Failed to connect:', err)
    }
  }

  /**
   * Disconnect from Virvi and clean up.
   */
  private async disconnect() {
    if (!this.virvi) return

    try {
      await this.virvi.destroy()
    } catch (err) {
      console.error('[Virvi Smart Item] Error during disconnect:', err)
    }

    this.virvi = null
    this.connected = false
    console.log('[Virvi Smart Item] Disconnected')
  }

  /**
   * Get the underlying Virvi instance (for advanced usage from code).
   */
  getVirvi(): Virvi | null {
    return this.virvi
  }

  /**
   * Check if currently connected to Virvi.
   */
  isConnected(): boolean {
    return this.connected
  }
}

// ---------------------------------------------------------------------------
// Creator Hub (SDK7 Script component)
// ---------------------------------------------------------------------------

export type VirviManagerOptions = Partial<VirviSmartItemProps>

const noopChannel: IChannel = {
  id: 'virvi-manager',
  handleAction: () => {},
  sendActions: () => {},
  request: async () => undefined as any,
  reply: () => {},
}

/**
 * Entry point for Creator Hub's Script component. The scene's script file
 * (see creator-hub/VirviManager.ts) declares the inspector fields and calls this
 * from start(). Blank serverUrl means "use the env's default server".
 */
export function startVirviManager(entity: Entity, options: VirviManagerOptions = {}): VirviSmartItem {
  const item = new VirviSmartItem()
  item.spawn(entity, {
    sceneId: options.sceneId || '',
    serverUrl: options.serverUrl || 'https://virvi.io',
    showBeacon: options.showBeacon ?? false,
    enableHud: options.enableHud ?? true,
    enableAnalytics: options.enableAnalytics ?? true,
    autoConnect: options.autoConnect ?? true,
    env: options.env || 'prod',
  }, noopChannel)
  return item
}

// Default export for Creator Hub's smart item loader
export default new VirviSmartItem()

// Named exports for code-based usage
export { createVirvi, startVirviAnalytics, stopVirviAnalytics, placeDeployedModels } from '@virvixr/adapter-dcl'
export type { Virvi } from '@virvixr/core'
export type { VirviInitConfig, VirviStorage } from '@virvixr/shared'
