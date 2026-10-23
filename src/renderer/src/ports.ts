import { SESSION_PORT_MESSAGE } from '@shared/types'

type Handler = (port: MessagePort) => void

const handlers = new Map<string, Handler>()

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== SESSION_PORT_MESSAGE || !e.ports[0]) return
  const id: string = e.data.id
  const port = e.ports[0]
  const h = handlers.get(id)
  // Every view subscribes before it asks main to attach, so a port nobody listens for was pushed unasked
  // (e.g. a service restart while Local is closed). Left open it would queue output until the view opens;
  // main replays history on the next attach anyway.
  if (h) h(port)
  else port.close()
})

/** Delivers every port main sends for this session from now on; subscribe before asking main to attach. */
export function onPort(id: string, h: Handler): () => void {
  handlers.set(id, h)
  return () => {
    if (handlers.get(id) === h) handlers.delete(id)
  }
}
