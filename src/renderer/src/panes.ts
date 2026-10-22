import type { PaneNode, ServiceDef } from '@shared/local'

export const servicePaneId = (name: string) => `svc:${name}`
export const shellPaneId = (name: string, n: number) => `pane:${name}:${n}`

/** The prd layout: the service's output on the left, its shell panes stacked on the right. */
export function defaultLayout(def: ServiceDef): PaneNode {
  const main: PaneNode = { type: 'leaf', id: servicePaneId(def.name) }
  if (def.panes === 0) return main
  const shells: PaneNode[] = Array.from({ length: def.panes }, (_, i) => ({ type: 'leaf', id: shellPaneId(def.name, i) }))
  const right: PaneNode = shells.length === 1 ? shells[0]! : { type: 'split', id: `${def.name}/right`, dir: 'col', children: shells }
  return { type: 'split', id: `${def.name}/root`, dir: 'row', children: [main, right], sizes: { [main.id]: 58, [right.id]: 42 } }
}

export function leaves(n: PaneNode): string[] {
  return n.type === 'leaf' ? [n.id] : n.children.flatMap(leaves)
}

/** Splits a leaf, putting a new leaf after it in the given direction. */
export function splitPane(root: PaneNode, target: string, dir: 'row' | 'col', newId: string): PaneNode {
  const walk = (n: PaneNode): PaneNode => {
    if (n.type === 'leaf') {
      if (n.id !== target) return n
      return { type: 'split', id: `${target}/${newId}`, dir, children: [n, { type: 'leaf', id: newId }] }
    }
    // Same direction as the parent: add a sibling instead of nesting.
    const at = n.children.findIndex((c) => c.type === 'leaf' && c.id === target)
    if (at >= 0 && n.dir === dir) {
      const children = [...n.children]
      children.splice(at + 1, 0, { type: 'leaf', id: newId })
      return { ...n, children, sizes: undefined }
    }
    return { ...n, children: n.children.map(walk) }
  }
  return walk(root)
}

/** Removes a leaf; a split left with one child collapses into it. */
export function closePane(root: PaneNode, target: string): PaneNode {
  const walk = (n: PaneNode): PaneNode | null => {
    if (n.type === 'leaf') return n.id === target ? null : n
    const children = n.children.map(walk).filter((c): c is PaneNode => c !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]!
    return { ...n, children, sizes: children.length === n.children.length ? n.sizes : undefined }
  }
  return walk(root) ?? root
}

export function setSizes(root: PaneNode, splitId: string, sizes: Record<string, number>): PaneNode {
  if (root.type === 'leaf') return root
  if (root.id === splitId) return { ...root, sizes }
  return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) }
}

/** The lowest shell pane number not used in the layout. */
export function nextShellId(root: PaneNode, name: string): string {
  const used = new Set(leaves(root))
  let n = 0
  while (used.has(shellPaneId(name, n))) n++
  return shellPaneId(name, n)
}
