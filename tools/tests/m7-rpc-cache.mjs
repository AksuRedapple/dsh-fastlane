// M7 验收：RPC 只读缓存（退出码 0/1）
const BASE = process.argv[2] || 'http://127.0.0.1:8781'
const POST = (args) => fetch(BASE + '/api/session/list', {
  method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'x' + Math.random(), method: 'session/list', payload: { args } }),
})
const st = async () => (await (await fetch(BASE + '/__proxy/status')).json())
let fail = 0
const ck = (name, ok, d = '') => { console.log(`${ok ? '✔' : '✗'} ${name}${d ? '  ' + d : ''}`); if (!ok) fail++ }

// 清一次（写路径触发失效）
await fetch(BASE + '/api/x/mutateNothing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
let s0 = await st()

// 1) 同参 20 次
const argsA = { _request: {} }
let firstBody = null, lastBody = null
for (let i = 0; i < 20; i++) {
  const r = await POST(argsA)
  const buf = Buffer.from(await r.arrayBuffer())
  if (i === 0) firstBody = buf
  lastBody = buf
}
let s1 = await st()
ck('20 次同参：上游增量 ≤1', s1.rpcCache.upstream - s0.rpcCache.upstream <= 1, `upstream +${s1.rpcCache.upstream - s0.rpcCache.upstream}`)
ck('20 次同参：命中 ≥19', s1.rpcCache.hits - s0.rpcCache.hits >= 19, `hits +${s1.rpcCache.hits - s0.rpcCache.hits}`)
ck('命中与新鲜响应逐字节相等', Buffer.compare(firstBody, lastBody) === 0, `${firstBody.length}B`)

// 2) 换 args → 必须是新的上游
const before = (await st()).rpcCache.upstream
await POST({ _request: { probe: 'different-' + Date.now() } })
const after = (await st()).rpcCache.upstream
ck('换 args 触发新上游调用', after - before === 1, `upstream +${after - before}`)

// 3) 写即失效
const pre = (await st()).rpcCache
await fetch(BASE + '/api/x/mutateNothing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const post = (await st()).rpcCache
ck('写路径命中 → 缓存清空', post.entries === 0 && pre.entries > 0, `${pre.entries} → ${post.entries}`)

// 4) 观测字段
const fields = ['hits', 'misses', 'stores', 'upstream', 'entries', 'bytes', 'ttlMs', 'max']
ck('status 暴露 rpcCache 八字段', fields.every((f) => f in post), fields.join(','))
ck('TTL/上限已声明', post.ttlMs > 0 && post.max > 0, `ttl=${post.ttlMs} max=${post.max}`)

console.log(fail ? `\n失败 ${fail} 项` : '\nM7 验收全绿')
process.exit(fail ? 1 : 0)
