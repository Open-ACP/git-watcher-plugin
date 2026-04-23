import { nanoid } from 'nanoid'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store.js'
import type { QueueStore } from '../storage/queue-store.js'
import type { RunLog } from '../storage/run-log.js'
import type { PairWorkerPool } from '../workers/pair-worker.js'
import type { PluginConfig, Downstream, Watcher } from '../types.js'
import { DEFAULT_PROMPT_TEMPLATE } from '../types.js'
import { registerWebhooksForAll } from '../hooks/tunnel-listener.js'
import { createGithubWebhook, deleteGithubWebhook } from '../hooks/github-webhook.js'
import { parseRepoInput } from '../utils/parse-repo.js'

export function registerCommands(
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  runLog: RunLog,
  workerPool: PairWorkerPool,
  pluginConfig: PluginConfig,
  getCurrentTunnelUrl: () => string,
): void {
  // /gitwatch <subcommand> — single entry-point command covering all git-watcher operations
  ctx.registerCommand({
    name: 'gitwatch',
    description: 'git-watcher: add, list, show, remove, downstream, status, queue, logs, retry, test, doctor, webhook-redeploy',
    usage: '<subcommand> [args]',
    category: 'plugin',
    handler: async (args) => {
      const parts = args.raw.trim().split(/\s+/)
      const sub = parts[0] ?? 'list'

      switch (sub) {
        case '': {
          return {
            type: 'menu',
            title: [
              'git-watcher — watch upstream repos for PR merges and trigger AI analysis.',
              '',
              'Commands needing arguments (type manually):',
              '  /gitwatch add <repo-or-url> [branch]',
              '  /gitwatch show <watcherId>',
              '  /gitwatch downstream add <watcherId> <repo-or-url> [branch]',
              '  /gitwatch downstream remove <watcherId> <downstreamId>',
              '  /gitwatch remove <watcherId>',
              '  /gitwatch queue <watcherId> <downstreamId>',
              '  /gitwatch retry <jobId> <watcherId> <downstreamId>',
              '  /gitwatch logs [watcherId] [downstreamId]',
              '  /gitwatch test <watcherId> <prNumber>',
              '',
              'Repo accepts owner/repo or https://github.com/owner/repo.',
            ].join('\n'),
            options: [
              { label: '📋 List watchers', command: '/gitwatch list' },
              { label: '📊 Status', command: '/gitwatch status' },
              { label: '🩺 Doctor', command: '/gitwatch doctor' },
              { label: '🔗 Redeploy webhooks', command: '/gitwatch webhook-redeploy' },
            ],
          }
        }

        case 'list': {
          const watchers = await watcherStore.list()
          if (watchers.length === 0) {
            return { type: 'text', text: 'No watchers configured. Use /gitwatch add to create one.' }
          }
          const lines = watchers.map((w) =>
            `• **${w.id}** — upstream: \`${w.upstream.repo}\` (${w.upstream.branch}) → ${w.downstreams.length} downstream(s)`,
          )
          return { type: 'text', text: `**Watchers (${watchers.length}):**\n${lines.join('\n')}` }
        }

        case 'show': {
          const id = parts[1]
          if (!id) return { type: 'error', message: 'Usage: /gitwatch show <watcherId>' }
          const watcher = await watcherStore.get(id)
          if (!watcher) return { type: 'error', message: `Watcher "${id}" not found` }
          const lines = [
            `**${watcher.id}**`,
            `Upstream: \`${watcher.upstream.repo}\` @ \`${watcher.upstream.branch}\``,
            `Webhook ID: ${watcher.upstream.webhookId || 'not registered'}`,
            `Downstreams (${watcher.downstreams.length}):`,
            ...watcher.downstreams.map((d) =>
              `  • **${d.id}** — \`${d.repo}\` @ \`${d.branch}\` [${d.sessionStrategy}]`,
            ),
          ]
          return { type: 'text', text: lines.join('\n') }
        }

        case 'add': {
          const repoArg = parts[1]
          const branch = parts[2] ?? 'main'
          if (!repoArg) {
            return { type: 'error', message: 'Usage: /gitwatch add <repo-or-url> [branch]' }
          }
          const repo = parseRepoInput(repoArg)
          if (!repo) {
            return { type: 'error', message: `Invalid repo: "${repoArg}". Use owner/repo or a GitHub URL.` }
          }

          const tunnelUrl = getCurrentTunnelUrl()
          if (!tunnelUrl) return { type: 'error', message: 'Tunnel not active. Wait for tunnel to start, then retry.' }

          const watcherId = `watcher_${nanoid(8)}`
          const webhookUrl = `${tunnelUrl}/git-watcher/webhooks/${watcherId}`

          let hookId: number
          let secret: string
          try {
            const created = createGithubWebhook({ repo, webhookUrl })
            hookId = created.hookId
            secret = created.secret
          } catch (err) {
            return {
              type: 'error',
              message: `Failed to register GitHub webhook: ${(err as Error).message}`,
            }
          }

          const watcher: Watcher = {
            id: watcherId,
            upstream: { repo, branch, webhookId: hookId, webhookSecret: secret },
            downstreams: [],
            createdAt: new Date().toISOString(),
          }
          await watcherStore.save(watcher)

          return {
            type: 'text',
            text:
              `✅ Watcher created: **${watcherId}**\n` +
              `Upstream: \`${repo}\` @ \`${branch}\`\n` +
              `Webhook: #${hookId} → ${webhookUrl}\n\n` +
              `Next: add a downstream with\n` +
              `/gitwatch downstream add ${watcherId} <repo-or-url> [branch]`,
          }
        }

        case 'downstream': {
          const dsub = parts[1]

          if (dsub === 'add') {
            const watcherId = parts[2]
            const repoArg = parts[3]
            const branch = parts[4] ?? 'main'

            if (!watcherId || !repoArg) {
              return { type: 'error', message: 'Usage: /gitwatch downstream add <watcherId> <repo-or-url> [branch]' }
            }
            const repo = parseRepoInput(repoArg)
            if (!repo) {
              return { type: 'error', message: `Invalid repo: "${repoArg}". Use owner/repo or a GitHub URL.` }
            }
            const watcher = await watcherStore.get(watcherId)
            if (!watcher) return { type: 'error', message: `Watcher "${watcherId}" not found` }

            const downstreamId = `down_${nanoid(6)}`
            const downstream: Downstream = {
              id: downstreamId,
              repo,
              branch,
              telegramTopicId: 0,
              issueLabels: ['sync'],
              promptTemplate: DEFAULT_PROMPT_TEMPLATE,
              agent: 'claude-opus-4-7',
              sessionStrategy: 'per-trigger',
              sessionLimits: { maxTurns: 10, maxAge: '24h' },
            }
            watcher.downstreams.push(downstream)
            await watcherStore.save(watcher)
            await queueStore.addPairToIndex(watcherId, downstreamId)
            return { type: 'text', text: `Added downstream ${downstreamId}: \`${repo}\` @ \`${branch}\`` }
          }

          if (dsub === 'remove') {
            const watcherId = parts[2]
            const downId = parts[3]
            if (!watcherId || !downId) {
              return { type: 'error', message: 'Usage: /gitwatch downstream remove <watcherId> <downstreamId>' }
            }
            const watcher = await watcherStore.get(watcherId)
            if (!watcher) return { type: 'error', message: `Watcher "${watcherId}" not found` }
            watcher.downstreams = watcher.downstreams.filter((d) => d.id !== downId)
            await watcherStore.save(watcher)
            await queueStore.removePairFromIndex(watcherId, downId)
            workerPool.delete(watcherId, downId)
            return { type: 'text', text: `Removed downstream ${downId}` }
          }

          return { type: 'error', message: 'Usage: /gitwatch downstream <add|remove> ...' }
        }

        case 'remove': {
          const watcherId = parts[1]
          if (!watcherId) return { type: 'error', message: 'Usage: /gitwatch remove <watcherId>' }
          const watcher = await watcherStore.get(watcherId)
          if (!watcher) return { type: 'error', message: `Watcher "${watcherId}" not found` }

          let webhookNote = ''
          if (watcher.upstream.webhookId) {
            const res = deleteGithubWebhook(watcher.upstream.repo, watcher.upstream.webhookId)
            webhookNote = res.ok
              ? ` (GitHub webhook #${watcher.upstream.webhookId} deleted)`
              : ` (⚠️ failed to delete GitHub webhook: ${res.error})`
          }

          await watcherStore.delete(watcherId)
          for (const d of watcher.downstreams) {
            workerPool.delete(watcherId, d.id)
          }
          return { type: 'text', text: `Removed watcher ${watcherId}${webhookNote}` }
        }

        case 'test': {
          const watcherId = parts[1]
          const prNumberStr = parts[2]
          if (!watcherId || !prNumberStr) {
            return { type: 'error', message: 'Usage: /gitwatch test <watcherId> <prNumber>' }
          }
          const prNumber = parseInt(prNumberStr, 10)
          if (isNaN(prNumber)) return { type: 'error', message: 'prNumber must be an integer' }

          const watcher = await watcherStore.get(watcherId)
          if (!watcher) return { type: 'error', message: `Watcher "${watcherId}" not found` }
          if (watcher.downstreams.length === 0) {
            return { type: 'error', message: 'Watcher has no downstreams. Add one first.' }
          }

          const prUrl = `https://github.com/${watcher.upstream.repo}/pull/${prNumber}`
          let enqueued = 0
          for (const d of watcher.downstreams) {
            await queueStore.enqueue({
              id: `job_${nanoid(8)}`,
              watcherId,
              downstreamId: d.id,
              prNumber,
              prUrl,
              deliveryId: `manual_${nanoid(6)}`,
              enqueuedAt: new Date().toISOString(),
              status: 'pending',
              attempts: 0,
            })
            workerPool.notify(watcherId, d.id)
            enqueued++
          }
          return {
            type: 'text',
            text: `Enqueued ${enqueued} job(s) for PR #${prNumber} on ${watcher.upstream.repo}`,
          }
        }

        case 'status': {
          const watchers = await watcherStore.list()
          const lines = ['**git-watcher status:**']
          for (const w of watchers) {
            lines.push(`\n**${w.id}** (${w.upstream.repo})`)
            for (const d of w.downstreams) {
              const items = await queueStore.getItems(w.id, d.id)
              const pending = items.filter((i) => i.status === 'pending').length
              const processing = items.filter((i) => i.status === 'processing').length
              const failed = items.filter((i) => i.status === 'failed').length
              lines.push(`  • ${d.id} (${d.repo}): pending=${pending} processing=${processing} failed=${failed}`)
            }
          }
          return { type: 'text', text: lines.join('\n') }
        }

        case 'queue': {
          const watcherId = parts[1]
          const downId = parts[2]
          if (!watcherId || !downId) {
            return { type: 'error', message: 'Usage: /gitwatch queue <watcherId> <downstreamId>' }
          }
          const items = await queueStore.getItems(watcherId, downId)
          if (items.length === 0) return { type: 'text', text: 'Queue is empty' }
          const lines = items.map((i) =>
            `• ${i.id} [${i.status}] PR #${i.prNumber} (attempts: ${i.attempts})${i.error ? ` — ${i.error}` : ''}`,
          )
          return { type: 'text', text: `**Queue (${items.length}):**\n${lines.join('\n')}` }
        }

        case 'logs': {
          const watcherId = parts[1]
          const downId = parts[2]
          const entries = watcherId && downId
            ? await runLog.getForPair(watcherId, downId)
            : await runLog.getAll()
          if (entries.length === 0) return { type: 'text', text: 'No log entries' }
          const recent = entries.slice(-10)
          const lines = recent.map((e) =>
            `• [${e.status}] ${e.jobId} — PR #${e.prNumber} → ${e.downstream}${e.issueUrl ? ` → ${e.issueUrl}` : ''}`,
          )
          return { type: 'text', text: `**Recent logs (last ${recent.length}):**\n${lines.join('\n')}` }
        }

        case 'retry': {
          const jobId = parts[1]
          const watcherId = parts[2]
          const downId = parts[3]
          if (!jobId || !watcherId || !downId) {
            return { type: 'error', message: 'Usage: /gitwatch retry <jobId> <watcherId> <downstreamId>' }
          }
          const items = await queueStore.getItems(watcherId, downId)
          const job = items.find((i) => i.id === jobId)
          if (!job) return { type: 'error', message: `Job "${jobId}" not found` }
          job.status = 'pending'
          job.attempts = 0
          job.retryAfter = undefined
          job.error = undefined
          await queueStore.updateItem(job)
          workerPool.notify(watcherId, downId)
          return { type: 'text', text: `Retrying job ${jobId}` }
        }

        case 'doctor': {
          const lines = ['**git-watcher doctor:**']
          // Check gh auth
          try {
            const { execSync } = await import('node:child_process')
            execSync('gh auth status', { stdio: 'pipe' })
            lines.push('✅ gh CLI authenticated')
          } catch {
            lines.push('❌ gh CLI not authenticated — run: gh auth login')
          }
          // Check tunnel
          const tunnelUrl = getCurrentTunnelUrl()
          if (tunnelUrl) {
            lines.push(`✅ Tunnel active: ${tunnelUrl}`)
          } else {
            lines.push('❌ Tunnel not active')
          }
          // Check watchers
          const watchers = await watcherStore.list()
          lines.push(`📊 Watchers: ${watchers.length}`)
          return { type: 'text', text: lines.join('\n') }
        }

        case 'webhook-redeploy': {
          const tunnelUrl = getCurrentTunnelUrl()
          if (!tunnelUrl) return { type: 'error', message: 'Tunnel not active' }
          // Cast ctx.log because SDK Logger type is msg-first but runtime is pino (obj-first)
          await registerWebhooksForAll(
            watcherStore,
            tunnelUrl,
            ctx.log as unknown as Parameters<typeof registerWebhooksForAll>[2],
          )
          return { type: 'text', text: 'Webhooks re-deployed to all watchers' }
        }

        default:
          return {
            type: 'error',
            message: `Unknown subcommand: ${sub}. Try: list, show, add, remove, downstream, status, queue, logs, retry, test, doctor, webhook-redeploy`,
          }
      }
    },
  })
}
