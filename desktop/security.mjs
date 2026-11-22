import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export const DESKTOP_TOKEN_HEADER = 'X-SecondMind-Desktop-Token';

export function sameOrigin(candidate, expected) {
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export function allowedFrameUrl(candidate, expected) {
  if (sameOrigin(candidate, expected)) return true;
  try { const url = new URL(candidate); return url.protocol === 'blob:' && url.origin === new URL(expected).origin; }
  catch { return false; }
}

export function isPrivateAddress(address) {
  const host = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

export function normalizeRemoteUrl(input, trustedHttp = false) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error('请输入完整的 HTTPS 服务器地址。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('服务器地址必须使用 HTTPS 或可信局域网 HTTP。');
  if (url.username || url.password) throw new Error('请在服务器登录页输入账号，地址中不能包含用户名或密码。');
  if (url.search || url.hash) throw new Error('服务器地址不能包含查询参数或页面片段。');
  if (url.protocol === 'http:' && !trustedHttp) throw new Error('HTTP 连接需要明确勾选“可信局域网服务器”。');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

// RFC 6598 shared space includes Tailscale IPv4 addresses. This is not
// classified as private globally: only explicitly trusted HTTP connections
// accept it, and every DNS result must still pass the same network check.
export function isSharedNetworkAddress(address) {
  const host = String(address);
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export async function validateRemoteUrl(input, trustedHttp = false, resolver = lookup) {
  const normalized = normalizeRemoteUrl(input, trustedHttp);
  const url = new URL(normalized);
  if (url.protocol === 'http:') {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname }] : await resolver(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPrivateAddress(address) && !isSharedNetworkAddress(address))) {
      throw new Error('HTTP 仅用于本机、私有局域网或明确可信的共享地址网络（如 Tailscale）；公网服务器请使用 HTTPS。');
    }
  }
  return normalized;
}

export function authenticatedHeaders(details, { origin, token, webContentsId }) {
  const headers = { ...details.requestHeaders };
  const untrustedFrame = details.frame?.parent && !sameOrigin(details.frame.url, origin);
  const authorized = Boolean(token) && !untrustedFrame && details.webContentsId === webContentsId && sameOrigin(details.url, origin);
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === DESKTOP_TOKEN_HEADER.toLowerCase() || (!authorized && name.toLowerCase() === 'cookie')) delete headers[name];
  }
  if (authorized) headers[DESKTOP_TOKEN_HEADER] = token;
  return headers;
}

export function canOpenExternal(input) {
  try {
    const url = new URL(input);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function isTrustedShellSender(event, shellContents, shellUrl) {
  return event.sender === shellContents && event.senderFrame === shellContents.mainFrame && event.senderFrame?.url === shellUrl;
}
