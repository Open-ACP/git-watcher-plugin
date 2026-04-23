import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface SyncResult {
  workspaceDir: string  // the pair dir containing upstream/ and downstream/
  upstreamDir: string   // path to upstream clone
  downstreamDir: string // path to downstream clone
}

/**
 * Sync (or create) the workspace for a downstream pair.
 *
 * Workspace layout:
 *   {dataDir}/workspaces/{watcherId}/upstream/           — shared upstream clone
 *   {dataDir}/workspaces/{watcherId}/{downstreamId}/     — pair dir
 *     upstream  →  symlink to ../upstream/
 *     downstream/  — clone of downstream repo
 *
 * On first run: clones both repos.
 * On subsequent runs: fetches + resets to the target branch tip.
 * Shallow clones (--depth 1) for speed.
 */
export class WorkspaceSync {
  constructor(private dataDir: string) {}

  async sync(opts: {
    watcherId: string
    downstreamId: string
    upstreamRepo: string
    upstreamBranch: string
    downstreamRepo: string
    downstreamBranch: string
  }): Promise<SyncResult> {
    const watcherDir = path.join(this.dataDir, 'workspaces', opts.watcherId)
    const upstreamDir = path.join(watcherDir, 'upstream')
    const pairDir = path.join(watcherDir, opts.downstreamId)
    const downstreamDir = path.join(pairDir, 'downstream')
    const upstreamSymlink = path.join(pairDir, 'upstream')

    fs.mkdirSync(watcherDir, { recursive: true })
    fs.mkdirSync(pairDir, { recursive: true })

    // Sync upstream (shared across all downstreams of this watcher)
    await this.syncRepo(upstreamDir, opts.upstreamRepo, opts.upstreamBranch)

    // Sync downstream
    await this.syncRepo(downstreamDir, opts.downstreamRepo, opts.downstreamBranch)

    // Create upstream symlink in pair dir (idempotent)
    if (!fs.existsSync(upstreamSymlink)) {
      fs.symlinkSync(upstreamDir, upstreamSymlink)
    }

    return { workspaceDir: pairDir, upstreamDir, downstreamDir }
  }

  private async syncRepo(dir: string, repo: string, branch: string): Promise<void> {
    if (fs.existsSync(path.join(dir, '.git'))) {
      // Repo already cloned — fetch and reset to latest
      run('git', ['-C', dir, 'fetch', '--depth=1', 'origin', branch])
      run('git', ['-C', dir, 'reset', '--hard', `origin/${branch}`])
    } else {
      // First time — shallow clone
      fs.mkdirSync(dir, { recursive: true })
      run('git', ['clone', '--depth=1', `--branch=${branch}`, `https://github.com/${repo}.git`, dir])
    }
  }
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || `exit ${result.status}`).trim()
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err}`)
  }
}
