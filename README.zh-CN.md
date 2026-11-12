# dsh-fastlane · 慢链路网页加速代理

English: [README.md](README.md)

联合连载：[慢链路下的网页加速](https://ouya15.cn/insights/series/dsh-fastlane.html)（三本账、四层优化、六层行程、WebSocket 与背压）

> DeepSeek Harness 网页版在**慢链路/高延迟**下的加速层。一个 200 行的 Node 反向代理，坐在浏览器和 DSH 之间，只做四件事：**认证代换、静态资源缓存、可诊断、不改变任何语义**。

状态：M1–M9 已在本地部署验证；M4 的代理层内容改写方案经 spike 后否决，结论见 `designs/2026-10-29-rpc-envelope-and-payload-map.md`。

## 问题

DSH 的 web-app 有两个对慢链路不友好的默认：

1. **静态资源没有缓存头**。`/assets/index-<hash>.js` 返回 `transfer-encoding: chunked`，没有 `cache-control`、没有 `etag`、没有 `last-modified`。浏览器每次打开都要重下首屏 ~544KB（gzip 后）。
2. **认证绑在启动 token 上**。`GET /?token=…` 换一个 authority 绑定的 cookie，之后全靠这个 cookie。反代、隧道、分享都绕不开它。

当访问路径是「中国 → Cloudflare 洛杉矶边缘 → Cloudflare 隧道 → 家里 Mac」时（实测隧道落点 `lax07/lax13`，RTT 195–316ms），上面两条叠加的结果是：**打开一次 5 秒，重复打开还是 5 秒**。

## 方案

```text
浏览器 ──HTTPS──> 入口（Tailscale serve / 窄门 gate / CF 隧道）
                     │
                     └─> dsh-fastlane（127.0.0.1:8781）──> DSH（127.0.0.1:8780）
                            ├─ 代持 DSH cookie（浏览器什么都不用带）
                            ├─ /assets/* 内容哈希 → immutable + etag + 进程内 LRU
                            └─ /__proxy/status（JSON，给人和脚本看）
```

三件事，都不改变 DSH 的语义：

| 能力 | 做法 | 效果 |
|---|---|---|
| 静态资源缓存 | 文件名本身是内容哈希 → 标 `cache-control: public, max-age=31536000, immutable` + `etag`；进程内 LRU（默认 96MB，单条 8MB） | 首次 544KB，之后**浏览器零请求**；绕过浏览器时也只需一次 `304`（0 字节） |
| 认证代换 | 从 DSH 日志里取 launch token，服务端换 cookie 并持有（`~/.cache/dsh-fastlane.json`，0600） | 设备不接触 launch token |
| JSON 换编码 | `/api/*` 的 JSON 响应（≥8KB、客户端吃 br、非 stream 路径）在代理里改 brotli-5；>2MB 自动退回流式 | `session/list` 197KB：上游 gzip 73KB → **br 52KB**（−28.6%，3ms） |
| WS 压缩 | 用 `ws` 把连接分两段终结：**浏览器侧开 `permessage-deflate`，上游不压**；上游未开前消息排队；**发往浏览器用串行队列**（一次只在途一帧，16MB 上限，超限 1011 断开）；404 以 1011 关闭、10s 打开超时；`DSHP_WS_COMPRESS=0` 退回 raw pipe | 会话回放 **1.0MB → 211KB（−79%）**，另一例 **11.3MB → 1.8MB（−84%）** |
| 窄屏收起侧栏 | 注入脚本认 DSH 的 `[data-sidebar-collapsed]` 帧，把**整块画布左移一个竖条宽度并加宽同像素**（不碰它的 grid 列宽）；右缘 6px 细缝开关来回切，状态存 localStorage；`?dshp=0` 关闭 | 394px 视口下主列 338→**394**（+16%） |
| 可诊断 | `/__proxy/status`：uptime、cookie 状态、缓存命中/节省字节、JSON 压缩计数、WS 活跃数；响应带 `x-dshp-cache` / `x-dshp-compress` | 「慢」变成可定位的数字，不靠猜 |

另外：WS 升级后对两端 `setNoDelay(true)`，交互流不为凑包多等 40ms。

## 不做

- **不做 WebRTC / TURN / P2P 选路**：浏览器里的 DSH 界面跑不了 WebRTC 数据面，要做等价能力应该换客户端（参考 `liguobao/ds-harness-remote` 的原生 App 路线），不是改代理。
- **不做端到端加密**：客户端是服务器下发的 JS，中间人必然看得见明文。加密只有在两端都是自己写的客户端时才成立。
- **不做鉴权**：鉴权归入口层（Tailscale / 窄门 gate）。本代理只假定「能到 127.0.0.1:8781 的就是可信的」。
- **不对纯管道重复实现 WS 背压**：`socket.pipe` 已自带 pause/resume；压缩桥则在应用层使用发送回调驱动的串行队列。回调只证明本地发送层处理完一帧，不是远端业务 ACK；队列超限时主动断开而不是静默暂停。

## 快速开始

```bash
# 1. DSH 用 CLI 起来（web-app 的 launch token 打在日志里，代理要读它）
dsh web

# 2. 起代理
node src/dsh-web-proxy.mjs                 # 默认 127.0.0.1:8781 → 127.0.0.1:8780
node src/dsh-web-proxy.mjs --help          # 看全部开关

# 3. 暴露给别的设备（二选一）
tailscale serve --bg --https=10001 http://127.0.0.1:8781   # 只在自己 tailnet，最快
cloudflared tunnel run <隧道名>                             # 公网；前面必须再加一层鉴权
```

### 两种出口的最小配置

**Tailscale（推荐：直连，20–60ms）**

```bash
tailscale serve --bg --https=10001 http://127.0.0.1:8781
# 手机打开 https://<machine>.<tailnet>.ts.net:10001/
```

**Cloudflare 隧道（可达性优先；注意落点）**

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:8781
  - service: http_status:404
```

```bash
cloudflared tunnel run <tunnel-id>
```

> 隧道会按出口就近选 Cloudflare 机房，中国大陆家宽实测常落在洛杉矶（`lax07/lax13`），
> 首字节 2–5s。**本代理削的是「每趟搬多少」，不是「绕了多远」**——要快就走 tailnet。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSHP_UP_HOST` / `DSHP_UP_PORT` | `127.0.0.1` / `8780` | 上游 DSH |
| `DSHP_LISTEN_HOST` / `DSHP_LISTEN_PORT` | `127.0.0.1` / `8781` | 本代理（别绑 0.0.0.0：鉴权在入口层） |
| `DSHP_DSH_LOG` | `~/Library/Logs/DeepSeek Harness/dsh-web.log` | 取 launch token 的地方 |
| `DSHP_STATE` | `~/.cache/dsh-fastlane.json` | cookie 落盘（0600） |
| `DSHP_ASSET_CACHE_MB` | `96` | 静态资源缓存上限 |
| `DSHP_PREWARM` | `1` | 启动预热 br 变体（`0` 关闭） |

## 实测收益（本机，2026-10-28/29）

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏静态资源 | 544 KB（gzip） | **399 KB**（br） |
| 重复打开 | 544 KB | **0 字节**（immutable 直接命中） |
| 强制重验 | 544 KB | **304 / 0 字节** |
| `session/list` | 73 KB（gzip） | **52 KB**（br） |

路径本身没变：经 Cloudflare 隧道时首字节仍是 2–5s（隧道落在 `lax07/lax13`，RTT 195–316ms）。
本代理只削「每一趟要搬多少」，不改变「绕了多远」——要快还是走 tailnet 直连。

## 测试与验收

```bash
npm test                                  # 单测（纯逻辑 + WS 升级链路，15 项）
npm run verify                            # 对着跑起来的代理做线上回归（14 项）
npm run bench                             # 首屏资源字节/命中统计
curl -s localhost:8781/__proxy/status | jq .
```

`verify` 的判据：变体命中与编码正确、immutable/etag 在位、`If-None-Match→304/0B`、
首屏 br ≤430KB、`session/list` 走 br 且 ≤60KB、API 未受影响、status 形状稳定。

## 许可

MIT，见 [LICENSE](LICENSE)。
