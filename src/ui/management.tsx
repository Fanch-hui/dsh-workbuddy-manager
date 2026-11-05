import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { ManagerRequest } from '../manager/contract.js'
import { safeMessage, type Remote } from './connection.js'

type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface AppRemote extends Remote {
  workbuddy: { manage(request: ManagerRequest): Promise<Result<unknown>> }
}
interface Account {
  file: string
  nickname: string
  note: string
  realm: string
  disabled: boolean
  blocked: boolean
  expired: boolean
  inPool: boolean
  cooling: boolean
  credits: number | null
}
interface Overview {
  accounts: Account[]
  gatewayURL: string
  poolAvailable: boolean
  manageable: boolean
}
interface Props {
  remote: AppRemote
  writable: boolean
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onConnect: (active: () => boolean) => Promise<void>
}

export function accountStatus(account: Account, poolAvailable: boolean): string {
  if (account.disabled) return '已停用'
  if (account.blocked) return '异常受限'
  if (account.expired) return '授权过期'
  if (!account.inPool && !poolAvailable) return '不可用'
  if (!account.inPool) return '未进入账号池'
  if (account.cooling) return '冷却中'
  return '可用'
}

export function keyScope(realm: string): string {
  if (realm === 'cn') return '仅国内版模型'
  if (realm === 'global') return '仅国际版模型'
  return realm ? '版本限制未知' : '版本不限'
}

export async function copyLoginLink(url: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<boolean> {
  if (!clipboard) return false
  try { await clipboard.writeText(url); return true } catch { return false }
}

export function Management({ remote, writable, disabled, onBusyChange, onConnect }: Props) {
  const [overview, setOverview] = useState<Overview>()
  const [realm, setRealm] = useState<'cn' | 'global'>('cn')
  const [authorization, setAuthorization] = useState<{ url: string; qr: string }>()
  const authorizationRef = useRef(authorization)
  authorizationRef.current = authorization
  const [qrStatus, setQrStatus] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const blocked = busy || disabled || loading
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')

  const call = useCallback(async (request: ManagerRequest) => {
    const answer = await remote.workbuddy.manage(request)
    if (!answer.ok) throw new Error(answer.error.message)
    return answer.value
  }, [remote])

  const refresh = useCallback(async () => {
    const next = await call({ action: 'overview' }) as Overview
    setOverview(next)
    return next
  }, [call])

  useEffect(() => {
    let active = true
    setLoading(true); setFailure(''); setMessage('')
    void (async () => {
      try {
        const next = await call({ action: 'overview' }) as Overview
        if (!active) return
        setOverview(next)
        if (next.poolAvailable) await onConnect(() => active)
      } catch (error) {
        if (active) setFailure(safeMessage(error, ''))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [call, onConnect])

  useEffect(() => {
    if (!authorization) return
    let cancelled = false
    let polling = false
    let finished = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (cancelled || polling || finished) return
      polling = true
      try {
        const result = await call({ action: 'authPoll' }) as { status: string; error?: string }
        if (cancelled) return
        if (result.status === 'success') {
          finished = true
          setQrStatus('账号授权成功，正在同步模型…')
          await refresh()
          if (!cancelled) await onConnect(() => !cancelled)
          if (!cancelled) { setAuthorization(undefined); setQrStatus(''); setMessage('账号已加入宿主账号池并完成模型同步。') }
          return
        }
        if (result.status === 'expired' || result.status === 'invalid') {
          finished = true
          setAuthorization(undefined); setQrStatus(''); setFailure(result.error || '授权已过期，请重新获取登录链接。')
          return
        }
        setQrStatus(result.status === 'scanned' ? '已扫码或打开授权，请完成确认…' : '等待扫码或打开登录链接并确认…')
      } catch (error) {
        if (!cancelled) setFailure(safeMessage(error, ''))
      } finally { polling = false }
      if (!cancelled && !finished) timer = setTimeout(() => void poll(), 2000)
    }
    const wake = () => {
      if (cancelled || polling || finished || document.hidden) return
      clearTimeout(timer)
      void poll()
    }
    timer = setTimeout(() => void poll(), 2000)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      cancelled = true; clearTimeout(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [call, authorization, refresh, onConnect])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); onBusyChange(true); setFailure(''); setMessage('')
    try { await operation() } catch (error) { setFailure(safeMessage(error, '')) }
    finally { setBusy(false); onBusyChange(false) }
  }

  const startAuth = () => run(async () => {
    setAuthorization(undefined); setCopyStatus(''); setQrStatus('')
    const result = await call({ action: 'authStart', realm }) as { authUrl: string }
    let qr = ''
    try { qr = await QRCode.toDataURL(result.authUrl, { width: 200, margin: 2 }) }
    catch { setFailure('二维码生成失败，请使用下方登录链接。') }
    setAuthorization({ url: result.authUrl, qr })
    setQrStatus('等待扫码或打开登录链接并确认…')
  })

  const copyAuthorization = async () => {
    if (!authorization) return
    const copied = await copyLoginLink(authorization.url, navigator.clipboard)
    if (authorizationRef.current !== authorization) return
    setCopyStatus(copied ? '登录链接已复制。' : '无法自动复制，请选中上方链接手动复制。')
  }

  const toggleAccount = (account: Account) => {
    const nextDisabled = !(account.disabled || account.blocked)
    if (!window.confirm(`确认${nextDisabled ? '停用' : '启用'}该账号？`)) return
    void run(async () => {
      await call({ action: 'accountDisabled', file: account.file, disabled: nextDisabled })
      await refresh()
      setMessage(nextDisabled ? '账号已停用。' : '账号已启用。')
    })
  }

  const deleteAccount = (account: Account) => {
    if (!window.confirm(`确认从账号池移除「${account.note || account.nickname || account.file}」？`)) return
    void run(async () => {
      await call({ action: 'accountDelete', file: account.file })
      await refresh()
      setMessage('账号已移除。')
    })
  }

  const refreshAccounts = () => run(async () => {
    await call({ action: 'accountRefresh' })
    await refresh()
    setMessage('账号状态与积分已刷新。')
  })

  const syncPoolModels = () => run(async () => {
    await onConnect(() => true)
    setMessage('本地网关已连接并同步模型到 DSH。')
  })

  const usableAccounts = overview?.accounts.filter(account => accountStatus(account, overview.poolAvailable) === '可用').length ?? 0

  return <>
    {overview && <section className="wb-summary" aria-label="账号池概览">
      <div><span>账号总数</span><strong>{overview.accounts.length}</strong></div>
      <div><span>可用账号</span><strong>{usableAccounts}</strong></div>
      <div><span>本地网关</span><strong style={{ fontSize: '14px', wordBreak: 'break-all' }}>{overview.gatewayURL || '待启动'}</strong></div>
    </section>}
    <section className="wb-card" aria-busy={busy || loading} aria-labelledby="workbuddy-accounts-title">
      <div className="wb-status">
        <div>
          <h3 id="workbuddy-accounts-title">宿主账号池与本地网关</h3>
          <p className="wb-muted" role="status">
            {loading ? '正在加载宿主账号池…' : overview?.poolAvailable ? '账号池就绪 · 凭据保存在 DSH 凭据服务' : '请先扫码或打开登录链接添加 WorkBuddy 账号'}
          </p>
        </div>
        <div className="wb-actions">
          <button type="button" disabled={blocked || !writable} onClick={() => void syncPoolModels()}>同步账号池模型</button>
          <button type="button" disabled={blocked} onClick={() => void refreshAccounts()}>刷新状态与积分</button>
        </div>
      </div>
      {failure && <p className="wb-error" role="alert">{failure}</p>}
      {message && <p className="wb-success" role="status">{message}</p>}
      {overview && (overview.accounts.length === 0 ? <p className="wb-empty">当前账号池中没有账号。</p> : <ul className="wb-records">{overview.accounts.map(account => <li key={account.file}>
        <div className="wb-record-main">
          <strong>{account.note || account.nickname || '未命名账号'}</strong>
          <p className="wb-muted">
            {account.realm === 'global' ? '国际版 (workbuddy.ai)' : '国内版 (copilot.tencent.com)'}
            {' · '}
            {accountStatus(account, overview.poolAvailable)}
            {account.credits !== null ? ` · 剩余额度 ${account.credits.toLocaleString()}` : ''}
          </p>
        </div>
        <div className="wb-actions">
          <button type="button" disabled={blocked} onClick={() => toggleAccount(account)}>{account.disabled || account.blocked ? '启用' : '停用'}</button>
          <button type="button" disabled={blocked} onClick={() => deleteAccount(account)}>移除</button>
        </div>
      </li>)}</ul>)}
      <details className="wb-details" open={!overview || overview.accounts.length === 0}>
        <summary>添加 WorkBuddy 账号</summary>
        <div className="wb-detail-body">
          <label htmlFor="workbuddy-realm">账号版本
            <select id="workbuddy-realm" value={realm} disabled={blocked} onChange={event => { setRealm(event.target.value as 'cn' | 'global'); setAuthorization(undefined); setCopyStatus('') }}>
              <option value="cn">国内版（copilot.tencent.com · 微信/企微等扫码）</option>
              <option value="global">国际版（www.workbuddy.ai · Google/GitHub 等登录）</option>
            </select>
          </label>
          <div className="wb-actions">
            <button type="button" disabled={blocked} onClick={() => void startAuth()}>获取登录链接或扫码</button>
          </div>
          {authorization && <div className="wb-detail-body">
            {authorization.qr && <img src={authorization.qr} width="200" height="200" alt="WorkBuddy 账号授权二维码" />}
            <label htmlFor="workbuddy-auth-url">登录链接
              <input id="workbuddy-auth-url" value={authorization.url} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
            </label>
            <div className="wb-actions">
              <button type="button" onClick={() => void copyAuthorization()}>复制登录链接</button>
              <a href={authorization.url} target="_blank" rel="noopener noreferrer">打开登录链接</a>
              <button type="button" onClick={() => setAuthorization(undefined)}>关闭</button>
            </div>
            <p className="wb-muted" role="status">{qrStatus}</p>
            {copyStatus && <p className="wb-muted" role="status">{copyStatus}</p>}
          </div>}
        </div>
      </details>
    </section>
  </>
}
