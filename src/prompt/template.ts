export interface TemplateVars {
  upstream_repo: string
  upstream_branch: string
  downstream_repo: string
  downstream_branch: string
  pr_number: number
  pr_url: string
  issue_labels: string
}

/**
 * Fill a prompt template with variables from {key} placeholders.
 */
export function fillTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{upstream_repo\}/g, vars.upstream_repo)
    .replace(/\{upstream_branch\}/g, vars.upstream_branch)
    .replace(/\{downstream_repo\}/g, vars.downstream_repo)
    .replace(/\{downstream_branch\}/g, vars.downstream_branch)
    .replace(/\{pr_number\}/g, String(vars.pr_number))
    .replace(/\{pr_url\}/g, vars.pr_url)
    .replace(/\{issue_labels\}/g, vars.issue_labels)
}

export type OutcomeKind = 'created' | 'exists' | 'skipped' | 'error'
export interface Outcome {
  kind: OutcomeKind
  /** URL for created/exists, free-form reason for skipped/error. */
  value: string
}

/**
 * Parse the AI output for a terminal outcome line. The last matching line wins
 * (the agent may emit intermediate noise before the real verdict).
 */
export function parseOutcome(output: string): Outcome | null {
  let last: Outcome | null = null
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    const created = trimmed.match(/^ISSUE_CREATED:\s*(\S+)/)
    if (created) { last = { kind: 'created', value: created[1] }; continue }
    const exists = trimmed.match(/^ISSUE_EXISTS:\s*(\S+)/)
    if (exists) { last = { kind: 'exists', value: exists[1] }; continue }
    const skipped = trimmed.match(/^ISSUE_SKIPPED:\s*(.+)/)
    if (skipped) { last = { kind: 'skipped', value: skipped[1] }; continue }
    const err = trimmed.match(/^ERROR:\s*(.+)/)
    if (err) { last = { kind: 'error', value: err[1] }; continue }
  }
  return last
}

/** @deprecated — kept for backward compat; returns null for skipped/error. */
export function parseIssueUrl(output: string): { status: 'created' | 'exists'; url: string } | null {
  const outcome = parseOutcome(output)
  if (!outcome) return null
  if (outcome.kind === 'created' || outcome.kind === 'exists') {
    return { status: outcome.kind, url: outcome.value }
  }
  return null
}
