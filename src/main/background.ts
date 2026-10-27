import { open, stat } from 'node:fs/promises'
import { scanBackground, type BackgroundTask } from '@shared/background'

interface Cached {
  /** Bytes read so far, up to the last complete line. */
  offset: number
  pending: Map<string, BackgroundTask>
  names: Map<string, string>
}

/** A session's background tasks still out, from its transcript, read incrementally like MarksReader. */
export class BackgroundReader {
  private cache = new Map<string, Cached>()

  /** Tasks launched since `since` (the claude process's start; older ones died with their process) and not back yet. */
  async read(file: string, since: number): Promise<BackgroundTask[]> {
    const size = (await stat(file)).size
    let c = this.cache.get(file)
    if (!c || size < c.offset) c = { offset: 0, pending: new Map(), names: new Map() }
    if (size > c.offset) {
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(size - c.offset)
        await fh.read(buf, 0, buf.length, c.offset)
        const end = buf.lastIndexOf(0x0a) + 1
        if (end > 0) {
          scanBackground(buf.subarray(0, end).toString('utf8'), c.pending, c.names)
          c.offset += end
        }
      } finally {
        await fh.close()
      }
    }
    this.cache.set(file, c)
    return [...c.pending.values()].filter((t) => t.at >= since)
  }
}
