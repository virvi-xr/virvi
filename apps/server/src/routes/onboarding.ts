import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { onboardingFunnel, onboardingOf, setOnboardingDismissed } from '../onboarding/onboarding.js'

/** The getting-started checklist (LIV-37): your own progress, hiding it, and for admins where new accounts stop. */
export default async function onboardingRoutes(app: FastifyInstance) {
  const accountOnly = (request: any) => request.user.guest || request.user.kind === 'scene' || request.user.kind === 'trial' || request.user.trial

  app.get('/api/me/onboarding', { preHandler: [authenticate] }, async (request, reply) => {
    if (accountOnly(request)) return reply.status(403).send({ error: 'account_required' })
    return reply.send(await onboardingOf(request.user.id))
  })

  app.post('/api/me/onboarding/dismiss', { preHandler: [authenticate] }, async (request, reply) => {
    if (accountOnly(request)) return reply.status(403).send({ error: 'account_required' })
    const dismissed = (request.body as { dismissed?: unknown } | null)?.dismissed
    if (dismissed !== undefined && typeof dismissed !== 'boolean') return reply.status(400).send({ error: 'dismissed must be true or false' })
    return reply.send(await setOnboardingDismissed(request.user.id, dismissed ?? true))
  })

  app.register(async (admin) => {
    admin.addHook('preHandler', authenticate)
    admin.addHook('preHandler', requireAdmin)
    admin.get('/api/admin/onboarding', async (request, reply) => {
      const raw = Number((request.query as { days?: string }).days ?? 90)
      const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.round(raw))) : 90
      return reply.send(await onboardingFunnel(days))
    })
  })
}
