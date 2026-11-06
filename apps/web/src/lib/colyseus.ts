'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Client, Room } from 'colyseus.js'
import { WSS_URL } from './config'
import type { StudioEvent } from './studio'

export function useSceneRoom(sceneId: string | null, token: string | null) {
  const [room, setRoom] = useState<Room | null>(null)
  const [connected, setConnected] = useState(false)
  const clientRef = useRef<Client | null>(null)
  const roomRef = useRef<Room | null>(null)

  useEffect(() => {
    if (!sceneId || sceneId === '_' || !token) return

    const connect = async () => {
      try {
        const client = new Client(WSS_URL)
        clientRef.current = client

        const newRoom = await client.joinOrCreate('virvi_scene', {
          sceneId,
          sessionToken: token,
          clientType: 'host',
          user: { id: 'dashboard' },
        })

        roomRef.current = newRoom
        setRoom(newRoom)
        setConnected(true)

        newRoom.onLeave(() => {
          setConnected(false)
          setRoom(null)
        })
      } catch (err) {
        console.error('Colyseus connection failed:', err)
        setConnected(false)
      }
    }

    connect()

    return () => {
      roomRef.current?.leave()
      roomRef.current = null
      setRoom(null)
      setConnected(false)
    }
  }, [sceneId, token])

  // Send a scene update (element/instance change)
  const sendUpdate = useCallback((message: any) => {
    if (roomRef.current) {
      roomRef.current.send('scene_preset_update', message)
    }
  }, [])

  // Send a preset change
  const changePreset = useCallback((presetId: string) => {
    if (roomRef.current) {
      roomRef.current.send('scene_change_preset', { presetId })
    }
  }, [])

  // Send an arbitrary message type
  const sendMessage = useCallback((type: string, payload: any) => {
    if (roomRef.current) {
      roomRef.current.send(type, payload)
    }
  }, [])

  return { room, connected, sendUpdate, changePreset, sendMessage }
}

export interface CommandCenterStatus {
  eventId: string | null
  worlds: Array<{
    sceneId: string
    sceneName: string
    /** LIV-88; absent from a server that predates it. */
    sceneThumbnailUrl?: string | null
    platform: string | null
    deploymentStatus: string | null
    visitorCount: number
    activePreset: string | null
  }>
  aggregate: {
    totalVisitors: number
    worldCount: number
    deployedCount: number
  }
  timestamp: number
}

export function useCommandCenterRoom(eventId: string | null, token: string | null) {
  const [room, setRoom] = useState<Room | null>(null)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<CommandCenterStatus | null>(null)
  const [activityLog, setActivityLog] = useState<Array<{ time: number; message: string }>>([])
  const clientRef = useRef<Client | null>(null)
  const roomRef = useRef<Room | null>(null)

  useEffect(() => {
    if (!eventId || !token) return

    const connect = async () => {
      try {
        const client = new Client(WSS_URL)
        clientRef.current = client

        const newRoom = await client.joinOrCreate('virvi_command_center', {
          eventId,
          sessionToken: token,
          clientType: 'host',
        })

        roomRef.current = newRoom
        setRoom(newRoom)
        setConnected(true)

        newRoom.onMessage('command_center_status', (data: CommandCenterStatus) => {
          setStatus(data)
        })

        newRoom.onMessage('cross_world_dispatched', (data: any) => {
          setActivityLog((prev) => [
            { time: Date.now(), message: `Broadcast sent to ${data.targetScenes?.length || 0} world(s)` },
            ...prev.slice(0, 99),
          ])
        })

        newRoom.onMessage('error', (data: any) => {
          setActivityLog((prev) => [
            { time: Date.now(), message: `Error: ${data.message}` },
            ...prev.slice(0, 99),
          ])
        })

        newRoom.onLeave(() => {
          setConnected(false)
          setRoom(null)
        })

        setActivityLog((prev) => [
          { time: Date.now(), message: 'Connected to command center' },
          ...prev.slice(0, 99),
        ])
      } catch (err) {
        console.error('Command center Colyseus connection failed:', err)
        setConnected(false)
      }
    }

    connect()

    return () => {
      roomRef.current?.leave()
      roomRef.current = null
      setRoom(null)
      setConnected(false)
    }
  }, [eventId, token])

  const sendBroadcast = useCallback((action: Record<string, unknown>) => {
    if (roomRef.current) {
      roomRef.current.send('cross_world_update', { action })
    }
  }, [])

  return { room, connected, status, activityLog, setActivityLog, sendBroadcast }
}

/** Rejoin delays after the studio room drops: 2 s, 4 s, then every 8 s. */
const STUDIO_REJOIN_MS = [2000, 4000, 8000]

/**
 * Live progress for one Design Studio design: the `virvi_studio` room relays the design's `studio_event`s. When the
 * room drops it rejoins on its own; the page re-reads the design whenever `connected` comes back.
 */
export function useStudioRoom(designId: string | null, token: string | null, onEvent: (e: StudioEvent) => void) {
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!designId || !token) return
    let room: Room | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let closed = false

    const retry = () => {
      if (closed) return
      timer = setTimeout(join, STUDIO_REJOIN_MS[Math.min(attempt, STUDIO_REJOIN_MS.length - 1)])
      attempt++
    }

    const join = async () => {
      timer = null
      try {
        const r = await new Client(WSS_URL).joinOrCreate('virvi_studio', { designId, sessionToken: token })
        if (closed) { r.leave(); return }
        room = r
        attempt = 0
        setConnected(true)
        r.onMessage('studio_event', (e: StudioEvent) => onEventRef.current(e))
        r.onLeave(() => {
          room = null
          setConnected(false)
          retry()
        })
      } catch {
        setConnected(false)
        retry()
      }
    }

    join()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      room?.leave()
      setConnected(false)
    }
  }, [designId, token])

  return { connected }
}
