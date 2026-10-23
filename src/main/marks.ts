import { open, stat } from 'node:fs/promises'
import { parseMarks, type Mark } from '@shared/marks'

interface Cached {
  /** Bytes read so far, up to the last complete line. */
  offset: number
  marks: Mark[]
}

/** A session's marks from its transcript, read incrementally: only what was appended since the last call. */
export class MarksReader {
  private cache = new Map<string, Cached>()

  async read(file: string): Promise<Mark[]> {
    const size = (await stat(file)).size
    let c = this.cache.get(file)
    // A rewritten (shorter) file starts over.
    if (!c || size < c.offset) c = { offset: 0, marks: [] }
    if (size > c.offset) {
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(size - c.offset)
        await fh.read(buf, 0, buf.length, c.offset)
        const end = buf.lastIndexOf(0x0a) + 1
        if (end > 0) c = { offset: c.offset + end, marks: [...c.marks, ...parseMarks(buf.subarray(0, end).toString('utf8'))] }
      } finally {
        await fh.close()
      }
    }
    this.cache.set(file, c)
    return c.marks
  }
}
