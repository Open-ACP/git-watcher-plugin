import { describe, it, expect } from 'vitest'
import plugin from '../index.js'

describe('@openacp/git-watcher', () => {
  it('has correct metadata', () => {
    expect(plugin.name).toBe('@openacp/git-watcher')
    expect(plugin.version).toBeDefined()
    expect(plugin.setup).toBeInstanceOf(Function)
  })

  it('declares required permissions', () => {
    expect(Array.isArray(plugin.permissions)).toBe(true)
    expect(plugin.permissions).toContain('commands:register')
    expect(plugin.permissions).toContain('storage:read')
    expect(plugin.permissions).toContain('storage:write')
  })

  it('teardown is defined', () => {
    expect(typeof plugin.teardown).toBe('function')
  })

  it('install is defined', () => {
    expect(typeof plugin.install).toBe('function')
  })
})
