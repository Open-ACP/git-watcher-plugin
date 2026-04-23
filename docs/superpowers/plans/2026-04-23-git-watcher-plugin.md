# git-watcher Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@openacp/git-watcher` — an OpenACP plugin that watches GitHub upstream repos for merged PRs, spawns AI agent sessions to analyze impact on downstream repos, and creates GitHub issues automatically.

**Architecture:** Plugin registers a webhook HTTP endpoint via `api-server` service. On PR merge, webhook enqueues jobs to per-downstream FIFO queues. Workers process jobs sequentially per downstream: sync workspace via `git`, spawn an OpenACP agent session tied to a Telegram topic, fill a prompt template, and let AI use `gh` CLI to analyze and create issues. Tunnel URL changes trigger automatic webhook re-registration.

**Tech Stack:** TypeScript, Vitest, OpenACP plugin-sdk, `micromatch` (glob), `gh` CLI (via AI session), GitHub Webhooks API

**Prerequisite:** Plan 1 (git-watcher core changes) must be merged first.

---

## File Map

```
git-watcher-plugin/
  src/
    index.ts                          plugin entry: setup(), install(), teardown()
    types.ts                          all shared interfaces
    storage/
      watcher-store.ts                CRUD for Watcher[] in ctx.storage
      queue-store.ts                  CRUD for QueueItem queues
      run-log.ts                      circular buffer of RunLogEntry (last 100)
    hooks/
      webhook-receiver.ts             Fastify POST /git-watcher/webhooks/:watcherId
      tunnel-listener.ts              ctx.on('tunnel:*') → re-register webhooks
    workers/
      pair-worker.ts                  FIFO processor per downstream
      session-resolver.ts             per-trigger / rolling / persistent logic
      workspace-sync.ts               git clone / pull / symlink
      concurrency-gate.ts             maxConcurrentSessions semaphore
    prompt/
      system-prompt.ts                locked system prompt constant
      template.ts                     fill user template with variables
    commands/
      add.ts                          /gitwatch add (wizard)
      downstream.ts                   /gitwatch downstream add/remove
      list.ts                         /gitwatch list, show
      edit.ts                         /gitwatch edit
      remove.ts                       /gitwatch remove
      test-cmd.ts                     /gitwatch test
      retry.ts                        /gitwatch retry
      status.ts                       /gitwatch status
      queue-cmd.ts                    /gitwatch queue
      logs.ts                         /gitwatch logs
      export-import.ts                /gitwatch export, import
      doctor.ts                       /gitwatch doctor
      webhook-redeploy.ts             /gitwatch webhook redeploy
    __tests__/
      watcher-store.test.ts
      queue-store.test.ts
      run-log.test.ts
      webhook-receiver.test.ts
      workspace-sync.test.ts
      session-resolver.test.ts
      template.test.ts
      pair-worker.test.ts
```

---

## Task 1: Scaffold Plugin with OpenACP CLI

**Files:**
- Creates entire `git-watcher-plugin/` structure

> **Note:** The existing `git-watcher-plugin/` directory already contains `docs/`. The CLI will generate into it — check if `--output` flag allows writing into an existing non-empty dir, or run it in parent dir and merge.

- [ ] **Step 1.1: Run OpenACP plugin CLI from workspace root**

```bash
cd /Users/lucas/openacp-workspace
openacp plugin create --name @openacp/git-watcher --description "Watch upstream GitHub repos for PR merges and create impact analysis issues in downstream repos" --output ./git-watcher-plugin
```

If it asks for author/license interactively, enter your info and MIT.

Expected output: generated files listed (src/index.ts, package.json, tsconfig.json, CLAUDE.md, etc.)

- [ ] **Step 1.2: Verify generated structure**

```bash
ls git-watcher-plugin/src/
```

Expected: `index.ts  __tests__/index.test.ts`

- [ ] **Step 1.3: Install dependencies**

```bash
cd git-watcher-plugin
npm install
```

Expected: no errors

- [ ] **Step 1.4: Run generated tests — expect PASS**

```bash
npm test
```

Expected: PASS (generated stub test)

- [ ] **Step 1.5: Read generated `src/index.ts`**

Open `src/index.ts` and understand the scaffold structure. The plan's later tasks will build on top of it.

- [ ] **Step 1.6: Commit scaffold**

```bash
cd /Users/lucas/openacp-workspace/git-watcher-plugin
git add .
git commit -m "chore: scaffold @openacp/git-watcher plugin with OpenACP CLI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 2.1: Create `src/types.ts`**

```typescript
// src/types.ts

export interface PluginConfig {
  telegramChatId: string
  maxConcurrentSessions: number
}

export interface Downstream {
  id: string
  repo: string                          // "owner/web-app"
  branch: string                        // "main"
  telegramTopicId: number
  issueLabels: string[]
  promptTemplate: string
  agent: string                         // Claude model name
  sessionStrategy: 'per-trigger' | 'rolling' | 'persistent'
  sessionLimits: {
    maxTurns: number                    // default 10
    maxAge: string                      // default "24h" (ms-parseable)
  }
  currentSessionId?: string
  sessionTurnCount?: number
  sessionCreatedAt?: string
}

export interface Watcher {
  id: string                            // "watcher_abc123"
  upstream: {
    repo: string                        // "owner/backend"
    branch: string
    webhookId: number
    webhookSecret: string               // random 32-char hex
  }
  downstreams: Downstream[]
  createdAt: string
}

export interface QueueItem {
  id: string                            // "job_def456"
  watcherId: string
  downstreamId: string
  prNumber: number
  prUrl: string
  deliveryId: string                    // X-GitHub-Delivery header value
  enqueuedAt: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  retryAfter?: string                   // ISO timestamp
  error?: string
}

export interface RunLogEntry {
  jobId: string
  watcherId: string
  downstreamId: string
  upstream: string
  downstream: string
  prNumber: number
  prUrl: string
  sessionId: string
  startedAt: string
  completedAt?: string
  status: 'success' | 'failed'
  issueUrl?: string
  error?: string
}

export const AUTO_APPROVED_COMMANDS = [
  'gh pr view *',
  'gh pr diff *',
  'gh auth status',
  'git -C */workspaces/* pull *',
  'git -C */workspaces/* fetch *',
  'git -C */workspaces/* checkout *',
  'git -C */workspaces/* log *',
  'git -C */workspaces/* diff *',
  'git -C */workspaces/* status',
  'git -C */workspaces/* reset *',
  'cat */workspaces/*',
  'grep * */workspaces/*',
  'find */workspaces/* *',
  'ls */workspaces/*',
  '*/workspaces/*/*/create_issue.sh *',
] as const

export const DEFAULT_PROMPT_TEMPLATE = `A PR was merged in the upstream repository {upstream_repo}:
- PR URL: {pr_url}
- Branch: {upstream_branch}

Your task:
1. Read the PR details:
   gh pr view {pr_number} --repo {upstream_repo} --json title,body,files,additions,deletions
2. Read the diff:
   gh pr diff {pr_number} --repo {upstream_repo}
3. Check if an issue already exists for this PR:
   gh issue list --repo {downstream_repo} --search "Impact of PR #{pr_number}" --json number,url
4. Explore the downstream codebase in ./downstream/ to identify affected areas
5. Create an issue in {downstream_repo}:
   gh issue create --repo {downstream_repo} \\
     --title "[sync] Impact of PR #{pr_number}: <short summary>" \\
     --body "<your analysis with checklist>" \\
     --label "{issue_labels}"

The issue body must end with:
---
*🤖 Auto-generated by [git-watcher] · [Upstream PR #{pr_number}]({pr_url})*

When done, output on its own line: ISSUE_CREATED: <url>
If issue already existed, output: ISSUE_EXISTS: <url>
Stop after outputting one of these lines.`
```

- [ ] **Step 2.2: Commit**

```bash
git add src/types.ts
git commit -m "feat(git-watcher): add shared types and constants

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Storage Layer

**Files:**
- Create: `src/storage/watcher-store.ts`
- Create: `src/storage/queue-store.ts`
- Create: `src/storage/run-log.ts`
- Create: `src/__tests__/watcher-store.test.ts`
- Create: `src/__tests__/queue-store.test.ts`
- Create: `src/__tests__/run-log.test.ts`

- [ ] **Step 3.1: Write failing tests for watcher-store**

Create `src/__tests__/watcher-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { WatcherStore } from '../storage/watcher-store'
import type { Watcher } from '../types'

function makeStorage() {
  const map = new Map<string, unknown>()
  return {
    get: (k: string) => map.get(k),
    set: (k: string, v: unknown) => { map.set(k, v) },
    delete: (k: string) => { map.delete(k) },
  } as any
}

const watcher: Watcher = {
  id: 'watcher_abc',
  upstream: { repo: 'owner/backend', branch: 'main', webhookId: 1, webhookSecret: 'secret' },
  downstreams: [],
  createdAt: new Date().toISOString(),
}

describe('WatcherStore', () => {
  let store: WatcherStore

  beforeEach(() => { store = new WatcherStore(makeStorage()) })

  it('saves and retrieves a watcher', () => {
    store.save(watcher)
    expect(store.get('watcher_abc')).toEqual(watcher)
  })

  it('lists all watchers', () => {
    store.save(watcher)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).toBe('watcher_abc')
  })

  it('removes a watcher', () => {
    store.save(watcher)
    store.remove('watcher_abc')
    expect(store.get('watcher_abc')).toBeUndefined()
  })
})
```

- [ ] **Step 3.2: Run — expect FAIL**

```bash
npm test src/__tests__/watcher-store.test.ts
```

- [ ] **Step 3.3: Implement `src/storage/watcher-store.ts`**

```typescript
import type { PluginStorage } from '@openacp/plugin-sdk'
import type { Watcher } from '../types'

const STORAGE_KEY = 'watchers'

export class WatcherStore {
  constructor(private storage: PluginStorage) {}

  list(): Watcher[] {
    return (this.storage.get(STORAGE_KEY) as Watcher[] | undefined) ?? []
  }

  get(id: string): Watcher | undefined {
    return this.list().find((w) => w.id === id)
  }

  save(watcher: Watcher): void {
    const existing = this.list().filter((w) => w.id !== watcher.id)
    this.storage.set(STORAGE_KEY, [...existing, watcher])
  }

  remove(id: string): void {
    this.storage.set(STORAGE_KEY, this.list().filter((w) => w.id !== id))
  }

  updateDownstream(watcherId: string, updater: (w: Watcher) => Watcher): void {
    const watcher = this.get(watcherId)
    if (watcher) this.save(updater(watcher))
  }
}
```

- [ ] **Step 3.4: Write failing tests for queue-store**

Create `src/__tests__/queue-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { QueueStore } from '../storage/queue-store'
import type { QueueItem } from '../types'

function makeStorage() {
  const map = new Map<string, unknown>()
  return { get: (k: string) => map.get(k), set: (k: string, v: unknown) => { map.set(k, v) } } as any
}

const item: QueueItem = {
  id: 'job_1', watcherId: 'w1', downstreamId: 'd1',
  prNumber: 42, prUrl: 'https://github.com/o/r/pull/42',
  deliveryId: 'uuid-1', enqueuedAt: new Date().toISOString(),
  status: 'pending', attempts: 0,
}

describe('QueueStore', () => {
  let store: QueueStore
  beforeEach(() => { store = new QueueStore(makeStorage()) })

  it('enqueues and dequeues in FIFO order', () => {
    const item2 = { ...item, id: 'job_2' }
    store.enqueue(item)
    store.enqueue(item2)
    const dequeued = store.dequeueNext('w1', 'd1')
    expect(dequeued?.id).toBe('job_1')
  })

  it('updates item status', () => {
    store.enqueue(item)
    store.updateStatus('w1', 'd1', 'job_1', 'processing')
    const jobs = store.list('w1', 'd1')
    expect(jobs[0].status).toBe('processing')
  })

  it('allKeys returns all queue keys', () => {
    store.enqueue(item)
    expect(store.allKeys()).toContain('queue:w1:d1')
  })
})
```

- [ ] **Step 3.5: Implement `src/storage/queue-store.ts`**

```typescript
import type { PluginStorage } from '@openacp/plugin-sdk'
import type { QueueItem } from '../types'

const INDEX_KEY = 'queue-index'

function queueKey(watcherId: string, downId: string) {
  return `queue:${watcherId}:${downId}`
}

export class QueueStore {
  constructor(private storage: PluginStorage) {}

  allKeys(): string[] {
    return (this.storage.get(INDEX_KEY) as string[] | undefined) ?? []
  }

  list(watcherId: string, downId: string): QueueItem[] {
    return (this.storage.get(queueKey(watcherId, downId)) as QueueItem[] | undefined) ?? []
  }

  enqueue(item: QueueItem): void {
    const key = queueKey(item.watcherId, item.downstreamId)
    const jobs = this.list(item.watcherId, item.downstreamId)
    this.storage.set(key, [...jobs, item])
    // Update index
    const index = this.allKeys()
    if (!index.includes(key)) {
      this.storage.set(INDEX_KEY, [...index, key])
    }
  }

  dequeueNext(watcherId: string, downId: string): QueueItem | undefined {
    const jobs = this.list(watcherId, downId)
    const now = Date.now()
    return jobs.find(
      (j) => j.status === 'pending' && (!j.retryAfter || new Date(j.retryAfter).getTime() <= now),
    )
  }

  updateStatus(
    watcherId: string,
    downId: string,
    jobId: string,
    status: QueueItem['status'],
    extra?: Partial<QueueItem>,
  ): void {
    const key = queueKey(watcherId, downId)
    const jobs = this.list(watcherId, downId).map((j) =>
      j.id === jobId ? { ...j, status, ...extra } : j,
    )
    this.storage.set(key, jobs)
  }

  removeKey(watcherId: string, downId: string): void {
    const key = queueKey(watcherId, downId)
    this.storage.set(key, [])
    this.storage.set(INDEX_KEY, this.allKeys().filter((k) => k !== key))
  }
}
```

- [ ] **Step 3.6: Write and implement run-log**

Create `src/__tests__/run-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RunLog } from '../storage/run-log'

function makeStorage() {
  const map = new Map<string, unknown>()
  return { get: (k: string) => map.get(k), set: (k: string, v: unknown) => { map.set(k, v) } } as any
}

describe('RunLog', () => {
  it('appends entries and limits to 100', () => {
    const log = new RunLog(makeStorage())
    for (let i = 0; i < 110; i++) {
      log.append({ jobId: `job_${i}` } as any)
    }
    expect(log.list().length).toBe(100)
    expect(log.list()[0].jobId).toBe('job_10') // oldest dropped
  })
})
```

Create `src/storage/run-log.ts`:

```typescript
import type { PluginStorage } from '@openacp/plugin-sdk'
import type { RunLogEntry } from '../types'

const KEY = 'run-log'
const MAX = 100

export class RunLog {
  constructor(private storage: PluginStorage) {}

  list(): RunLogEntry[] {
    return (this.storage.get(KEY) as RunLogEntry[] | undefined) ?? []
  }

  append(entry: RunLogEntry): void {
    const entries = [...this.list(), entry]
    this.storage.set(KEY, entries.slice(-MAX))
  }
}
```

- [ ] **Step 3.7: Run all storage tests — expect PASS**

```bash
npm test src/__tests__/watcher-store.test.ts src/__tests__/queue-store.test.ts src/__tests__/run-log.test.ts
```

- [ ] **Step 3.8: Commit**

```bash
git add src/storage/ src/__tests__/watcher-store.test.ts src/__tests__/queue-store.test.ts src/__tests__/run-log.test.ts
git commit -m "feat(git-watcher): implement storage layer (watcher-store, queue-store, run-log)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Prompt Template Engine

**Files:**
- Create: `src/prompt/system-prompt.ts`
- Create: `src/prompt/template.ts`
- Create: `src/__tests__/template.test.ts`

- [ ] **Step 4.1: Write failing test**

Create `src/__tests__/template.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { fillTemplate } from '../prompt/template'

describe('fillTemplate', () => {
  it('replaces all known variables', () => {
    const tmpl = 'PR {pr_number} in {upstream_repo} affects {downstream_repo}. Labels: {issue_labels}'
    const result = fillTemplate(tmpl, {
      upstreamRepo: 'owner/backend',
      downstreamRepo: 'owner/web',
      prNumber: 42,
      prUrl: 'https://github.com/owner/backend/pull/42',
      upstreamBranch: 'main',
      downstreamBranch: 'main',
      issueLabels: 'sync-upstream,auto-generated',
    })
    expect(result).toBe('PR 42 in owner/backend affects owner/web. Labels: sync-upstream,auto-generated')
  })

  it('leaves unknown placeholders unchanged', () => {
    const result = fillTemplate('Hello {unknown}', {
      upstreamRepo: 'o/r', downstreamRepo: 'o/d', prNumber: 1,
      prUrl: '', upstreamBranch: 'main', downstreamBranch: 'main', issueLabels: '',
    })
    expect(result).toBe('Hello {unknown}')
  })
})
```

- [ ] **Step 4.2: Run — expect FAIL**

```bash
npm test src/__tests__/template.test.ts
```

- [ ] **Step 4.3: Implement system prompt and template**

Create `src/prompt/system-prompt.ts`:

```typescript
export const SYSTEM_PROMPT = `You are a git-watcher agent analyzing the impact of upstream repository changes on a downstream codebase.

GitHub operations: Use \`gh\` CLI for all GitHub interactions.
First action: Run \`gh auth status\` — if not authenticated, stop and output:
  ERROR: gh CLI not authenticated. Run \`gh auth login\` on the server.

Workspace layout:
  ./upstream/     — upstream repository (read PR details and diffs here)
  ./downstream/   — downstream repository (analyze impact here)

When your task is complete:
  1. Output the issue URL on its own line in this exact format: ISSUE_CREATED: <url>
  2. If an issue for this PR already exists in downstream, output: ISSUE_EXISTS: <url>
  3. Stop immediately after outputting one of these lines. Do not continue.`
```

Create `src/prompt/template.ts`:

```typescript
export interface TemplateVars {
  upstreamRepo: string
  downstreamRepo: string
  prNumber: number
  prUrl: string
  upstreamBranch: string
  downstreamBranch: string
  issueLabels: string
}

export function fillTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/{upstream_repo}/g, vars.upstreamRepo)
    .replace(/{downstream_repo}/g, vars.downstreamRepo)
    .replace(/{pr_number}/g, String(vars.prNumber))
    .replace(/{pr_url}/g, vars.prUrl)
    .replace(/{upstream_branch}/g, vars.upstreamBranch)
    .replace(/{downstream_branch}/g, vars.downstreamBranch)
    .replace(/{issue_labels}/g, vars.issueLabels)
}

export function parseIssueUrl(agentOutput: string): { url: string; created: boolean } | null {
  const createdMatch = agentOutput.match(/ISSUE_CREATED:\s*(https:\/\/github\.com\/[^\s]+)/)
  if (createdMatch) return { url: createdMatch[1], created: true }

  const existsMatch = agentOutput.match(/ISSUE_EXISTS:\s*(https:\/\/github\.com\/[^\s]+)/)
  if (existsMatch) return { url: existsMatch[1], created: false }

  return null
}
```

- [ ] **Step 4.4: Run tests — expect PASS**

```bash
npm test src/__tests__/template.test.ts
```

- [ ] **Step 4.5: Commit**

```bash
git add src/prompt/ src/__tests__/template.test.ts
git commit -m "feat(git-watcher): add prompt system-prompt and template engine

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Workspace Sync

**Files:**
- Create: `src/workers/workspace-sync.ts`
- Create: `src/__tests__/workspace-sync.test.ts`

- [ ] **Step 5.1: Write failing test**

Create `src/__tests__/workspace-sync.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { WorkspaceSync } from '../workers/workspace-sync'
import * as child_process from 'node:child_process'

vi.mock('node:child_process')

describe('WorkspaceSync', () => {
  it('clones upstream when workspace does not exist', async () => {
    const execMock = vi.spyOn(child_process, 'execSync').mockReturnValue(Buffer.from(''))
    const sync = new WorkspaceSync('/data', 'watcher_abc', 'down_xyz')

    vi.spyOn(sync as any, 'exists').mockReturnValue(false)
    await sync.syncUpstream('owner/backend', 'main')

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('git clone --depth 1'),
      expect.any(Object),
    )
  })

  it('pulls when workspace already exists', async () => {
    const execMock = vi.spyOn(child_process, 'execSync').mockReturnValue(Buffer.from(''))
    const sync = new WorkspaceSync('/data', 'watcher_abc', 'down_xyz')

    vi.spyOn(sync as any, 'exists').mockReturnValue(true)
    await sync.syncUpstream('owner/backend', 'main')

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('git fetch origin'),
      expect.any(Object),
    )
  })
})
```

- [ ] **Step 5.2: Run — expect FAIL**

```bash
npm test src/__tests__/workspace-sync.test.ts
```

- [ ] **Step 5.3: Implement `src/workers/workspace-sync.ts`**

```typescript
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

export class WorkspaceSync {
  private watcherDir: string
  private downstreamDir: string

  constructor(
    private dataDir: string,
    private watcherId: string,
    private downstreamId: string,
  ) {
    this.watcherDir = join(dataDir, 'workspaces', watcherId)
    this.downstreamDir = join(this.watcherDir, downstreamId)
  }

  private exists(path: string): boolean {
    return existsSync(join(path, '.git'))
  }

  private exec(cmd: string, cwd?: string): void {
    execSync(cmd, { cwd, stdio: 'pipe' })
  }

  async syncUpstream(repo: string, branch: string): Promise<void> {
    const upstreamPath = join(this.watcherDir, 'upstream')
    mkdirSync(this.watcherDir, { recursive: true })

    if (!this.exists(upstreamPath)) {
      this.exec(
        `git clone --depth 1 --single-branch --branch ${branch} https://github.com/${repo}.git upstream`,
        this.watcherDir,
      )
    } else {
      this.exec(`git fetch origin --depth 1 ${branch}`, upstreamPath)
      this.exec(`git reset --hard origin/${branch}`, upstreamPath)
    }
  }

  async syncDownstream(repo: string, branch: string): Promise<void> {
    const downPath = join(this.downstreamDir, 'downstream')
    mkdirSync(this.downstreamDir, { recursive: true })

    if (!this.exists(downPath)) {
      this.exec(
        `git clone --depth 1 --single-branch --branch ${branch} https://github.com/${repo}.git downstream`,
        this.downstreamDir,
      )
      // Symlink upstream into the session working directory
      const symlinkPath = join(this.downstreamDir, 'upstream')
      if (!existsSync(symlinkPath)) {
        symlinkSync(join('..', 'upstream'), symlinkPath)
      }
    } else {
      this.exec(`git fetch origin --depth 1 ${branch}`, downPath)
      this.exec(`git reset --hard origin/${branch}`, downPath)
    }
  }

  /** Returns the session working directory path (contains upstream/ symlink + downstream/ clone) */
  sessionWorkDir(): string {
    return this.downstreamDir
  }
}
```

- [ ] **Step 5.4: Run tests — expect PASS**

```bash
npm test src/__tests__/workspace-sync.test.ts
```

- [ ] **Step 5.5: Commit**

```bash
git add src/workers/workspace-sync.ts src/__tests__/workspace-sync.test.ts
git commit -m "feat(git-watcher): implement workspace sync (clone/pull upstream+downstream)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Session Resolver

**Files:**
- Create: `src/workers/session-resolver.ts`
- Create: `src/workers/concurrency-gate.ts`
- Create: `src/__tests__/session-resolver.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `src/__tests__/session-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionResolver } from '../workers/session-resolver'
import type { Downstream } from '../types'

function makeDownstream(override: Partial<Downstream> = {}): Downstream {
  return {
    id: 'down_xyz', repo: 'owner/web', branch: 'main',
    telegramTopicId: 100, issueLabels: ['sync'], promptTemplate: '',
    agent: 'claude', sessionStrategy: 'per-trigger',
    sessionLimits: { maxTurns: 10, maxAge: '24h' },
    ...override,
  }
}

describe('SessionResolver', () => {
  it('per-trigger: always returns null (create new)', () => {
    const resolver = new SessionResolver({} as any, {} as any)
    const result = resolver.resolveSessionId(makeDownstream({ sessionStrategy: 'per-trigger' }))
    expect(result).toBeNull()
  })

  it('rolling: returns currentSessionId when under maxTurns', () => {
    const resolver = new SessionResolver({} as any, {} as any)
    const downstream = makeDownstream({
      sessionStrategy: 'rolling',
      currentSessionId: 'sess-old',
      sessionTurnCount: 5,
      sessionCreatedAt: new Date().toISOString(),
    })
    expect(resolver.resolveSessionId(downstream)).toBe('sess-old')
  })

  it('rolling: returns null (rollover) when maxTurns reached', () => {
    const resolver = new SessionResolver({} as any, {} as any)
    const downstream = makeDownstream({
      sessionStrategy: 'rolling',
      currentSessionId: 'sess-old',
      sessionTurnCount: 10,
      sessionCreatedAt: new Date().toISOString(),
    })
    expect(resolver.resolveSessionId(downstream)).toBeNull()
  })

  it('persistent: returns currentSessionId', () => {
    const resolver = new SessionResolver({} as any, {} as any)
    const downstream = makeDownstream({
      sessionStrategy: 'persistent',
      currentSessionId: 'sess-persistent',
    })
    expect(resolver.resolveSessionId(downstream)).toBe('sess-persistent')
  })
})
```

- [ ] **Step 6.2: Run — expect FAIL**

```bash
npm test src/__tests__/session-resolver.test.ts
```

- [ ] **Step 6.3: Implement `src/workers/concurrency-gate.ts`**

```typescript
// Simple semaphore to cap concurrent AI sessions across all pair workers
export class ConcurrencyGate {
  private active = 0

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    while (this.active >= this.max) {
      await new Promise((r) => setTimeout(r, 2000))
    }
    this.active++
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }
}
```

- [ ] **Step 6.4: Implement `src/workers/session-resolver.ts`**

```typescript
import { parse as parseMs } from 'ms'
import type { Downstream } from '../types'

export class SessionResolver {
  constructor(
    private sessionManager: any,   // core.sessionManager
    private watcherStore: any,     // WatcherStore
  ) {}

  /**
   * Returns existing sessionId to reuse, or null if a new session should be created.
   * For rolling mode: also returns null when the session has exceeded limits.
   */
  resolveSessionId(downstream: Downstream): string | null {
    const { sessionStrategy, currentSessionId, sessionTurnCount, sessionCreatedAt, sessionLimits } =
      downstream

    switch (sessionStrategy) {
      case 'per-trigger':
        return null

      case 'persistent':
        return currentSessionId ?? null

      case 'rolling': {
        if (!currentSessionId) return null

        const turnLimit = sessionLimits.maxTurns
        const ageMs = parseMs(sessionLimits.maxAge)
        const createdAt = sessionCreatedAt ? new Date(sessionCreatedAt).getTime() : 0
        const ageExceeded = Date.now() - createdAt > ageMs
        const turnsExceeded = (sessionTurnCount ?? 0) >= turnLimit

        if (ageExceeded || turnsExceeded) return null
        return currentSessionId
      }
    }
  }
}
```

- [ ] **Step 6.5: Run tests — expect PASS**

```bash
npm test src/__tests__/session-resolver.test.ts
```

- [ ] **Step 6.6: Commit**

```bash
git add src/workers/session-resolver.ts src/workers/concurrency-gate.ts src/__tests__/session-resolver.test.ts
git commit -m "feat(git-watcher): session resolver (per-trigger, rolling, persistent) + concurrency gate

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Webhook Receiver

**Files:**
- Create: `src/hooks/webhook-receiver.ts`
- Create: `src/__tests__/webhook-receiver.test.ts`

- [ ] **Step 7.1: Write failing test**

Create `src/__tests__/webhook-receiver.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { verifySignature, parseWebhookPayload } from '../hooks/webhook-receiver'
import { createHmac } from 'node:crypto'

describe('webhook signature verification', () => {
  it('accepts valid HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ action: 'closed', pull_request: { merged: true } })
    const secret = 'mysecret'
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    expect(verifySignature(body, sig, secret)).toBe(true)
  })

  it('rejects invalid signature', () => {
    expect(verifySignature('body', 'sha256=bad', 'secret')).toBe(false)
  })
})

describe('parseWebhookPayload', () => {
  it('extracts PR info from a merged PR closed event', () => {
    const payload = {
      action: 'closed',
      pull_request: {
        merged: true,
        number: 42,
        html_url: 'https://github.com/o/r/pull/42',
        head: { ref: 'feature-branch' },
      },
    }
    const result = parseWebhookPayload(payload)
    expect(result).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      branch: 'feature-branch',
    })
  })

  it('returns null for non-merged events', () => {
    const payload = { action: 'opened', pull_request: { merged: false, number: 1, html_url: '', head: { ref: 'x' } } }
    expect(parseWebhookPayload(payload)).toBeNull()
  })
})
```

- [ ] **Step 7.2: Run — expect FAIL**

```bash
npm test src/__tests__/webhook-receiver.test.ts
```

- [ ] **Step 7.3: Implement `src/hooks/webhook-receiver.ts`**

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueueStore } from '../storage/queue-store'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueItem } from '../types'

export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

export function parseWebhookPayload(
  payload: Record<string, any>,
): { prNumber: number; prUrl: string; branch: string } | null {
  if (payload.action !== 'closed') return null
  const pr = payload.pull_request
  if (!pr?.merged) return null
  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    branch: pr.head.ref,
  }
}

export function createWebhookRoutes(
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  deliveryIds: { has(id: string): boolean; add(id: string): void },
  onEnqueued: (watcherId: string, downId: string) => void,
) {
  return async (app: FastifyInstance) => {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_, body, done) => {
      done(null, body)
    })

    app.post<{ Params: { watcherId: string } }>(
      '/webhooks/:watcherId',
      async (req, reply) => {
        const rawBody = req.body as string
        const watcherId = req.params.watcherId
        const deliveryId = req.headers['x-github-delivery'] as string
        const signature = req.headers['x-hub-signature-256'] as string

        const watcher = watcherStore.get(watcherId)
        if (!watcher) return reply.status(404).send({ error: 'Unknown watcher' })

        if (!verifySignature(rawBody, signature, watcher.upstream.webhookSecret)) {
          return reply.status(401).send({ error: 'Invalid signature' })
        }

        if (deliveryId && deliveryIds.has(deliveryId)) {
          return reply.status(200).send({ status: 'duplicate' })
        }

        const payload = JSON.parse(rawBody)
        const pr = parseWebhookPayload(payload)
        if (!pr) return reply.status(200).send({ status: 'ignored' })

        if (pr.branch !== watcher.upstream.branch) {
          return reply.status(200).send({ status: 'branch-mismatch' })
        }

        if (deliveryId) deliveryIds.add(deliveryId)

        for (const downstream of watcher.downstreams) {
          const item: QueueItem = {
            id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            watcherId,
            downstreamId: downstream.id,
            prNumber: pr.prNumber,
            prUrl: pr.prUrl,
            deliveryId: deliveryId ?? '',
            enqueuedAt: new Date().toISOString(),
            status: 'pending',
            attempts: 0,
          }
          queueStore.enqueue(item)
          onEnqueued(watcherId, downstream.id)
        }

        return reply.status(200).send({ status: 'queued', count: watcher.downstreams.length })
      },
    )
  }
}
```

- [ ] **Step 7.4: Run tests — expect PASS**

```bash
npm test src/__tests__/webhook-receiver.test.ts
```

- [ ] **Step 7.5: Commit**

```bash
git add src/hooks/webhook-receiver.ts src/__tests__/webhook-receiver.test.ts
git commit -m "feat(git-watcher): webhook receiver with HMAC verification and queue dispatch

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Pair Worker (Main Pipeline)

**Files:**
- Create: `src/workers/pair-worker.ts`
- Create: `src/__tests__/pair-worker.test.ts`

- [ ] **Step 8.1: Write failing test**

Create `src/__tests__/pair-worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PairWorker } from '../workers/pair-worker'

describe('PairWorker.extractIssueUrl', () => {
  it('extracts URL from ISSUE_CREATED line', () => {
    const output = 'Some analysis...\nISSUE_CREATED: https://github.com/owner/web/issues/5\nDone.'
    expect(PairWorker.extractIssueUrl(output)).toEqual({
      url: 'https://github.com/owner/web/issues/5',
      created: true,
    })
  })

  it('extracts URL from ISSUE_EXISTS line', () => {
    const output = 'ISSUE_EXISTS: https://github.com/owner/web/issues/3'
    expect(PairWorker.extractIssueUrl(output)).toEqual({
      url: 'https://github.com/owner/web/issues/3',
      created: false,
    })
  })

  it('returns null when no issue URL found', () => {
    expect(PairWorker.extractIssueUrl('just some text')).toBeNull()
  })
})
```

- [ ] **Step 8.2: Run — expect FAIL**

```bash
npm test src/__tests__/pair-worker.test.ts
```

- [ ] **Step 8.3: Implement `src/workers/pair-worker.ts`**

```typescript
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import type { RunLog } from '../storage/run-log'
import type { ConcurrencyGate } from './concurrency-gate'
import type { SessionResolver } from './session-resolver'
import { WorkspaceSync } from './workspace-sync'
import { fillTemplate, parseIssueUrl } from '../prompt/template'
import { SYSTEM_PROMPT } from '../prompt/system-prompt'
import { AUTO_APPROVED_COMMANDS } from '../types'
import type { Downstream, Watcher, QueueItem } from '../types'

const SESSION_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export class PairWorker {
  private running = false

  constructor(
    private ctx: PluginContext,
    private watcher: Watcher,
    private downstream: Downstream,
    private watcherStore: WatcherStore,
    private queueStore: QueueStore,
    private runLog: RunLog,
    private resolver: SessionResolver,
    private gate: ConcurrencyGate,
    private dataDir: string,
    private telegramChatId: string,
  ) {}

  static extractIssueUrl(output: string): { url: string; created: boolean } | null {
    return parseIssueUrl(output)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop()
  }

  stop(): void {
    this.running = false
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const job = this.queueStore.dequeueNext(this.watcher.id, this.downstream.id)
      if (!job) {
        await new Promise((r) => setTimeout(r, 5000))
        continue
      }
      await this.processJob(job)
    }
  }

  private async processJob(job: QueueItem): Promise<void> {
    this.queueStore.updateStatus(this.watcher.id, this.downstream.id, job.id, 'processing')
    const startedAt = new Date().toISOString()

    try {
      await this.gate.acquire()
      const result = await this.runAnalysis(job)
      this.gate.release()

      this.queueStore.updateStatus(this.watcher.id, this.downstream.id, job.id, 'done')
      this.runLog.append({
        jobId: job.id, watcherId: this.watcher.id, downstreamId: this.downstream.id,
        upstream: this.watcher.upstream.repo, downstream: this.downstream.repo,
        prNumber: job.prNumber, prUrl: job.prUrl, sessionId: result.sessionId,
        startedAt, completedAt: new Date().toISOString(), status: 'success',
        issueUrl: result.issueUrl,
      })
      this.ctx.emit('gitwatch:analysis:completed', { ...job, issueUrl: result.issueUrl })
    } catch (err: any) {
      this.gate.release()
      const attempts = job.attempts + 1

      if (attempts < 2) {
        const retryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString()
        this.queueStore.updateStatus(this.watcher.id, this.downstream.id, job.id, 'pending', {
          attempts, retryAfter,
        })
      } else {
        this.queueStore.updateStatus(this.watcher.id, this.downstream.id, job.id, 'failed', {
          attempts, error: err.message,
        })
        this.runLog.append({
          jobId: job.id, watcherId: this.watcher.id, downstreamId: this.downstream.id,
          upstream: this.watcher.upstream.repo, downstream: this.downstream.repo,
          prNumber: job.prNumber, prUrl: job.prUrl, sessionId: '',
          startedAt, completedAt: new Date().toISOString(), status: 'failed', error: err.message,
        })
        this.ctx.emit('gitwatch:analysis:failed', { ...job, error: err.message })
      }
    }
  }

  private async runAnalysis(job: QueueItem): Promise<{ sessionId: string; issueUrl?: string }> {
    // 1. Sync workspace
    const sync = new WorkspaceSync(this.dataDir, this.watcher.id, this.downstream.id)
    await sync.syncUpstream(this.watcher.upstream.repo, this.watcher.upstream.branch)
    await sync.syncDownstream(this.downstream.repo, this.downstream.branch)

    // 2. Resolve session
    const core = (this.ctx as any).core
    let sessionId = this.resolver.resolveSessionId(this.downstream)
    let session: any

    if (sessionId) {
      session = core.sessionManager.getSession(sessionId)
    }

    if (!session) {
      // Cancel stale rolling session if needed
      if (sessionId && this.downstream.sessionStrategy === 'rolling') {
        await core.sessionManager.cancelSession(sessionId).catch(() => {})
      }
      session = await core.sessionManager.createSession(
        `${this.telegramChatId}/${this.downstream.telegramTopicId}`,
        this.downstream.agent,
        sync.sessionWorkDir(),
        core.agentManager,
        { autoApprovedCommands: [...AUTO_APPROVED_COMMANDS] },
      )
      sessionId = session.id
      this.watcherStore.updateDownstream(this.watcher.id, (w) => ({
        ...w,
        downstreams: w.downstreams.map((d) =>
          d.id === this.downstream.id
            ? { ...d, currentSessionId: sessionId, sessionTurnCount: 0, sessionCreatedAt: new Date().toISOString() }
            : d,
        ),
      }))
    }

    // 3. Fill and enqueue prompt
    const prompt = `${SYSTEM_PROMPT}\n\n${fillTemplate(this.downstream.promptTemplate, {
      upstreamRepo: this.watcher.upstream.repo,
      downstreamRepo: this.downstream.repo,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      upstreamBranch: this.watcher.upstream.branch,
      downstreamBranch: this.downstream.branch,
      issueLabels: this.downstream.issueLabels.join(','),
    })}`

    // 4. Collect agent output
    let fullText = ''
    let done = false
    session.on('agent_event', (ev: any) => {
      if (ev.type === 'text') fullText += ev.content
      if (ev.type === 'end_turn') done = true
    })

    await session.enqueuePrompt(prompt)

    const deadline = Date.now() + SESSION_TIMEOUT_MS
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!done) throw new Error('Session timed out after 10 minutes')

    // 5. Cleanup per-trigger sessions
    if (this.downstream.sessionStrategy === 'per-trigger') {
      await core.sessionManager.cancelSession(session.id).catch(() => {})
    } else {
      // Update turn count for rolling mode
      this.watcherStore.updateDownstream(this.watcher.id, (w) => ({
        ...w,
        downstreams: w.downstreams.map((d) =>
          d.id === this.downstream.id
            ? { ...d, sessionTurnCount: (d.sessionTurnCount ?? 0) + 1 }
            : d,
        ),
      }))
    }

    const issueResult = PairWorker.extractIssueUrl(fullText)
    return { sessionId: session.id, issueUrl: issueResult?.url }
  }
}
```

- [ ] **Step 8.4: Run tests — expect PASS**

```bash
npm test src/__tests__/pair-worker.test.ts
```

- [ ] **Step 8.5: Commit**

```bash
git add src/workers/pair-worker.ts src/__tests__/pair-worker.test.ts
git commit -m "feat(git-watcher): implement pair worker — full PR analysis pipeline

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Tunnel Listener & Boot Recovery

**Files:**
- Create: `src/hooks/tunnel-listener.ts`

- [ ] **Step 9.1: Implement `src/hooks/tunnel-listener.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'

export function registerTunnelListener(
  ctx: PluginContext,
  watcherStore: WatcherStore,
  getWebhookBaseUrl: () => string,
) {
  const reregisterAll = async (newUrl: string) => {
    const watchers = watcherStore.list()
    for (const watcher of watchers) {
      const webhookUrl = `${newUrl}/git-watcher/webhooks/${watcher.id}`
      try {
        execSync(
          `gh api PATCH /repos/${watcher.upstream.repo}/hooks/${watcher.upstream.webhookId} ` +
          `-f config[url]="${webhookUrl}" -f config[secret]="${watcher.upstream.webhookSecret}"`,
          { stdio: 'pipe' },
        )
      } catch (err: any) {
        ctx.log.error({ err, watcher: watcher.id }, 'Failed to re-register webhook')
      }
    }
    ctx.emit('gitwatch:webhook:reregistered', { count: watchers.length, url: newUrl })
    ctx.log.info(`git-watcher: re-registered ${watchers.length} webhook(s) to ${newUrl}`)
  }

  ctx.on('tunnel:started', async (data: any) => {
    await reregisterAll(data.url)
  })

  ctx.on('tunnel:urlChanged', async (data: any) => {
    await reregisterAll(data.url)
  })

  ctx.on('tunnel:stopped', () => {
    ctx.log.warn('git-watcher: tunnel stopped — webhooks will not fire until tunnel restarts')
  })
}

export async function bootRecovery(
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: any,
  storage: any,
) {
  // 1. Reset processing → pending
  const index = queueStore.allKeys() as string[]
  for (const key of index) {
    const [, watcherId, downId] = key.split(':')
    const jobs = queueStore.list(watcherId, downId)
    let changed = false
    const updated = jobs.map((j: any) => {
      if (j.status === 'processing') { changed = true; return { ...j, status: 'pending' } }
      return j
    })
    if (changed) storage.set(key, updated)
  }

  // 2. Catch up missed PRs
  const watchers = watcherStore.list()
  for (const watcher of watchers) {
    const lastTimeKey = `last-delivery-time:${watcher.id}`
    const lastTime = (storage.get(lastTimeKey) as string | undefined) ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    try {
      const output = execSync(
        `gh pr list --repo ${watcher.upstream.repo} --state merged --base ${watcher.upstream.branch} --json number,mergedAt,url --limit 50`,
        { stdio: 'pipe' },
      ).toString()
      const prs: { number: number; mergedAt: string; url: string }[] = JSON.parse(output)
      const missed = prs.filter((pr) => pr.mergedAt > lastTime)

      for (const pr of missed) {
        const deliveryIds: string[] = (storage.get('delivery-ids') as string[] | undefined) ?? []
        const fakeDeliveryId = `catchup-${watcher.id}-${pr.number}`
        if (deliveryIds.includes(fakeDeliveryId)) continue

        for (const downstream of watcher.downstreams) {
          queueStore.enqueue({
            id: `job_catchup_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
            watcherId: watcher.id, downstreamId: downstream.id,
            prNumber: pr.number, prUrl: pr.url,
            deliveryId: fakeDeliveryId,
            enqueuedAt: new Date().toISOString(),
            status: 'pending', attempts: 0,
          })
        }
        storage.set('delivery-ids', [...deliveryIds, fakeDeliveryId].slice(-50))
      }
      storage.set(lastTimeKey, new Date().toISOString())
    } catch (err: any) {
      ctx.log.warn({ err, watcher: watcher.id }, 'Boot catch-up failed for watcher')
    }
  }
}
```

- [ ] **Step 9.2: Commit**

```bash
git add src/hooks/tunnel-listener.ts
git commit -m "feat(git-watcher): tunnel listener (webhook re-registration) and boot catch-up

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 10: Core Commands (add, downstream, list, show, edit, remove)

**Files:**
- Create: `src/commands/add.ts`
- Create: `src/commands/downstream.ts`
- Create: `src/commands/list.ts`
- Create: `src/commands/edit.ts`
- Create: `src/commands/remove.ts`

> **Note:** Commands use `ctx.terminal` for interactive prompts. Each command handler receives `(args: string[], ctx: PluginContext)`. Check `workspace-plugin/src/commands/` for the exact handler signature and `CommandResponse` return type used in this codebase, and follow that pattern exactly.

- [ ] **Step 10.1: Implement `src/commands/add.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import { DEFAULT_PROMPT_TEMPLATE } from '../types'
import type { Watcher, Downstream } from '../types'
import { randomBytes } from 'node:crypto'

function generateId(prefix: string) {
  return `${prefix}_${randomBytes(3).toString('hex')}`
}

export async function handleAdd(
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  tunnelService: any,
  pluginConfig: { telegramChatId: string },
) {
  const upstreamRepo = await ctx.terminal.input('Upstream repo (owner/repo):')
  const branch = await ctx.terminal.input('Upstream branch [main]:') || 'main'
  const downstreamRepo = await ctx.terminal.input('Downstream repo (owner/repo):')
  const downBranch = await ctx.terminal.input('Downstream branch [main]:') || 'main'
  const strategyChoice = await ctx.terminal.select('Session strategy:', [
    { label: 'rolling (default)', value: 'rolling' },
    { label: 'per-trigger', value: 'per-trigger' },
    { label: 'persistent', value: 'persistent' },
  ])
  const agentInput = await ctx.terminal.input('Agent name [leave blank for default]:')
  const labelsInput = await ctx.terminal.input('Issue labels [sync-upstream,auto-generated]:') || 'sync-upstream,auto-generated'
  const useDefaultTemplate = await ctx.terminal.confirm('Use default prompt template?')
  const promptTemplate = useDefaultTemplate
    ? DEFAULT_PROMPT_TEMPLATE
    : await ctx.terminal.input('Enter custom prompt template:')

  const watcherId = generateId('watcher')
  const downstreamId = generateId('down')
  const webhookSecret = randomBytes(16).toString('hex')

  // Register webhook on GitHub
  const tunnelUrl = tunnelService.getPublicUrl()
  if (!tunnelUrl) {
    return { type: 'error', message: 'Tunnel is not running. Start the tunnel first.' }
  }
  const webhookUrl = `${tunnelUrl}/git-watcher/webhooks/${watcherId}`

  let webhookId: number
  try {
    const output = execSync(
      `gh api POST /repos/${upstreamRepo}/hooks ` +
      `-f events[]="pull_request" ` +
      `-f config[url]="${webhookUrl}" ` +
      `-f config[secret]="${webhookSecret}" ` +
      `-f config[content_type]="json" ` +
      `--jq ".id"`,
      { stdio: 'pipe' },
    ).toString().trim()
    webhookId = parseInt(output, 10)
  } catch (err: any) {
    return { type: 'error', message: `Failed to register webhook: ${err.message}` }
  }

  // Create Telegram topic
  let telegramTopicId = 0
  try {
    const topicName = `${upstreamRepo.split('/')[1]} → ${downstreamRepo.split('/')[1]}`
    const output = execSync(
      `curl -s -X POST "https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createForumTopic" ` +
      `-d "chat_id=${pluginConfig.telegramChatId}&name=${encodeURIComponent(topicName)}"`,
      { stdio: 'pipe' },
    ).toString()
    const parsed = JSON.parse(output)
    telegramTopicId = parsed.result?.message_thread_id ?? 0
  } catch {
    ctx.log.warn('Failed to create Telegram topic — using General topic (id=0)')
  }

  const downstream: Downstream = {
    id: downstreamId,
    repo: downstreamRepo,
    branch: downBranch,
    telegramTopicId,
    issueLabels: labelsInput.split(',').map((l: string) => l.trim()),
    promptTemplate,
    agent: agentInput || '',
    sessionStrategy: strategyChoice as Downstream['sessionStrategy'],
    sessionLimits: { maxTurns: 10, maxAge: '24h' },
  }

  const watcher: Watcher = {
    id: watcherId,
    upstream: { repo: upstreamRepo, branch, webhookId, webhookSecret },
    downstreams: [downstream],
    createdAt: new Date().toISOString(),
  }

  watcherStore.save(watcher)

  return {
    type: 'text',
    message: `✅ Watcher created!\n- ID: \`${watcherId}\`\n- Upstream: ${upstreamRepo}:${branch}\n- Downstream: ${downstreamRepo}\n- Webhook: ${webhookUrl}\n- Telegram topic: ${telegramTopicId}`,
  }
}
```

- [ ] **Step 10.2: Implement `src/commands/downstream.ts`** (add/remove downstream to existing watcher)

Follow the same pattern as `add.ts` but look up existing watcher by ID:
- `downstream add <watcherId>`: prompt for downstream fields, skip upstream fields, add to existing watcher, create Telegram topic
- `downstream remove <watcherId> <downstreamId>`: cancel session, remove from watcher.downstreams, remove queue key, delete workspace

```typescript
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import { DEFAULT_PROMPT_TEMPLATE, type Downstream } from '../types'
import { randomBytes } from 'node:crypto'

function generateId(prefix: string) {
  return `${prefix}_${randomBytes(3).toString('hex')}`
}

export async function handleDownstreamAdd(
  args: string[],
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  pluginConfig: { telegramChatId: string },
  dataDir: string,
) {
  const watcherId = args[0]
  if (!watcherId) return { type: 'error', message: 'Usage: /gitwatch downstream add <watcherId>' }

  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  const repo = await ctx.terminal.input('Downstream repo (owner/repo):')
  const branch = await ctx.terminal.input('Downstream branch [main]:') || 'main'
  const strategyChoice = await ctx.terminal.select('Session strategy:', [
    { label: 'rolling', value: 'rolling' },
    { label: 'per-trigger', value: 'per-trigger' },
    { label: 'persistent', value: 'persistent' },
  ])
  const labelsInput = await ctx.terminal.input('Issue labels [sync-upstream,auto-generated]:') || 'sync-upstream,auto-generated'
  const useDefault = await ctx.terminal.confirm('Use default prompt template?')
  const promptTemplate = useDefault ? DEFAULT_PROMPT_TEMPLATE : await ctx.terminal.input('Template:')

  let telegramTopicId = 0
  try {
    const topicName = `${watcher.upstream.repo.split('/')[1]} → ${repo.split('/')[1]}`
    const out = execSync(
      `curl -s -X POST "https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createForumTopic" ` +
      `-d "chat_id=${pluginConfig.telegramChatId}&name=${encodeURIComponent(topicName)}"`,
    ).toString()
    telegramTopicId = JSON.parse(out).result?.message_thread_id ?? 0
  } catch { /* use 0 */ }

  const downstream: Downstream = {
    id: generateId('down'), repo, branch, telegramTopicId,
    issueLabels: labelsInput.split(',').map((l: string) => l.trim()),
    promptTemplate, agent: '', sessionStrategy: strategyChoice as any,
    sessionLimits: { maxTurns: 10, maxAge: '24h' },
  }

  watcherStore.updateDownstream(watcherId, (w) => ({
    ...w, downstreams: [...w.downstreams, downstream],
  }))

  return { type: 'text', message: `✅ Downstream ${downstream.id} added to watcher ${watcherId}` }
}

export async function handleDownstreamRemove(
  args: string[],
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  dataDir: string,
) {
  const [watcherId, downId] = args
  if (!watcherId || !downId) return { type: 'error', message: 'Usage: /gitwatch downstream remove <watcherId> <downstreamId>' }

  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  queueStore.removeKey(watcherId, downId)

  try {
    rmSync(join(dataDir, 'workspaces', watcherId, downId), { recursive: true, force: true })
  } catch { /* ignore */ }

  watcherStore.updateDownstream(watcherId, (w) => ({
    ...w, downstreams: w.downstreams.filter((d) => d.id !== downId),
  }))

  return { type: 'text', message: `✅ Downstream ${downId} removed from watcher ${watcherId}` }
}
```

- [ ] **Step 10.3: Implement `src/commands/list.ts`**

```typescript
import type { WatcherStore } from '../storage/watcher-store'

export function handleList(watcherStore: WatcherStore) {
  const watchers = watcherStore.list()
  if (watchers.length === 0) return { type: 'text', message: 'No watchers configured. Use `/gitwatch add` to create one.' }

  const lines = watchers.map((w) => {
    const downs = w.downstreams.map((d) => `  → ${d.repo} (${d.sessionStrategy})`).join('\n')
    return `**${w.id}** · ${w.upstream.repo}:${w.upstream.branch}\n${downs}`
  })
  return { type: 'text', message: lines.join('\n\n') }
}

export function handleShow(args: string[], watcherStore: WatcherStore) {
  const watcherId = args[0]
  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  const downs = watcher.downstreams.map((d) =>
    `  **${d.id}** → ${d.repo}:${d.branch} | ${d.sessionStrategy} | labels: ${d.issueLabels.join(',')} | topic: ${d.telegramTopicId}`,
  ).join('\n')

  return {
    type: 'text',
    message: `**${watcher.id}**\nUpstream: ${watcher.upstream.repo}:${watcher.upstream.branch}\nWebhook ID: ${watcher.upstream.webhookId}\nCreated: ${watcher.createdAt}\n\nDownstreams:\n${downs}`,
  }
}
```

- [ ] **Step 10.4: Implement `src/commands/edit.ts`**

```typescript
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'

export async function handleEdit(args: string[], ctx: PluginContext, watcherStore: WatcherStore) {
  const [watcherId, downId, field] = args
  if (!watcherId) return { type: 'error', message: 'Usage: /gitwatch edit <watcherId> [downstreamId] [field]' }

  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  if (!downId) {
    // Edit watcher-level: only branch currently
    const newBranch = await ctx.terminal.input(`New upstream branch [${watcher.upstream.branch}]:`) || watcher.upstream.branch
    watcherStore.save({ ...watcher, upstream: { ...watcher.upstream, branch: newBranch } })
    return { type: 'text', message: `Updated upstream branch to ${newBranch}` }
  }

  const downstream = watcher.downstreams.find((d) => d.id === downId)
  if (!downstream) return { type: 'error', message: `Downstream ${downId} not found` }

  const editField = field ?? await ctx.terminal.select('Which field?', [
    { label: 'branch', value: 'branch' },
    { label: 'strategy', value: 'strategy' },
    { label: 'agent', value: 'agent' },
    { label: 'labels', value: 'labels' },
    { label: 'template', value: 'template' },
  ])

  let updated = { ...downstream }
  switch (editField) {
    case 'branch':
      updated.branch = await ctx.terminal.input(`New downstream branch [${downstream.branch}]:`) || downstream.branch
      break
    case 'strategy':
      updated.sessionStrategy = await ctx.terminal.select('Strategy:', [
        { label: 'rolling', value: 'rolling' },
        { label: 'per-trigger', value: 'per-trigger' },
        { label: 'persistent', value: 'persistent' },
      ]) as any
      break
    case 'agent':
      updated.agent = await ctx.terminal.input(`Agent name [${downstream.agent || 'default'}]:`)
      break
    case 'labels':
      const labelsInput = await ctx.terminal.input(`Labels (comma-separated) [${downstream.issueLabels.join(',')}]:`)
      updated.issueLabels = labelsInput ? labelsInput.split(',').map((l: string) => l.trim()) : downstream.issueLabels
      break
    case 'template':
      updated.promptTemplate = await ctx.terminal.input('New template (paste full template):')
      break
  }

  watcherStore.updateDownstream(watcherId, (w) => ({
    ...w, downstreams: w.downstreams.map((d) => d.id === downId ? updated : d),
  }))

  return { type: 'text', message: `✅ Updated ${editField} for downstream ${downId}` }
}
```

- [ ] **Step 10.5: Implement `src/commands/remove.ts`**

```typescript
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'

export async function handleRemove(
  args: string[],
  ctx: PluginContext,
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  dataDir: string,
) {
  const watcherId = args[0]
  if (!watcherId) return { type: 'error', message: 'Usage: /gitwatch remove <watcherId>' }

  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  const confirmed = await ctx.terminal.confirm(`Remove watcher ${watcherId} (${watcher.upstream.repo}) and all its downstreams?`)
  if (!confirmed) return { type: 'text', message: 'Cancelled' }

  // Delete GitHub webhook
  try {
    execSync(`gh api DELETE /repos/${watcher.upstream.repo}/hooks/${watcher.upstream.webhookId}`, { stdio: 'pipe' })
  } catch { ctx.log.warn(`Failed to delete webhook ${watcher.upstream.webhookId}`) }

  // Remove queues and workspaces
  for (const downstream of watcher.downstreams) {
    queueStore.removeKey(watcherId, downstream.id)
  }
  try {
    rmSync(join(dataDir, 'workspaces', watcherId), { recursive: true, force: true })
  } catch { /* ignore */ }

  watcherStore.remove(watcherId)
  return { type: 'text', message: `✅ Watcher ${watcherId} removed` }
}
```

- [ ] **Step 10.6: Commit all core commands**

```bash
git add src/commands/add.ts src/commands/downstream.ts src/commands/list.ts src/commands/edit.ts src/commands/remove.ts
git commit -m "feat(git-watcher): core commands (add, downstream, list, show, edit, remove)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 11: Utility Commands (test, retry, status, queue, logs, export, import, doctor, webhook-redeploy)

**Files:**
- Create: `src/commands/test-cmd.ts`
- Create: `src/commands/retry.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/queue-cmd.ts`
- Create: `src/commands/logs.ts`
- Create: `src/commands/export-import.ts`
- Create: `src/commands/doctor.ts`
- Create: `src/commands/webhook-redeploy.ts`

- [ ] **Step 11.1: Implement `src/commands/test-cmd.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import type { QueueItem } from '../types'

export function handleTest(
  args: string[],
  watcherStore: WatcherStore,
  queueStore: QueueStore,
) {
  // args: <watcherId> [--downstream <downId>] [prNumber]
  const watcherId = args[0]
  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  const downFlag = args.indexOf('--downstream')
  const downId = downFlag !== -1 ? args[downFlag + 1] : undefined
  const prNumberArg = args.find((a) => /^\d+$/.test(a))

  let prNumber: number
  let prUrl: string

  if (prNumberArg) {
    prNumber = parseInt(prNumberArg, 10)
    prUrl = `https://github.com/${watcher.upstream.repo}/pull/${prNumber}`
  } else {
    try {
      const out = execSync(
        `gh pr list --repo ${watcher.upstream.repo} --state merged --base ${watcher.upstream.branch} --json number,url --limit 1`,
        { stdio: 'pipe' },
      ).toString()
      const prs = JSON.parse(out)
      if (!prs.length) return { type: 'error', message: 'No merged PRs found on this branch' }
      prNumber = prs[0].number
      prUrl = prs[0].url
    } catch (err: any) {
      return { type: 'error', message: `Failed to fetch PRs: ${err.message}` }
    }
  }

  const targets = downId
    ? watcher.downstreams.filter((d) => d.id === downId)
    : watcher.downstreams

  for (const downstream of targets) {
    const item: QueueItem = {
      id: `job_test_${Date.now()}`,
      watcherId, downstreamId: downstream.id,
      prNumber, prUrl,
      deliveryId: `test-${Date.now()}`,
      enqueuedAt: new Date().toISOString(),
      status: 'pending', attempts: 0,
    }
    queueStore.enqueue(item)
  }

  return { type: 'text', message: `✅ Enqueued PR #${prNumber} test for ${targets.length} downstream(s)` }
}
```

- [ ] **Step 11.2: Implement `src/commands/retry.ts`**

```typescript
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import type { QueueItem } from '../types'

export function handleRetry(args: string[], watcherStore: WatcherStore, queueStore: QueueStore) {
  const [watcherId, downId, prNumberStr] = args
  if (!watcherId || !downId || !prNumberStr) {
    return { type: 'error', message: 'Usage: /gitwatch retry <watcherId> <downstreamId> <prNumber>' }
  }
  const watcher = watcherStore.get(watcherId)
  if (!watcher) return { type: 'error', message: `Watcher ${watcherId} not found` }

  const prNumber = parseInt(prNumberStr, 10)
  const prUrl = `https://github.com/${watcher.upstream.repo}/pull/${prNumber}`

  queueStore.enqueue({
    id: `job_retry_${Date.now()}`,
    watcherId, downstreamId: downId,
    prNumber, prUrl,
    deliveryId: `retry-${Date.now()}`,
    enqueuedAt: new Date().toISOString(),
    status: 'pending', attempts: 0,
  })

  return { type: 'text', message: `✅ Re-queued PR #${prNumber} for ${downId}` }
}
```

- [ ] **Step 11.3: Implement `src/commands/status.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'
import type { ConcurrencyGate } from '../workers/concurrency-gate'

export function handleStatus(
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  tunnelService: any,
  gate: ConcurrencyGate,
  maxConcurrent: number,
) {
  const tunnelUrl = tunnelService.getPublicUrl() ?? '(not running)'
  const watchers = watcherStore.list()

  let ghStatus = 'unknown'
  try {
    execSync('gh auth status', { stdio: 'pipe' })
    ghStatus = '✅ authenticated'
  } catch {
    ghStatus = '❌ not authenticated'
  }

  const queueSummary = watchers.flatMap((w) =>
    w.downstreams.map((d) => {
      const pending = queueStore.list(w.id, d.id).filter((j) => j.status === 'pending').length
      return `  ${w.id}/${d.id}: ${pending} pending`
    }),
  ).join('\n') || '  (no queues)'

  return {
    type: 'text',
    message: [
      `**git-watcher status**`,
      `Tunnel: ${tunnelUrl}`,
      `gh CLI: ${ghStatus}`,
      `Watchers: ${watchers.length}`,
      `Concurrent sessions: ${(gate as any).active}/${maxConcurrent}`,
      `Queue depths:\n${queueSummary}`,
    ].join('\n'),
  }
}
```

- [ ] **Step 11.4: Implement `src/commands/queue-cmd.ts`**

```typescript
import type { WatcherStore } from '../storage/watcher-store'
import type { QueueStore } from '../storage/queue-store'

export function handleQueue(args: string[], watcherStore: WatcherStore, queueStore: QueueStore) {
  const [watcherId, downId] = args
  const watchers = watcherStore.list()

  const pairs = watcherId
    ? watchers
        .filter((w) => w.id === watcherId)
        .flatMap((w) =>
          downId
            ? w.downstreams.filter((d) => d.id === downId).map((d) => ({ w, d }))
            : w.downstreams.map((d) => ({ w, d })),
        )
    : watchers.flatMap((w) => w.downstreams.map((d) => ({ w, d })))

  const lines = pairs.flatMap(({ w, d }) => {
    const pending = queueStore.list(w.id, d.id).filter((j) => ['pending', 'processing'].includes(j.status))
    if (!pending.length) return []
    return [
      `**${w.id}/${d.id}** (${w.upstream.repo} → ${d.repo}):`,
      ...pending.map((j) => `  ${j.status} | PR #${j.prNumber} | enqueued ${j.enqueuedAt}`),
    ]
  })

  return { type: 'text', message: lines.length ? lines.join('\n') : 'No pending jobs' }
}
```

- [ ] **Step 11.5: Implement `src/commands/logs.ts`**

```typescript
import type { WatcherStore } from '../storage/watcher-store'
import type { RunLog } from '../storage/run-log'

export function handleLogs(args: string[], watcherStore: WatcherStore, runLog: RunLog) {
  const limitFlag = args.indexOf('--limit')
  const limit = limitFlag !== -1 ? parseInt(args[limitFlag + 1], 10) : 10
  const watcherId = args.find((a) => a.startsWith('watcher_'))
  const downId = args.find((a) => a.startsWith('down_'))

  let entries = runLog.list()
  if (watcherId) entries = entries.filter((e) => e.watcherId === watcherId)
  if (downId) entries = entries.filter((e) => e.downstreamId === downId)
  entries = entries.slice(-limit).reverse()

  if (!entries.length) return { type: 'text', message: 'No log entries found' }

  const lines = entries.map((e) => {
    const status = e.status === 'success' ? `✅ ${e.issueUrl}` : `❌ ${e.error}`
    return `${e.startedAt.slice(0, 16)} | PR #${e.prNumber} | ${e.upstream} → ${e.downstream} | ${status}`
  })

  return { type: 'text', message: lines.join('\n') }
}
```

- [ ] **Step 11.6: Implement `src/commands/export-import.ts`**

```typescript
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '@openacp/plugin-sdk'
import type { WatcherStore } from '../storage/watcher-store'

export async function handleExport(
  args: string[],
  watcherStore: WatcherStore,
  dataDir: string,
) {
  const withSecrets = args.includes('--with-secrets')
  const watchers = watcherStore.list().map((w) => ({
    ...w,
    upstream: withSecrets ? w.upstream : { ...w.upstream, webhookSecret: '[redacted]' },
  }))
  const content = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), watchers }, null, 2)
  const path = join(dataDir, 'exports', `gitwatch-export-${Date.now()}.json`)
  writeFileSync(path, content)
  return { type: 'text', message: `Exported to ${path}${withSecrets ? '\n⚠️ Contains secrets — keep this file secure' : ''}` }
}

export async function handleImport(
  args: string[],
  ctx: PluginContext,
  watcherStore: WatcherStore,
) {
  const filePath = args[0]
  if (!filePath) return { type: 'error', message: 'Usage: /gitwatch import <file>' }

  let parsed: any
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err: any) {
    return { type: 'error', message: `Failed to read file: ${err.message}` }
  }

  if (!parsed.watchers) return { type: 'error', message: 'Invalid export file format' }

  let imported = 0
  for (const watcher of parsed.watchers) {
    const existing = watcherStore.get(watcher.id)
    if (existing) {
      const overwrite = await ctx.terminal.confirm(`Watcher ${watcher.id} already exists. Overwrite?`)
      if (!overwrite) continue
    }
    watcherStore.save(watcher)
    imported++
  }

  return { type: 'text', message: `✅ Imported ${imported} watcher(s)` }
}
```

- [ ] **Step 11.7: Implement `src/commands/doctor.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { WatcherStore } from '../storage/watcher-store'

export function handleDoctor(watcherStore: WatcherStore, tunnelService: any) {
  const results: string[] = []

  // gh CLI
  try {
    const version = execSync('gh --version', { stdio: 'pipe' }).toString().split('\n')[0]
    results.push(`✅ gh CLI: ${version}`)
  } catch {
    results.push('❌ gh CLI: not installed. Install from https://cli.github.com')
  }

  // gh auth
  try {
    execSync('gh auth status', { stdio: 'pipe' })
    results.push('✅ gh auth: authenticated')
  } catch {
    results.push('❌ gh auth: not authenticated. Run `gh auth login`')
  }

  // Tunnel
  const url = tunnelService.getPublicUrl()
  results.push(url ? `✅ Tunnel: ${url}` : '❌ Tunnel: not running')

  // Webhooks
  const watchers = watcherStore.list()
  for (const watcher of watchers) {
    try {
      execSync(
        `gh api GET /repos/${watcher.upstream.repo}/hooks/${watcher.upstream.webhookId} --jq ".active"`,
        { stdio: 'pipe' },
      )
      results.push(`✅ Webhook: ${watcher.id} (${watcher.upstream.repo}) active`)
    } catch {
      results.push(`❌ Webhook: ${watcher.id} (${watcher.upstream.repo}) not found or inactive`)
    }
  }

  return { type: 'text', message: results.join('\n') }
}
```

- [ ] **Step 11.8: Implement `src/commands/webhook-redeploy.ts`**

```typescript
import { execSync } from 'node:child_process'
import type { WatcherStore } from '../storage/watcher-store'

export function handleWebhookRedeploy(args: string[], watcherStore: WatcherStore, tunnelService: any) {
  const tunnelUrl = tunnelService.getPublicUrl()
  if (!tunnelUrl) return { type: 'error', message: 'Tunnel is not running' }

  const watcherId = args[0]
  const watchers = watcherId
    ? [watcherStore.get(watcherId)].filter(Boolean)
    : watcherStore.list()

  const results: string[] = []
  for (const watcher of watchers as any[]) {
    const webhookUrl = `${tunnelUrl}/git-watcher/webhooks/${watcher.id}`
    try {
      execSync(
        `gh api PATCH /repos/${watcher.upstream.repo}/hooks/${watcher.upstream.webhookId} ` +
        `-f config[url]="${webhookUrl}" -f config[secret]="${watcher.upstream.webhookSecret}"`,
        { stdio: 'pipe' },
      )
      results.push(`✅ ${watcher.id}: ${webhookUrl}`)
    } catch (err: any) {
      results.push(`❌ ${watcher.id}: ${err.message}`)
    }
  }

  return { type: 'text', message: results.join('\n') }
}
```

- [ ] **Step 11.9: Commit all utility commands**

```bash
git add src/commands/
git commit -m "feat(git-watcher): utility commands (test, retry, status, queue, logs, export, import, doctor, webhook-redeploy)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 12: Plugin Entry Point (`src/index.ts`)

**Files:**
- Modify: `src/index.ts` (replace scaffold with full implementation)

- [ ] **Step 12.1: Implement `src/index.ts`**

Replace the scaffold content with:

```typescript
import type { OpenACPPlugin, PluginContext } from '@openacp/plugin-sdk'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { WatcherStore } from './storage/watcher-store'
import { QueueStore } from './storage/queue-store'
import { RunLog } from './storage/run-log'
import { SessionResolver } from './workers/session-resolver'
import { ConcurrencyGate } from './workers/concurrency-gate'
import { PairWorker } from './workers/pair-worker'
import { createWebhookRoutes } from './hooks/webhook-receiver'
import { registerTunnelListener, bootRecovery } from './hooks/tunnel-listener'
import { handleAdd } from './commands/add'
import { handleDownstreamAdd, handleDownstreamRemove } from './commands/downstream'
import { handleList, handleShow } from './commands/list'
import { handleEdit } from './commands/edit'
import { handleRemove } from './commands/remove'
import { handleTest } from './commands/test-cmd'
import { handleRetry } from './commands/retry'
import { handleStatus } from './commands/status'
import { handleQueue } from './commands/queue-cmd'
import { handleLogs } from './commands/logs'
import { handleExport, handleImport } from './commands/export-import'
import { handleDoctor } from './commands/doctor'
import { handleWebhookRedeploy } from './commands/webhook-redeploy'
import { AUTO_APPROVED_COMMANDS, type PluginConfig } from './types'

const MAX_CONCURRENT_DEFAULT = 3
const workers = new Map<string, PairWorker>()

const plugin: OpenACPPlugin = {
  name: '@openacp/git-watcher',
  version: '1.0.0',
  description: 'Watch upstream GitHub repos for PR merges and create impact analysis issues in downstream repos',
  pluginDependencies: {
    '@openacp/api-server': '*',
    '@openacp/tunnel': '*',
  },
  permissions: [
    'kernel:access',
    'services:use',
    'events:read',
    'events:emit',
    'storage:read',
    'storage:write',
    'commands:register',
    'terminal:interactive',
  ],
  autoApprovedCommands: [...AUTO_APPROVED_COMMANDS],

  async install(ctx) {
    // Validate gh CLI
    try { execSync('gh --version', { stdio: 'pipe' }) }
    catch { throw new Error('gh CLI not found. Install from https://cli.github.com and run `gh auth login`') }

    try { execSync('gh auth status', { stdio: 'pipe' }) }
    catch { throw new Error('gh CLI not authenticated. Run `gh auth login` first') }

    // Collect Telegram chat ID
    const telegramChatId = await ctx.terminal.input('Telegram supergroup chat ID (for monitoring topics):')
    await ctx.storage.set('plugin-config', {
      telegramChatId,
      maxConcurrentSessions: MAX_CONCURRENT_DEFAULT,
    } satisfies PluginConfig)
  },

  async setup(ctx: PluginContext) {
    const storage = ctx.storage
    const config = (await storage.get('plugin-config') as PluginConfig | undefined) ?? {
      telegramChatId: '',
      maxConcurrentSessions: MAX_CONCURRENT_DEFAULT,
    }
    const dataDir = storage.getDataDir()
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true })
    mkdirSync(join(dataDir, 'exports'), { recursive: true })

    const watcherStore = new WatcherStore(storage)
    const queueStore = new QueueStore(storage)
    const runLog = new RunLog(storage)
    const gate = new ConcurrencyGate(config.maxConcurrentSessions)

    // Delivery ID set (last 50)
    const deliveryIdSet = {
      has: (id: string) => {
        const ids = (storage.get('delivery-ids') as string[] | undefined) ?? []
        return ids.includes(id)
      },
      add: (id: string) => {
        const ids = (storage.get('delivery-ids') as string[] | undefined) ?? []
        storage.set('delivery-ids', [...ids, id].slice(-50))
      },
    }

    const tunnelService = ctx.getService<any>('tunnel')
    const apiServer = ctx.getService<any>('api-server')

    // Register webhook endpoint
    if (apiServer) {
      apiServer.registerPlugin('/git-watcher', createWebhookRoutes(
        watcherStore, queueStore, deliveryIdSet,
        (watcherId, downId) => {
          ctx.emit('gitwatch:trigger:enqueued', { watcherId, downId })
          kickWorker(watcherId, downId)
        },
      ), { auth: false })
    }

    // Register tunnel listener
    registerTunnelListener(ctx, watcherStore, () => tunnelService?.getPublicUrl() ?? '')

    // Boot recovery
    await bootRecovery(ctx, watcherStore, queueStore, storage)

    // Start workers for existing watchers
    function kickWorker(watcherId: string, downId: string) {
      const key = `${watcherId}:${downId}`
      if (!workers.has(key)) {
        const watcher = watcherStore.get(watcherId)
        const downstream = watcher?.downstreams.find((d) => d.id === downId)
        if (!watcher || !downstream) return
        const resolver = new SessionResolver((ctx as any).core.sessionManager, watcherStore)
        const worker = new PairWorker(
          ctx, watcher, downstream, watcherStore, queueStore, runLog,
          resolver, gate, dataDir, config.telegramChatId,
        )
        workers.set(key, worker)
        worker.start()
      }
    }

    for (const watcher of watcherStore.list()) {
      for (const downstream of watcher.downstreams) {
        kickWorker(watcher.id, downstream.id)
      }
    }

    // Register commands
    ctx.registerCommand({
      name: 'gitwatch',
      description: 'Manage git-watcher upstream repo monitoring',
      usage: '/gitwatch <subcommand> [args]',
      handler: async (args) => {
        const [sub, ...rest] = args
        switch (sub) {
          case 'add': return handleAdd(ctx, watcherStore, queueStore, tunnelService, config)
          case 'list': return handleList(watcherStore)
          case 'show': return handleShow(rest, watcherStore)
          case 'edit': return handleEdit(rest, ctx, watcherStore)
          case 'remove': return handleRemove(rest, ctx, watcherStore, queueStore, dataDir)
          case 'downstream':
            if (rest[0] === 'add') return handleDownstreamAdd(rest.slice(1), ctx, watcherStore, queueStore, config, dataDir)
            if (rest[0] === 'remove') return handleDownstreamRemove(rest.slice(1), ctx, watcherStore, queueStore, dataDir)
            return { type: 'error', message: 'Usage: /gitwatch downstream add|remove' }
          case 'test': return handleTest(rest, watcherStore, queueStore)
          case 'retry': return handleRetry(rest, watcherStore, queueStore)
          case 'status': return handleStatus(watcherStore, queueStore, tunnelService, gate, config.maxConcurrentSessions)
          case 'queue': return handleQueue(rest, watcherStore, queueStore)
          case 'logs': return handleLogs(rest, watcherStore, runLog)
          case 'export': return handleExport(rest, watcherStore, dataDir)
          case 'import': return handleImport(rest, ctx, watcherStore)
          case 'doctor': return handleDoctor(watcherStore, tunnelService)
          case 'webhook':
            if (rest[0] === 'redeploy') return handleWebhookRedeploy(rest.slice(1), watcherStore, tunnelService)
            return { type: 'error', message: 'Usage: /gitwatch webhook redeploy [watcherId]' }
          default:
            return { type: 'text', message: 'Commands: add, list, show, edit, remove, downstream, test, retry, status, queue, logs, export, import, doctor, webhook redeploy' }
        }
      },
    })
  },

  async teardown() {
    for (const worker of workers.values()) {
      worker.stop()
    }
    workers.clear()
  },
}

export default plugin
```

- [ ] **Step 12.2: Build to check for TypeScript errors**

```bash
npm run build
```

Fix any type errors before proceeding. Common issues:
- `PluginStorage.get()` is async in some SDK versions — check and add `await` if needed
- `ctx.terminal` methods may have different signatures — check `workspace-plugin/src/commands/` for reference
- `CommandResponse` type — check what the command handler should return

- [ ] **Step 12.3: Commit**

```bash
git add src/index.ts
git commit -m "feat(git-watcher): plugin entry point with setup, install, teardown, and all commands wired

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 13: Self-Review and Smoke Test

- [ ] **Step 13.1: Run full test suite**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 13.2: Read generated CLAUDE.md and update with git-watcher specifics**

The CLI generates a generic CLAUDE.md. Update it to reflect:
- Purpose and architecture of git-watcher
- How to test locally (requires gh CLI + tunnel + Telegram)
- Key files and their responsibilities

- [ ] **Step 13.3: Check spec coverage**

Open the spec at `docs/superpowers/specs/2026-04-23-git-watcher-design.md` and verify each section has a corresponding task in this plan:

- [x] Section 3 (Plugin Identity) → Task 12 (index.ts)
- [x] Section 4 (Config Model) → Task 2 (types.ts)
- [x] Section 5 (Storage Schema) → Task 3
- [x] Section 6 (Commands) → Tasks 10, 11
- [x] Section 7 (Custom Events) → Task 8 (pair-worker emits)
- [x] Section 8 (Webhook Flow) → Tasks 7, 8
- [x] Section 8 (Bot attribution footer) → Task 2 (DEFAULT_PROMPT_TEMPLATE)
- [x] Section 9 (Tunnel Integration) → Task 9
- [x] Section 10 (Boot Recovery) → Task 9
- [x] Section 11 (Error Handling) → Tasks 7, 8 (job failure, retries)
- [x] Section 12 (Telegram) → Tasks 10, 12 (topic creation in add.ts, session channelId)
- [x] Section 13 (Teardown) → Task 12 (teardown() in index.ts)

- [ ] **Step 13.4: Final commit**

```bash
git add .
git commit -m "docs: update CLAUDE.md with git-watcher architecture and test instructions

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Done

Plugin `@openacp/git-watcher` fully implemented. Manual smoke test:
1. Run `openacp plugin install ./git-watcher-plugin` in OpenACP workspace
2. `/gitwatch doctor` — verify gh and tunnel health
3. `/gitwatch add` — configure one upstream/downstream pair
4. `/gitwatch test <watcherId>` — trigger analysis of latest merged PR
5. Observe Telegram topic for AI activity and issue URL in output
