// dsh-fastlane · 代理层单测（node --test）
// 跑法：node --test tests/
process.env.DSHP_NO_LISTEN = '1' // 只 import 纯逻辑，不起服务
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

const m = await import(new URL('../src/dsh-web-proxy.mjs', import.meta.url).href)

test('accepts：大小写/逗号列表，且不做子串误判', () => {
  const req = (v) => ({ headers: { 'accept-encoding': v } })
  assert.equal(m.accepts(req('gzip, deflate, br'), 'br'), true)
  assert.equal(m.accepts(req('GZIP'), 'gzip'), true)
  assert.equal(m.accepts(req('x-gzip2'), 'gzip'), false)
  assert.equal(m.accepts(req(''), 'gzip'), false)
  assert.equal(m.accepts({ headers: {} }, 'br'), false)
})

test('variantPreference：br > gzip > identity 的优先级', () => {
  const req = (v) => ({ headers: { 'accept-encoding': v } })
  assert.deepEqual(m.variantPreference(req('gzip, deflate, br, zstd')), ['br', 'gzip', 'identity'])
  assert.deepEqual(m.variantPreference(req('gzip')), ['gzip', 'identity'])
  assert.deepEqual(m.variantPreference(req('')), ['identity'])
})

test('assetPathOf：只认 /assets/ 下的白名单扩展名，且剥掉查询串', () => {
  assert.equal(m.assetPathOf('/assets/index-abc.js'), '/assets/index-abc.js')
  assert.equal(m.assetPathOf('/assets/index-abc.js?v=1'), '/assets/index-abc.js')
  assert.equal(m.assetPathOf('/assets/'), null)
  assert.equal(m.assetPathOf('/api/session/list'), null)
  assert.equal(m.assetPathOf('/assets/weird.bin'), null)
})

test('cacheKey：编码是键的一部分（避免 br/gzip 串味）', () => {
  assert.notEqual(m.cacheKey('/a.js', 'br'), m.cacheKey('/a.js', 'gzip'))
  assert.equal(m.cacheKey('/a.js', ''), '/a.js|identity')
})

test('gunzipMaybe：gzip 能还原，非 gzip 原样返回，坏数据返回 null', () => {
  const raw = Buffer.from('hello 世界'.repeat(100))
  const gz = zlib.gzipSync(raw)
  assert.deepEqual(m.gunzipMaybe(gz, 'gzip'), raw)
  assert.deepEqual(m.gunzipMaybe(raw, 'identity'), raw)
  assert.equal(m.gunzipMaybe(Buffer.from('not-gzip'), 'gzip'), null)
})

test('buildVariants：从 gzip 字节产出更小的 br 与 gzip-9 变体，且可还原', async () => {
  const raw = Buffer.from('export const x = 1\n'.repeat(2000))
  const gz = zlib.gzipSync(raw, { level: 1 })
  const path = '/assets/variants-test-' + Date.now() + '.js'
  await m.buildVariants(path, 'text/javascript', gz, 'gzip')

  const br = m.cacheGet(m.cacheKey(path, 'br'))
  const g9 = m.cacheGet(m.cacheKey(path, 'gzip'))
  assert.ok(br && g9, '两个变体都应写入缓存')
  assert.equal(br.encoding, 'br')
  assert.deepEqual(zlib.brotliDecompressSync(br.buf), raw)
  assert.deepEqual(zlib.gunzipSync(g9.buf), raw)
  assert.ok(br.buf.length < g9.buf.length, 'br 应小于 gzip-9')
  assert.ok(g9.buf.length < gz.length, 'gzip-9 应小于 gzip-1')
})

test('buildVariants：超过上限的正文不再压 br（不为大文件烧 CPU）', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x61)
  const gz = zlib.gzipSync(big)
  const path = '/assets/too-big-' + Date.now() + '.js'
  await m.buildVariants(path, 'text/javascript', gz, 'gzip')
  assert.equal(m.cacheGet(m.cacheKey(path, 'br')), null)
})

test('statusPayload：形状稳定（监控/脚本依赖这些字段）', () => {
  const s = m.statusPayload()
  for (const k of ['ok', 'uptimeSec', 'upstream', 'listen', 'cookie', 'assetCache', 'prewarm', 'ws', 'requests', 'node']) {
    assert.ok(k in s, '缺少字段 ' + k)
  }
  assert.ok('variants' in s.assetCache)
  assert.ok(['idle', 'running', 'done'].includes(s.prewarm.state) || String(s.prewarm.state).startsWith('failed'))
})
