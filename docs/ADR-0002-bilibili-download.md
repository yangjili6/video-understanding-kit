# ADR-0002：B 站链接分析的下载耗时

- **状态**：Accepted（2026-11-02，v0.2.0 之后落地）
- **影响文件**：`dsh-plugin/index.js`
- **相关**：本文自带实测数据，未单独写实验报告

## 背景

2026-11-02 在 Windows 桌面端实测：一个 **31 秒**的 B 站视频，从贴链接到出结果要 **85.2 秒**，其中下载 6.28 MB 占约 **62 秒**。用户第一反应是「是不是要挂 VPN」。

需要回答两件事：慢在哪、能优化到什么程度、哪些优化是做了也没用的。

## 定位过程

按「先证明不是网络问题」的顺序排除：

1. **本地带宽正常**：国内 `npmmirror` 测速 3.79 MB/s，npm 装 18 个包 8.8 秒。
2. **单个连接被限速**：`hf-mirror` 拉 44.7 MB 模型，串行 80 秒（0.56 MB/s），4 文件并发 18.6 秒（2.41 MB/s）。
3. **B 站 CDN 支持 Range**：`Accept-Ranges: bytes`，`Range` 请求返回 **206**。
4. **Node 的 `fetch` 连 `bilibili.com` 极慢**：`curl` 1–3 秒，Node `fetch` 报 `UND_ERR_CONNECT_TIMEOUT`（undici 默认连接超时 10 秒），靠 3 次重试才偶尔成功。

第 4 条是关键：**同一台机器、同一个域名，`curl` 正常而 `fetch` 超时**。

## 决策

### D1. 视频下载复用模型下载的分片逻辑（✅ 有效）

`downloadVideo` 从 `pipeline(Readable.fromWeb(...))` 改为复用 `downloadToFile(url, dest, null, size, headers)`：

- ≥ 6 MB 的文件按 `Range` 切 4 片并行，服务器不支持 Range 时自动回退单连接；
- `downloadRange` / `downloadSingle` / `downloadToFile` 增加 `extraHeaders` 参数——B 站直链必须带 `Referer` + `Cookie` + `UA`，否则 403；
- `resolveVideo` 把 playurl 返回的 `durl.size` 一起带出来，供分片判断。

实测同一个 6.28 MB 视频：

| 方式 | 耗时 | 速度 |
|---|---|---|
| 单连接 | 32.2 秒 | 0.20 MB/s |
| 4 片并发 | **5.7 秒** | **1.1 MB/s** |

### D2. 关闭 undici 的 autoSelectFamily（⚠️ 独立脚本有效，DSH 进程内无效）

独立脚本里加 `net.setDefaultAutoSelectFamily(false)` 后，`www.bilibili.com` 首页请求从 **37.8 秒降到 3.7 秒**。原因：undici 的 happy-eyeballs 在 IPv6 不通时仍会尝试 IPv6，一路拖到 10 秒连接超时。

但在 **DSH 进程内没有效果**。推测：undici 的 Agent 在插件模块加载之前就被其他插件初始化了，模块级的 `net.setDefaultAutoSelectFamily(false)` 调用太晚，改不动已建好的 Agent 配置。

实测（同一视频，各跑 2 次）：加这行前后是 63.9 / 57.5 → 64.2 / 56.9 秒，差异落在网络波动范围内。

**处理**：保留这行（对某些环境可能生效，且无副作用），但**不把它算作已完成的优化**。

## 结果

| 版本 | 耗时（30 秒视频，B 站直链） |
|---|---|
| v0.2.0（单连接下载） | 85.2 秒 |
| + 分片下载 | 63.9 / 57.5 秒 |
| + autoSelectFamily | 64.2 / 56.9 秒 |
| 独立脚本的理想值（网络 12 秒 + 分析 23.5 秒） | ≈ 35 秒 |

现状 **57–64 秒**，其中网络约 34–40 秒、本地分析 23.5 秒。

## 未解决的部分

进程内关不掉 happy-eyeballs。三个方向，都没做：

1. **改用 `node:https`** 替代 `fetch`——绕开 undici 的 Agent，但要重写 B 站 API 调用和下载循环。
2. **DSH 启动参数** `--no-network-family-autoselection`——要改宿主的启动方式，不现实。
3. **引入 `undici` 包**自建 Agent——多一个运行时依赖。

暂不做的理由：

- 分析本身就要 23.5 秒，即使网络归零，总耗时下限也在 35 秒左右；
- 分片下载已经拿到收益的大头（62 秒 → 34 秒）；
- 换 HTTP 栈的风险（Windows/Android 行为差异、Cookie 处理）大于收益。

如果以后要继续压，优先级是 1 > 3 > 2。

## 备注

- 本文数字全部是 Windows 桌面端实测，**未在手机端复现**；两者网络栈和 CDN 链路不同，结论不能直接搬。
- 结论依赖「到 B 站国内 CDN 单连接约 200 KB/s」这个前提；换网络可能完全不同。
- `dns.setDefaultResultOrder('ipv4first')` 仍保留——它解决的是 DNS 返回顺序，和 D2 是两件不同的事。
