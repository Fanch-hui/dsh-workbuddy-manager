/** URLs never carry credentials; plaintext is restricted to the local machine. */
export function normalizeURL(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入有效的网关地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('地址必须是 HTTP(S) 地址，不能包含账号、密码、查询参数或片段。')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:' && !loopback) throw new Error('非本机网关请使用 HTTPS 地址。')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  return url.toString().replace(/\/$/, '')
}

export function managementURL(input: string): string {
  return normalizeURL(input).replace(/\/v1$/, '')
}

export const BRIDGE_PROVIDER = 'workbuddy-manager-session'

export const BRIDGE_CREDENTIAL_REF = 'WORKBUDDY_MANAGER_BRIDGE_8F4D2C1E9A0B7E6D5C3A1F2E4B6D8C0A'
