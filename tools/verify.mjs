// dsh-fastlane · 线上回归（对着已跑起来的代理打）
// 跑法：node tools/verify.mjs [base]     默认 http://127.0.0.1:8781
// 判据：任何一条 ✗ 就退出码 1
const BASE = process.argv[2] || 'http://127.0.0.1:8781'
const out = []
let failed = 0

function check(name, ok, detail = '') {
  out.push(`${ok ? '✔' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

const req = (path, init = {}) => fetch(BASE + path, { redirect: 'manual', ...init })

// 1 状态端点
const st = await (await req('/__proxy/status')).json()
check('status 可读且形状完整', st.ok === true && 'assetCache' in st && 'prewarm' in st, JSON.stringify({ uptime: st.uptimeSec, prewarm: st.prewarm?.state }))
check('cookie 已载', st.cookie?.loaded === true)

// 2 首屏
const html = await (await req('/')).text()
const assets = [...new Set([...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => '/' + m[1]))]
check('首屏可用', html.includes('<div id="root"') || html.includes('<!doctype html'), `${assets.length} 个资源`)

// 3 三种编码变体
for (const [label, ae, expect] of [['br', 'gzip, deflate, br', 'br'], ['gzip', 'gzip', 'gzip']]) {
  const r = await req(assets[0], { headers: { 'accept-encoding': ae } })
  await r.arrayBuffer()
  const wire = Number(r.headers.get('content-length'))
  check(`${label} 变体命中且编码正确`, r.headers.get('content-encoding') === expect && r.headers.get('x-dshp-cache') === 'hit', `wire=${wire}B`)
  check(`${label} 带 immutable`, /immutable/.test(r.headers.get('cache-control') || ''))
  check(`${label} 有 etag`, Boolean(r.headers.get('etag')))
}

// 4 302/304 协商
const first = await req(assets[0], { headers: { 'accept-encoding': 'gzip, deflate, br' } })
await first.arrayBuffer()
const etag = first.headers.get('etag')
const reval = await req(assets[0], { headers: { 'accept-encoding': 'gzip, deflate, br', 'if-none-match': etag } })
const revalBuf = Buffer.from(await reval.arrayBuffer())
check('If-None-Match → 304 且 0 字节', reval.status === 304 && revalBuf.length === 0, `${reval.status}/${revalBuf.length}B`)

// 5 首屏总字节（浏览器口径）
// undici 会自动解压，所以只能看 content-length（我们命中时一定会带）
let total = 0
for (const a of assets) {
  const r = await req(a, { headers: { 'accept-encoding': 'gzip, deflate, br' } })
  await r.arrayBuffer()
  const wire = Number(r.headers.get('content-length'))
  if (!Number.isFinite(wire)) { check('命中响应带 content-length', false, a); break }
  total += wire
}
check('首屏 br 合计 ≤ 430KB', total <= 430 * 1024, `${(total / 1024).toFixed(0)}KB`)

// 6 API 仍通（Typert 信封：空体会回 gateway/bad-request 而不是 404/401）
const api = await req('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const apiBody = await api.text()
check('API 代理未受影响', api.status === 200 && apiBody.includes('client-request'), `http=${api.status}`)

// 7 JSON 响应 brotli（session/list 是最大的一条：上游 gzip 73KB → br 52KB）
const rpc = await req('/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'verify', method: 'session/list', payload: { args: { _request: {} } } }),
})
await rpc.arrayBuffer()
const rpcWire = Number(rpc.headers.get('content-length'))
check('session/list 走 br 且 ≤ 60KB', rpc.headers.get('content-encoding') === 'br' && rpcWire <= 60 * 1024, `${(rpcWire / 1024).toFixed(0)}KB`)

// 8 WS 计数存在（真实升级由浏览器触发；这里只验证字段可读）
check('WS 计数器可读', typeof st.ws?.active === 'number' && typeof st.ws?.total === 'number', `active=${st.ws?.active}/total=${st.ws?.total}`)

console.log(out.join('\n'))
console.log(failed === 0 ? `\n全部通过（${out.length} 项）` : `\n失败 ${failed} 项 / 共 ${out.length} 项`)
process.exit(failed === 0 ? 0 : 1)
