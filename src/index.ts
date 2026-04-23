import type { OpenACPPlugin, PluginContext, InstallContext } from '@openacp/plugin-sdk'
import { AUTO_APPROVED_COMMANDS } from './types.js'
import { WatcherStore } from './storage/watcher-store.js'
import { QueueStore } from './storage/queue-store.js'
import { RunLog } from './storage/run-log.js'
import { WorkspaceSync } from './workers/workspace-sync.js'
import { PairWorkerPool } from './workers/pair-worker.js'
import { ConcurrencyGate } from './workers/concurrency-gate.js'
import { createWebhookRoutes } from './hooks/webhook-receiver.js'
import { registerWebhooksForAll } from './hooks/tunnel-listener.js'
import { bootRecovery } from './hooks/boot-recovery.js'
import { registerCommands } from './commands/index.js'

let teardownFn: (() => Promise<void>) | null = null

// autoApprovedCommands is not in the published OpenACPPlugin interface yet —
// it is a new core feature. Declared here as a runtime property for future support.
const plugin: OpenACPPlugin = {
  name: '@openacp/git-watcher',
  version: '0.1.0',
  description: 'Watch upstream GitHub repos for PR merges and create impact analysis issues in downstream repos',

  permissions: [
    'events:read',
    'events:emit',
    'services:use',
    'commands:register',
    'storage:read',
    'storage:write',
    'kernel:access',
  ],

  pluginDependencies: {
    '@openacp/api-server': '*',
    '@openacp/tunnel': '*',
  },

  async install(ctx: InstallContext): Promise<void> {
    const { terminal, settings } = ctx

    terminal.log.info('git-watcher requires Telegram to be configured for session monitoring.')
    terminal.log.info('Sessions will be visible in Telegram topics for oversight and approval.')

    const telegramChatId = await terminal.text({
      message: 'Telegram supergroup chat ID (negative number, e.g. -1001234567890):',
      validate: (v) => {
        if (!v.trim()) return 'Chat ID is required'
        if (!/^-?\d+$/.test(v.trim())) return 'Chat ID must be a number'
        return undefined
      },
    })

    const maxConcurrent = await terminal.text({
      message: 'Max concurrent AI sessions:',
      defaultValue: '3',
      validate: (v) => {
        const n = Number(v.trim())
        if (isNaN(n) || n < 1 || n > 20) return 'Must be 1-20'
        return undefined
      },
    })

    await settings.setAll({
      telegramChatId: telegramChatId.trim(),
      maxConcurrentSessions: Number(maxConcurrent.trim()),
    })

    terminal.log.success('git-watcher installed. Restart OpenACP to activate.')
  },

  async setup(ctx: PluginContext): Promise<void> {
    const config = ctx.pluginConfig as { telegramChatId?: string; maxConcurrentSessions?: number }

    if (!config.telegramChatId) {
      ctx.log.warn('git-watcher: telegramChatId not configured — run: openacp plugin configure @openacp/git-watcher')
      return
    }

    // --- Initialize shared state ---
    const watcherStore = new WatcherStore(ctx.storage)
    const queueStore = new QueueStore(ctx.storage)
    const runLogStore = new RunLog(ctx.storage)
    const workspaceSync = new WorkspaceSync(ctx.storage.getDataDir())
    const concurrencyGate = new ConcurrencyGate(config.maxConcurrentSessions ?? 3)

    let currentTunnelUrl = ''
    const getCurrentTunnelUrl = (): string => currentTunnelUrl

    // --- Session factory ---
    // ctx.sessions is typed as SessionManager (index signature only in published SDK),
    // so we use `as any` to access the concrete createSession / getSession methods.
    const sessionManager = ctx.sessions as unknown as {
      createSession: (...args: unknown[]) => Promise<{ id: string }>
      getSession: (id: string) => { on: (event: string, handler: (e: unknown) => void) => void; prompt: (text: string, a: undefined, b: undefined) => Promise<void> } | undefined
    }

    const createSessionFn = async (opts: {
      channelId: string
      agentName: string
      workingDir: string
      autoApprovedCommands: string[]
      telegramChatId: string
      telegramTopicId: number
    }): Promise<{ sessionId: string }> => {
      await concurrencyGate.acquire()
      try {
        const session = await sessionManager.createSession(
          opts.channelId,
          opts.agentName,
          opts.workingDir,
        )
        concurrencyGate.release()
        return { sessionId: session.id }
      } catch (err) {
        concurrencyGate.release()
        throw err
      }
    }

    // Sends a prompt to an existing session and accumulates text output until
    // the agent emits a 'result' or 'error' event.
    const promptSessionFn = async (sessionId: string, prompt: string): Promise<string> => {
      const session = sessionManager.getSession(sessionId)
      if (!session) throw new Error(`Session ${sessionId} not found`)

      return new Promise<string>((resolve, reject) => {
        let output = ''
        const handler = (event: unknown) => {
          const e = event as { type: string; text?: string }
          if (e.type === 'text_delta' && e.text) output += e.text
          if (e.type === 'result' || e.type === 'error') {
            if (e.type === 'error') reject(new Error(output || 'Agent error'))
            else resolve(output)
          }
        }
        session.on('agent_event', handler)
        session.prompt(prompt, undefined, undefined).catch(reject)
      })
    }

    // --- Worker pool ---
    const workerPool = new PairWorkerPool({
      queueStore,
      watcherStore,
      runLog: runLogStore,
      workspaceSync,
      createSession: createSessionFn,
      promptSession: promptSessionFn,
      log: ctx.log,
      autoApprovedCommands: [...AUTO_APPROVED_COMMANDS],
    })

    // --- Webhook routes via api-server ---
    const apiServer = ctx.getService<{
      registerPlugin: (prefix: string, plugin: unknown, opts?: unknown) => void
    }>('api-server')

    if (!apiServer) {
      ctx.log.warn('git-watcher: api-server service not found — webhook receiver unavailable')
    } else {
      const routes = createWebhookRoutes(watcherStore, queueStore, (watcherId, downId) => {
        workerPool.notify(watcherId, downId)
      })
      apiServer.registerPlugin('/', routes, { auth: false })
      ctx.log.info('git-watcher: webhook routes registered')
    }

    // --- Tunnel event listeners ---
    ctx.on('tunnel:started', async (data: unknown) => {
      currentTunnelUrl = (data as { url: string }).url
      ctx.log.info(`git-watcher: tunnel started at ${currentTunnelUrl}`)
      await registerWebhooksForAll(watcherStore, currentTunnelUrl, ctx.log)
    })

    ctx.on('tunnel:stopped', () => {
      currentTunnelUrl = ''
    })

    // --- Boot recovery: reset interrupted jobs and drain pending queues ---
    await bootRecovery(watcherStore, queueStore, workerPool, ctx.log)

    // --- Commands ---
    registerCommands(ctx, watcherStore, queueStore, runLogStore, workerPool, {
      telegramChatId: config.telegramChatId,
      maxConcurrentSessions: config.maxConcurrentSessions ?? 3,
    }, getCurrentTunnelUrl)

    ctx.log.info('git-watcher: setup complete')

    teardownFn = async () => {
      ctx.log.info('git-watcher: tearing down')
    }
  },

  async teardown(): Promise<void> {
    if (teardownFn) await teardownFn()
    teardownFn = null
  },
}

export default plugin
