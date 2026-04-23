import type { Downstream } from '../types.js'

// Exported so PairWorker can import it
export interface SessionHandle {
  sessionId: string
  turnCount: number
  createdAt: string
}

export interface SessionResolverResult {
  sessionId: string | null  // null = create new session
  reuseExisting: boolean
}

/** Parse ms from strings like '24h', '2h', '30m', '3600000' */
function parseMs(value: string): number {
  const h = value.match(/^(\d+)h$/)
  if (h) return parseInt(h[1]) * 3600000
  const m = value.match(/^(\d+)m$/)
  if (m) return parseInt(m[1]) * 60000
  const n = parseInt(value)
  return isNaN(n) ? 86400000 : n  // default 24h
}

/**
 * Determines whether to reuse an existing session or create a new one
 * based on the downstream's sessionStrategy and current session state.
 */
export function resolveSession(downstream: Downstream): SessionResolverResult {
  switch (downstream.sessionStrategy) {
    case 'per-trigger':
      // Always create a new session for every PR trigger
      return { sessionId: null, reuseExisting: false }

    case 'persistent':
      // Always reuse the same session (never replace)
      if (downstream.currentSessionId) {
        return { sessionId: downstream.currentSessionId, reuseExisting: true }
      }
      return { sessionId: null, reuseExisting: false }

    case 'rolling': {
      // Reuse the current session unless it's exhausted (too many turns or too old)
      if (!downstream.currentSessionId) {
        return { sessionId: null, reuseExisting: false }
      }
      const maxTurns = downstream.sessionLimits.maxTurns ?? 10
      const maxAgeMs = parseMs(downstream.sessionLimits.maxAge ?? '24h')
      const turnCount = downstream.sessionTurnCount ?? 0
      const createdAt = downstream.sessionCreatedAt
        ? new Date(downstream.sessionCreatedAt).getTime()
        : 0
      const ageMs = Date.now() - createdAt

      if (turnCount >= maxTurns || ageMs >= maxAgeMs) {
        // Session exhausted — create a new one
        return { sessionId: null, reuseExisting: false }
      }
      return { sessionId: downstream.currentSessionId, reuseExisting: true }
    }

    default:
      return { sessionId: null, reuseExisting: false }
  }
}
