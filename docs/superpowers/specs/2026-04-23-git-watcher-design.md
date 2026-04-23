# git-watcher Plugin Design

**Date**: 2026-04-23  
**Plugin**: `@openacp/git-watcher`  
**Status**: Design approved, pending implementation

---

## 1. Overview

`git-watcher` is a generic OpenACP plugin that monitors upstream GitHub repositories for merged PRs and automatically spawns AI agent sessions to analyze the impact on downstream repositories, then creates actionable GitHub issues for the downstream teams.

**Problem**: When a backend/shared repo merges changes, frontend repos (web, app, extension, etc.) often need to update accordingly. These changes are easy to miss when teams move fast. The plugin bridges this gap by watching upstream PRs and creating contextualized issues in downstream repos automatically.

**Design goals**:
- Generic: works for any team, any repo relationship
- Automated: minimum user interaction after initial setup
- Transparent: all AI activity visible in Telegram topics
- Secure: no credential sprawl; uses `gh` CLI for GitHub operations

---

## 2. Project Structure

This plugin is a **two-part project**:

### Part 1 — OpenACP Core Changes (prerequisite)

Four targeted changes to `./OpenACP`:

| Change | File | Purpose |
|---|---|---|
| Tunnel event emission | `src/plugins/tunnel/tunnel-service.ts` + `src/plugins/tunnel/index.ts` | Emit `tunnel:started`, `tunnel:urlChanged`, `tunnel:stopped` via callback pattern (same as identity plugin) |
| `autoApprovedCommands` in createSession | `src/core/sessions/session-manager.ts:54` | Accept `autoApprovedCommands?: string[]` param |
| Pattern matching in checkAutoApprove | `src/core/sessions/session-bridge.ts:457` | Glob-match bash commands against session's approved list using `micromatch` |
| Plugin manifest `autoApprovedCommands` | `packages/plugin-sdk/src/types.ts` + `src/core/plugin/plugin-context.ts` | Plugin declares list; plugin-context injects into spawned sessions; core validates against a blocklist (`rm *`, `sudo *`, `curl *`, `chmod *`, etc.) |

### Part 2 — Plugin `@openacp/git-watcher`

New standalone repo at `./git-watcher-plugin/` (parallel to `workspace-plugin`).

---

## 3. Plugin Identity

```typescript
// git-watcher-plugin/src/index.ts
{
  name: '@openacp/git-watcher',
  version: '1.0.0',
  dependencies: [
    '@openacp/api-server',   // register webhook HTTP endpoint
    '@openacp/tunnel',       // public URL + tunnel:urlChanged events
  ],
  permissions: [
    'kernel:access',         // spawn agent sessions via ctx.core.sessionManager
    'services:use',          // use api-server, tunnel, notifications services
    'events:read',           // listen to tunnel:urlChanged, agent_event
    'events:emit',           // emit gitwatch:* events
    'storage:read',
    'storage:write',
    'commands:register',
    'terminal:interactive',  // wizard prompts in /gitwatch add, /gitwatch edit
  ],
  autoApprovedCommands: [
    // GitHub read operations (AI uses these to analyze PR)
    'gh pr view *',
    'gh pr diff *',
    'gh auth status',
    // Issue creation goes through ./create_issue.sh (see Section 8)
    // Git workspace operations (AI may pull for freshness)
    'git -C */workspaces/* pull *',
    'git -C */workspaces/* checkout *',
    'git -C */workspaces/* fetch *',
    'git -C */workspaces/* log *',
    'git -C */workspaces/* diff *',
    'git -C */workspaces/* status',
    // Read-only filesystem within workspaces only
    'cat */workspaces/*',
    'grep * */workspaces/*',
    'find */workspaces/* *',
    'ls */workspaces/*',
  ],
}
```

### Install-time validation (`install()` hook)

1. Check `gh` installed: `gh --version` — if missing, throw with instructions
2. Check `gh` authenticated: `gh auth status` — if not, throw with `gh auth login` instructions
3. Check Telegram is connected to OpenACP — if not, warn: "Set up Telegram with OpenACP first for activity monitoring"
4. Check `api-server` and `tunnel` services are available — if missing, throw
5. Prompt for Telegram supergroup chat ID (required for topic creation): `ctx.terminal.input("Telegram supergroup chat ID:")` — store in `plugin-config.telegramChatId`
6. Validate bot has `can_manage_topics` permission in that chat (via Telegram Bot API `getChat`)

Soft deps (`notifications` service): warn if absent but continue.

---

## 4. Config Model

### Global plugin config (key `plugin-config` in storage)

```typescript
interface PluginConfig {
  telegramChatId: string       // supergroup ID for topic creation
  maxConcurrentSessions: number  // default: 3
}
```

### Watcher (key `watchers` in storage)

```typescript
interface Watcher {
  id: string                   // "watcher_abc123" (random 6-char suffix)
  upstream: {
    repo: string               // "owner/backend"
    branch: string             // "main"
    webhookId: number          // GitHub webhook ID (for cleanup/update)
    webhookSecret: string      // random 32-char hex, HMAC-SHA256 verify
  }
  downstreams: Downstream[]
  createdAt: string            // ISO timestamp
}

interface Downstream {
  id: string                   // "down_xyz789"
  repo: string                 // "owner/web-app"
  branch: string               // "main" (branch to sync/read)
  telegramTopicId: number      // Telegram forum topic ID for this pair
  issueLabels: string[]        // default: ["sync-upstream", "auto-generated"]
  promptTemplate: string       // user-editable, see Section 8 for default
  agent: string                // Claude model, default: OpenACP default agent
  sessionStrategy: 'per-trigger' | 'rolling' | 'persistent'
  sessionLimits: {
    maxTurns: number           // default: 10 (rolling mode)
    maxAge: string             // default: "24h" (rolling mode)
  }
  currentSessionId?: string    // rolling/persistent: active session
  sessionTurnCount?: number    // rolling: current turn count
  sessionCreatedAt?: string    // rolling: age tracking
}
```

---

## 5. Storage Schema

### Key-value (ctx.storage)

| Key | Type | Purpose |
|---|---|---|
| `plugin-config` | `PluginConfig` | Global plugin settings |
| `watchers` | `Watcher[]` | All watcher + downstream configs |
| `queue:<watcherId>:<downId>` | `QueueItem[]` | Pending jobs per downstream |
| `queue-index` | `string[]` | List of all active queue keys (for enumeration). Must be updated when downstream is added or removed. |
| `run-log` | `RunLogEntry[]` | Circular buffer, last 100 runs |
| `delivery-ids` | `string[]` | Last 50 GitHub delivery UUIDs (dedup) |
| `last-delivery-time:<watcherId>` | `string` | ISO timestamp, for catch-up on boot |
| `plugin-meta` | `{ version, tunnelUrl, installedAt }` | Tunnel URL tracked for boot comparison |

```typescript
interface QueueItem {
  id: string                   // "job_def456"
  watcherId: string
  downstreamId: string
  prNumber: number
  prUrl: string
  deliveryId: string           // X-GitHub-Delivery header
  enqueuedAt: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number             // max 2 retries
  retryAfter?: string          // ISO timestamp for delayed retry
  error?: string
}

interface RunLogEntry {
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
```

### File system (ctx.storage.getDataDir())

```
dataDir/
  workspaces/
    <watcherId>/
      upstream/                ← git clone of upstream repo (shared across downstreams)
      <downstreamId>/
        upstream/              ← symlink to ../../upstream/
        downstream/            ← git clone of downstream repo
        create_issue.sh        ← written before session, deleted after (see Section 8)
  exports/
    gitwatch-export-<date>.json
```

AI session working directory: `dataDir/workspaces/<watcherId>/<downstreamId>/`  
AI sees: `./upstream/` (symlink) and `./downstream/` (clone) — always consistent paths regardless of IDs.

---

## 6. Commands

Terminology: `<wId>` = watcherId, `<dId>` = downstreamId.

### Setup & Config

**`/gitwatch add`** — interactive wizard (no params)
- Step 1: upstream repo (`owner/repo`)
- Step 2: upstream branch (default: `main`)
- Step 3: add first downstream (required — at least 1 downstream must be configured before webhook is registered)
- Step 4 (per downstream): repo, branch, session strategy, agent, issueLabels, prompt template (default or open editor)
- Plugin generates watcherId, random webhook secret
- Plugin shells: `gh api POST /repos/<upstream>/hooks -f events[]=pull_request -f config[url]=<webhookUrl> -f config[secret]=<secret> -f config[content_type]=json`
- Plugin creates Telegram topic: `<upstreamRepo> → <downstreamRepo>`
- Plugin does first workspace clone (upstream + downstream, shallow)
- Confirm with watcherId and downstream summary

**`/gitwatch downstream add <wId>`** — add downstream to existing watcher
- Same per-downstream wizard as above (step 4)
- Creates Telegram topic, clones workspace

**`/gitwatch list`** — list all watchers
- Table: `watcherId | upstream:branch → downstreams | webhook status | lastTrigger`

**`/gitwatch show <wId>`** — detail of a watcher
- Upstream config (ẩn secret), list of downstreams, webhook health, stats

**`/gitwatch edit <wId>`** — edit watcher-level fields
- Interactive: upstream branch (triggers webhook re-register if changed)

**`/gitwatch edit <wId> <dId> [field]`** — edit downstream fields
- No field: ask which field
- Fields: `branch`, `strategy`, `agent`, `labels`, `template`
- `/gitwatch edit watcher_abc down_xyz template` → opens template in editor

**`/gitwatch remove <wId>`** — remove entire watcher
- DELETE webhook via `gh api DELETE /repos/<upstream>/hooks/<hookId>`
- Cancel active sessions
- Delete workspaces
- Clear storage + queues

**`/gitwatch downstream remove <wId> <dId>`** — remove one downstream
- Cancel session, delete workspace, remove from watcher.downstreams

### Run & Debug

**`/gitwatch test <wId> [--downstream <dId>] [prNumber]`**
- No prNumber: fetch latest merged PR via `gh pr list --state merged --limit 1`
- No --downstream: trigger all downstreams
- Simulates full pipeline (goes through queue)

**`/gitwatch retry <wId> <dId> <prNumber>`**
- Re-enqueue job, reset attempts to 0

**`/gitwatch status`**
- Tunnel URL + health
- Webhooks: registered vs total
- Queue depths per downstream
- `gh auth status` summary
- maxConcurrentSessions: current/max

**`/gitwatch queue [<wId>] [<dId>]`**
- Show pending jobs, filtered by watcher/downstream if specified

**`/gitwatch logs [<wId>] [<dId>] [--limit N]`**
- Recent runs, default limit 10
- Columns: time, pair, PR#, status, issueUrl/error

### Portability

**`/gitwatch export [--with-secrets]`**
- Default: omit webhook secrets
- `--with-secrets`: full backup (warn user before proceeding)
- Output: file attached via Telegram adapter

**`/gitwatch import <file>`**
- Parse → validate → confirm each watcher → re-register webhooks → re-clone workspaces

### Health

**`/gitwatch doctor`**
- `gh` installed + version
- `gh auth status` + scopes (`repo`, `admin:repo_hook`)
- Tunnel running + URL
- Each webhook: `gh api GET /repos/<upstream>/hooks/<hookId>` → active?
- Telegram chat accessible, bot can create topics
- Workspace dirs exist + git status clean

**`/gitwatch webhook redeploy [<wId>]`**
- Force re-register webhook(s) with current tunnel URL
- Runs automatically on `tunnel:urlChanged` event

---

## 7. Custom Events Emitted

```
gitwatch:trigger:received     // webhook arrived + verified
gitwatch:trigger:enqueued     // added to downstream queue
gitwatch:analysis:started     // session spawned for this PR
gitwatch:analysis:completed   // AI done, issue created { issueUrl }
gitwatch:analysis:failed      // error { error, prUrl }
gitwatch:webhook:reregistered // after tunnel URL change
```

Other plugins can subscribe via `ctx.on('gitwatch:analysis:completed', ...)`.

---

## 8. Webhook Flow & Session Lifecycle

### Step 1: Webhook receipt

```
POST {tunnelUrl}/git-watcher/webhooks/<watcherId>
  → verify X-Hub-Signature-256 (HMAC-SHA256 with stored secret)
  → if invalid: drop silently, log warn
  → check X-GitHub-Delivery in last 50 delivery-ids → if dup: drop
  → add delivery ID to list, persist
  → parse payload: prNumber, prUrl, headRef (branch), action
  → if action != 'closed' OR merged != true: drop
  → if headRef != upstream.branch: drop
  → update last-delivery-time:<watcherId>
  → for each downstream: create QueueItem, enqueue
  → emit gitwatch:trigger:enqueued
```

### Step 2: PairWorker (per downstream, FIFO)

One worker per downstream. Respects `maxConcurrentSessions` plugin-wide.

```
dequeue QueueItem
  → mark status: 'processing'
  → resolve session (see Session Strategy below)
  → sync workspace (plugin shells out, before spawning AI)
  → write create_issue.sh (see Bot Account below)
  → spawn/reuse session
  → fill + enqueue prompt
  → listen agent_event until end_turn (10min timeout)
  → parse ISSUE_CREATED: <url> from output
  → delete create_issue.sh
  → cleanup session if per-trigger
  → mark job done/failed
  → append run log entry
  → emit gitwatch:analysis:completed / failed
```

### Workspace sync

```
// First time (workspace doesn't exist):
git clone --depth 1 --single-branch --branch <branch> <repo> <path>
ln -s ../../upstream <downstreamDir>/upstream

// Subsequent times:
git -C <path> fetch origin
git -C <path> reset --hard origin/<branch>   // clean state, safe to force
```

Note: AI may also pull/fetch within the session — that is fine and expected.

### Session strategy

```
per-trigger:
  always createSession, cancelSession after done

rolling:
  if currentSessionId exists:
    if turnCount < maxTurns AND age < maxAge: reuse
    else: cancelSession(old), createSession(new)
  else: createSession(new)
  increment sessionTurnCount after each turn

persistent:
  if currentSessionId exists: reuse
  else: createSession, store id forever
```

Session spawn:
```typescript
core.sessionManager.createSession(
  channelId: `${telegramChatId}/${topicId}`,
  agent: downstream.agent || core.configManager.get().defaultAgent,
  workingDirectory: `${dataDir}/workspaces/${watcherId}/${downstreamId}/`,
  agentManager: core.agentManager,
  autoApprovedCommands: pluginManifest.autoApprovedCommands,
)
```

### Bot attribution in issue body

No separate bot token or account is needed. Issues are created via the user's `gh` auth. Attribution is embedded in the issue body template footer:

```
---
*🤖 Auto-generated by [git-watcher](https://github.com/openacp/git-watcher) · [Upstream PR #{pr_number}]({pr_url})*
```

This makes bot-created issues visually distinct without credential complexity. The `auto-generated` label provides machine-filterable attribution.

### Prompt template

**System prompt (locked, non-editable):**

```
You are a git-watcher agent analyzing the impact of upstream repository changes on a downstream codebase.

GitHub operations: Use `gh` CLI for all GitHub interactions.
First action: Run `gh auth status` — if not authenticated, stop and output:
  ERROR: gh CLI not authenticated. Run `gh auth login` on the server.

Workspace layout (read-only paths, do NOT modify):
  ./upstream/     — upstream repository (read PR details and diffs here)
  ./downstream/   — downstream repository (analyze impact here)

Issue creation: Use `./create_issue.sh` (not `gh issue create` directly).

When your task is complete:
  1. Output the issue URL on its own line in this exact format: ISSUE_CREATED: <url>
  2. If an issue for this PR already exists in downstream, output: ISSUE_EXISTS: <url>
  3. Stop. Do not continue after this.
```

**User prompt template (editable per downstream, default):**

```
A PR was merged in the upstream repository {upstream_repo}:
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
5. Create an issue in {downstream_repo} using:
   ./create_issue.sh --repo {downstream_repo} \
     --title "[sync] Impact of PR #{pr_number}: <short summary>" \
     --body "<your analysis>" \
     --label "{issue_labels}"

Issue body should include:
- Summary of upstream changes
- Affected files/functions in downstream (with paths)
- Actionable checklist of what needs to change
- Link to upstream PR: {pr_url}
```

Available template variables: `{upstream_repo}`, `{downstream_repo}`, `{pr_number}`, `{pr_url}`, `{upstream_branch}`, `{downstream_branch}`, `{issue_labels}`.

---

## 9. Tunnel Integration

### Tunnel events (added in Part 1)

Plugin subscribes during `setup()`:

```typescript
ctx.on('tunnel:started', ({ url }) => {
  storage.set('plugin-meta', { ...meta, tunnelUrl: url })
  reregisterAllWebhooks(url)
})

ctx.on('tunnel:urlChanged', ({ url }) => {
  storage.set('plugin-meta', { ...meta, tunnelUrl: url })
  reregisterAllWebhooks(url)
  sendToGeneralTopic('🔄 Tunnel URL changed, webhooks re-registered')
})

ctx.on('tunnel:stopped', () => {
  sendToGeneralTopic('⚠️ Tunnel stopped — webhooks will not receive events until tunnel restarts')
})
```

### Webhook re-registration

```typescript
async function reregisterAllWebhooks(newUrl: string) {
  for (const watcher of watchers) {
    await shell(`gh api PATCH /repos/${watcher.upstream.repo}/hooks/${watcher.upstream.webhookId} \
      -f config[url]=${newUrl}/git-watcher/webhooks/${watcher.id} \
      -f config[secret]=${watcher.upstream.webhookSecret}`)
  }
  emit('gitwatch:webhook:reregistered', { count: watchers.length, url: newUrl })
}
```

---

## 10. Boot Recovery & Catch-up

On `setup()`:

```
1. Resume interrupted jobs:
   for each queue key in queue-index:
     jobs with status='processing' → reset to 'pending'
   (failed jobs with attempts >= 2 are NOT reset)

2. Catch-up missed PRs:
   for each watcher:
     lastDeliveryTime = storage.get('last-delivery-time:<watcherId>') || '24h ago'
     prs = shell(`gh pr list --repo <upstream> --state merged --base <branch> \
       --json number,mergedAt,url --limit 50`)
     missed = prs.filter(pr => pr.mergedAt > lastDeliveryTime)
     for each missed PR: enqueue to all downstreams (dedup check applies)

3. Validate tunnel URL:
   currentUrl = tunnelService.getPublicUrl()
   savedUrl = storage.get('plugin-meta').tunnelUrl
   if currentUrl && currentUrl !== savedUrl:
     reregisterAllWebhooks(currentUrl)
```

---

## 11. Error Handling

| Scenario | Response |
|---|---|
| Webhook signature invalid | Drop, log warn |
| Branch mismatch | Drop silently |
| Duplicate delivery | Drop (delivery-ids dedup) |
| `gh` not installed | Block install |
| `gh` auth expired | Fail job, notify Telegram General, stop retrying |
| Workspace clone/sync fail | `git fetch + reset --hard origin/<branch>`, retry once |
| Session spawn fail | Fail job, log, notify |
| AI timeout (10min) | Cancel session, mark job failed, notify |
| AI runs unapproved command | Telegram approval prompt (existing OpenACP mechanism) |
| `ISSUE_CREATED:` not found in output | Log full output to run-log, notify with raw output |
| Downstream repo not found / no access | Fail job, notify — check gh permissions |
| Telegram topic deleted | Fallback to General topic |
| Upstream repo renamed/deleted | Webhook re-register will fail gracefully; notify |
| Retry creates duplicate issue | AI checks existing issues first (step 3 in template) |
| Max concurrent sessions reached | Queue job waits; PairWorker polls every 30s |
| Job fails after 2 retries | Mark permanently failed; user can `/gitwatch retry` manually |

### Retry policy

```
attempt 1: immediate
attempt 2: after 5 minutes (store retryAfter timestamp)
attempt 3+: permanently failed (user must /gitwatch retry manually)
```

---

## 12. Telegram Monitoring

### Topic structure

```
Telegram Supergroup (user creates once, provides chatId)
  ├── General              ← errors, webhook events, plugin-wide alerts
  ├── owner/backend → web  ← all activity for this downstream
  ├── owner/backend → app
  └── ...
```

Plugin auto-creates topics via Telegram Bot API when adding a downstream.  
Topic name format: `{upstreamRepo} → {downstreamRepo}` (short repo names).

### Activity visible per topic

- PR received + enqueued: `📥 PR #123 received, queued`
- Analysis started: `🔍 Analyzing PR #123...`
- All AI tool calls (bash commands) — visible via normal session output
- Unexpected command → Telegram approve/deny button
- Analysis complete: `✅ Issue created: <url>`
- Analysis failed: `❌ Failed: <error summary>`

User approval needed only for commands outside `autoApprovedCommands` (should not happen in normal operation).

---

## 13. Teardown

Plugin `teardown()` hook (called on OpenACP graceful shutdown, 10s timeout):

1. Stop accepting new webhook requests (unregister HTTP route or return 503)
2. Persist all in-memory queue state to `ctx.storage`
3. Mark all `processing` jobs back to `pending` (will be recovered on next boot)
4. Cancel any sessions in `per-trigger` mode (rolling/persistent sessions survive restart)
5. Log: "git-watcher teardown complete, {n} jobs queued for next boot"

---

## 14. File Structure (Plugin Repo)

```
git-watcher-plugin/
  src/
    index.ts                  ← plugin definition, setup(), install()
    commands/
      add.ts                  ← /gitwatch add wizard
      downstream.ts           ← /gitwatch downstream add/remove
      list.ts, show.ts, edit.ts, remove.ts
      test.ts, retry.ts, status.ts, queue.ts, logs.ts
      export.ts, import.ts, doctor.ts, webhook-redeploy.ts
    hooks/
      webhook-receiver.ts     ← POST /git-watcher/webhooks/:watcherId
      tunnel-listener.ts      ← ctx.on('tunnel:urlChanged', ...)
    workers/
      pair-worker.ts          ← FIFO queue processor per downstream
      session-resolver.ts     ← per-trigger / rolling / persistent logic
      workspace-sync.ts       ← git clone / pull / symlink
    storage/
      watcher-store.ts        ← CRUD for watchers in ctx.storage
      queue-store.ts          ← queue operations
      run-log.ts              ← circular buffer
    prompt/
      system-prompt.ts        ← locked system prompt (constant)
      template.ts             ← fill user template with variables
    types.ts
  docs/
    superpowers/
      specs/
        2026-04-23-git-watcher-design.md   ← this file
  package.json
  tsconfig.json
```
