// WebSocket 升级链路：真起一个「假上游」和一个真代理，验证 101 透传与字节双向流动
// 跑法：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PROXY = new URL('../src/dsh-web-proxy.mjs', import.meta.url).pathname
const freePort = () => new Promise((res) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

// 假上游：/ws 升级并回显；其它路径 404
function fakeUpstream(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') })
    srv.on('upgrade', (req, socket) => {
      if (req.url === '/boom') { socket.destroy(); return } // 模拟上游直接断链
      if (req.url !== '/ws') { // 只有 /ws 是可升级路由，其余按普通请求回 404
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nnope')
        socket.end()
        return
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', (b) => socket.write(b)) // 回显
    })
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

function startProxy(env) {
  const child = spawn(process.execPath, [PROXY], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy 未在 8s 内就绪: ' + child.stderr.read()?.toString())), 8000)
    child.stdout.on('data', (b) => { if (String(b).includes('已起')) { clearTimeout(timer); resolve(child) } })
  })
}

function upgrade(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    })
    req.on('upgrade', (res, socket) => resolve({ status: 101, socket, headers: res.headers }))
    req.on('response', (res) => resolve({ status: res.statusCode, body: res }))
    req.on('error', reject)
    req.end()
  })
}

test('WS 升级：101 透传 + 双向字节 + 计数器', async (t) => {
  const upPort = await freePort()
  const listenPort = await freePort()
  const up = await fakeUpstream(upPort)
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-')), 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ cookie: 'dsh-auth-test=deadbeef', at: Date.now() }))

  const proxy = await startProxy({
    DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort),
    DSHP_STATE: stateFile, DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '0',
  })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  // 1) 升级成功
  const ok = await upgrade(listenPort, '/ws')
  assert.equal(ok.status, 101)
  assert.equal(ok.headers.upgrade, 'websocket')

  // 2) 字节双向透传
  const echoed = await new Promise((resolve) => {
    ok.socket.once('data', (b) => resolve(b.toString()))
    ok.socket.write('ping-through-proxy')
  })
  assert.equal(echoed, 'ping-through-proxy')

  // 3) 计数器
  const st = await (await fetch(`http://127.0.0.1:${listenPort}/__proxy/status`)).json()
  assert.ok(st.ws.total >= 1, 'ws.total 应 ≥1')
  assert.ok(st.ws.active >= 1, '连接未关时 ws.active 应 ≥1')
  ok.socket.destroy()
})

test('WS 升级：上游不升约时把响应透传回来，不悬空', async (t) => {
  const upPort = await freePort()
  const listenPort = await freePort()
  const up = await fakeUpstream(upPort)
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-')), 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ cookie: 'dsh-auth-test=deadbeef', at: Date.now() }))
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile, DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '0' })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  const res = await upgrade(listenPort, '/not-a-ws-route')
  assert.equal(res.status, 404, '应向客户端回 404，而不是挂住 socket')
  let body = ''
  for await (const chunk of res.body) body += chunk
  assert.equal(body, 'nope')
})

test('WS 升级：上游直接断链 → 客户端拿到 502，不是空回复', async (t) => {
  const upPort = await freePort()
  const listenPort = await freePort()
  const up = await fakeUpstream(upPort)
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-')), 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ cookie: 'dsh-auth-test=deadbeef', at: Date.now() }))
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile, DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '0' })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  const res = await upgrade(listenPort, '/boom')
  assert.equal(res.status, 502, '应回 502 而不是空回复')
  res.body.resume()
})
