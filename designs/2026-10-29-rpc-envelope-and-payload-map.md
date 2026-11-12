# Spike：RPC 信封、响应体积地图、历史瘦身可行性（2026-10-29）

> 结论先行：**代理层只做「换编码」，不做「改内容」**。历史瘦身在代理层不可行，理由见 §3。

## 1 网关信封（实测出来的，不是猜的）

Web UI 与 Host 之间是 Typert RPC，端点就是路径：

```
POST /api/<domain>/<method>
{ "type": "client-request", "rpcId": "<任意>", "method": "<domain>/<method>", "payload": { "args": { "_request": { … } } } }
→ { "type": "server-response", "rpcId": "<同>", "result": { "ok": true, "value": { … } } }
```

发现过程全靠校验器回话（只读，无副作用）：

| 请求 | 服务端答复 |
|---|---|
| `{"type":"client-request"}` | 缺 `rpcId` / `method` / `payload` |
| `method:"session.list"` | `method "session.list" does not match endpoint "session/list"` |
| `payload:{}` | `Remote payload must contain exactly one plain-object args field` |
| `payload:{args:{}}` | `args fields do not match the descriptor: missing "_request"` |
| `payload:{args:{_request:{}}}` | ✅ 返回 197KB 会话列表 |

## 2 响应体积地图（同一个 `session/list`）

| 形态 | 字节 | 说明 |
|---|---|---|
| JSON 原文 | 197,282 | 42 个会话的 projections |
| 上游 gzip（现状） | 73,343 | DSH 自己压的 |
| 代理 gzip-9 | 65,964 | −10% |
| **代理 br-5** | **52,402** | **−28.6%，3ms CPU** |
| 代理 br-9 | 51,216 | −30%，9ms CPU（不值得） |

→ 选 br-5：197KB 的 body 换编码只花 3ms，但对跨太平洋链路是 21KB 的净节省。

## 3 历史瘦身：否决

**证据**：把 gate 审计里浏览器真实请求的 53 条路径全列出来，`/api/session/*` 只有
`list / create / prompt / attachment / modelCatalog`，**没有任何 history 端点**。
会话正文因此走的是流（WS/事件通道），不是 REST。

**为什么不在代理层做**：

| 做法 | 问题 |
|---|---|
| 解析 WS 帧改内容 | 要懂帧序、分片、ack、重放语义；改坏是「会话显示错乱」级别的事故，且 DSH 升级即失效 |
| 加一个「历史」REST 端点再压 | 等于在代理里重建 DSH 的会话投影，越权且必与上游漂移 |
| 用官方 projection 能力 | 这才是正路，但属于上游/插件的事，不是代理能做的 |

**决策**：代理层维持「不改变语义」的边界。历史瘦身转为两个备选记入 BACKLOG：
①向上游提 feature（Host 侧精简投影）；②客户端注入（用户脚本级，不进代理）。

## 4 落地

只落了 §2 那一行：`/api/*` 的 JSON 响应（≥8KB、客户端吃 br、非 stream 路径）在代理里换
brotli-5，保留 `content-encoding: br` + `content-length`，并计入 `/__proxy/status` 的
`jsonBrotli`。超过 2MB 的响应自动放弃压缩、退回流式，避免把大响应堵在内存里。
