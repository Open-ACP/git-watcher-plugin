import type { PluginStorage } from '@openacp/plugin-sdk'
import type { RunLogEntry } from '../types.js'

const RUN_LOG_KEY = 'run-log'
const MAX_ENTRIES = 100

export class RunLog {
  constructor(private storage: PluginStorage) {}

  async getAll(): Promise<RunLogEntry[]> {
    return (await this.storage.get<RunLogEntry[]>(RUN_LOG_KEY)) ?? []
  }

  async append(entry: RunLogEntry): Promise<void> {
    const entries = await this.getAll()
    entries.push(entry)
    // Keep only the last MAX_ENTRIES entries
    const trimmed = entries.slice(-MAX_ENTRIES)
    await this.storage.set(RUN_LOG_KEY, trimmed)
  }

  async getForPair(watcherId: string, downstreamId: string): Promise<RunLogEntry[]> {
    const all = await this.getAll()
    return all.filter((e) => e.watcherId === watcherId && e.downstreamId === downstreamId)
  }

  async clear(): Promise<void> {
    await this.storage.set(RUN_LOG_KEY, [])
  }
}
