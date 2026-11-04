import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { BrandingError } from '../branding/images.js'
import { getBranding, NO_BRANDING, resetBranding, updateBranding } from '../branding/store.js'

/** Branding is a self-hosted feature: cloud (virvi.io) answers as if the routes don't exist. */
async function selfHostedOnly(_request: FastifyRequest, reply: FastifyReply) {
  if (config.mode === 'cloud') return reply.status(404).send({ error: 'not_found' })
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Forbidden', message: 'Only an instance admin can change branding' })
}

/** base64 string → bytes; null clears; anything else (missing) keeps the current value. */
function fileField(v: unknown): Buffer | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  return Buffer.from(v.replace(/^data:[^,]*,/, ''), 'base64')
}

export default async function brandingRoutes(app: FastifyInstance, opts: { version: string }) {
  // Which install this is (hosted virvi.io, or self-hosted single/scalable) and its branding, for the app's label,
  // sidebar and sign-in page. Public, no secrets.
  app.get('/api/instance', async (_request, reply) => {
    const branding = config.mode === 'cloud' ? NO_BRANDING : await getBranding()
    return reply.send({ mode: config.mode, version: opts.version, ...branding })
  })

  const guard = { preHandler: [selfHostedOnly, authenticate, requireAdmin] }

  app.put('/api/instance/branding', guard, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    try {
      const branding = await updateBranding({ name: body.name, logo: fileField(body.logo), favicon: fileField(body.favicon) }, request.user.id)
      return reply.send(branding)
    } catch (e) {
      if (e instanceof BrandingError) return reply.status(e.status).send({ error: e.code, message: e.message })
      throw e
    }
  })

  app.delete('/api/instance/branding', guard, async (_request, reply) => {
    await resetBranding()
    return reply.status(204).send()
  })
}
