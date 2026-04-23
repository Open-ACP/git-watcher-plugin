import { describe, it, expect } from 'vitest'
import { parseRepoInput } from '../utils/parse-repo.js'

describe('parseRepoInput', () => {
  it('accepts bare owner/repo', () => {
    expect(parseRepoInput('octocat/hello-world')).toBe('octocat/hello-world')
  })

  it('accepts https GitHub URL', () => {
    expect(parseRepoInput('https://github.com/octocat/hello-world')).toBe('octocat/hello-world')
  })

  it('strips .git suffix', () => {
    expect(parseRepoInput('https://github.com/octocat/hello-world.git')).toBe('octocat/hello-world')
    expect(parseRepoInput('octocat/hello-world.git')).toBe('octocat/hello-world')
  })

  it('strips trailing slash and extra path segments', () => {
    expect(parseRepoInput('https://github.com/octocat/hello-world/')).toBe('octocat/hello-world')
    expect(parseRepoInput('https://github.com/octocat/hello-world/pull/5')).toBe('octocat/hello-world')
    expect(parseRepoInput('https://github.com/octocat/hello-world/tree/main')).toBe('octocat/hello-world')
  })

  it('accepts SSH clone URL', () => {
    expect(parseRepoInput('git@github.com:octocat/hello-world.git')).toBe('octocat/hello-world')
  })

  it('trims whitespace', () => {
    expect(parseRepoInput('  octocat/hello-world  ')).toBe('octocat/hello-world')
  })

  it('returns null for invalid input', () => {
    expect(parseRepoInput('')).toBeNull()
    expect(parseRepoInput('not-a-repo')).toBeNull()
    expect(parseRepoInput('too/many/slashes')).toBeNull()
  })
})
