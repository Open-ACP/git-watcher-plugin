import type { QueueStore } from '../storage/queue-store.js'
import type { WatcherStore } from '../storage/watcher-store.js'
import type { RunLog } from '../storage/run-log.js'
import type { QueueItem, Downstream, Watcher } from '../types.js'
import { WorkspaceSync } from './workspace-sync.js'
import { resolveSession } from './session-resolver.js'
import { fillTemplate, parseOutcome } from '../prompt/template.js'
import { SYSTEM_PROMPT } from '../prompt/system-prompt.js'
import { nanoid } from 'nanoid'

const RETRY_DELAY_MS = 5 * 60 * 1000  // 5 minutes
const MAX_ATTEMPTS = 3

export interface PairWorkerDeps {
  queueStore: QueueStore
  watcherStore: WatcherStore
  runLog: RunLog
  workspaceSync: WorkspaceSync
  createSession: (opts: {
    channelId: string
    agentName: string
    workingDir: string
    autoApprovedCommands: string[]
    threadTitle?: string
  }) => Promise<{ sessionId: string }>
  promptSession: (sessionId: string, prompt: string) => Promise<string>
  destroySession?: (sessionId: string) => Promise<void>
  log: {
    info: (ctx: unknown, msg?: string) => void
    warn: (ctx: unknown, msg?: string) => void
    error: (ctx: unknown, msg?: string) => void
  }
  autoApprovedCommands: string[]
}

/**
 * FIFO processor for a single (watcherId, downstreamId) pair.
 *
 * Picks pending jobs from the queue, syncs the workspace, spawns/reuses an AI
 * session, fills and sends the prompt, then records the outcome. Failed jobs
 * are retried up to MAX_ATTEMPTS with a RETRY_DELAY_MS delay.
 */
export class PairWorker {
  private running = false
  private scheduled = false

  constructor(
    private watcherId: string,
    private downstreamId: string,
    private deps: PairWorkerDeps,
  ) {}

  /** Signal that new work may be available — triggers processing if not already running. */
  notify(): void {
    if (this.running) return
    if (this.scheduled) return
    this.scheduled = true
    // Use setTimeout(0) so the caller's stack unwinds first
    setTimeout(() => this.processLoop(), 0)
  }

  private async processLoop(): Promise<void> {
    this.scheduled = false
    if (this.running) return
    this.running = true

    try {
      while (true) {
        const job = await this.nextPendingJob()
        if (!job) break

        await this.processJob(job)
      }
    } finally {
      this.running = false
    }
  }

  private async nextPendingJob(): Promise<QueueItem | null> {
    const items = await this.deps.queueStore.getItems(this.watcherId, this.downstreamId)
    const now = Date.now()

    return (
      items.find((item) => {
        if (item.status !== 'pending') return false
        if (item.retryAfter && new Date(item.retryAfter).getTime() > now) return false
        return true
      }) ?? null
    )
  }

  private async processJob(job: QueueItem): Promise<void> {
    const { queueStore, watcherStore, runLog, workspaceSync } = this.deps

    // Mark as processing
    job.status = 'processing'
    job.attempts++
    await queueStore.updateItem(job)

    const watcher = await watcherStore.get(this.watcherId)
    if (!watcher) {
      await this.failJob(job, 'Watcher not found')
      return
    }
    const downstream = watcher.downstreams.find((d) => d.id === this.downstreamId)
    if (!downstream) {
      await this.failJob(job, 'Downstream not found')
      return
    }

    const startedAt = new Date().toISOString()
    let sessionId = ''
    let step: 'sync-workspace' | 'create-session' | 'prompt-session' | 'finalize' = 'sync-workspace'

    const jobCtx = {
      jobId: job.id,
      watcherId: this.watcherId,
      downstreamId: this.downstreamId,
      prNumber: job.prNumber,
      attempts: job.attempts,
    }

    this.deps.log.info(jobCtx, `git-watcher: processing job`)

    try {
      // Sync workspace
      step = 'sync-workspace'
      this.deps.log.info({
        ...jobCtx,
        upstream: `${watcher.upstream.repo}@${watcher.upstream.branch}`,
        downstream: `${downstream.repo}@${downstream.branch}`,
      }, `git-watcher: syncing workspace`)
      const { workspaceDir } = await workspaceSync.sync({
        watcherId: this.watcherId,
        downstreamId: this.downstreamId,
        upstreamRepo: watcher.upstream.repo,
        upstreamBranch: watcher.upstream.branch,
        downstreamRepo: downstream.repo,
        downstreamBranch: downstream.branch,
      })
      this.deps.log.info({ ...jobCtx, workspaceDir }, `git-watcher: workspace ready`)

      // Resolve session (reuse or create)
      step = 'create-session'
      const resolved = resolveSession(downstream)
      if (resolved.reuseExisting && resolved.sessionId) {
        sessionId = resolved.sessionId
        this.deps.log.info({ ...jobCtx, sessionId }, `git-watcher: reusing session`)
      } else {
        this.deps.log.info({ ...jobCtx, agent: downstream.agent }, `git-watcher: creating session`)
        const created = await this.deps.createSession({
          channelId: `git-watcher:${this.watcherId}:${this.downstreamId}`,
          agentName: downstream.agent,
          workingDir: workspaceDir,
          autoApprovedCommands: this.deps.autoApprovedCommands,
          threadTitle: `git-watcher: ${downstream.repo} #${job.prNumber}`,
        })
        sessionId = created.sessionId
        this.deps.log.info({ ...jobCtx, sessionId }, `git-watcher: session created`)

        // Update downstream session tracking
        downstream.currentSessionId = sessionId
        downstream.sessionTurnCount = 0
        downstream.sessionCreatedAt = new Date().toISOString()
        await watcherStore.save(watcher)
      }

      // Fill prompt
      const prompt = `${SYSTEM_PROMPT}\n\n${fillTemplate(downstream.promptTemplate, {
        upstream_repo: watcher.upstream.repo,
        upstream_branch: watcher.upstream.branch,
        downstream_repo: downstream.repo,
        downstream_branch: downstream.branch,
        pr_number: job.prNumber,
        pr_url: job.prUrl,
        issue_labels: downstream.issueLabels.join(','),
      })}`

      // Send prompt and collect output
      step = 'prompt-session'
      this.deps.log.info({ ...jobCtx, sessionId, promptLength: prompt.length }, `git-watcher: sending prompt`)
      const output = await this.deps.promptSession(sessionId, prompt)
      this.deps.log.info({ ...jobCtx, sessionId, outputLength: output.length }, `git-watcher: prompt completed`)

      // Increment turn count for rolling strategy
      step = 'finalize'
      downstream.sessionTurnCount = (downstream.sessionTurnCount ?? 0) + 1
      await watcherStore.save(watcher)

      // Parse the terminal outcome line from agent output
      const outcome = parseOutcome(output)
      if (!outcome) {
        this.deps.log.warn({
          ...jobCtx,
          tail: output.slice(-500),
        }, `git-watcher: no outcome sentinel (ISSUE_CREATED/ISSUE_EXISTS/ISSUE_SKIPPED/ERROR) in agent output — tail`)
      }

      // Agent-reported ERROR → treat as job failure (will retry or mark failed)
      if (outcome?.kind === 'error') {
        throw new Error(`Agent reported ERROR: ${outcome.value}`)
      }

      const issueUrl = outcome?.kind === 'created' || outcome?.kind === 'exists' ? outcome.value : undefined
      const skipReason = outcome?.kind === 'skipped' ? outcome.value : undefined
      const runStatus: 'success' | 'skipped' = outcome?.kind === 'skipped' ? 'skipped' : 'success'

      // Mark job done
      job.status = 'done'
      await queueStore.updateItem(job)

      // Log success/skipped
      await runLog.append({
        jobId: job.id,
        watcherId: this.watcherId,
        downstreamId: this.downstreamId,
        upstream: watcher.upstream.repo,
        downstream: downstream.repo,
        prNumber: job.prNumber,
        prUrl: job.prUrl,
        sessionId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: runStatus,
        issueUrl,
        skipReason,
      })

      this.deps.log.info({ ...jobCtx, outcome: outcome?.kind ?? 'unknown', issueUrl, skipReason }, `git-watcher: job completed`)
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err))
      const error = `[${step}] ${errObj.message}`
      this.deps.log.error({
        ...jobCtx,
        step,
        sessionId,
        error: errObj.message,
        stack: errObj.stack,
      }, `git-watcher: job failed`)

      if (job.attempts >= MAX_ATTEMPTS) {
        job.status = 'failed'
        job.error = error
        await queueStore.updateItem(job)
        await runLog.append({
          jobId: job.id,
          watcherId: this.watcherId,
          downstreamId: this.downstreamId,
          upstream: watcher?.upstream.repo ?? '',
          downstream: downstream?.repo ?? '',
          prNumber: job.prNumber,
          prUrl: job.prUrl,
          sessionId,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'failed',
          error,
        })
      } else {
        // Schedule retry
        job.status = 'pending'
        job.retryAfter = new Date(Date.now() + RETRY_DELAY_MS).toISOString()
        job.error = error
        await queueStore.updateItem(job)

        // Wake up again after the retry delay
        setTimeout(() => this.notify(), RETRY_DELAY_MS)
      }
    }
  }

  private async failJob(job: QueueItem, reason: string): Promise<void> {
    job.status = 'failed'
    job.error = reason
    await this.deps.queueStore.updateItem(job)
  }
}

/** Factory that manages one PairWorker per (watcherId, downstreamId) pair. */
export class PairWorkerPool {
  private workers = new Map<string, PairWorker>()

  constructor(private deps: Omit<PairWorkerDeps, never>) {}

  getOrCreate(watcherId: string, downstreamId: string): PairWorker {
    const key = `${watcherId}:${downstreamId}`
    if (!this.workers.has(key)) {
      this.workers.set(key, new PairWorker(watcherId, downstreamId, this.deps))
    }
    return this.workers.get(key)!
  }

  notify(watcherId: string, downstreamId: string): void {
    this.getOrCreate(watcherId, downstreamId).notify()
  }

  delete(watcherId: string, downstreamId: string): void {
    this.workers.delete(`${watcherId}:${downstreamId}`)
  }
}
