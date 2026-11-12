# 设计：静态资源缓存层（2026-10-28）

> 状态：**已实现**，公开整理版。

## 1 问题与证据

| 证据 | 数值 | 出处 |
|---|---|---|
| 直连代理首屏 | 1.9–19 ms | 本机 curl `127.0.0.1:8781` |
| 经示例 CF 路径 TTFB | 2.4–5.1 s | 本机 curl ×3 |
| 经 CF 取 601B 的 401 页 | 1.6–7.0 s | 同上 |
| 隧道落点 | `lax07` / `lax13` | `~/Library/Logs/cloudflared.err.log` |
| 到隧道入口 RTT | 195–316 ms | `ping region1/region2.v2.argotunnel.com` |
| 首屏静态资源 | 544 KB（gzip） | `tools/bench-assets.sh` |
| 资源响应头 | 无 `cache-control` / `etag` / `last-modified`，`transfer-encoding: chunked` | 直连 `-D -` 实读 |

结论：每次打开都要跨太平洋搬 544KB，且**没有任何缓存协商机制**，所以「重复打开」和「第一次打开」等价。

## 2 方案

- **入口**：命中 `/assets/*` 且扩展名在白名单内 → 视为不可变资源。
- **响应头**：`cache-control: public, max-age=31536000, immutable`、`etag: "<clean path>"`、`vary: Accept-Encoding`；命中时补 `content-length`（上游是 chunked）。
- **协商**：`If-None-Match` 匹配 → `304`，0 字节。
- **存储**：进程内 LRU，key = `path|encoding`，默认上限 96MB、单条 8MB，超限逐出最旧。
- **编码**：按客户端 `Accept-Encoding` 决定向上游要 `gzip` 还是 `identity`，缓存键与之一一对应 —— **避免 br/zstd 变体串味**（第一版就踩了这个坑：强行向上游要 gzip 却回给不支持 gzip 的客户端）。

## 3 备选与否决

| 备选 | 否决原因 |
|---|---|
| 交给 Cloudflare 边缘缓存 | 资源在 gate 鉴权之后，未认证请求一律 401；要缓存得先拆鉴权边界，风险大于收益（记入 BACKLOG 做 spike 而非排期） |
| 在代理里做 WS 背压 | Node `socket.pipe` 已自带 pause/resume；`bufferedAmount` 守卫在纯管道里是死代码。真要限流得换 `ws` 库的发送队列 |
| 在代理里做历史瘦身（当场） | 历史不是独立 REST 端点（线上抓到的是 Typert `client-request` 信封 + WS 流），盲改字节风险高；降级为 M4 spike |
| brotli 预压缩（当场） | 纯收益但需同时维护两个变体 + CPU 预算；单列为 M3 |

## 4 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 资源若被就地覆盖（非哈希名） | 客户端缓存住旧版本 | 只对 `/assets/*` + 白名单扩展名生效；DSH 的资源名带内容哈希 |
| 缓存键与编码不一致 | 客户端拿到错误编码 | 单一事实源 `clientWantsGzip()`；存储时校验上游 `content-encoding` |
| 代理成为单点 | 打不开 | launchd KeepAlive 拉起；备份文件一行回滚 |
| DSH 换认证方式 | 代理拿不到 cookie | 已有 401 → 重新交换 → 重放一次的兜底 |

## 5 验收（已跑）

```
冷启：4 个资源 miss，合计 544KB
二次：4 个资源 hit
带 If-None-Match：304，size_download = 0
API 代理：POST /api/session/list → 200（未受影响）
```

`/__proxy/status` 里 `assetCache.savedBytes` 随命中增长，可作为线上观测。
