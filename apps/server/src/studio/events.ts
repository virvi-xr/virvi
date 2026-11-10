import { publishOnBus } from '../realtime/bus.js'

/** What a design's page hears, through the virvi_studio room. A `job` event that is done or failed means "re-read the design". */
export type StudioEvent =
  | { type: 'progress'; jobId: string; text: string }
  | { type: 'phase'; jobId: string; phase: string }
  /** `senderName`: on a queued prompt, who sent it (null for support's) */
  | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string; senderName?: string | null }
  /** The user is no longer on the design: the room disconnects their clients, and the others re-read who is on it. */
  | { type: 'member_removed'; userId: string }

export const studioTopic = (designId: string) => `studio:${designId}`

export async function publishStudio(designId: string, e: StudioEvent): Promise<void> {
  await publishOnBus(studioTopic(designId), e)
}
