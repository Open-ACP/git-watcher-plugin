import { spawnSync } from 'node:child_process'
import type { WatcherStore } from '../storage/watcher-store.js'

/**
 * Re-registers GitHub webhooks for all watchers when the tunnel URL changes.
 * Called once per tunnel:started event during plugin lifecycle.
 *
 * Uses the dedicated config endpoint (`PATCH /repos/{owner}/{repo}/hooks/{id}/config`)
 * which supports individual-field updates. The main hook PATCH endpoint
 * replaces the whole `config` object, which would silently drop `secret` and
 * reset `content_type` to the form default — that caused webhooks to stop
 * being signed and to arrive as application/x-www-form-urlencoded.
 */
export async function registerWebhooksForAll(
  watcherStore: WatcherStore,
  tunnelUrl: string,
  log: { info: (ctx: unknown, msg?: string) => void; warn: (ctx: unknown, msg?: string) => void; error: (ctx: unknown, msg?: string) => void },
): Promise<void> {
  const watchers = await watcherStore.list()
  if (watchers.length === 0) return

  for (const watcher of watchers) {
    const webhookUrl = `${tunnelUrl}/git-watcher/webhooks/${watcher.id}`
    const hookId = watcher.upstream.webhookId
    const repo = watcher.upstream.repo
    if (!hookId) continue

    // Send full config including the stored secret so it is preserved even
    // against any API quirk that might still treat this as a replace.
    const body = JSON.stringify({
      url: webhookUrl,
      content_type: 'json',
      secret: watcher.upstream.webhookSecret,
      insecure_ssl: '0',
    })

    const result = spawnSync(
      'gh',
      ['api', `repos/${repo}/hooks/${hookId}/config`, '--method', 'PATCH', '--input', '-'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: body },
    )

    if (result.status === 0) {
      log.info({ hookId, webhookUrl }, `git-watcher: re-registered webhook for ${repo}`)
    } else {
      log.warn({
        hookId,
        repo,
        stderr: result.stderr?.trim(),
        stdout: result.stdout?.trim(),
      }, `git-watcher: failed to re-register webhook for ${repo}`)
    }
  }
}
