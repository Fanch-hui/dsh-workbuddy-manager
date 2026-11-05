import { chatOf, systemOn, unsignedOn, withSystem } from './rewrite.js'

const NAME_OK = /^[A-Za-z0-9_-]+$/
const NUL_ESCAPE = /\\\\|\\0(?![0-9])/g
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
const SUB_ONE = ['items', 'additionalItems', 'unevaluatedItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'additionalProperties', 'unevaluatedProperties']
const SUB_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems']
const SUB_MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const BOOL_OK = new Set(['additionalProperties', 'unevaluatedProperties'])

function safeName(name: string, taken: Set<string>): string {
  const base = String(name).replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
  let n = base
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
  taken.add(n)
  return n
}

export function fitSchema(s: any, depth = 0): boolean {
  if (!s || typeof s !== 'object' || depth > 64) return false
  let changed = false
  if (Array.isArray(s)) {
    for (const v of s) if (fitSchema(v, depth + 1)) changed = true
    return changed
  }
  if (typeof s.pattern === 'string' && s.pattern.includes('\\0')) {
    const p = s.pattern.replace(NUL_ESCAPE, (m: string) => (m === '\\\\' ? m : '\\u0000'))
    if (p !== s.pattern) { s.pattern = p; changed = true }
  }
  if (Array.isArray(s.items)) {
    const list = s.items.filter((v: any) => v && typeof v === 'object')
    s.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list }
    delete s.additionalItems
    changed = true
  }
  for (const v of Object.values(s)) if (fitSchema(v, depth + 1)) changed = true
  return changed
}

function valueType(v: any): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function fitEnum(s: any): boolean {
  if (!('enum' in s)) return false
  if (!Array.isArray(s.enum) || s.enum.length === 0) {
    delete s.enum
    return true
  }
  const listed = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : []
  if (listed.filter((t: any) => t !== 'null').length === 1) return false
  const byType = new Map<string, any[]>()
  for (const v of s.enum) {
    const t = valueType(v)
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(v)
  }
  if (byType.has('integer') && byType.has('number')) {
    byType.get('number')!.push(...byType.get('integer')!)
    byType.delete('integer')
  }
  const hasNull = byType.delete('null')
  if (byType.size <= 1) {
    const [t] = byType.keys()
    const want = t === undefined ? 'null' : hasNull ? [t, 'null'] : t
    if (JSON.stringify(want) === JSON.stringify(s.type)) return false
    s.type = want
    return true
  }
  const split: any[] = [...byType].map(([t, vs]) => ({ type: t, enum: vs }))
  if (hasNull) split.push({ type: 'null' })
  delete s.enum
  delete s.type
  if (Array.isArray(s.anyOf)) s.allOf = [...(Array.isArray(s.allOf) ? s.allOf : []), { anyOf: split }]
  else s.anyOf = split
  return true
}

function subSchema(v: any, key: string): any {
  if (typeof v !== 'boolean' || BOOL_OK.has(key)) return v
  return v ? {} : { not: {} }
}

export function fitShape(s: any, depth = 0): boolean {
  if (!s || typeof s !== 'object' || Array.isArray(s) || depth > 64) return false
  let changed = false
  if ('type' in s) {
    const list = (Array.isArray(s.type) ? s.type : [s.type])
      .map((t: any) => (typeof t === 'string' ? t.toLowerCase() : t))
      .filter((t: any) => TYPES.has(t))
    const uniq = [...new Set(list)]
    const want = uniq.length === 0 ? undefined : uniq.length === 1 ? uniq[0] : uniq
    if (JSON.stringify(want) !== JSON.stringify(s.type)) {
      if (want === undefined) delete s.type
      else s.type = want
      changed = true
    }
  }
  if ('required' in s && !Array.isArray(s.required)) {
    delete s.required
    changed = true
  } else if (Array.isArray(s.required) && s.required.some((k: any) => typeof k !== 'string')) {
    s.required = s.required.filter((k: any) => typeof k === 'string')
    changed = true
  }
  if (fitEnum(s)) changed = true
  for (const k of SUB_ONE) {
    if (!(k in s)) continue
    const v = subSchema(s[k], k)
    if (v !== s[k]) { s[k] = v; changed = true }
    if (fitShape(v, depth + 1)) changed = true
  }
  for (const k of SUB_LIST) {
    if (!Array.isArray(s[k])) continue
    s[k].forEach((v0: any, i: number) => {
      const v = subSchema(v0, k)
      if (v !== v0) { s[k][i] = v; changed = true }
      if (fitShape(v, depth + 1)) changed = true
    })
  }
  for (const k of SUB_MAP) {
    const m = s[k]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    for (const [name, v0] of Object.entries(m)) {
      const v = subSchema(v0, k)
      if (v !== v0) { m[name] = v; changed = true }
      if (fitShape(v, depth + 1)) changed = true
    }
  }
  return changed
}

function localRef(root: any, s: any): any {
  const ref = s?.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return s
  let at = root
  for (const k of ref.slice(2).split('/')) at = at?.[k.replaceAll('~1', '/').replaceAll('~0', '~')]
  return at && typeof at === 'object' ? at : s
}

function objectBranch(root: any, b: any, seen: string[] = []): boolean {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false
  if ('type' in b) return b.type === 'object'
  if (typeof b.$ref !== 'string' || seen.includes(b.$ref) || seen.length > 16) return false
  const t = localRef(root, b)
  return t !== b && objectBranch(root, t, [...seen, b.$ref])
}

export function typeUnions(s: any, root: any = s, depth = 0): boolean {
  if (!s || typeof s !== 'object' || Array.isArray(s) || depth > 64) return false
  let changed = false
  if (!('type' in s) && Array.isArray(s.oneOf) && s.oneOf.length && s.oneOf.every((b: any) => objectBranch(root, b))) {
    s.type = 'object'
    changed = true
  }
  for (const k of SUB_ONE) if (typeUnions(s[k], root, depth + 1)) changed = true
  for (const k of SUB_LIST) for (const v of Array.isArray(s[k]) ? s[k] : []) if (typeUnions(v, root, depth + 1)) changed = true
  for (const k of SUB_MAP) {
    const m = s[k]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    for (const v of Object.values(m)) if (typeUnions(v, root, depth + 1)) changed = true
  }
  return changed
}

export function objectRoot(ps: any, root: any = ps, depth = 0): boolean {
  const unions = ['allOf', 'anyOf', 'oneOf'].filter(k => Array.isArray(ps[k]))
  if (ps.type === 'object' && !unions.length) return false
  const props: Record<string, any> = ps.properties && typeof ps.properties === 'object' ? ps.properties : {}
  const required: string[] = Array.isArray(ps.required) ? [...ps.required] : []
  for (const b0 of ps.allOf ?? []) {
    let b = localRef(root, b0)
    if (!b || typeof b !== 'object') continue
    if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some(k => Array.isArray(b[k]))) objectRoot((b = structuredClone(b)), root, depth + 1)
    for (const [k, v] of Object.entries(b.properties ?? {})) if (!(k in props)) props[k] = v
    if (Array.isArray(b.required)) required.push(...b.required)
  }
  const branches: any[] = []
  for (const key of ['anyOf', 'oneOf']) {
    for (const b0 of ps[key] ?? []) {
      let b = localRef(root, b0)
      if (!b || typeof b !== 'object') continue
      if (depth < 8 && ['allOf', 'anyOf', 'oneOf'].some(k => Array.isArray(b[k]))) objectRoot((b = structuredClone(b)), root, depth + 1)
      if (b.type !== 'object' && !b.properties) continue
      branches.push(b)
    }
  }
  const from = new Map<string, any[]>()
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      if (k in props) continue
      const seen = from.get(k) ?? []
      if (!seen.some(x => JSON.stringify(x) === JSON.stringify(v))) seen.push(v)
      from.set(k, seen)
    }
  }
  for (const [k, list] of from) props[k] = list.length === 1 ? list[0] : { anyOf: list }
  if (branches.length) {
    for (const k of Object.keys(branches[0].properties ?? {})) {
      if (branches.every(b => Array.isArray(b.required) && b.required.includes(k))) required.push(k)
    }
  }
  for (const k of unions) delete ps[k]
  ps.type = 'object'
  ps.properties = props
  const req = [...new Set(required)].filter(k => typeof k === 'string' && k in props)
  if (req.length) ps.required = req
  else delete ps.required
  return true
}

export function fitTools(b: any): { changed: boolean; names: Map<string, string> } {
  const names = new Map<string, string>()
  if (!Array.isArray(b?.tools) || !b.tools.length) return { changed: false, names }
  let changed = false
  const taken = new Set<string>()
  for (const t of b.tools) {
    const n = t?.function?.name
    if (typeof n === 'string' && NAME_OK.test(n)) taken.add(n)
  }
  const theirs = new Map<string, string>()
  for (const t of b.tools) {
    const fn = t?.type === 'function' || t?.function ? t.function : null
    if (!fn || typeof fn !== 'object') continue
    if (typeof fn.name === 'string' && !NAME_OK.test(fn.name)) {
      const safe = safeName(fn.name, taken)
      names.set(safe, fn.name)
      theirs.set(fn.name, safe)
      fn.name = safe
      changed = true
    }
    if (fn.parameters === undefined) continue
    if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) {
      fn.parameters = { type: 'object', properties: {} }
      changed = true
      continue
    }
    if (fitSchema(fn.parameters)) changed = true
    if (fitShape(fn.parameters)) changed = true
    if (typeUnions(fn.parameters)) changed = true
    if (objectRoot(fn.parameters)) changed = true
  }
  if (theirs.size && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      for (const c of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        const safe = theirs.get(c?.function?.name)
        if (safe) c.function.name = safe
      }
      if (m?.role === 'tool' && theirs.has(m.name)) m.name = theirs.get(m.name)
    }
  }
  const choice = b.tool_choice?.function
  if (choice && theirs.has(choice.name)) choice.name = theirs.get(choice.name)
  return { changed, names }
}

export function toolChoiceOn(b: any): boolean {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !('tool_choice' in b)) return false
  const choice = b.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() !== 'none') return false
    delete b.tool_choice; delete b.tools; delete b.functions
    return true
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) { delete b.tool_choice; return true }
  const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
  if (type === 'none') { delete b.tool_choice; delete b.tools; delete b.functions }
  else if (type === 'auto' || type === 'required') b.tool_choice = type
  else if (type === 'function') {
    const fn = choice.function && typeof choice.function === 'object' && !Array.isArray(choice.function) ? choice.function : undefined
    b.tool_choice = (typeof fn?.name === 'string' ? fn.name.trim() : '') || 'auto'
  } else delete b.tool_choice
  return true
}

export function prepared(body: string, native = false): { body: string; chat: Record<string, any> | null; names: Map<string, string>; changed: boolean } {
  const chat = chatOf(body)
  if (!chat) return { body, chat: null, names: new Map(), changed: false }
  if (native) return { body, chat, names: new Map(), changed: unsignedOn(chat) }
  try {
    let changed = systemOn(chat)
    const fit = fitTools(chat)
    if (fit.changed) changed = true
    if (toolChoiceOn(chat)) changed = true
    return { body, chat, names: fit.names, changed }
  } catch {
    const s = withSystem(body)
    const c = chatOf(s)
    if (!c) return { body: s, chat: null, names: new Map(), changed: false }
    const fit = fitTools(c)
    toolChoiceOn(c)
    return { body: JSON.stringify(c), chat: c, names: fit.names, changed: false }
  }
}
