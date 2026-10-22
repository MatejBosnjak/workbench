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

/** Read-only Productive REST client. The token comes from the login shell (keychain via ~/.zprofile). */
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

  private async get(path: string, query: string[]): Promise<JsonApiDoc> {
    const env = await shellEnv()
    const token = env.PRODUCTIVE_AUTH_TOKEN
    if (!token) throw new Error('PRODUCTIVE_AUTH_TOKEN is not set in the login shell')
    const headers: Record<string, string> = { 'X-Auth-Token': token, 'Content-Type': 'application/vnd.api+json' }
    if (this.orgId) headers['X-Organization-Id'] = this.orgId
    const res = await fetch(`${API}${path}?${query.join('&')}`, { headers })
    const doc = (await res.json()) as JsonApiDoc
    if (!res.ok || doc.errors) throw new Error(doc.errors?.[0]?.detail ?? doc.errors?.[0]?.title ?? `HTTP ${res.status}`)
    return doc
  }
}
