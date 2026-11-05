import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BRIDGE_PROVIDER, managementURL } from '../address.js'
import { connectBridge } from './bridge-connection.js'
import { DEFAULT_URL, discover, loadConnection, normalizeURL, safeMessage, sync, type Connection } from './connection.js'
import { Management, type AppRemote } from './management.js'

const css = `
.workbuddy-panel{max-width:900px;color:var(--dsw-alias-label-primary,#242424);display:flex;flex-direction:column;gap:16px;text-align:left}
.workbuddy-panel h2,.workbuddy-panel p{margin:0}.workbuddy-panel h2{font-size:18px;font-weight:600;line-height:26px}
.workbuddy-panel .wb-muted{color:var(--dsw-alias-label-secondary,#686868);font-size:13px;line-height:20px}
.workbuddy-panel .wb-card{border:1px solid var(--dsw-alias-settings-card-stroke,#dedede);background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px}
.workbuddy-panel .wb-status{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.workbuddy-panel .wb-status strong{font-size:14px}.workbuddy-panel form,.workbuddy-panel label{display:flex;flex-direction:column;gap:7px}.workbuddy-panel label.wb-check{flex-direction:row;align-items:center;gap:6px;cursor:pointer}
.workbuddy-panel form{gap:14px}.workbuddy-panel label{font-size:13px;font-weight:500}
.workbuddy-panel input:not([type=checkbox]),.workbuddy-panel select{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#bbb);border-radius:7px;color:inherit;background:var(--dsw-alias-settings-card-fill,transparent);font:inherit}.workbuddy-panel input[type=checkbox]{width:15px;height:15px;margin:0;cursor:pointer}
.workbuddy-panel input:focus-visible,.workbuddy-panel select:focus-visible,.workbuddy-panel button:focus-visible,.workbuddy-panel a:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#2673d9);outline-offset:2px}
.workbuddy-panel .wb-actions{display:flex;gap:8px;flex-wrap:wrap}.workbuddy-panel button,.workbuddy-panel a{border-radius:7px;font:inherit;font-size:13px;cursor:pointer;padding:8px 12px}
.workbuddy-panel button{border:1px solid var(--dsw-alias-border-l3,#bbb);background:transparent;color:inherit}.workbuddy-panel button[type=submit]{background:var(--dsw-alias-state-info-primary,#276cdc);border-color:transparent;color:#fff}
.workbuddy-panel button:disabled{opacity:.55;cursor:not-allowed}.workbuddy-panel a{color:var(--dsw-alias-state-info-primary,#276cdc);padding-left:0;text-decoration:underline}
.workbuddy-panel .wb-error{color:var(--dsw-alias-state-error-primary,#b3261e);font-size:13px;line-height:20px}.workbuddy-panel .wb-success{color:var(--dsw-alias-state-success-primary,#207444);font-size:13px;line-height:20px}
.workbuddy-panel ul{padding-left:20px;margin:0;display:flex;flex-wrap:wrap;gap:6px 24px;font-size:13px}
.workbuddy-panel h3{margin:0;font-size:15px;line-height:22px}.workbuddy-panel .wb-records{padding:0;list-style:none;display:flex;flex-direction:column;gap:0}
.workbuddy-panel .wb-records li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#dedede)}
.workbuddy-panel .wb-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.workbuddy-panel .wb-summary>div{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--dsw-alias-settings-card-stroke,#dedede);border-radius:10px;background:var(--dsw-alias-settings-card-fill,transparent)}
.workbuddy-panel .wb-summary span,.workbuddy-panel .wb-summary small{font-size:13px;color:var(--dsw-alias-label-secondary,#686868)}.workbuddy-panel .wb-summary strong{font-size:22px;line-height:28px;font-weight:600}
.workbuddy-panel .wb-records li{align-items:flex-start;gap:14px;padding:12px 0}.workbuddy-panel .wb-records li:last-child{border-bottom:0}.workbuddy-panel .wb-record-main{min-width:0;flex:1 1 220px}.workbuddy-panel .wb-record-main strong{overflow-wrap:anywhere}.workbuddy-panel .wb-record-main p{margin-top:3px}
.workbuddy-panel .wb-connection>summary{font-size:14px;font-weight:600;cursor:pointer}.workbuddy-panel .wb-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#686868);padding:8px 0}.workbuddy-panel .wb-details{border-top:1px solid var(--dsw-alias-border-l3,#dedede);padding-top:12px}.workbuddy-panel .wb-details summary{font-size:13px;font-weight:600;cursor:pointer}.workbuddy-panel .wb-detail-body,.workbuddy-panel .wb-rename{display:flex;flex-direction:column;gap:12px;padding-top:12px}.workbuddy-panel img{max-width:100%;height:auto}
@media(max-width:480px){.workbuddy-panel .wb-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.workbuddy-panel .wb-summary>div{padding:10px}.workbuddy-panel .wb-summary strong{font-size:18px}.workbuddy-panel .wb-records li{flex-direction:column}.workbuddy-panel .wb-record-main{flex-basis:auto}}
`

function installStyles() {
  if (typeof document === 'undefined' || document.getElementById('workbuddy-manager-styles')) return
  const style = document.createElement('style')
  style.id = 'workbuddy-manager-styles'
  style.textContent = css
  document.head.appendChild(style)
}

function displayAddress(url: string): string {
  return `${managementURL(url)}/v1`
}

export function targetURL(_connection: Connection, address: string): string {
  return normalizeURL(address)
}

interface Props { remote: AppRemote }
export function WorkbuddyPanel({ remote }: Props) {
  const [connection, setConnection] = useState<Connection>()
  const [address, setAddress] = useState(DEFAULT_URL)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [managementBusy, setManagementBusy] = useState(false)
  const [status, setStatus] = useState('尚未检查连接')
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(async (selectedId?: string) => {
    setBusy(true)
    setFailure('')
    try {
      const current = await loadConnection(remote, selectedId)
      setConnection(current)
      setAddress(displayAddress(current.url))
      if (selectedId) setKey('')
      if (current.existing && current.keyConfigured) {
        setStatus('正在检查连接…')
        try {
          const models = await discover(remote, current, current.url, '')
          setStatus(`已连接 · ${models.length} 个可用模型`)
        } catch {
          setStatus('连接未就绪，请检查账号池或网关状态')
        }
      } else if (!current.providerId) setStatus('检测到多个提供方，请选择一个')
      else if (current.existing) setStatus('已识别提供方，等待同步凭据')
      else if (current.keyConfigured) setStatus('发现已保存凭据，可恢复连接')
      else setStatus('尚未连接模型，请添加账号并同步')
    } catch (error) {
      setFailure(safeMessage(error, ''))
    } finally {
      setBusy(false)
    }
  }, [remote])

  useEffect(() => { installStyles(); void load() }, [load])

  const autoConnect = useCallback(async (active: () => boolean): Promise<boolean> => {
    if (!active()) return false
    setBusy(true); setFailure(''); setMessage(''); setStatus('正在启动本地网关并同步模型…')
    try {
      const count = await connectBridge(remote, active)
      if (count === undefined || !active()) return false
      const updated = await loadConnection(remote, BRIDGE_PROVIDER)
      if (!active()) return false
      setConnection(updated)
      setAddress(displayAddress(updated.url))
      setStatus(`已连接本地网关 · 已同步 ${count} 个模型`)
      setMessage('宿主账号池与本地网关已就绪，现在可在对话中选择 WorkBuddy 模型。')
      return true
    } catch (error) {
      if (active()) { setStatus('本地网关连接未完成'); setFailure(safeMessage(error, '')) }
      return false
    } finally { setBusy(false) }
  }, [remote])

  const check = async () => {
    if (!connection) return
    setBusy(true); setFailure(''); setMessage(''); setStatus('正在检查连接…')
    try {
      const models = await discover(remote, connection, targetURL(connection, address), key)
      setStatus(`已连接 · ${models.length} 个可用模型`)
      setMessage('网关连接正常。点击“保存并同步模型”将模型加入 DSH。')
    } catch (error) {
      setStatus('连接未成功')
      setFailure(safeMessage(error, key))
    } finally { setBusy(false) }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!connection) return
    setBusy(true); setFailure(''); setMessage(''); setStatus('正在同步模型…')
    try {
      const count = await sync(remote, connection, targetURL(connection, address), key)
      setKey('')
      const current = await loadConnection(remote, connection.providerId)
      setConnection(current)
      setAddress(displayAddress(current.url))
      setStatus(`已连接 · 已同步 ${count} 个模型`)
      setMessage('保存成功。现在可以在对话的模型选择器中选择 WorkBuddy 模型。')
    } catch (error) {
      setStatus('同步未完成')
      setFailure(safeMessage(error, key))
    } finally { setBusy(false) }
  }

  return <section className="workbuddy-panel" aria-busy={busy || managementBusy}>
    <div><h2>WorkBuddy</h2><p className="wb-muted">在宿主内登录管理 WorkBuddy 账号池，通过本地网关将国内版与国际版模型接入 DSH。</p></div>
    <div className="wb-card wb-status">
      <div><strong>模型连接状态</strong><p className="wb-muted" role="status">{status}</p></div>
    </div>
    {failure && <p className="wb-error" role="alert">{failure}</p>}
    {message && <p className="wb-success" role="status">{message}</p>}
    {connection && <Management remote={remote} disabled={busy} writable={connection.writable && connection.keyWritable} onBusyChange={setManagementBusy} onConnect={autoConnect} />}
    {connection && connection.models.length > 0 && <div className="wb-card">
      <strong>已配置模型 · {connection.models.length}</strong>
      <ul>{connection.models.map(model => <li key={model.id}>{model.name || model.id}</li>)}</ul>
    </div>}
    <details className="wb-card wb-connection">
      <summary>高级连接与外部网关设置</summary>
      <form className="wb-detail-body" onSubmit={event => void save(event)}>
        {connection && connection.candidates.length > 1 && <label htmlFor="workbuddy-provider">已有提供方
          <select id="workbuddy-provider" value={connection.providerId} disabled={busy || managementBusy} onChange={event => { if (event.target.value) void load(event.target.value) }}>
            {!connection.providerId && <option value="">请选择提供方</option>}
            {connection.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </label>}
        <label htmlFor="workbuddy-address">网关地址
          <input id="workbuddy-address" type="url" required value={address} disabled={busy || managementBusy} onChange={event => setAddress(event.target.value)} aria-describedby="workbuddy-address-hint" />
        </label>
        <p className="wb-muted" id="workbuddy-address-hint">默认由宿主本地网关（127.0.0.1:随机端口）自动配置；也可连接自定义网关。</p>
        {connection?.providerId !== BRIDGE_PROVIDER && <details className="wb-details"><summary>使用自定义网关密钥</summary><div className="wb-detail-body">
          <label htmlFor="workbuddy-key">网关密钥
            <input id="workbuddy-key" type="password" autoComplete="off" value={key} disabled={busy || managementBusy || !connection?.providerId} onChange={event => setKey(event.target.value)} placeholder={connection?.keyConfigured ? '已保存；留空使用现有密钥' : '输入网关密钥'} aria-describedby="workbuddy-key-hint" />
          </label>
          <p className="wb-muted" id="workbuddy-key-hint">密钥保存在 DSH 凭据库中。</p>
        </div></details>}
        {!connection?.writable && connection && <p className="wb-error">当前 DSH 配置不可写，无法同步模型。</p>}
        <div className="wb-actions">
          <button type="submit" disabled={busy || managementBusy || !connection?.providerId || !connection.writable}>保存并同步模型</button>
          <button type="button" disabled={busy || managementBusy || !connection?.providerId} onClick={() => void check()}>检查连接</button>
          <button type="button" disabled={busy || managementBusy} onClick={() => void load()}>重新载入</button>
        </div>
      </form>
    </details>
  </section>
}
