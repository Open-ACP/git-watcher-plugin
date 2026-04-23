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

        if (!deliveryId || !event || !signature) {
          return reply.status(400).send({ error: 'Missing required GitHub webhook headers' })
        }

        // Dedup check
        if (cache.has(deliveryId)) {
          return reply.status(200).send({ status: 'duplicate' })
        }

        const watcher = await watcherStore.get(watcherId)
        if (!watcher) {
          return reply.status(404).send({ error: 'Watcher not found' })
        }

        // HMAC verification
        const rawBody = req.body as Buffer
        if (!verifySignature(watcher.upstream.webhookSecret, rawBody, signature)) {
          return reply.status(401).send({ error: 'Invalid signature' })
        }

        cache.add(deliveryId)

        if (event !== 'pull_request') {
          return reply.status(200).send({ status: 'ignored' })
        }

        const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>

        if (!isMergedPR(payload)) {
          return reply.status(200).send({ status: 'ignored' })
        }

        const pr = payload.pull_request as Record<string, unknown>
        const prBranch = (pr.base as Record<string, unknown>).ref as string

        // Filter by branch
        const matchingDownstreams = watcher.downstreams.filter(
          (d) => d.branch === prBranch || watcher.upstream.branch === prBranch,
        )

        if (matchingDownstreams.length === 0) {
          return reply.status(200).send({ status: 'no_matching_downstreams' })
        }

        const prNumber = pr.number as number
        const prUrl = (pr.html_url as string) ?? `https://github.com/${watcher.upstream.repo}/pull/${prNumber}`

        // Enqueue a job for each downstream
        for (const downstream of matchingDownstreams) {
          await queueStore.enqueue({
            id: `job_${nanoid(8)}`,
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
        }

        return reply.status(200).send({ status: 'queued', count: matchingDownstreams.length })
      },
    )
  }
}
