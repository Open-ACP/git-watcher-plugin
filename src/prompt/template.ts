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

/**
 * Parse the AI output to find ISSUE_CREATED or ISSUE_EXISTS lines.
 * Returns the issue URL if found, or null.
 */
export function parseIssueUrl(output: string): { status: 'created' | 'exists'; url: string } | null {
  for (const line of output.split('\n')) {
    const created = line.match(/^ISSUE_CREATED:\s*(https?:\/\/\S+)/)
    if (created) return { status: 'created', url: created[1] }
    const exists = line.match(/^ISSUE_EXISTS:\s*(https?:\/\/\S+)/)
    if (exists) return { status: 'exists', url: exists[1] }
  }
  return null
}
