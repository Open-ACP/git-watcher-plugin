# @openacp/git-watcher

> An [OpenACP](https://github.com/Open-ACP/OpenACP) plugin that watches upstream GitHub repositories for merged PRs and uses an AI agent to open impact-analysis issues in your downstream repositories — only when the change actually affects them.

---

## The problem

You maintain more than one repository that depends on a shared upstream — an SDK, a protocol schema, a backend API, a design system, a monorepo package, anything. Every time a PR is merged into the upstream, someone has to read the diff, cross-reference it against every downstream, decide whether each one is affected, and file follow-up issues where needed. This is tedious, easy to forget, and scales poorly as the number of downstreams grows.

## What this plugin does

`git-watcher` turns that loop into an automated pipeline:

1. A GitHub webhook tells OpenACP whenever a PR is merged in an upstream repo you configured.
2. For each downstream you paired with that upstream, the plugin spawns an AI agent inside a temporary workspace that has both repos cloned side-by-side.
3. The agent reads the PR, reads the downstream code, and decides whether the change has any real impact on this downstream.
4. If there is real impact, the agent opens a GitHub issue in the downstream repo with a summary, affected files, and a TODO checklist. If there is no impact, it skips gracefully — no issue noise.
5. The whole run is visible in Telegram as a session topic so you can watch it unfold, answer questions, or intervene.

Cosmetic refactors, internal-only changes, docs, tests, and opt-in features you do not use are filtered out by design. Only changes that could break or affect the downstream produce an issue.

---

## How it works

```
┌────────────────┐   webhook    ┌─────────────────┐   enqueue    ┌─────────────┐
│ GitHub upstream│ ───────────▶ │  git-watcher    │ ───────────▶ │  pair queue │
│   (PR merged)  │              │ webhook route   │              │ per (u,d)   │
└────────────────┘              └─────────────────┘              └─────┬───────┘
                                                                       │
                                       ┌───────────────────────────────┘
                                       ▼
                              ┌──────────────────────┐
                              │  pair worker         │
                              │  • sync workspaces   │
                              │  • spawn AI session  │
                              │  • fill prompt       │
                              │  • await outcome     │
                              └──────────┬───────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            ISSUE_CREATED         ISSUE_EXISTS          ISSUE_SKIPPED
            (new issue filed)   (duplicate detected)   (no real impact)
```

Each (upstream, downstream) pair has its own FIFO worker, so jobs for the same pair never race but different pairs run in parallel (bounded by `maxConcurrentSessions`).

---

## Requirements

- OpenACP with the following plugins active:
  - `@openacp/telegram` — the plugin uses Telegram topics for session visibility and approval prompts
  - `@openacp/tunnel` — exposes the local API server so GitHub can reach the webhook route
  - `@openacp/api-server` — hosts the webhook endpoint
- `gh` CLI authenticated on the host machine: `gh auth login` (with `repo` scope for both upstream and downstream repos — write scope needed to create hooks and issues)
- At least one AI agent installed: `openacp agents install <name>` (the plugin uses your configured `defaultAgent`)

---

## Installation

```bash
openacp plugin add @openacp/git-watcher
```

You will be asked for a single setting:

- **Max concurrent AI sessions** — how many pair workers may run in parallel across all watchers (default `3`)

The Telegram chat ID is read at runtime from your `@openacp/telegram` settings — you do not need to configure it again.

Restart OpenACP after install.

---

## Quick start

```text
# 1. Make sure the tunnel is up and reachable
/tunnel                                            # shows the public URL

# 2. Sanity check
/gitwatch doctor                                   # should show ✅ gh, ✅ tunnel

# 3. Watch an upstream
/gitwatch add https://github.com/acme/api main
# → Watcher created: watcher_AbCd1234

# 4. Pair it with a downstream
/gitwatch downstream add watcher_AbCd1234 https://github.com/acme/web main
# → Added downstream down_Xy12z: acme/web @ main using agent claude

# 5. Trigger a test run without merging a real PR
/gitwatch test watcher_AbCd1234 42                 # replays PR #42 of the upstream

# 6. Watch it happen
/gitwatch status                                   # queue counts per pair
/gitwatch logs                                     # recent outcomes
```

After this, any PR merged into `acme/api` will be analyzed against `acme/web` automatically.

---

## Commands reference

All commands are available as `/gitwatch <subcommand> …` in any configured chat channel.

Calling `/gitwatch` on its own returns an interactive menu with clickable buttons for the common read-only subcommands plus a usage cheat sheet for the ones that need arguments.

### Watcher lifecycle

#### `/gitwatch add <repo-or-url> [branch]`

Create a watcher for an upstream repo and register a GitHub webhook on it.

- `repo-or-url` — accepts `owner/repo`, `https://github.com/owner/repo`, `https://github.com/owner/repo.git`, or `git@github.com:owner/repo.git`
- `branch` — upstream branch to watch (default `main`)

Returns the generated `watcherId` and the webhook URL. The hook is created with a random HMAC secret so only genuine GitHub deliveries are accepted. Requires the tunnel to be active.

```text
/gitwatch add acme/api develop
/gitwatch add https://github.com/acme/api main
```

#### `/gitwatch list`

Show all configured watchers with their upstream repo, branch, and downstream count.

#### `/gitwatch show <watcherId>`

Show a single watcher in detail: upstream, webhook ID, and every downstream with its branch, agent, and session strategy.

#### `/gitwatch remove <watcherId>`

Delete the watcher from storage and also delete the GitHub webhook on the upstream repo. Workers for the pair are stopped.

### Downstream lifecycle

#### `/gitwatch downstream add <watcherId> <repo-or-url> [branch] [agent]`

Pair a downstream repo with an existing watcher.

- `branch` — downstream branch (default `main`)
- `agent` — agent name to run the session (default: your `config.defaultAgent`, else the first installed agent). Must be installed.

The downstream gets a generated `downstreamId` and inherits the default prompt template until you customize it.

```text
/gitwatch downstream add watcher_AbCd1234 acme/web main
/gitwatch downstream add watcher_AbCd1234 acme/mobile main claude-sonnet-4-6
```

#### `/gitwatch downstream remove <watcherId> <downstreamId>`

Unpair a downstream. Its pair queue is stopped and removed from the index.

### Prompt customization

#### `/gitwatch template <watcherId> <downstreamId>`

Show the current prompt template for a downstream, along with the list of available placeholders.

#### `/gitwatch template <watcherId> <downstreamId> <new template…>`

Replace the template. Everything after the downstream ID becomes the new template — newlines are preserved, so you can paste a multi-line prompt in one message.

Available placeholders (replaced per run):

| Placeholder | Example |
|---|---|
| `{upstream_repo}` | `acme/api` |
| `{upstream_branch}` | `main` |
| `{downstream_repo}` | `acme/web` |
| `{downstream_branch}` | `main` |
| `{pr_number}` | `42` |
| `{pr_url}` | `https://github.com/acme/api/pull/42` |
| `{issue_labels}` | `sync` |

The agent always has the hard contract from the system prompt on top (impact-analysis method, output sentinels, no code changes) — your template supplies the task specifics, not the rules.

#### `/gitwatch template <watcherId> <downstreamId> reset`

Restore the default template.

### Operations

#### `/gitwatch status`

Per-pair counters: how many jobs are pending, processing, failed.

#### `/gitwatch queue <watcherId> <downstreamId>`

Full list of jobs for one pair, with status, attempts, and error (if any).

#### `/gitwatch logs [watcherId] [downstreamId]`

The 10 most recent run-log entries. Each line shows the outcome (`success` with issue URL, `skipped` with reason, or `failed` with error). Without args, logs across all pairs.

#### `/gitwatch retry <jobId> <watcherId> <downstreamId>`

Reset a failed job back to `pending` with `attempts=0` and wake the worker. Useful after fixing a misconfiguration.

#### `/gitwatch test <watcherId> <prNumber>`

Manually enqueue jobs for a given PR number on every downstream of a watcher, as if the webhook had just fired. Handy for dry-running a change without having to merge a real PR.

### Diagnostics

#### `/gitwatch doctor`

Health check. Reports `gh` authentication, tunnel status, and watcher count.

#### `/gitwatch webhook-redeploy`

Re-register every watcher's webhook with the current tunnel URL. Runs automatically on `tunnel:started`, but you can trigger it manually after a tunnel restart.

---

## The outcome contract

Every AI session ends by emitting exactly one of these lines, then stopping:

| Sentinel | Meaning | Logged as |
|---|---|---|
| `ISSUE_CREATED: <url>` | Impact found and a new issue was filed | `success` + issueUrl |
| `ISSUE_EXISTS: <url>` | An issue for this PR already existed in the downstream | `success` + issueUrl |
| `ISSUE_SKIPPED: <reason>` | No real impact — on purpose, no issue created | `skipped` + reason |
| `ERROR: <reason>` | Something went wrong the agent could not handle | retried, then `failed` |

`ISSUE_SKIPPED` is what keeps this sustainable on high-traffic upstreams: formatting PRs, internal refactors, test-only changes, and unrelated new features do not produce noise in your downstream issue tracker.

---

## Session strategies

Each downstream has a `sessionStrategy` that controls how AI sessions are reused across PR triggers:

- `per-trigger` (default) — every PR gets a fresh session. Safest. Highest cost.
- `rolling` — reuse the current session until it hits `maxTurns` (default 10) or `maxAge` (default `24h`), then spin up a new one
- `persistent` — one session per downstream, forever. Preserves full context but costs grow unbounded.

The defaults are set at `/gitwatch downstream add` time. Advanced: edit the watcher store directly at `~/.openacp/plugins/data/@openacp/git-watcher/` if you need to switch strategies for an existing downstream.

---

## Troubleshooting

### `❌ Tunnel not active` in `/gitwatch doctor`

The `@openacp/tunnel` plugin is either not enabled or has not finished starting. `/tunnel` should print a URL; if it does not, check the tunnel plugin config.

### `webhook rejected — no signature (webhook was created without a secret)`

An old webhook is pointing at this endpoint that was created without an HMAC secret. Recreate:

```text
/gitwatch remove <watcherId>
/gitwatch add <repo> <branch>
```

### `webhook rejected — invalid signature`

The watcher's stored secret does not match what GitHub is signing with. This happens if the webhook was edited on github.com to remove or change the secret. Remove and recreate the watcher.

### `Agent "…" is not installed`

Install the agent, or pick one that is:

```bash
openacp agents list                                 # see what's available
openacp agents install <name>                       # install one
```

Then recreate the downstream (or pass `[agent]` explicitly in `/gitwatch downstream add`).

### `fatal: Remote branch <name> not found in upstream origin`

The branch you gave to `/gitwatch add` or `/gitwatch downstream add` does not exist in that repo. Check with:

```bash
gh api repos/<owner>/<repo>/branches --jq '.[].name'
```

### Jobs are stuck in `processing` after an OpenACP restart

Boot recovery resets them to `pending` and notifies workers automatically on next start. If you see one still stuck, `/gitwatch retry <jobId> <watcherId> <downstreamId>` forces a re-drain.

---

## Development

```bash
npm install
npm run build                   # tsc
npm test                        # vitest
npm run dev                     # tsc --watch

# Hot-reload against a running OpenACP instance
openacp dev .
```

> Note on hot-reload: the dev watcher reloads on changes to `dist/index.js` specifically. After editing a helper file, `touch dist/index.js` to force a reload.

## License

MIT
