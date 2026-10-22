import { SESSION_PORT_MESSAGE } from '@shared/types'

type Handler = (port: MessagePort) => void

const handlers = new Map<string, Handler>()
const waiting = new Map<string, MessagePort>()

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== SESSION_PORT_MESSAGE || !e.ports[0]) return
  const id: string = e.data.id
  const port = e.ports[0]
  const h = handlers.get(id)
  if (h) h(port)
  else waiting.set(id, port)
})

/** Delivers every port main sends for this session, including one that arrived before subscribing. */
export function onPort(id: string, h: Handler): () => void {
  handlers.set(id, h)
  const early = waiting.get(id)
  if (early) {
    waiting.delete(id)
    h(early)
  }
  return () => {
    if (handlers.get(id) === h) handlers.delete(id)
  }
}
