import { describe, it, expect } from 'vitest'
import { fillTemplate, parseIssueUrl } from '../prompt/template.js'

const vars = {
  upstream_repo: 'owner/backend',
  upstream_branch: 'main',
  downstream_repo: 'owner/frontend',
  downstream_branch: 'main',
  pr_number: 42,
  pr_url: 'https://github.com/owner/backend/pull/42',
  issue_labels: 'sync,backend',
}

describe('fillTemplate', () => {
  it('replaces all placeholders', () => {
    const template = '{upstream_repo} {downstream_repo} PR #{pr_number} {pr_url}'
    const result = fillTemplate(template, vars)
    expect(result).toBe('owner/backend owner/frontend PR #42 https://github.com/owner/backend/pull/42')
  })

  it('replaces multiple occurrences', () => {
    const template = '{pr_number} and {pr_number}'
    expect(fillTemplate(template, vars)).toBe('42 and 42')
  })
})

describe('parseIssueUrl', () => {
  it('parses ISSUE_CREATED line', () => {
    const output = 'Some analysis\nISSUE_CREATED: https://github.com/owner/frontend/issues/10\nDone'
    const result = parseIssueUrl(output)
    expect(result).toEqual({ status: 'created', url: 'https://github.com/owner/frontend/issues/10' })
  })

  it('parses ISSUE_EXISTS line', () => {
    const output = 'ISSUE_EXISTS: https://github.com/owner/frontend/issues/5'
    const result = parseIssueUrl(output)
    expect(result).toEqual({ status: 'exists', url: 'https://github.com/owner/frontend/issues/5' })
  })

  it('returns null when no issue line found', () => {
    expect(parseIssueUrl('Some output without issue lines')).toBeNull()
  })
})
