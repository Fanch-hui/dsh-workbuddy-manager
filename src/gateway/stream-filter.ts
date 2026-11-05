import { REFUSED } from './rewrite.js'

export const FILTER_SAYS = ["Sorry, I can't respond to this question."]
export const REFUSED_DOC = 'https://github.com/magpie-community/plugins/blob/main/packages/workbuddy/REFUSED.md'
export const REFUSED_HINT = "WorkBuddy refused words in this client's prompt (most often its system prompt); use it from Hermes, OpenCode or Pi, or add another provider to this group"
export const RESTRICTED_HINT = 'WorkBuddy restricted this account for unusual activity; it stays out until WorkBuddy lifts that, which an appeal (Submit feedback in WorkBuddy) asks for'
export const RESTRICTED_CODE = 11140
export const RESTRICTED_TEXT = /account has been restricted due to unusual activity|账号存在异常行为|帳號存在異常行為|["']code["']\s*:\s*["']?11140(?![\d.])/i
export const EXHAUSTED_HINT = 'WorkBuddy requires an active credit package even for 0-rate free models; check your account package balance'
export const EXHAUSTED_TEXT = /credits exhausted|额度已用尽|["']code["']\s*:\s*["']?14018(?![\d.])/i
export const MODEL_RATE_LIMIT_TEXT = /switch to the other models|切换其他模型|切換其他模型/i

export const isModelRateLimit = (text: string): boolean => MODEL_RATE_LIMIT_TEXT.test(text)

export function namedBack(v: any, names: Map<string, string>): boolean {
  let changed = false
  for (const c of Array.isArray(v?.choices) ? v.choices : []) {
    for (const at of [c?.message, c?.delta]) {
      for (const tc of Array.isArray(at?.tool_calls) ? at.tool_calls : []) {
        const ours = names.get(tc?.function?.name)
        if (ours) {
          tc.function.name = ours
          changed = true
        }
      }
    }
  }
  return changed
}

export async function renamed(res: Response, names: Map<string, string>): Promise<Response> {
  if (!names.size || !res.body) return res
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  if (/json/i.test(res.headers.get('content-type') ?? '')) {
    const text = await res.text()
    try {
      const v = JSON.parse(text)
      return new Response(namedBack(v, names) ? JSON.stringify(v) : text, { status: res.status, statusText: res.statusText, headers })
    } catch {
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    }
  }
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let rest = ''
  const line = (l: string): string => {
    const m = /^data:\s?(.*)$/.exec(l)
    if (!m || m[1] === '[DONE]') return l
    try {
      const v = JSON.parse(m[1])
      return namedBack(v, names) ? `data: ${JSON.stringify(v)}` : l
    } catch {
      return l
    }
  }
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      rest += dec.decode(chunk, { stream: true })
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      if (lines.length) ctl.enqueue(enc.encode(`${lines.map(line).join('\n')}\n`))
    },
    flush(ctl) {
      rest += dec.decode()
      if (rest) ctl.enqueue(enc.encode(line(rest)))
    },
  }))
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

const filterSaid = (text: string): boolean => {
  const t = text.replace(/’/g, "'").trim()
  return FILTER_SAYS.some(s => s.startsWith(t))
}

const chunkOf = (ev: string): any => {
  const m = /^data:\s?(.*)$/m.exec(ev)
  if (!m || m[1] === '[DONE]') return null
  try {
    const v = JSON.parse(m[1])
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export function unsaid(res: Response): Response {
  if (!res.body || !/event-stream/i.test(res.headers.get('content-type') ?? '')) return res
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let rest = ''
  let open = true
  let said = ''
  let held: string[] = []
  const without = (ev: string): string => {
    const v = chunkOf(ev)
    const c = v?.choices?.[0]
    if (!c?.delta || typeof c.delta.content !== 'string') return ev
    delete c.delta.content
    const left = Object.keys(c.delta).filter(k => k !== 'role')
    if (!left.length && c.finish_reason == null && v.usage == null) return ''
    return `data: ${JSON.stringify(v)}`
  }
  const event = (ev: string): string[] => {
    if (!open) return [ev]
    const c = chunkOf(ev)?.choices?.[0]
    const text = typeof c?.delta?.content === 'string' ? c.delta.content : ''
    const finish = c?.finish_reason
    const calls = c?.delta?.tool_calls
    if ((Array.isArray(calls) ? calls.length > 0 : Boolean(calls)) || (text && !filterSaid(said + text))) {
      open = false
      const out = [...held, ev]
      held = []
      return out
    }
    said += text
    if (finish === 'content_filter' && said) {
      open = false
      const out = [...held, ev].map(without).filter(Boolean)
      held = []
      return out
    }
    if (finish) {
      open = false
      const out = [...held, ev]
      held = []
      return out
    }
    if (!said) return [ev]
    held.push(ev)
    return []
  }
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      rest = (rest + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
      const evs = rest.split('\n\n')
      rest = evs.pop() ?? ''
      const out = evs.flatMap(event)
      if (out.length) ctl.enqueue(enc.encode(out.map(e => `${e}\n\n`).join('')))
    },
    flush(ctl) {
      rest += dec.decode()
      const out = held.map(e => `${e}\n\n`).join('') + rest
      held = []
      if (out) ctl.enqueue(enc.encode(out))
    },
  }))
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

export async function inspectStreamForFailover(
  res: Response,
): Promise<{ response: Response; filterRefused: boolean; streamErrorText?: string }> {
  if (!res.body || !/event-stream/i.test(res.headers.get('content-type') ?? '')) {
    return { response: res, filterRefused: false }
  }
  const reader = res.body.getReader()
  const buffered: Uint8Array[] = []
  const dec = new TextDecoder()
  let rest = ''
  let said = ''
  let open = true
  let filterRefused = false
  let streamErrorText: string | undefined

  const checkEvent = (ev: string): void => {
    if (!open) return
    const v = chunkOf(ev)
    if (v?.error) {
      open = false
      filterRefused = true
      streamErrorText = JSON.stringify(v)
      return
    }
    const c = v?.choices?.[0]
    const text = typeof c?.delta?.content === 'string' ? c.delta.content : ''
    const finish = c?.finish_reason
    const calls = c?.delta?.tool_calls
    if ((Array.isArray(calls) ? calls.length > 0 : Boolean(calls)) || (text && !filterSaid(said + text))) {
      open = false
      return
    }
    said += text
    if (finish === 'content_filter') {
      open = false
      filterRefused = true
    } else if (finish) {
      open = false
    }
  }

  let done = false
  while (open && !done) {
    const step = await reader.read()
    done = step.done
    if (step.value) {
      buffered.push(step.value)
      rest = (rest + dec.decode(step.value, { stream: true })).replace(/\r\n/g, '\n')
      const evs = rest.split('\n\n')
      rest = evs.pop() ?? ''
      for (const ev of evs) checkEvent(ev)
    }
  }
  if (open && rest.trim()) checkEvent(rest)

  const replay = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const chunk of buffered) ctl.enqueue(chunk)
      if (done) ctl.close()
    },
    async pull(ctl) {
      const step = await reader.read()
      if (step.done) ctl.close()
      else if (step.value) ctl.enqueue(step.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const rewrapped = new Response(replay, { status: res.status, statusText: res.statusText, headers: res.headers })
  return { response: unsaid(rewrapped), filterRefused, ...(streamErrorText ? { streamErrorText } : {}) }
}

export function windowOffset(text: unknown): number | null {
  const m = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i.exec(String(text ?? ''))
  if (!m) return null
  const min = Number(m[2]) * 60 + Number(m[3] ?? 0)
  if (min > 14 * 60) return null
  return m[1] === '-' ? -min : min
}

export function windowReset(text: unknown): number {
  const s = String(text ?? '')
  const at =
    /reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s) ||
    /将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!at) return NaN
  const off = windowOffset(s)
  if (off === null) return NaN
  return Date.UTC(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6]) - off * 60000
}

export function classifyUpstreamError(text: string): {
  isRefused: boolean
  isRestricted: boolean
  isExhausted: boolean
  isModelRateLimit: boolean
  codes: number[]
  message: string
} {
  let v: any
  try { v = JSON.parse(text) } catch {}
  const at = v?.error && typeof v.error === 'object' ? v.error : v && typeof v === 'object' ? v : null
  const inner = at?.internal_code ?? (typeof v?.error === 'string' ? v.error.match(/^(\d{5}):/)?.[1] : undefined)
  const codes = [inner, at?.data?.code, at?.code, v?.code, v?.data?.code].filter(c => c != null).map(Number)
  const isRefused = REFUSED.test(text)
  const isRestricted = !isRefused && (codes.includes(RESTRICTED_CODE) || RESTRICTED_TEXT.test(text))
  const isExhausted = !isRestricted && (codes.includes(14018) || EXHAUSTED_TEXT.test(text))
  let msg = text.trim()
  if (at && typeof at.message === 'string') msg = at.message
  else if (typeof at?.data?.msg === 'string') msg = at.data.msg
  else if (typeof v?.error === 'string') msg = v.error
  else if (typeof v?.msg === 'string' && v.msg) msg = v.msg
  else if (typeof v?.data?.msg === 'string') msg = v.data.msg
  return { isRefused, isRestricted, isExhausted, isModelRateLimit: isModelRateLimit(text), codes, message: msg }
}

export async function explained(res: Response, preReadText?: string): Promise<Response> {
  const text = preReadText ?? await res.text()
  const again = (b: string) => {
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.set('X-Magpie-Sign-In', 'kept')
    return new Response(b, { status: res.status, statusText: res.statusText, headers })
  }
  const { isRefused, isRestricted, isExhausted, message } = classifyUpstreamError(text)
  if (!isRefused && !isRestricted && !isExhausted) return again(text)
  const hint = isRefused ? REFUSED_HINT : isRestricted ? RESTRICTED_HINT : EXHAUSTED_HINT
  const type = isRefused || isRestricted ? 'permission_error' : 'insufficient_quota'
  const errCode = isRefused ? null : isRestricted ? RESTRICTED_CODE : 14018
  const where = isRefused ? `${REFUSED_DOC} — ` : ''
  const msg = `${message} — ${where}${hint}`
  const headers = new Headers(res.headers)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('X-Magpie-Sign-In', 'kept')
  return new Response(JSON.stringify({ error: { message: msg, type, code: errCode } }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
