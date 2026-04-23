import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

export interface CreatedWebhook {
  hookId: number
  secret: string
}

/**
 * Register a new `pull_request` webhook on the upstream repo via `gh api`.
 *
 * Generates a fresh HMAC secret, POSTs the hook, and returns the hook ID and
 * secret so the caller can persist them with the watcher. Throws if `gh` is
 * unauthenticated, the repo is inaccessible, or GitHub rejects the request.
 */
export function createGithubWebhook(opts: {
  repo: string
  webhookUrl: string
}): CreatedWebhook {
  const secret = crypto.randomBytes(16).toString('hex')

  const result = spawnSync(
    'gh',
    [
      'api',
      `repos/${opts.repo}/hooks`,
      '-X', 'POST',
      '-f', 'name=web',
      '-F', 'active=true',
      '-f', 'events[]=pull_request',
      '-f', `config[url]=${opts.webhookUrl}`,
      '-f', 'config[content_type]=json',
      '-f', `config[secret]=${secret}`,
      '-f', 'config[insecure_ssl]=0',
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  )

  if (result.status !== 0) {
    throw new Error(`gh api failed: ${result.stderr || result.stdout || 'unknown error'}`)
  }

  let hookId: number
  try {
    const parsed = JSON.parse(result.stdout) as { id?: number }
    if (typeof parsed.id !== 'number') throw new Error('missing id in response')
    hookId = parsed.id
  } catch (err) {
    throw new Error(`Failed to parse gh api response: ${(err as Error).message}`)
  }

  return { hookId, secret }
}

/** Delete a webhook via `gh api`. Best-effort — logs errors but does not throw. */
export function deleteGithubWebhook(repo: string, hookId: number): { ok: boolean; error?: string } {
  const result = spawnSync(
    'gh',
    ['api', `repos/${repo}/hooks/${hookId}`, '-X', 'DELETE'],
    { encoding: 'utf8', stdio: 'pipe' },
  )
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || 'unknown error' }
  }
  return { ok: true }
}
