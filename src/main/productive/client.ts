import { shellEnv } from '../shell-env'

const API = 'https://api.productive.io/api/v2'

export interface JsonApiResource {
  id: string
  type: string
  attributes: Record<string, unknown>
  relationships?: Record<string, { data?: { id: string; type: string } | null }>
}

interface JsonApiDoc {
  data: JsonApiResource[]
  included?: JsonApiResource[]
  meta?: { total_pages?: number }
  errors?: { detail?: string; title?: string }[]
}

/** Rails-style nested query params: {a: {eq: ['1', '2']}} → filter[a][eq][]=1&filter[a][eq][]=2. */
export function encodeParams(prefix: string, value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => encodeParams(`${prefix}[]`, v, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) encodeParams(`${prefix}[${k}]`, v, out)
  else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`)
  return out
}

/** Productive REST client. The token comes from the login shell (keychain via ~/.zprofile). */
export class Productive {
  constructor(private orgId: string | null = null) {}

  setOrg(orgId: string): void {
    this.orgId = orgId
  }

  /** GETs every page of a collection. */
  async getAll(path: string, query: string[] = []): Promise<{ data: JsonApiResource[]; included: JsonApiResource[] }> {
    const data: JsonApiResource[] = []
    const included: JsonApiResource[] = []
    for (let page = 1; page <= 20; page++) {
      const doc = await this.get(path, [...query, `page%5Bsize%5D=200`, `page%5Bnumber%5D=${page}`])
      data.push(...doc.data)
      included.push(...(doc.included ?? []))
      if (!doc.meta?.total_pages || page >= doc.meta.total_pages) break
    }
    return { data, included }
  }

  async getOne(path: string, query: string[] = []): Promise<{ data: JsonApiResource; included: JsonApiResource[] }> {
    const doc = await this.request<{ data: JsonApiResource; included?: JsonApiResource[] }>('GET', `${path}?${query.join('&')}`)
    return { data: doc.data, included: doc.included ?? [] }
  }

  /** The only write. Callers go through the drafts confirm step first. */
  async post(path: string, body: unknown): Promise<JsonApiResource> {
    return (await this.request<{ data: JsonApiResource }>('POST', path, body)).data
  }

  private get(path: string, query: string[]): Promise<JsonApiDoc> {
    return this.request<JsonApiDoc>('GET', `${path}?${query.join('&')}`)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const env = await shellEnv()
    const token = env.PRODUCTIVE_AUTH_TOKEN
    if (!token) throw new Error('PRODUCTIVE_AUTH_TOKEN is not set in the login shell')
    const headers: Record<string, string> = { 'X-Auth-Token': token, 'Content-Type': 'application/vnd.api+json' }
    if (this.orgId) headers['X-Organization-Id'] = this.orgId
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const doc = (await res.json()) as T & Pick<JsonApiDoc, 'errors'>
    if (!res.ok || doc.errors) throw new Error(doc.errors?.[0]?.detail ?? doc.errors?.[0]?.title ?? `HTTP ${res.status}`)
    return doc
  }
}

const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Plain text with light Markdown (**bold**, `code`, "- " lists) → the HTML Productive stores for comments. */
export function commentHtml(text: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li><p>${inline(l.replace(/^\s*[-*] /, ''))}</p></li>`).join('')}</ul>`
      return `<p>${lines.map(inline).join('<br>')}</p>`
    })
    .join('')
}

/** Productive's stored HTML → plain text, for prompts. */
export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|li|h\d|div)>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
