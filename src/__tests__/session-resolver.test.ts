import { describe, it, expect } from 'vitest'
import { resolveSession } from '../workers/session-resolver.js'
import type { Downstream } from '../types.js'

function makeDownstream(overrides: Partial<Downstream> = {}): Downstream {
  return {
    id: 'down_1',
    repo: 'owner/frontend',
    branch: 'main',
    telegramTopicId: 1,
    issueLabels: ['sync'],
    promptTemplate: 'default',
    agent: 'claude-opus-4-5',
    sessionStrategy: 'per-trigger',
    sessionLimits: { maxTurns: 10, maxAge: '24h' },
    ...overrides,
  }
}

describe('resolveSession', () => {
  describe('per-trigger', () => {
    it('always returns null sessionId', () => {
      const result = resolveSession(makeDownstream({ sessionStrategy: 'per-trigger', currentSessionId: 'sess-1' }))
      expect(result.sessionId).toBeNull()
      expect(result.reuseExisting).toBe(false)
    })
  })

  describe('persistent', () => {
    it('returns existing session when set', () => {
      const result = resolveSession(makeDownstream({ sessionStrategy: 'persistent', currentSessionId: 'sess-1' }))
      expect(result.sessionId).toBe('sess-1')
      expect(result.reuseExisting).toBe(true)
    })

    it('returns null when no current session', () => {
      const result = resolveSession(makeDownstream({ sessionStrategy: 'persistent' }))
      expect(result.sessionId).toBeNull()
    })
  })

  describe('rolling', () => {
    it('reuses session when under limits', () => {
      const result = resolveSession(makeDownstream({
        sessionStrategy: 'rolling',
        currentSessionId: 'sess-1',
        sessionTurnCount: 5,
        sessionCreatedAt: new Date().toISOString(),
      }))
      expect(result.sessionId).toBe('sess-1')
      expect(result.reuseExisting).toBe(true)
    })

    it('creates new session when turn count exhausted', () => {
      const result = resolveSession(makeDownstream({
        sessionStrategy: 'rolling',
        currentSessionId: 'sess-1',
        sessionTurnCount: 10,
        sessionCreatedAt: new Date().toISOString(),
        sessionLimits: { maxTurns: 10, maxAge: '24h' },
      }))
      expect(result.sessionId).toBeNull()
      expect(result.reuseExisting).toBe(false)
    })

    it('creates new session when age exceeded', () => {
      const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
      const result = resolveSession(makeDownstream({
        sessionStrategy: 'rolling',
        currentSessionId: 'sess-1',
        sessionTurnCount: 1,
        sessionCreatedAt: old,
        sessionLimits: { maxTurns: 10, maxAge: '24h' },
      }))
      expect(result.sessionId).toBeNull()
    })

    it('returns null when no current session', () => {
      const result = resolveSession(makeDownstream({ sessionStrategy: 'rolling' }))
      expect(result.sessionId).toBeNull()
    })
  })
})
