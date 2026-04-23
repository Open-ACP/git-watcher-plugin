import type { WatcherStore } from '../storage/watcher-store.js'

/**
 * Re-registers GitHub webhooks for all watchers when the tunnel URL changes.
 * Called once per tunnel:started event during plugin lifecycle.
 */
export async function registerWebhooksForAll(
  watcherStore: WatcherStore,
  tunnelUrl: string,
  log: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void },
): Promise<void> {
  const watchers = await watcherStore.list()
  if (watchers.length === 0) return

  for (const watcher of watchers) {
    const webhookUrl = `${tunnelUrl}/git-watcher/webhooks/${watcher.id}`
    try {
      // Use gh CLI to update the webhook URL — the AI would normally do this,
      // but for re-registration we run it directly via exec.
      const { execSync } = await import('node:child_process')
      const hookId = watcher.upstream.webhookId
      const repo = watcher.upstream.repo

      if (hookId) {
        execSync(
          `gh api repos/${repo}/hooks/${hookId} -X PATCH -f "config[url]=${webhookUrl}"`,
          { stdio: 'pipe' },
        )
        log.info(`Re-registered webhook for ${repo}`, { hookId, webhookUrl })
      }
    } catch (err) {
      log.warn(`Failed to re-register webhook for ${watcher.upstream.repo}`, {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
