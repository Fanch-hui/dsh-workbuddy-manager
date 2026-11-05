import { createHash, randomBytes } from 'node:crypto'
import { hex, type AccountIdentity } from './sites.js'

export const SESSION = 'x-magpie-workbuddy-session'
const SALT = randomBytes(16).toString('hex')

export interface AttendedIds {
  set: string[]
  turn: string
  conv: string
}

export function idFor(kind: string, key: string | string[]): string {
  const h = createHash('sha256').update(`${SALT}|${kind}|`)
  let held = ''
  for (let piece of typeof key === 'string' ? [key] : key) {
    if (held) piece = held + piece
    held = ''
    const c = piece.charCodeAt(piece.length - 1)
    if (c >= 0xd800 && c <= 0xdbff) {
      held = piece.slice(-1)
      piece = piece.slice(0, -1)
    }
    h.update(piece)
  }
  if (held) h.update(held)
  return h.digest('hex').slice(0, 32)
}

export function signatureParts(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : []
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    const type = part?.type ?? ''
    if (type === '' || type === 'text') {
      if (typeof part?.text === 'string' && part.text) out.push(part.text)
    } else if (type !== 'tool_result' && type !== 'tool-result') {
      out.push(`[${type}:${createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 8)}]`)
    }
  }
  return out
}

export function signatureOf(content: unknown): string {
  return signatureParts(content).join('')
}

function hasBlock(m: any, type: string): boolean {
  return Array.isArray(m?.content) && m.content.some((p: any) => p?.type === type)
}

export function answeredBefore(msgs: any[], i: number): boolean {
  if (hasBlock(msgs[i], 'tool_result')) return true
  let j = i - 1
  while (j >= 0 && msgs[j]?.role === 'system') j--
  const prev = msgs[j]
  if (prev === null || typeof prev !== 'object') return false
  if (prev.role === 'tool') return true
  if (prev.role === 'user' && hasBlock(prev, 'tool_result')) return true
  if (prev.role !== 'assistant') return false
  if (Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) return true
  return hasBlock(prev, 'tool_use')
}

export function turnParts(chat: any): string[] {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'user' || answeredBefore(msgs, i)) continue
    const sig = signatureParts(msgs[i].content)
    return sig.length ? [`u${i}:`, ...sig] : []
  }
  return []
}

export function turnKey(chat: any): string {
  return turnParts(chat).join('')
}

export function conversationParts(chat: any, session?: string): string[] {
  if (session) return [`session:${session}`]
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (const m of msgs) {
    if (m?.role !== 'user') continue
    const sig = signatureParts(m.content)
    if (sig.length) return ['first:', ...sig]
  }
  return []
}

export function conversationKey(chat: any, session?: string): string {
  return conversationParts(chat, session).join('')
}

export function sessionOf(headers: Headers): string {
  const s = String(headers.get(SESSION) ?? '').trim()
  headers.delete(SESSION)
  return s.slice(0, 128)
}

export function scopeOf(a?: AccountIdentity): string {
  return `${a?.uid ?? ''}|${a?.enterpriseId ?? ''}|${a?.source === 'key' ? a.key ?? '' : ''}`
}

function setIds(headers: Headers, ids: AttendedIds, who: string): AttendedIds {
  const msg = hex()
  headers.set('X-Conversation-Message-ID', msg)
  headers.set('X-Request-ID', msg)
  const set: string[] = []
  const own = (kind: string, base: string) => (who ? idFor(kind, [`account:${who}`, '|', base]) : base)
  if (!headers.has('X-Conversation-Request-ID')) {
    headers.set('X-Conversation-Request-ID', ids.turn ? own('turn', ids.turn) : hex())
    set.push('X-Conversation-Request-ID')
  }
  if (ids.conv && !headers.has('X-Conversation-ID')) {
    headers.set('X-Conversation-ID', own('conversation', ids.conv))
    set.push('X-Conversation-ID')
  }
  return { ...ids, set }
}

export function attendChat(headers: Headers, chat: any, session?: string, who = ''): AttendedIds {
  const conv = conversationParts(chat, session)
  const turn = turnParts(chat)
  const ids: AttendedIds = {
    set: [],
    turn: turn.length ? idFor('turn', [...conv, '|', ...turn]) : '',
    conv: conv.length ? idFor('conversation', conv) : '',
  }
  return setIds(headers, ids, who)
}

export function reattend(headers: Headers, ids: AttendedIds, was: string, now: string): AttendedIds {
  if (was === now) return ids
  for (const h of ids.set) headers.delete(h)
  return setIds(headers, ids, now)
}
