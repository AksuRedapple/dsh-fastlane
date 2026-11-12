// M9 验收：WS 压缩桥（浏览器侧 deflate、上游侧不压、内容逐字节一致）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer, WebSocket as WSClient } from 'ws'

const PROXY = new URL('../src/dsh-web-proxy.mjs', import.meta.url).pathname
const freePort = () => new Promise((res) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

function fakeUpstream(port) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1', perMessageDeflate: false })
    wss.on('connection', (sock) => {
      sock.on('message', (data, isBinary) => {
        if (String(data) === 'BIG') sock.send(JSON.stringify({ pad: 'x'.repeat(400 * 1024), tag: 'big' }))
        else sock.send(data, { binary: isBinary })
      })
    })
    wss.on('listening', () => resolve(wss))
  })
}

function startProxy(env) {
  const child = spawn(process.execPath, [PROXY], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('proxy 未就绪')), 8000)
    child.stdout.on('data', (b) => { if (String(b).includes('已起')) { clearTimeout(t); resolve(child) } })
  })
}

function stateFile() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshp9-')), 'state.json')
  fs.writeFileSync(f, JSON.stringify({ cookie: 'dsh-auth-test=deadbeef', at: Date.now() }))
  return f
}

test('WS 压缩桥：内容一致 + 浏览器侧协商出 permessage-deflate', async (t) => {
  const upPort = await freePort(), listenPort = await freePort()
  const up = await fakeUpstream(upPort)
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile(), DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '1' })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  const client = new WSClient(`ws://127.0.0.1:${listenPort}/api/remote.mux`, { perMessageDeflate: true })
  await new Promise((r, j) => { client.on('open', r); client.on('error', j) })
  assert.match(String(client.extensions || ''), /permessage-deflate/, '浏览器侧应协商出压缩扩展')

  const small = await new Promise((resolve) => { client.once('message', (d) => resolve(String(d))); client.send('hello-压缩') })
  assert.equal(small, 'hello-压缩')

  const big = await new Promise((resolve) => { client.once('message', (d) => resolve(String(d))); client.send('BIG') })
  const obj = JSON.parse(big)
  assert.equal(obj.tag, 'big')
  assert.equal(obj.pad.length, 400 * 1024)
  client.close()
})

test('WS 压缩桥：开关关闭时退回原路（不协商 deflate）', async (t) => {
  const upPort = await freePort(), listenPort = await freePort()
  const up = await fakeUpstream(upPort)
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile(), DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '0' })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  const client = new WSClient(`ws://127.0.0.1:${listenPort}/api/remote.mux`, { perMessageDeflate: true })
  await new Promise((r, j) => { client.on('open', r); client.on('error', j) })
  assert.doesNotMatch(String(client.extensions || ''), /permessage-deflate/, '关闭时不应协商压缩')
  const echo = await new Promise((resolve) => { client.once('message', (d) => resolve(String(d))); client.send('plain') })
  assert.equal(echo, 'plain')
  client.close()
})

test('WS 压缩桥：上游拒绝升级时以非正常关闭码结束，不悬挂', async (t) => {
  const upPort = await freePort(), listenPort = await freePort()
  const srv = http.createServer((_q, r) => { r.writeHead(404); r.end('nope') })
  await new Promise((r) => srv.listen(upPort, '127.0.0.1', r))
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile(), DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '1' })
  t.after(() => { proxy.kill('SIGKILL'); srv.close() })

  const client = new WSClient(`ws://127.0.0.1:${listenPort}/api/remote.mux`)
  const outcome = await new Promise((resolve) => {
    client.on('error', (e) => resolve('error:' + e.message))
    client.on('close', (code) => resolve('close:' + code))
    setTimeout(() => resolve('still-open'), 4000)
  })
  assert.notEqual(outcome, 'still-open', '不应悬挂')
  assert.match(outcome, /^(error:|close:1[0-9]{3})$/, '应以错误或非正常关闭码结束，实际=' + outcome)
})

test('WS 压缩桥：慢客户端（读端暂停 2s）下 10MB 回放不卡死、字节全到', async (t) => {
  const upPort = await freePort(), listenPort = await freePort()
  const CHUNKS = 100, CHUNK = 100 * 1024
  let sent = 0
  const up = await new Promise((resolve) => {
    const wss = new WebSocketServer({ port: upPort, host: '127.0.0.1', perMessageDeflate: false })
    wss.on('connection', (sock) => {
      sock.on('message', (m) => {
        if (String(m) !== 'FLOOD') return
        const payload = 'x'.repeat(CHUNK)
        const timer = setInterval(() => {
          if (sent >= CHUNKS) { clearInterval(timer); sock.send('DONE'); return }
          sock.send(payload); sent++
        }, 5)
      })
    })
    wss.on('listening', () => resolve(wss))
  })
  const proxy = await startProxy({ DSHP_UP_PORT: String(upPort), DSHP_LISTEN_PORT: String(listenPort), DSHP_STATE: stateFile(), DSHP_PREWARM: '0', DSHP_WS_COMPRESS: '1' })
  t.after(() => { proxy.kill('SIGKILL'); up.close() })

  const client = new WSClient(`ws://127.0.0.1:${listenPort}/api/remote.mux`, { perMessageDeflate: true })
  await new Promise((r, j) => { client.on('open', r); client.on('error', j) })

  let bytes = 0, done = false
  const finished = new Promise((resolve) => {
    client.on('message', (d) => {
      const s = String(d)
      if (s === 'DONE') { done = true; resolve('done'); return }
      bytes += s.length
    })
    setTimeout(() => resolve('timeout'), 20000)
  })
  client.send('FLOOD')
  // 模拟慢客户端：先把读端停住，2 秒后再放开
  client.pause ? client.pause() : client._socket.pause()
  await new Promise((r) => setTimeout(r, 2000))
  client.resume ? client.resume() : client._socket.resume()

  const outcome = await finished
  assert.equal(outcome, 'done', '应在 20s 内收完，不悬挂')
  assert.equal(done, true)
  assert.equal(bytes, CHUNKS * CHUNK, '字节必须全部到达')
  client.close()
})
