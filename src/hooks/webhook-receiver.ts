import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { WatcherStore } from '../storage/watcher-store.js'
import type { QueueStore } from '../storage/queue-store.js'
import type { Watcher } from '../types.js'
import { nanoid } from 'nanoid'

interface DeliveryCache {
  has(id: string): boolean
  add(id: string): void
}

function makeDeliveryCache(maxSize = 50): DeliveryCache {
  const ids: string[] = []
  return {
    has: (id) => ids.includes(id),
    add: (id) => {
      ids.push(id)
      if (ids.length > maxSize) ids.shift()
    },
  }
}

function verifySignature(secret: string, body: Buffer, signature: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

function isMergedPR(payload: Record<string, unknown>): boolean {
  return (
    typeof payload === 'object' &&
    payload.action === 'closed' &&
    typeof payload.pull_request === 'object' &&
    (payload.pull_request as Record<string, unknown>).merged === true
  )
}

export function createWebhookRoutes(
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  onNewJob: (watcherId: string, downstreamId: string) => void,
  log: {
    info: (msg: string, ctx?: unknown) => void
    warn: (msg: string, ctx?: unknown) => void
    error: (msg: string, ctx?: unknown) => void
  },
): FastifyPluginAsync {
  const cache = makeDeliveryCache()

  return async (fastify) => {
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body: Buffer) => void) => done(null, body),
    )

    fastify.post<{ Params: { watcherId: string } }>(
      '/git-watcher/webhooks/:watcherId',
      async (req: FastifyRequest<{ Params: { watcherId: string } }>, reply: FastifyReply) => {
        const { watcherId } = req.params
        const deliveryId = req.headers['x-github-delivery'] as string | undefined
        const event = req.headers['x-github-event'] as string | undefined
        const signature = req.headers['x-hub-signature-256'] as string | undefined

        log.info('git-watcher: webhook received', {
          watcherId,
          deliveryId,
          event,
          hasSignature: Boolean(signature),
          ip: req.ip,
        })

        if (!deliveryId || !event || !signature) {
          log.warn('git-watcher: webhook rejected — missing headers', { watcherId, deliveryId, event, hasSignature: Boolean(signature) })
          return reply.status(400).send({ error: 'Missing required GitHub webhook headers' })
        }

        // Dedup check
        if (cache.has(deliveryId)) {
          log.info('git-watcher: webhook duplicate — already processed', { watcherId, deliveryId })
          return reply.status(200).send({ status: 'duplicate' })
        }

        const watcher = await watcherStore.get(watcherId)
        if (!watcher) {
          log.warn('git-watcher: webhook rejected — watcher not found', { watcherId })
          return reply.status(404).send({ error: 'Watcher not found' })
        }

        // HMAC verification
        const rawBody = req.body as Buffer
        if (!verifySignature(watcher.upstream.webhookSecret, rawBody, signature)) {
          log.warn('git-watcher: webhook rejected — invalid signature', { watcherId, deliveryId })
          return reply.status(401).send({ error: 'Invalid signature' })
        }

        cache.add(deliveryId)

        if (event !== 'pull_request') {
          log.info('git-watcher: webhook ignored — non-PR event', { watcherId, event })
          return reply.status(200).send({ status: 'ignored' })
        }

        const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>
        const action = payload.action as string | undefined
        const pr = payload.pull_request as Record<string, unknown> | undefined
        const prNumberEarly = pr?.number as number | undefined

        if (!isMergedPR(payload)) {
          log.info('git-watcher: webhook ignored — PR not merged', {
            watcherId,
            action,
            prNumber: prNumberEarly,
            merged: pr?.merged,
          })
          return reply.status(200).send({ status: 'ignored' })
        }

        const prBranch = (pr!.base as Record<string, unknown>).ref as string

        // Filter by branch
        const matchingDownstreams = watcher.downstreams.filter(
          (d) => d.branch === prBranch || watcher.upstream.branch === prBranch,
        )

        if (matchingDownstreams.length === 0) {
          log.info('git-watcher: webhook ignored — no matching downstreams for branch', {
            watcherId,
            prBranch,
            upstreamBranch: watcher.upstream.branch,
            downstreamBranches: watcher.downstreams.map((d) => d.branch),
          })
          return reply.status(200).send({ status: 'no_matching_downstreams' })
        }

        const prNumber = pr!.number as number
        const prUrl = (pr!.html_url as string) ?? `https://github.com/${watcher.upstream.repo}/pull/${prNumber}`

        // Enqueue a job for each downstream
        const jobIds: string[] = []
        for (const downstream of matchingDownstreams) {
          const jobId = `job_${nanoid(8)}`
          await queueStore.enqueue({
            id: jobId,
            watcherId,
            downstreamId: downstream.id,
            prNumber,
            prUrl,
            deliveryId,
            enqueuedAt: new Date().toISOString(),
            status: 'pending',
            attempts: 0,
          })
          onNewJob(watcherId, downstream.id)
          jobIds.push(jobId)
        }

        log.info('git-watcher: webhook triggered — jobs enqueued', {
          watcherId,
          prNumber,
          prUrl,
          count: matchingDownstreams.length,
          jobIds,
        })

        return reply.status(200).send({ status: 'queued', count: matchingDownstreams.length })
      },
    )
  }
}
