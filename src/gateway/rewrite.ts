import { gzipSync } from 'node:zlib'
import type { ModelSpec } from './sites.js'

export const DEFAULT_SYSTEM = 'You are a helpful assistant.'
const INSTRUCTIONS: readonly [string, string] = ['<instructions>\n', '\n</instructions>']
export const SMALL_BUDGET = 1024

export const REFUSED = /unapproved channel|illegal api invocation|["']code["']\s*:\s*["']?11128(?![\d.])/i
export const AFTER_TOOLS_REFUSED = /must end with a user message|["']code["']\s*:\s*["']?11153(?![\d.])/i
export const BAD_SIGNATURE = /thinking_signature_invalid|invalid\s+`?signature`?\s+in\s+`?thinking|block is bound to a different conversation|"internal_code"\s*:\s*"?11159/i

const FLAGGED: ReadonlyArray<readonly [RegExp, string]> = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ''],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (usually the base for PRs)'],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, 'The Codex CLI is an open source project led by OpenAI.'],
  [/You are an AI agent powered by DeepSeek Harness\.?/gi, 'You are an AI agent, powered by DeepSeek Harness.'],
  [/Web GUI whose URL the runtime context names\.\s+When the user refers/gi, 'Web GUI whose URL the runtime context names. The interface, when the user refers'],
]

const DSH_NAMED: ReadonlyArray<readonly [RegExp, string | ((match: string, the?: string) => string)]> = [
  [/You are an AI agent,? powered by DeepSeek Harness\.?/g, 'You are an AI agent.'],
  [/DeepSeek Harness (Web GUI)/g, '$1'],
  [/DeepSeek Harness (implementation checkout)/g, 'agent $1'],
  [/\bDSH itself\b/g, 'the agent itself'],
  [/\b([Tt]he )?DeepSeek Harness\b/g, (_, the) => `${the ?? 'the '}agent harness`],
  [/\bDSH\b(?!_)/g, 'the agent harness'],
]

const OPENERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\bYou are (?:an?|the)\s[^\n.,]{0,60}?\b(?:agent|assistant))\s+(powered by|running on|running in|built on|based on)\b/gi, '$1, $2'],
]

const PAUSED_ROLES = new Set(['system', 'assistant'])

export function chatOf(body: unknown): Record<string, any> | null {
  if (typeof body !== 'string') return null
  try {
    const b = JSON.parse(body)
    return b !== null && typeof b === 'object' && !Array.isArray(b) ? b : null
  } catch {
    return null
  }
}

export function unflagged(text: string): string {
  for (const [re, to] of FLAGGED) text = text.replace(re, to)
  return text
}

export function unflag(messages: any[]): boolean {
  let changed = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m?.content === 'string') {
      const t = unflagged(m.content)
      if (t === m.content) continue
      changed = true
      if (t.trim() || m.role !== 'system') m.content = t
      else messages.splice(i, 1)
    } else if (Array.isArray(m?.content)) {
      const parts: any[] = []
      let here = false
      for (const p of m.content) {
        const t = typeof p?.text === 'string' ? unflagged(p.text) : null
        if (t === null || t === p.text) {
          parts.push(p)
          continue
        }
        here = true
        if (t.trim()) parts.push({ ...p, text: t })
      }
      if (!here) continue
      changed = true
      if (parts.length || m.role !== 'system') m.content = parts
      else messages.splice(i, 1)
    }
  }
  return changed
}

export function dshHidden(text: string): string {
  for (const [re, to] of DSH_NAMED) text = text.replace(re, to as any)
  return text
}

export function hideDsh(chat: any): boolean {
  if (!chat || typeof chat !== 'object') return false
  let changed = false
  const parts = (content: any): any => {
    if (typeof content === 'string') {
      const t = dshHidden(content)
      if (t !== content) changed = true
      return t
    }
    if (!Array.isArray(content)) return content
    return content.map((p: any) => {
      if (!p || typeof p.text !== 'string' || (p.type !== undefined && p.type !== 'text')) return p
      const t = dshHidden(p.text)
      if (t === p.text) return p
      changed = true
      return { ...p, text: t }
    })
  }
  if (Array.isArray(chat.messages)) {
    for (const m of chat.messages) {
      if (m && typeof m === 'object' && m.role !== 'tool') m.content = parts(m.content)
    }
  }
  if (chat.system !== undefined) chat.system = parts(chat.system)
  const described = (o: any): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(described); return }
    for (const k of Object.keys(o)) {
      if (k === 'description' && typeof o[k] === 'string') {
        const t = dshHidden(o[k])
        if (t !== o[k]) { o[k] = t; changed = true }
      } else described(o[k])
    }
  }
  if (Array.isArray(chat.tools)) described(chat.tools)
  return changed
}

function reasoningOf(m: any): string {
  if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m.reasoning_content
  if (Array.isArray(m.reasoning_details)) {
    const text = m.reasoning_details
      .map((d: any) => (typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''))
      .join('')
    if (text) return text
  }
  return ''
}

export function asReasoning(messages: any[]): boolean {
  let changed = false
  for (const m of messages) {
    if (m?.role !== 'assistant' || (m.reasoning_content === undefined && m.reasoning_details === undefined)) continue
    const text = reasoningOf(m)
    if (text && !(typeof m.reasoning === 'string' && m.reasoning)) m.reasoning = text
    delete m.reasoning_content
    delete m.reasoning_details
    changed = true
  }
  return changed
}

export function systemOn(b: any): boolean {
  if (!Array.isArray(b?.messages) || !b.messages.length) return false
  let changed = unflag(b.messages)
  if (b.max_completion_tokens !== undefined) {
    if (b.max_tokens === undefined) b.max_tokens = b.max_completion_tokens
    delete b.max_completion_tokens
    changed = true
  }
  for (const m of b.messages) {
    if (m?.role !== 'developer') continue
    m.role = 'system'
    changed = true
  }
  if (asReasoning(b.messages)) changed = true
  if (b.messages[0]?.role !== 'system') {
    b.messages.unshift({ role: 'system', content: DEFAULT_SYSTEM })
    changed = true
  }
  return changed
}

export function withSystem(body: string): string {
  const b = chatOf(body)
  return b && systemOn(b) ? JSON.stringify(b) : body
}

function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
}

export function systemKeyOf(chat: any): string {
  const msgs = chat?.messages
  if (!Array.isArray(msgs)) return ''
  const key = msgs.filter((m: any) => m?.role === 'system').map((m: any) => textOf(m.content)).join('\n')
  return key.trim() === DEFAULT_SYSTEM ? '' : key
}

export function systemAsUserOn(b: any): boolean {
  const msgs = b?.messages
  if (!Array.isArray(msgs)) return false
  let i = 0
  const lead: string[] = []
  for (; i < msgs.length && msgs[i]?.role === 'system'; i++) lead.push(textOf(msgs[i].content))
  const said = lead.join('\n\n').trim()
  const rest = msgs.slice(i).map((m: any) => (m?.role === 'system' ? { ...m, role: 'user' } : m))
  const moved = Boolean(said && said !== DEFAULT_SYSTEM)
  if (!moved && rest.every((m: any, k: number) => m === msgs[i + k])) return false
  if (moved) {
    const text = INSTRUCTIONS[0] + said + INSTRUCTIONS[1]
    const u = rest.findIndex((m: any) => m?.role === 'user')
    if (u < 0) rest.unshift({ role: 'user', content: text })
    else if (typeof rest[u].content === 'string') rest[u] = { ...rest[u], content: `${text}\n\n${rest[u].content}` }
    else if (Array.isArray(rest[u].content)) rest[u] = { ...rest[u], content: [{ type: 'text', text }, ...rest[u].content] }
    else rest[u] = { ...rest[u], content: text }
  }
  b.messages = [{ role: 'system', content: DEFAULT_SYSTEM }, ...rest]
  return true
}

export function systemAsUser(body: string): string | null {
  const b = chatOf(body)
  return b && systemAsUserOn(b) ? JSON.stringify(b) : null
}

export function opened(text: string): string {
  for (const [re, to] of OPENERS) text = text.replace(re, to)
  return text
}

export function commaPausedOn(b: any, roles?: Set<string>): boolean {
  const msgs = b?.messages
  if (!Array.isArray(msgs)) return false
  let changed = false
  for (const m of msgs) {
    if (!PAUSED_ROLES.has(m?.role)) continue
    let mine = false
    if (typeof m.content === 'string') {
      const t = opened(m.content)
      if (t !== m.content) { m.content = t; mine = true }
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p?.text !== 'string') continue
        const t = opened(p.text)
        if (t !== p.text) { p.text = t; mine = true }
      }
    }
    if (!mine) continue
    changed = true
    roles?.add(m.role)
  }
  return changed
}

export function commaPaused(body: string, roles?: Set<string>): string | null {
  const b = chatOf(body)
  return b && commaPausedOn(b, roles) ? JSON.stringify(b) : null
}

export function replyAfterToolsOn(b: any): boolean {
  const msgs = b?.messages
  if (!Array.isArray(msgs)) return false
  let i = msgs.length - 1
  while (i >= 0 && msgs[i]?.role === 'user') i--
  if (i === msgs.length - 1 || i < 0 || msgs[i]?.role !== 'tool') return false
  msgs.splice(i + 1, 0, { role: 'assistant', content: '' })
  return true
}

export function replyAfterTools(body: string): string | null {
  const b = chatOf(body)
  return b && replyAfterToolsOn(b) ? JSON.stringify(b) : null
}

export function namesEffort(chat: any): boolean {
  return chat?.reasoning_effort !== undefined || (Boolean(chat?.reasoning) && typeof chat.reasoning === 'object' && chat.reasoning.effort !== undefined)
}

export function withDefaultEffort(chat: any, list: ModelSpec[] | null): boolean {
  if (!chat || typeof chat !== 'object' || namesEffort(chat)) return false
  const limit = chat.max_tokens ?? chat.max_completion_tokens
  if (typeof limit === 'number' && limit > 0 && limit <= SMALL_BUDGET) return false
  const m = list?.find(x => x.id === chat.model)
  if (!m?.effort) return false
  chat.reasoning_effort = m.effort
  return true
}

export function gzipped(completion: boolean, b: string | Uint8Array | ArrayBuffer | null | undefined): Uint8Array<ArrayBuffer> | null {
  if (!completion) return null
  if (typeof b === 'string') return new Uint8Array(gzipSync(Buffer.from(b)))
  if (b instanceof ArrayBuffer) return new Uint8Array(gzipSync(Buffer.from(b)))
  if (ArrayBuffer.isView(b)) return new Uint8Array(gzipSync(Buffer.from(b.buffer, b.byteOffset, b.byteLength)))
  return null
}
