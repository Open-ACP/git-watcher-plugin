/**
 * Normalize a user-supplied repo reference to the canonical `owner/repo` form.
 *
 * Accepts:
 *   - `owner/repo`
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo.git`
 *   - `git@github.com:owner/repo.git`
 *   - Any of the above with trailing slash or extra path segments (pulls, tree/...)
 *
 * Returns null if the input does not look like a valid repo reference.
 */
export function parseRepoInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`

  // https://github.com/owner/repo[/...][.git]
  const urlMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i)
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2]}`

  // Bare owner/repo — exactly one slash, no scheme
  const bareMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (bareMatch) return `${bareMatch[1]}/${bareMatch[2]}`

  return null
}
