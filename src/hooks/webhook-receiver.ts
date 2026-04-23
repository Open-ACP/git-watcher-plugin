import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { WatcherStore } from '../storage/watcher-store.js'
import type { QueueStore } from '../storage/queue-store.js'
import type { Watcher } from '../types.js'
import { nanoid } from 'nanoid'

type WebhookHandlerFn = (
  req: FastifyRequest<{ Params: { watcherId: string } }>,
  reply: FastifyReply,
) => Promise<unknown>

/**
 * ApiServer.registerPlugin is a no-op after Fastify boots, so on hot-reload
 * our new handler is never wired to the route. We use globalThis + Symbol.for()
 * as a re-import-safe registry: the Fastify route (registered once on first
 * boot) looks up the handler here every request, and each plugin setup updates
 * the slot with the latest handler.
 */
const HANDLER_KEY = Symbol.for('@openacp/git-watcher/webhook-handler-v1')
type GlobalSlot = Record<symbol, WebhookHandlerFn | undefined>

export function setWebhookHandler(handler: WebhookHandlerFn): void {
  ;(globalThis as unknown as GlobalSlot)[HANDLER_KEY] = handler
}

function getWebhookHandler(): WebhookHandlerFn | undefined {
  return (globalThis as unknown as GlobalSlot)[HANDLER_KEY]
}

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

/**
 * Build the Fastify-level route (registered once). It does NOT hold the real
 * handler — it delegates to whatever is stored via `setWebhookHandler()`.
 * This lets hot-reload swap logic without needing to re-register the route.
 */
export function createWebhookRoutes(
  log: {
    info: (ctx: unknown, msg?: string) => void
    warn: (ctx: unknown, msg?: string) => void
    error: (ctx: unknown, msg?: string) => void
  },
): FastifyPluginAsync {
  return async (fastify) => {
    // GitHub may send either `application/json` (content_type=json) or
    // `application/x-www-form-urlencoded` (content_type=form, the GitHub default).
    // We need RAW bytes for HMAC verification, so register a raw-body parser
    // for both types.
    const rawPassthrough = (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body: Buffer) => void,
    ): void => done(null, body)

    for (const ct of ['application/json', 'application/x-www-form-urlencoded']) {
      try {
        fastify.removeContentTypeParser(ct)
      } catch {
        // parser may not exist at this scope
      }
      try {
        fastify.addContentTypeParser(ct, { parseAs: 'buffer' }, rawPassthrough)
      } catch (err) {
        log.warn({
          contentType: ct,
          error: err instanceof Error ? err.message : String(err),
        }, 'git-watcher: failed to register raw-body parser')
      }
    }

    fastify.post<{ Params: { watcherId: string } }>(
      '/git-watcher/webhooks/:watcherId',
      async (req, reply) => {
        const handler = getWebhookHandler()
        if (!handler) {
          log.error('git-watcher: webhook hit but no handler registered (plugin not ready)')
          return reply.status(503).send({ error: 'Service not ready' })
        }
        try {
          return await handler(req, reply)
        } catch (err) {
          const errObj = err instanceof Error ? err : new Error(String(err))
          log.error({
            watcherId: req.params.watcherId,
            deliveryId: req.headers['x-github-delivery'],
            event: req.headers['x-github-event'],
            error: errObj.message,
            stack: errObj.stack,
            bodyType: typeof req.body,
            bodyIsBuffer: Buffer.isBuffer(req.body),
          }, 'git-watcher: webhook handler threw')
          return reply.status(500).send({ error: 'Internal error — see dev log' })
        }
      },
    )
  }
}

/** Build the real handler closure for the current plugin instance. */
export function buildWebhookHandler(
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  onNewJob: (watcherId: string, downstreamId: string) => void,
  log: {
    info: (ctx: unknown, msg?: string) => void
    warn: (ctx: unknown, msg?: string) => void
    error: (ctx: unknown, msg?: string) => void
  },
): WebhookHandlerFn {
  const cache = makeDeliveryCache()
  return (req, reply) => handleWebhook(req, reply, watcherStore, queueStore, onNewJob, cache, log)
}

async function handleWebhook(
  req: FastifyRequest<{ Params: { watcherId: string } }>,
  reply: FastifyReply,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  onNewJob: (watcherId: string, downstreamId: string) => void,
  cache: DeliveryCache,
  log: {
    info: (ctx: unknown, msg?: string) => void
    warn: (ctx: unknown, msg?: string) => void
    error: (ctx: unknown, msg?: string) => void
  },
): Promise<FastifyReply> {
  const { watcherId } = req.params
  const deliveryId = req.headers['x-github-delivery'] as string | undefined
  const event = req.headers['x-github-event'] as string | undefined
  const signature = req.headers['x-hub-signature-256'] as string | undefined

  log.info({
    watcherId,
    deliveryId,
    event,
    hasSignature: Boolean(signature),
    ip: req.ip,
    bodyType: typeof req.body,
    bodyIsBuffer: Buffer.isBuffer(req.body),
  }, 'git-watcher: webhook received')

  if (!deliveryId || !event || !signature) {
    log.warn({ watcherId, deliveryId, event, hasSignature: Boolean(signature) }, 'git-watcher: webhook rejected — missing headers')
    return reply.status(400).send({ error: 'Missing required GitHub webhook headers' })
  }

  // Dedup check
  if (cache.has(deliveryId)) {
    log.info({ watcherId, deliveryId }, 'git-watcher: webhook duplicate — already processed')
    return reply.status(200).send({ status: 'duplicate' })
  }

  const watcher = await watcherStore.get(watcherId)
  if (!watcher) {
    log.warn({ watcherId }, 'git-watcher: webhook rejected — watcher not found')
    return reply.status(404).send({ error: 'Watcher not found' })
  }

  // HMAC verification — req.body may be Buffer (ideal) or parsed object if our
  // raw parser failed to register. Re-serialize as a fallback, but warn loudly.
  let rawBody: Buffer
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body
  } else if (typeof req.body === 'string') {
    rawBody = Buffer.from(req.body)
  } else {
    log.warn({
      watcherId,
      bodyType: typeof req.body,
    }, 'git-watcher: body was pre-parsed (HMAC will fail) — raw parser not active')
    rawBody = Buffer.from(JSON.stringify(req.body))
  }

  if (!verifySignature(watcher.upstream.webhookSecret, rawBody, signature)) {
    log.warn({ watcherId, deliveryId }, 'git-watcher: webhook rejected — invalid signature')
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  cache.add(deliveryId)

  if (event !== 'pull_request') {
    log.info({ watcherId, event }, 'git-watcher: webhook ignored — non-PR event')
    return reply.status(200).send({ status: 'ignored' })
  }

  // Body may be either raw JSON (content_type=json) or form-urlencoded
  // `payload=<json>` (content_type=form, the GitHub default). Extract accordingly.
  const contentType = (req.headers['content-type'] as string | undefined) ?? ''
  let payloadJson: string
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const parsed = new URLSearchParams(rawBody.toString())
    const encoded = parsed.get('payload')
    if (!encoded) {
      log.warn({ watcherId }, 'git-watcher: form-urlencoded body missing "payload" field')
      return reply.status(400).send({ error: 'Missing payload field' })
    }
    payloadJson = encoded
  } else {
    payloadJson = rawBody.toString()
  }
  const payload = JSON.parse(payloadJson) as Record<string, unknown>
  const action = payload.action as string | undefined
  const pr = payload.pull_request as Record<string, unknown> | undefined
  const prNumberEarly = pr?.number as number | undefined

  if (!isMergedPR(payload)) {
    log.info({
      watcherId,
      action,
      prNumber: prNumberEarly,
      merged: pr?.merged,
    }, 'git-watcher: webhook ignored — PR not merged')
    return reply.status(200).send({ status: 'ignored' })
  }

  const prBranch = (pr!.base as Record<string, unknown>).ref as string

  // Filter by branch
  const matchingDownstreams = watcher.downstreams.filter(
    (d) => d.branch === prBranch || watcher.upstream.branch === prBranch,
  )

  if (matchingDownstreams.length === 0) {
    log.info({
      watcherId,
      prBranch,
      upstreamBranch: watcher.upstream.branch,
      downstreamBranches: watcher.downstreams.map((d) => d.branch),
    }, 'git-watcher: webhook ignored — no matching downstreams for branch')
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

  log.info({
    watcherId,
    prNumber,
    prUrl,
    count: matchingDownstreams.length,
    jobIds,
  }, 'git-watcher: webhook triggered — jobs enqueued')

  return reply.status(200).send({ status: 'queued', count: matchingDownstreams.length })
}
