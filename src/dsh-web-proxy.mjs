#!/usr/bin/env node
// dsh-web-proxy · 免 token 代理 + 慢链路加速层（2026-10-25 立，2026-10-28 加缓存层）
//
// 为什么有它：DSH 的 web-app 只在 `GET /` 上认 launch token，换成 authority 绑定的
// 会话 cookie（`dsh-auth-<hash>`），之后靠 cookie 放行；`connection` 的 Config 里
// 没有「关掉认证」的口子。要让 tailnet 内的手机「打开即用、不带 token」，只能让
// 代理在服务端完成这次交换：代理持有 DSH cookie，浏览器什么都不用带。
//
// 拓扑（地址不变）：
//   浏览器 https://<machine>.<tailnet>.ts.net:10001/   ← tailscale serve（tailnet-only）
//        → 127.0.0.1:8781（本代理，免 token 入口）
//        → 127.0.0.1:8780（DSH，Host 改写成绑定 IP 字面量，绕开 browser-trust fence）
//   公网路径：https://<your-domain> → CF 隧道 → 127.0.0.1:8790（外部 gate）→ 本代理
//
// 安全边界：只有 tailnet / 窄门（owner）能到；代理只监听 127.0.0.1；
// DSH cookie 落在 ~/.cache/dsh-fastlane.json（0600），不外发、不进浏览器。
//
// 2026-10-28 加速层（为什么加）：
//   DSH 的静态资源返回 chunked + 无 cache-control / 无 etag，浏览器每次都重取；
//   经 CF 隧道时落点在 lax07/lax13（洛杉矶），1.7MB JS 每趟跨太平洋。实测直连
//   1.9ms、经隧道 2.4–7s（连 601B 的 401 页都要 7s）。资源名本身是内容哈希
//   （index-BXV-oxvX.js），因此可以安全地标 immutable 并本地缓存，重复打开
//   接近零流量。
//
//   未做「WS 背压」：Node 的 socket.pipe 自带 pause/resume 背压，抄一个
//   bufferedAmount 守卫在纯管道里是死代码。真需要时优先换 ws 库的 send 队列。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

// 配置面：全部可用环境变量覆盖，改端口/路径不用动代码
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const PORT = (k, d) => { const v = Number(env(k, d)); if (!Number.isInteger(v) || v <= 0 || v > 65535) throw new Error(`${k} 不是合法端口: ${v}`); return v }

const UP_HOST = env('DSHP_UP_HOST', '127.0.0.1')
const UP_PORT = PORT('DSHP_UP_PORT', 8780)
const LISTEN_HOST = env('DSHP_LISTEN_HOST', '127.0.0.1')
const LISTEN_PORT = PORT('DSHP_LISTEN_PORT', 8781)
const LOG = path.resolve(env('DSHP_DSH_LOG', path.join(os.homedir(), 'Library', 'Logs', 'DeepSeek Harness', 'dsh-web.log')))
const STATE = path.resolve(env('DSHP_STATE', path.join(os.homedir(), '.cache', 'dsh-fastlane.json')))

const HELP = `dsh-fastlane — DSH 网页版的慢链路加速代理

用法：
  node src/dsh-web-proxy.mjs [--help]

环境变量（都有默认值）：
  DSHP_UP_HOST        上游 DSH 主机        默认 127.0.0.1
  DSHP_UP_PORT        上游 DSH 端口        默认 8780
  DSHP_LISTEN_HOST    本代理监听地址        默认 127.0.0.1（别改成 0.0.0.0：鉴权在入口层）
  DSHP_LISTEN_PORT    本代理监听端口        默认 8781
  DSHP_DSH_LOG        DSH 日志路径（取 launch token 用）
  DSHP_STATE          cookie 落盘路径        默认 ~/.cache/dsh-fastlane.json
  DSHP_ASSET_CACHE_MB 静态资源缓存上限      默认 96
  DSHP_PREWARM        启动预热 br 变体      默认 1（0 关闭）

出口（二选一，见 README）：
  tailscale serve --bg --https=10001 http://127.0.0.1:8781
  cloudflared tunnel run <隧道名>
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}
const TOKEN_RE = /dsh web:\s*http:\/\/[^?\s]+\?token=([^\s]+)/g
const MAX_BODY = 12 * 1024 * 1024

let cookiePair = null // "dsh-auth-<hash>=<value>" 整个对，名字与 authority 绑定，不能只留 value
let cookieAt = 0

/* ── 加速层：静态资源缓存 ───────────────────────────────────────────── */
const IMMUTABLE = 'public, max-age=31536000, immutable'
const ASSET_MAX_BYTES = Number(process.env.DSHP_ASSET_CACHE_MB || 96) * 1024 * 1024
const ASSET_MAX_ENTRY = 8 * 1024 * 1024
const ASSET_EXT = /\.(js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico)$/i
const ASSET_TEXT = /\.(js|mjs|css|map|svg|json|html|txt)$/i
const BR_MAX_BYTES = 4 * 1024 * 1024 // 超过就不再压 br：CPU 不划算
const JSON_BR_MAX = 2 * 1024 * 1024 // JSON 响应超过这个就不再缓冲/压缩
const JSON_BR_MIN = 8 * 1024 // 小响应不值得换编码
const JSON_BR_LEVEL = 5

/* ── 页面注入（M8）：窄屏把左侧 56px 竖条收起来，留一个悬浮开关 ──────
   为什么用几何识别而不是类名：DSH 的样式是模块化哈希名，没有稳定的
   sidebar/rail 类，也没有宽度变量；唯一稳定的事实是「一个靠左、宽约
   56px、高过一屏的方块」。认出它、给它打标记、用一条 CSS 收起。
   失败即放弃（找不到就不动），环境变量 DSHP_INJECT=0 可整体关掉。 */
const INJECT_ENABLED = String(env('DSHP_INJECT', '1')) !== '0'

/* ── M9：WS 压缩代理（permessage-deflate 装在浏览器侧）───────────────
   现状：切一次会话要回放 ~1MB 的 JSON 历史，跨洋约 6s。
   做法：用 ws 库把浏览器侧和上游侧都终结，浏览器侧开 deflate，上游侧不开——
   内容一样是密文/明文原样转，只是浏览器那段链路压过。
   稳定性：默认关闭（DSHP_WS_COMPRESS=0），ws 不可用或开关关闭时**完全走原来的 raw pipe**；
   单连接出错只拆这一条，不影响进程；可随时一键退回。 */
let WS_IMPL = null
try { WS_IMPL = await import('ws') } catch { WS_IMPL = null }
const WS_COMPRESS = String(env('DSHP_WS_COMPRESS', '1')) !== '0' && Boolean(WS_IMPL)
const WS_MAX_PAYLOAD = Number(env('DSHP_WS_MAX_MB', 64)) * 1024 * 1024
const RAIL_HTML = '<script src="/__dshp/inject.js" defer></script>' // 仅 ?dshp=1 时注入
const INJECT_JS = String.raw`(function () {
  if (window.__dshp8) return; window.__dshp8 = true;
  var KEY = 'dshp.rail8';                 // 'hidden'（默认）| 'shown' | 'off'（自愈放弃）
  function report(m, i) { try { new Image().src = '/__dshp/report?m=' + encodeURIComponent(m) + '&i=' + encodeURIComponent(i || ''); } catch (e) {} }
  function state() { try { return localStorage.getItem(KEY) || 'hidden'; } catch (e) { return 'hidden'; } }
  function setState(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  if (state() === 'off') { report('skip-off'); return; }

  var styleEl = document.createElement('style');
  styleEl.id = 'dshp8-style';
  (document.head || document.documentElement).appendChild(styleEl);

  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function findFrame() {
    var f = document.querySelector('[data-sidebar-collapsed]');
    if (f) return f;
    var divs = document.body ? document.body.querySelectorAll('div') : [];
    for (var i = 0; i < divs.length && i < 800; i++) {
      var el = divs[i], cs = window.getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display !== 'grid') continue;
      if (r.height < window.innerHeight * 0.85) continue;
      if (cs.gridTemplateColumns.split(' ').filter(Boolean).length >= 2) return el;
    }
    return null;
  }
  var frame = null, railW = 0;

  function ensureBtn() {
    var b = document.getElementById('dshp8-btn');
    if (b) return b;
    b = document.createElement('button');
    b.id = 'dshp8-btn'; b.type = 'button';
    // 视觉上只有 6px 一条细缝，命中区留 22px——不抢内容宽度
    b.style.cssText = 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;' +
      'width:20px;height:44px;padding:0;border:0;background:transparent;display:flex;align-items:center;' +
      'justify-content:flex-end;-webkit-tap-highlight-color:transparent;';
    var bar = document.createElement('span');
    bar.id = 'dshp8-bar';
    bar.style.cssText = 'display:block;width:5px;height:34px;border-radius:3px 0 0 3px;' +
      'background:rgba(150,150,150,.32);transition:background .15s;';
    b.appendChild(bar);
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var next = state() === 'hidden' ? 'shown' : 'hidden';
      setState(next);
      apply();
      report('toggle', next);
    });
    document.body.appendChild(b);
    return b;
  }
  function paintBtn() {
    var b = ensureBtn();
    var bar = b.querySelector('#dshp8-bar');
    var hidden = state() === 'hidden';
    var title = hidden ? '显示侧栏' : '隐藏侧栏';
    b.title = title;
    b.setAttribute('aria-label', title);
    if (bar) bar.style.background = hidden ? 'rgba(150,150,150,.42)' : 'rgba(120,190,150,.55)';
  }

  function apply() {
    if (!frame || !frame.isConnected) frame = findFrame();
    if (!frame) { report('no-frame'); return; }
    var kids = [].slice.call(frame.children).filter(visible);
    if (!kids.length) { report('no-kids'); return; }
    if (!railW || !(railW > 0 && railW <= 120)) railW = Math.round(kids[0].getBoundingClientRect().width);
    if (!(railW > 0 && railW <= 120)) { report('skip-firstcol', 'railW=' + railW); return; }

    paintBtn();
    if (state() !== 'hidden') {               // 显示态：清掉我们加的样式，恢复原样
      frame.removeAttribute('data-dshp8');
      styleEl.textContent = '';
      report('shown', 'rail=' + railW);
      return;
    }
    frame.setAttribute('data-dshp8', 'off');
    styleEl.textContent =
      '[data-dshp8]{transform:translateX(-' + railW + 'px)!important;width:calc(100% + ' + railW + 'px)!important}' +
      'html,body{overflow-x:hidden!important}';
    setTimeout(function () {
      try {
        var r = frame.getBoundingClientRect();
        var c = frame.children[1] ? frame.children[1].getBoundingClientRect() : null;
        report('ok', 'w=' + Math.round(r.width) + ' x=' + Math.round(r.x) + ' center=' + (c ? Math.round(c.width) : '?'));
        fitLater();
      } catch (e) { report('check-error', e.message); }
    }, 400);
  }

  // 内容区收紧 v2：不猜类名——从滚动容器往上走，凡是带横向内边距的祖先都算「内边距链」，
  // 把这条链上的左右内边距压到 8px。链上可能有两三层（slot → scroll），逐层压才对。
  var fitStyle = null;
  function dumpPads(center, scroll) {
    var out = [], all = center.querySelectorAll('*');
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i], cs = window.getComputedStyle(el);
      var pl = Math.round(parseFloat(cs.paddingLeft) || 0);
      var pr = Math.round(parseFloat(cs.paddingRight) || 0);
      if (pl < 6 && pr < 6) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 120) continue;
      out.push({ w: Math.round(r.width), x: Math.round(r.x), pl: pl, pr: pr, tag: el.tagName.toLowerCase(), cls: String(el.className || '').split(' ')[0].slice(0, 14) });
    }
    out.sort(function (a, b) { return b.w - a.w; });
    return out.slice(0, 6).map(function (o) { return o.w + '@' + o.x + ' p' + o.pl + '/' + o.pr + ' ' + o.tag + '.' + o.cls; }).join(' | ');
  }

  function fitContent() {
    if (!frame) return report('fit-no-frame');
    var center = frame.children[1];
    if (!center) return report('fit-no-center');
    var all = center.querySelectorAll('*');
    var scroll = null, bestArea = 0;
    var cw = center.clientWidth;
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i], cs = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.clientWidth < cw * 0.6 || el.clientHeight < 200) continue;   // 放掉“必须已可滚”的条件
      var area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { bestArea = area; scroll = el; }
    }
    // 主路径：不依赖"能不能滚"——中心列里凡是「左右内边距都 ≥24 且宽度 ≥90%」的元素，
    // 就是吃宽度的那几层（实测是 slot 32/32 + scroll 32/32；header 20/28、输入区 16/16 都不满足）
    var chain = [], node = scroll, guard = 0;
    while (node && node !== center && guard++ < 8) {
      var c2 = window.getComputedStyle(node);
      var pl = Math.round(parseFloat(c2.paddingLeft) || 0);
      var pr = Math.round(parseFloat(c2.paddingRight) || 0);
      if (pl >= 12 && pr >= 12) chain.push({ el: node, pl: pl, pr: pr });
      node = node.parentElement;
    }
    if (!chain.length) {
      for (var k = 0; k < all.length && k < 4000; k++) {
        var e2 = all[k], s2 = window.getComputedStyle(e2);
        var l2 = Math.round(parseFloat(s2.paddingLeft) || 0);
        var r2 = Math.round(parseFloat(s2.paddingRight) || 0);
        var w2 = e2.getBoundingClientRect().width;
        if (l2 >= 24 && r2 >= 24 && w2 >= cw * 0.9) chain.push({ el: e2, pl: l2, pr: r2 });
        if (chain.length >= 3) break;
      }
    }
    if (!chain.length) return report('fit-no-chain', (scroll ? '' : 'no-scroll ') + dumpPads(center, scroll));
    if (!fitStyle) { fitStyle = document.createElement('style'); fitStyle.id = 'dshp10-fit'; document.head.appendChild(fitStyle); }
    fitStyle.textContent = '[data-dshp-fit]{padding-left:8px!important;padding-right:8px!important}';
    var probe = chain[chain.length - 1].el;
    // 注意：clientWidth 含 padding，改 padding 不会改它 —— 要量子元素（内容区）
    function contentWidth(el) {
      var max = 0;
      for (var i = 0; i < el.children.length; i++) {
        var w = el.children[i].getBoundingClientRect().width;
        if (w > max) max = w;
      }
      return Math.round(max || el.scrollWidth);
    }
    var before = contentWidth(probe);
    chain.forEach(function (o) { o.el.setAttribute('data-dshp-fit', ''); });

    setTimeout(function () {
      try {
        var after = contentWidth(probe);
        var info = chain.map(function (o) { return o.pl + '/' + o.pr; }).join('+');
        if (after - before < 10) {
          chain.forEach(function (o) { o.el.removeAttribute('data-dshp-fit'); });
          fitStyle.textContent = '';
          report('fit-revert', 'before=' + before + ' after=' + after + ' chain=' + info);
        } else {
          report('fit-ok', '+' + (after - before) + 'px (chain ' + info + ')');
        }
      } catch (e) { report('fit-error', e.message); }
    }, 350);
  }

  var fitTries = 0;
  function fitLater() {
    if (fitTries >= 6) return;
    fitTries++;
    var delays = [300, 800, 1600, 3000, 5000, 8000];
    setTimeout(function () { try { fitContent(); } catch (e) { report('fit-error', e.message); } }, delays[fitTries - 1]);
  }

  function boot() {
    report('boot', 'state=' + state());
    apply();
    var t = null;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(apply, 200); }, { passive: true });
    new MutationObserver(function () {
      if (!document.getElementById('dshp8-btn')) paintBtn();
    }).observe(document.body, { childList: true, subtree: false });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();`


/* ── RPC 只读缓存（M7）：把「每 300ms 问一次同一件事」变成本地读 ────── */
const RPC_TTL_MS = Number(env('DSHP_RPC_TTL_MS', 20000))
// 动态但只读的接口给短 TTL：它会在发消息后变，但不该每次都出海
const RPC_TTL_BY_METHOD = { 'session/list': 5000 }
const ttlOf = (method) => RPC_TTL_BY_METHOD[method] ?? RPC_TTL_MS
const RPC_MAX = Number(env('DSHP_RPC_CACHE_MAX', 512))
const RPC_MAX_BODY = 512 * 1024
const RPC_ENABLED = String(env('DSHP_RPC_CACHE', '1')) !== '0'
// 只读白名单：宁可漏缓存，不可缓存写
const RPC_ALLOW = new Set([
  'credentials/describe', 'commands/list', 'permissionPresets/catalog',
  'agentPresets/list', 'settings/describe', 'schedule/list',
  'session/modelCatalog', 'messageFeedback/list', 'llm/listProviders',
  'session/list',
  'llm/listConfigurableProviders', 'skills/list', 'account/getProfile',
])
const RPC_INVALIDATE = /mutate|create|update|delete|remove|archive|prompt|cancel|interrupt|set[A-Z]|save/i
const rpcCache = new Map() // key → { body:Buffer, type:string, at:number }
let rpcBytes = 0 // 197KB 的 session/list：br5 52KB/3ms vs 上游 gzip 73KB
const PREWARM_MAX_ASSETS = 12
const assetCache = new Map() // key: cleanPath + '|' + encoding → { buf, type, encoding, etag }
let assetBytes = 0
const stats = {
  started: Date.now(),
  prewarm: { state: 'idle', assets: 0, at: null, bytesSaved: 0 },
  reqTotal: 0,
  assetHits: 0,
  assetMisses: 0,
  assetSavedBytes: 0,
  wsActive: 0,
  wsTotal: 0,
  wsCompress: { enabled: WS_COMPRESS, connections: 0, msgsToClient: 0, bytesToClient: 0, msgsToServer: 0, bytesToServer: 0, errors: 0 },
  jsonBr: { count: 0, savedBytes: 0 },
  rpcCache: { enabled: RPC_ENABLED, hits: 0, misses: 0, stores: 0, upstream: 0, entries: 0, bytes: 0 },
}

function assetPathOf(url) {
  const clean = url.split('?')[0]
  if (!clean.startsWith('/assets/')) return null
  if (!ASSET_EXT.test(clean)) return null
  return clean
}

function accepts(req, enc) {
  return new RegExp('(^|,)\\s*' + enc + '\\b', 'i').test(String(req.headers['accept-encoding'] || ''))
}
function clientWantsGzip(req) { return accepts(req, 'gzip') }

/** 客户端能吃什么，按优先级排；upstream 只会给我们 gzip 或 identity */
function variantPreference(req) {
  const list = []
  if (accepts(req, 'br')) list.push('br')
  if (accepts(req, 'gzip')) list.push('gzip')
  list.push('identity')
  return list
}

function cacheKey(clean, encoding) {
  return clean + '|' + (encoding || 'identity')
}

function cacheGet(key) {
  const hit = assetCache.get(key)
  if (!hit) return null
  // LRU：重新插入到末尾
  assetCache.delete(key)
  assetCache.set(key, hit)
  return hit
}

function cacheSet(key, entry) {
  if (entry.buf.length > ASSET_MAX_ENTRY) return
  const prev = assetCache.get(key)
  if (prev) {
    assetBytes -= prev.buf.length
    assetCache.delete(key)
  }
  assetCache.set(key, entry)
  assetBytes += entry.buf.length
  while (assetBytes > ASSET_MAX_BYTES && assetCache.size > 1) {
    const [oldKey, oldVal] = assetCache.entries().next().value
    assetCache.delete(oldKey)
    assetBytes -= oldVal.buf.length
  }
}

function serveCached(req, res, entry, clean) {
  const etag = entry.etag
  const inm = req.headers['if-none-match']
  if (inm && inm.split(',').some((v) => v.trim() === etag)) {
    res.writeHead(304, { etag, 'cache-control': IMMUTABLE, 'x-dshp-cache': 'revalidate' })
    res.end()
    stats.assetHits++
    stats.assetSavedBytes += entry.buf.length
    return true
  }
  const headers = {
    'content-type': entry.type,
    'cache-control': IMMUTABLE,
    etag,
    'content-length': String(entry.buf.length),
    vary: 'Accept-Encoding',
    'x-dshp-cache': 'hit',
  }
  if (entry.encoding) headers['content-encoding'] = entry.encoding
  res.writeHead(200, headers)
  if (req.method === 'HEAD') res.end()
  else res.end(entry.buf)
  stats.assetHits++
  stats.assetSavedBytes += entry.buf.length
  console.log(new Date().toISOString(), 'ASSET-HIT', clean, entry.buf.length + 'B', entry.encoding || 'identity')
  return true
}

/* ── cookie / token ───────────────────────────────────────────────── */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    if (s.cookie) { cookiePair = s.cookie; cookieAt = s.at || 0 }
  } catch { /* 无状态文件 = 首次跑 */ }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true })
    fs.writeFileSync(STATE, JSON.stringify({ cookie: cookiePair, at: cookieAt }), { mode: 0o600 })
  } catch { /* 落盘失败不影响服务 */ }
}
function readToken() {
  try {
    const txt = fs.readFileSync(LOG, 'utf8')
    const all = [...txt.matchAll(TOKEN_RE)]
    return all.length ? all[all.length - 1][1] : null
  } catch { return null }
}

async function exchangeCookie() {
  const token = readToken()
  if (!token) return null
  try {
    const res = await fetch(`http://${UP_HOST}:${UP_PORT}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const c of setCookies) {
      const m = /^([^=]+)=([^;]*)/.exec(c.trim())
      if (m && m[1].startsWith('dsh-auth-')) {
        cookiePair = `${m[1]}=${m[2]}`
        cookieAt = Date.now()
        saveState()
        return cookiePair
      }
    }
  } catch { /* DSH 未起 */ }
  return null
}

async function ensureCookie() {
  if (cookiePair) return cookiePair
  return exchangeCookie()
}

function upstreamHeaders(req) {
  const h = { ...req.headers }
  h.host = `${UP_HOST}:${UP_PORT}`
  h.cookie = cookiePair
  h.origin = `http://${UP_HOST}:${UP_PORT}`
  delete h['sec-fetch-site']
  // 静态资源按客户端能力向 DSH 要确定的一种编码，缓存键才不会串味
  if (assetPathOf(req.url)) h['accept-encoding'] = clientWantsGzip(req) ? 'gzip' : 'identity'
  return h
}

/* ── 转发（带资源缓存捕获）───────────────────────────────────────── */
function pipeRequest(req, res, body, t0, rpcKey) {
  const clean = assetPathOf(req.url)
  const options = {
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req),
  }
  return new Promise((resolve) => {
    const upReq = http.request(options, (upRes) => {
      const headers = { ...upRes.headers }
      delete headers['set-cookie'] // cookie 归代理管，不下发给浏览器
      const enc = headers['content-encoding'] || ''
      const cacheable =
        clean &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        upRes.statusCode === 200 &&
        !/no-store/i.test(String(headers['cache-control'] || ''))

      if (clean) headers['x-dshp-cache'] = 'miss'
      if (cacheable) {
        // 资源名是内容哈希：可以标 immutable，并去掉 chunked 让浏览器拿到长度
        headers['cache-control'] = IMMUTABLE
        headers['etag'] = `"${clean}"`
        delete headers['transfer-encoding']
        stats.assetMisses++
      } else {
        delete headers['content-length']
      }

      console.log(
        new Date().toISOString(), 'RESP', upRes.statusCode, req.url,
        'len=' + (upRes.headers['content-length'] || 'chunked'),
        (Date.now() - t0) + 'ms',
      )

      // JSON 响应换 brotli：语义不变，只是换编码。上游 gzip 偏弱（73KB），br5 约 52KB
      const jsonCandidate =
        !clean &&
        (req.method === 'GET' || req.method === 'POST') &&
        upRes.statusCode === 200 &&
        /^application\/json/i.test(String(headers['content-type'] || '')) &&
        (accepts(req, 'br') || Boolean(rpcKey)) &&
        !/stream|event|watch|sse/i.test(req.url)
      if (jsonCandidate) {
        bufferAndBrotli(req, res, upRes, headers, rpcKey)
        return
      }

      const isHtml = /^text\/html/i.test(String(headers['content-type'] || ''))
      const optOut = req.url.indexOf('dshp=0') >= 0
      if (INJECT_ENABLED && !optOut && isHtml && (req.method === 'GET') && upRes.statusCode === 200) {
        injectIntoHtml(req, res, upRes, headers)
        return
      }

      res.writeHead(upRes.statusCode, headers)

      if (!cacheable) {
        upRes.pipe(res)
        upRes.on('end', () => resolve(upRes.statusCode))
        upRes.on('error', () => resolve(0))
        return
      }

      const expectEnc = clientWantsGzip(req) ? 'gzip' : ''
      const chunks = []
      let total = 0
      let overflow = false
      upRes.on('data', (chunk) => {
        res.write(chunk)
        if (overflow) return
        total += chunk.length
        if (total > ASSET_MAX_ENTRY) { overflow = true; chunks.length = 0; return }
        chunks.push(chunk)
      })
      upRes.on('end', () => {
        if (!overflow && chunks.length) {
          const stored = Buffer.concat(chunks)
          cacheSet(cacheKey(clean, expectEnc || 'identity'), {
            buf: stored,
            type: String(headers['content-type'] || 'application/octet-stream'),
            encoding: enc || '',
            etag: `"${clean}"`,
          })
          console.log(new Date().toISOString(), 'ASSET-STORE', clean, total + 'B', enc || 'identity', 'cache=' + assetCache.size)
          // 后台补建 gzip-9 / brotli 变体（不阻塞本次响应）
          if (ASSET_TEXT.test(clean)) {
            setImmediate(() => {
              buildVariants(clean, String(headers['content-type'] || 'application/octet-stream'), stored, enc)
                .catch((e) => console.log('ASSET-VARIANT-FAIL', clean, e.message))
            })
          }
        }
        res.end()
        resolve(upRes.statusCode)
      })
      upRes.on('error', () => { res.destroy(); resolve(0) })
    })
    upReq.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`DSH 上游不可达：${e.message}\n（确认 DSH web 服务正在运行）`)
      }
      resolve(0)
    })
    if (body && body.length) upReq.write(body)
    upReq.end()
  })
}

/* ── 变体构建：把一份字节变成 gzip-9 + brotli 两份缓存 ─────────────── */
const gzipAsync = (buf) => new Promise((res, rej) => zlib.gzip(buf, { level: 9 }, (e, out) => e ? rej(e) : res(out)))
const brotliAsync = (buf) => new Promise((res, rej) => zlib.brotliCompress(buf, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
  },
}, (e, out) => e ? rej(e) : res(out)))

function gunzipMaybe(buf, encoding) {
  if (encoding !== 'gzip') return buf
  try { return zlib.gunzipSync(buf) } catch { return null }
}

async function buildVariants(clean, type, stored, upstreamEncoding) {
  const raw = gunzipMaybe(stored, upstreamEncoding)
  if (!raw) return
  if (raw.length > BR_MAX_BYTES) return
  const etag = `"${clean}"`
  const g9 = await gzipAsync(raw)
  cacheSet(cacheKey(clean, 'gzip'), { buf: g9, type, encoding: 'gzip', etag })
  const br = await brotliAsync(raw)
  cacheSet(cacheKey(clean, 'br'), { buf: br, type, encoding: 'br', etag })
  console.log(new Date().toISOString(), 'ASSET-VARIANTS', clean, 'raw=' + raw.length + 'B', 'br=' + br.length + 'B')
}

/** 启动预热：把当前首屏引用的资源先算好 br 变体，让「第一次打开」就吃到小的那份 */
async function prewarm() {
  stats.prewarm.state = 'running'
  try {
    await ensureCookie()
    if (!cookiePair) { stats.prewarm.state = 'no-cookie'; return }
    const html = await new Promise((resolve, reject) => {
      const r = http.get({ host: UP_HOST, port: UP_PORT, path: '/', headers: { cookie: cookiePair } }, (res) => {
        const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve(Buffer.concat(b).toString('utf8')))
      })
      r.on('error', reject)
    })
    const refs = [...new Set([...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => '/' + m[1]))].slice(0, PREWARM_MAX_ASSETS)
    let done = 0
    for (const ref of refs) {
      if (!ASSET_EXT.test(ref)) continue
      const got = await new Promise((resolve) => {
        const r = http.get({ host: UP_HOST, port: UP_PORT, path: ref, headers: { cookie: cookiePair, 'accept-encoding': 'gzip' } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); resolve(null); return }
          const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ buf: Buffer.concat(b), type: String(res.headers['content-type'] || 'application/octet-stream'), enc: String(res.headers['content-encoding'] || '') }))
        })
        r.on('error', () => resolve(null))
      })
      if (!got) continue
      await buildVariants(ref, got.type, got.buf, got.enc)
      done++
    }
    stats.prewarm = { state: 'done', assets: done, at: Date.now() }
    console.log(new Date().toISOString(), 'PREWARM-DONE', done + ' assets')
  } catch (e) {
    stats.prewarm.state = 'failed: ' + e.message
    console.log('PREWARM-FAIL', e.message)
  }
}

/* ── JSON 响应即席 brotli（不改结构，只换编码）────────────────────── */
function bufferAndBrotli(req, res, upRes, headers, rpcKey) {
  const aborted = { done: false }
  const chunks = []
  let total = 0
  const finish = (compress) => {
    if (aborted.done) return
    aborted.done = true
    let body = Buffer.concat(chunks)
    if (compress) {
      const enc = String(headers['content-encoding'] || '')
      if (enc === 'gzip') {
        try { body = zlib.gunzipSync(body) } catch { compress = false }
      } else if (enc && enc !== 'identity') {
        compress = false
      }
    }
    const outHeaders = { ...headers }
    delete outHeaders['transfer-encoding']
    delete outHeaders['connection']
    if (compress) {
      let br
      try {
        br = zlib.brotliCompressSync(body, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: JSON_BR_LEVEL,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        })
      } catch { br = null }
      if (br && br.length < body.length) {
        outHeaders['content-encoding'] = 'br'
        outHeaders['content-length'] = String(br.length)
        outHeaders['x-dshp-compress'] = 'br'
        stats.jsonBr.count++
        stats.jsonBr.savedBytes += Math.max(0, body.length - br.length)
        res.writeHead(200, outHeaders)
        res.end(br)
        return
      }
    }
    outHeaders['content-length'] = String(body.length)
    res.writeHead(200, outHeaders)
    res.end(body)
  }

  upRes.on('data', (c) => {
    if (aborted.done) return
    total += c.length
    if (total > JSON_BR_MAX) {
      // 太大：放弃压缩，把已缓冲的吐出去后转为流式
      aborted.done = true
      const h = { ...headers }
      delete h['transfer-encoding']
      delete h['content-length']
      res.writeHead(200, h)
      res.write(Buffer.concat(chunks))
      chunks.length = 0
      upRes.pipe(res)
      return
    }
    chunks.push(c)
  })
  upRes.on('end', () => {
    if (aborted.done) { res.end(); return }
    if (rpcKey && upRes.statusCode === 200) {
      const type = String(headers['content-type'] || 'application/json')
      let raw = Buffer.concat(chunks)
      const enc0 = String(headers['content-encoding'] || '')
      if (enc0 === 'gzip') { try { raw = zlib.gunzipSync(raw) } catch { raw = null } }
      else if (enc0 && enc0 !== 'identity') raw = null
      if (raw && raw.length <= RPC_MAX_BODY) rpcSet(rpcKey, raw, type, ttlOf(rpcKey.split('|')[0]))
    }
    if (total < JSON_BR_MIN) {
      // 小响应：不解压不压缩，直接原样发（保持上游编码）
      const h = { ...headers }
      delete h['transfer-encoding']
      const body = Buffer.concat(chunks)
      h['content-length'] = String(body.length)
      res.writeHead(200, h)
      res.end(body)
      return
    }
    finish(true)
  })
  upRes.on('error', () => { if (!aborted.done) { aborted.done = true; res.destroy() } })
}

/* ── M9：压缩桥（浏览器 ⇄ 代理 ⇄ DSH）────────────────────────────── */
const wss = WS_IMPL
  ? new WS_IMPL.WebSocketServer({
      noServer: true,
      perMessageDeflate: { threshold: Number(env('DSHP_WS_DEFLATE_MIN', 512)), zlibDeflateOptions: { level: 6 } },
      maxPayload: WS_MAX_PAYLOAD,
    })
  : null

function compressedUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (client) => bridgeCompressed(req, client))
}

function bridgeCompressed(req, client) {
  const c = stats.wsCompress
  c.connections++
  stats.wsTotal++
  const proto = req.headers['sec-websocket-protocol']
  const headers = { cookie: cookiePair, origin: `http://${UP_HOST}:${UP_PORT}` }
  if (proto) headers['sec-websocket-protocol'] = proto
  const up = new WS_IMPL.WebSocket(`ws://${UP_HOST}:${UP_PORT}${req.url}`, {
    headers,
    perMessageDeflate: false,       // 上游侧不压：保持 DSH 看到的行为不变
    maxPayload: WS_MAX_PAYLOAD,
  })
  let closed = false
  const closeAll = (why) => {
    if (closed) return
    closed = true
    try { clearTimeout(openTimer) } catch {}
    c.connections = Math.max(0, c.connections - 1)
    stats.wsActive = Math.max(0, stats.wsActive - 1)
    try { toClient.length = 0; qBytes = 0 } catch {}
    try { if (client.readyState === 1) client.close(1000) } catch {}
    try { up.terminate() } catch {}
    let wireIn = 0, wireOut = 0
    try { wireIn = client._socket ? client._socket.bytesRead : 0; wireOut = client._socket ? client._socket.bytesWritten : 0 } catch {}
    console.log(new Date().toISOString(), 'WS2-CLOSE', req.url, why,
      'payloadToClient=' + Math.round(c.bytesToClient / 1024) + 'KB',
      'wireToClient=' + Math.round(wireOut / 1024) + 'KB',
      'payloadFromClient=' + Math.round(c.bytesToServer / 1024) + 'KB')
  }

  const pending = []
  let pendingBytes = 0
  const flush = () => {
    while (pending.length && up.readyState === 1) {
      const m = pending.shift()
      up.send(m.data, { binary: m.binary })
    }
    pendingBytes = pending.reduce((n, m) => n + m.data.length, 0)
  }
  client.on('message', (data, isBinary) => {
    c.msgsToServer++; c.bytesToServer += data.length
    if (up.readyState === 1) { up.send(data, { binary: isBinary }); return }
    if (up.readyState > 1) return                    // 已关闭，丢弃
    if (pendingBytes + data.length > 8 * 1024 * 1024) { c.errors++; closeAll('queue-overflow'); return }
    pending.push({ data, binary: isBinary }); pendingBytes += data.length
  })
  // 串行发送队列（确认驱动）：一次只在途一帧。没有 pause/resume，也就没有"忘了恢复"。
  const toClient = []
  let qBytes = 0
  let sending = false
  const Q_MAX = Number(env('DSHP_WS_QUEUE_MB', 16)) * 1024 * 1024
  function pumpToClient() {
    if (sending || closed || client.readyState !== 1 || !toClient.length) return
    const item = toClient.shift()
    qBytes -= item.data.length
    sending = true
    client.send(item.data, { binary: item.binary }, (err) => {
      sending = false
      if (err) { c.errors++; closeAll('client-send-error:' + err.message); return }
      pumpToClient()
    })
  }
  up.on('message', (data, isBinary) => {
    c.msgsToClient++; c.bytesToClient += data.length
    if (closed || client.readyState !== 1) return
    if (qBytes + data.length > Q_MAX) {          // 队列上限：宁可断开重连，也不无限涨
      c.errors++; closeAll('client-queue-overflow');
      try { client.close(1011, 'client too slow') } catch {}
      return
    }
    toClient.push({ data, binary: isBinary }); qBytes += data.length
    pumpToClient()
  })
  up.on('open', () => {
    stats.wsActive++
    clearTimeout(openTimer)
    flush()
  })
  // 上游没给 101（404/401 等）：ws 会发 unexpected-response，不会自动关，必须自己收
  up.on('unexpected-response', (rq, res) => {
    c.errors++
    closeAll('up-unexpected:' + res.statusCode)
    try { if (client.readyState === 1) client.close(1011, 'upstream rejected') } catch {}
  })
  const openTimer = setTimeout(() => { if (!closed) closeAll('up-timeout') }, 10000)
  up.on('close', () => closeAll('upstream'))
  client.on('close', () => closeAll('client'))
  up.on('error', (e) => { c.errors++; closeAll('up-error:' + e.message) })
  client.on('error', () => { c.errors++; closeAll('client-error') })
}

/* ── HTML 注入：只为窄屏收起侧栏，失败即原样放行 ─────────────────── */
function injectIntoHtml(req, res, upRes, headers) {
  const chunks = []
  let total = 0
  let bail = false
  upRes.on('data', (c) => {
    if (bail) { res.write(c); return }
    total += c.length
    if (total > 4 * 1024 * 1024) { // 太大就别碰了，原样透传
      bail = true
      const h = { ...headers }
      delete h['content-encoding']; delete h['content-length']; delete h['transfer-encoding']
      res.writeHead(200, h); res.write(Buffer.concat(chunks)); res.write(c); upRes.pipe(res)
      return
    }
    chunks.push(c)
  })
  upRes.on('end', () => {
    if (bail) { res.end(); return }
    let body = Buffer.concat(chunks)
    const enc = String(headers['content-encoding'] || '')
    if (enc === 'gzip') { try { body = zlib.gunzipSync(body) } catch { /* 解不开就原样发 */ } }
    else if (enc && enc !== 'identity') { /* br 等：不碰 */ }
    let html = body.toString('utf8')
    if (html.includes('</body>')) html = html.replace('</body>', RAIL_HTML + '</body>')
    else html += RAIL_HTML
    const out = Buffer.from(html, 'utf8')
    const h = { ...headers }
    delete h['content-encoding']
    delete h['transfer-encoding']
    h['content-length'] = String(out.length)
    h['cache-control'] = 'no-store'
    res.writeHead(200, h)
    res.end(out)
  })
  upRes.on('error', () => { try { res.destroy() } catch {} })
}

/* ── RPC 只读缓存实现 ─────────────────────────────────────────────── */
function rpcKeyOf(url, bodyBuf) {
  if (!RPC_ENABLED) return null
  if (!/^\/api\/[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/.test(url)) return null
  if (!bodyBuf || bodyBuf.length > RPC_MAX_BODY) return null
  let msg
  try { msg = JSON.parse(bodyBuf.toString('utf8')) } catch { return null }
  if (!msg || msg.type !== 'client-request') return null
  const method = String(msg.method || '')
  if (!RPC_ALLOW.has(method)) return null
  const args = JSON.stringify(msg.payload?.args ?? null)
  return method + '|' + crypto.createHash('sha1').update(args).digest('hex').slice(0, 16)
}

function rpcGet(key) {
  const hit = rpcCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > (hit.ttl ?? RPC_TTL_MS)) { rpcCache.delete(key); rpcBytes -= hit.body.length; return null }
  return hit
}

function rpcSet(key, body, type, ttl) {
  const prev = rpcCache.get(key)
  if (prev) { rpcBytes -= prev.body.length; rpcCache.delete(key) }
  rpcCache.set(key, { body, type, at: Date.now(), ttl })
  rpcBytes += body.length
  while (rpcCache.size > RPC_MAX) {
    const [k, v] = rpcCache.entries().next().value
    rpcCache.delete(k); rpcBytes -= v.body.length
  }
  stats.rpcCache.stores++
  stats.rpcCache.entries = rpcCache.size
  stats.rpcCache.bytes = rpcBytes
}

function rpcInvalidateAll() {
  if (!rpcCache.size) return
  rpcCache.clear(); rpcBytes = 0
  stats.rpcCache.entries = 0; stats.rpcCache.bytes = 0
  stats.rpcCache.invalidations = (stats.rpcCache.invalidations || 0) + 1
}

/** 把一段 JSON 原样（必要时换编码）发给客户端；命中/新鲜共用 */
function serveJson(req, res, body, type) {
  const out = { 'content-type': type || 'application/json', vary: 'Accept-Encoding', 'x-dshp-cache': 'rpc' }
  if (accepts(req, 'br') && body.length >= JSON_BR_MIN) {
    try {
      const br = zlib.brotliCompressSync(body, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: JSON_BR_LEVEL,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      } })
      if (br.length < body.length) {
        out['content-encoding'] = 'br'
        out['x-dshp-compress'] = 'br'
        out['content-length'] = String(br.length)
        stats.jsonBr.count++; stats.jsonBr.savedBytes += body.length - br.length
        res.writeHead(200, out); res.end(br); return
      }
    } catch { /* 压不了就发原文 */ }
  }
  out['content-length'] = String(body.length)
  res.writeHead(200, out); res.end(body)
}

/* ── 状态端点：让「慢」可诊断，不靠猜 ─────────────────────────────── */
function statusPayload() {
  return {
    ok: true,
    uptimeSec: Math.round((Date.now() - stats.started) / 1000),
    upstream: `http://${UP_HOST}:${UP_PORT}`,
    listen: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
    cookie: { loaded: Boolean(cookiePair), at: cookieAt || null },
    assetCache: {
      entries: assetCache.size,
      bytes: assetBytes,
      limitBytes: ASSET_MAX_BYTES,
      hits: stats.assetHits,
      misses: stats.assetMisses,
      savedBytes: stats.assetSavedBytes,
      variants: { br: [...assetCache.keys()].filter((k) => k.endsWith('|br')).length, gzip: [...assetCache.keys()].filter((k) => k.endsWith('|gzip')).length },
    },
    prewarm: stats.prewarm,
    jsonBr: undefined,
    inject: stats.inject || null,
    jsonBrotli: stats.jsonBr,
    rpcCache: { ...stats.rpcCache, entries: rpcCache.size, bytes: rpcBytes, ttlMs: RPC_TTL_MS, max: RPC_MAX },
    wsCompress: { ...stats.wsCompress, connections: stats.wsCompress.connections },
    ws: { active: stats.wsActive, total: stats.wsTotal },
    requests: stats.reqTotal,
    node: process.version,
  }
}

const server = http.createServer(async (req, res) => {
  const _t0 = Date.now()
  stats.reqTotal++

  if (req.url === '/__proxy/status') {
    const body = JSON.stringify(statusPayload())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
    return
  }

  if (req.url.split('?')[0] === '/__dshp/report') {
    const q = new URL(req.url, 'http://x').searchParams
    const msg = q.get('m') || '-'
    const info = q.get('i') || ''
    stats.inject = { at: Date.now(), msg, info }
    console.log(new Date().toISOString(), 'INJECT-REPORT', msg, info)
    res.writeHead(204, { 'cache-control': 'no-store' }); res.end()
    return
  }

  if (INJECT_ENABLED && req.url.split('?')[0] === '/__dshp/inject.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(INJECT_JS)
    return
  }

  const assetClean = assetPathOf(req.url)
  if (assetClean && (req.method === 'GET' || req.method === 'HEAD')) {
    for (const variant of variantPreference(req)) {
      const cached = cacheGet(cacheKey(assetClean, variant))
      if (cached) { serveCached(req, res, cached, assetClean); return }
    }
  }

  console.log(new Date().toISOString(), 'REQ', req.method, req.url, 'host=' + (req.headers.host || '-'), 'ua=' + String(req.headers['user-agent'] || '').slice(0, 30))
  // 收body（为了 401 时能重放）
  let body = []
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const tBody = Date.now()
    for await (const chunk of req) {
      body.push(chunk)
      if (body.reduce((a, b) => a + b.length, 0) > MAX_BODY) break
    }
    body = Buffer.concat(body)
    // 上行（手机→这里）的真实耗时与体积：图片/附件慢的时候，这一行就是证据
    console.log(new Date().toISOString(), 'UP-BODY', req.url, body.length + 'B', (Date.now() - tBody) + 'ms')
  }

  if (!(await ensureCookie())) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('拿不到 DSH launch token：请通过 DSH CLI 启动 web 服务（从 Finder 启动可能丢失 token 输出）')
    return
  }

  // 写操作先失效（宁可多清）
  if (req.method !== 'GET' && req.method !== 'HEAD' && RPC_INVALIDATE.test(req.url)) rpcInvalidateAll()

  const rpcKey = req.method === 'POST' ? rpcKeyOf(req.url, body) : null
  if (rpcKey) {
    const hit = rpcGet(rpcKey)
    if (hit) {
      stats.rpcCache.hits++
      serveJson(req, res, hit.body, hit.type)
      return
    }
    stats.rpcCache.misses++
    stats.rpcCache.upstream++
  }

  let status = await pipeRequest(req, res, body, _t0, rpcKey)
  if (status === 401) {
    // cookie 失效（DSH 重启换了 secret 之类）→ 重新交换一次再重放
    cookiePair = null
    if (await exchangeCookie()) {
      if (!res.headersSent) status = await pipeRequest(req, res, body, _t0)
    }
  }
  if (status === 0 && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('上游异常')
  }
})

// WebSocket 升级：relay 到 DSH，带上代理持有的 cookie
server.on('upgrade', (req, socket, head) => {
  if (WS_COMPRESS && cookiePair) return compressedUpgrade(req, socket, head)
  if (!cookiePair) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  let headWritten = false
  const upReq = http.request({
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req),
  })
  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`)
    headWritten = true
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
    if (upHead?.length) socket.write(upHead)
    if (head?.length) upSocket.write(head)
    // 交互流是小帧高频：关掉 Nagle，别为了凑包再等 40ms
    socket.setNoDelay(true)
    upSocket.setNoDelay(true)
    // 观测：WS 是「切会话要等」的唯一通道，先把它的字节与时长记下来
    const openedAt = Date.now()
    let toServer = 0, toClient = 0
    socket.on('data', (b) => { toServer += b.length })       // 浏览器→DSH
    upSocket.on('data', (b) => { toClient += b.length })     // DSH→浏览器
    const report = (why) => console.log(new Date().toISOString(), 'WS-CLOSE', req.url,
      'toClient=' + Math.round(toClient / 1024) + 'KB', 'toServer=' + Math.round(toServer / 1024) + 'KB',
      'dur=' + ((Date.now() - openedAt) / 1000).toFixed(1) + 's', why)
    socket.on('close', () => report('client'))
    upSocket.on('close', () => report('upstream'))
    console.log(new Date().toISOString(), 'WS-OPEN', req.url)
    stats.wsActive++
    stats.wsTotal++
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    upSocket.on('error', () => socket.destroy())
    socket.on('error', () => upSocket.destroy())
    upSocket.on('close', () => { stats.wsActive = Math.max(0, stats.wsActive - 1) })
    socket.on('close', () => { stats.wsActive = Math.max(0, stats.wsActive - 1) })
  })
  // 上游没升约（404/400 等）：把响应原样回给客户端，别让 socket 悬着
  upReq.on('response', (res) => {
    headWritten = true
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`.trimEnd()]
    for (const [k, v] of Object.entries(res.headers)) {
      if (k === 'transfer-encoding') continue
      lines.push(`${k}: ${v}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    res.pipe(socket)
    res.on('end', () => socket.end())
  })
  upReq.on('error', () => {
    if (!headWritten && socket.writable) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nupstream rejected the upgrade\n')
    }
    socket.destroy()
  })
  upReq.end()
})

loadState()
if (process.env.DSHP_NO_LISTEN !== '1') server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`dsh-web-proxy 已起：http://${LISTEN_HOST}:${LISTEN_PORT} → http://${UP_HOST}:${UP_PORT}（cookie ${cookiePair ? '已载' : '待取'}，资源缓存 ${Math.round(ASSET_MAX_BYTES / 1048576)}MB）`)
  if (String(process.env.DSHP_PREWARM || '1') !== '0') prewarm()
})

export { accepts, variantPreference, assetPathOf, cacheKey, cacheGet, cacheSet, gunzipMaybe, buildVariants, statusPayload }
