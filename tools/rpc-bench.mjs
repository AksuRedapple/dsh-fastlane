// 同一 RPC 连打 N 次：测总耗时 + 上游实际调用数（读 /__proxy/status）
const BASE = process.argv[2] || 'http://127.0.0.1:8781'
const N = Number(process.argv[3] || 20)
const before = await (await fetch(BASE + '/__proxy/status')).json()
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const r = await fetch(BASE + '/api/session/list', {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'bench' + i, method: 'session/list', payload: { args: { _request: {} } } }),
  })
  await r.arrayBuffer()
}
const ms = Date.now() - t0
const after = await (await fetch(BASE + '/__proxy/status')).json()
const upBefore = before.rpcCache?.upstream ?? 0
const upAfter = after.rpcCache?.upstream ?? 0
console.log(JSON.stringify({ n: N, ms, avgMs: +(ms / N).toFixed(1), upstreamDelta: upAfter - upBefore, cache: after.rpcCache }, null, 1))
