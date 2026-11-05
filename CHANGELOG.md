# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号以 `dsh-plugin/package.json` 的 `version` 为准，根 `package.json` 与之同号。

## [0.2.2] - 2026-11-05

### 文档
- **ADR-0003**：画面运动强度 —— 光流 vs 帧差。实测低运动占比仅 2.2%，自适应抽帧**收益不足，标记 Rejected**。
- **ADR-0004**：动作判断的采样策略。三组实验（捏脸/羽毛球/补抽）证明「网格分辨率不够」与「帧差峰值即动作」两个假设都不成立，下一步转向「全局位移补偿 + 残差」定位密采区间。
- **实验 2026-11-03**：三组对照，含素材、命令、边界。

### 性能
- **按 CPU 负载决定并行度**：Android 上 loadavg/stat/thermal 全读不到，只能用 cpufreq 频率比分档（cool/warm/hot）；hot 时 TransNet 退回串行、OCR 退回单路。新增 （拓扑 + 负载探测）。注意：同一配置实测总耗时 56~136s 波动，**不承诺固定提速**。见 [ADR-0008](docs/ADR-0008-load-aware-concurrency.md)。
- **PP-OCR 检测分片并行**：26s/10 条字幕的片子，字幕提取 86.1s→56.6s，整条管线 98.7s→69.6s（1.42x，三轮交替对照全胜）。det 模型仅 4.5MB，3 路 worker 内存代价约 13.5MB。见 [ADR-0007](docs/ADR-0007-ocr-parallel.md)。
- **TransNet 移到 worker 线程并行**：主线程跑 ASR/OCR 的同时做镜头检测，三轮交替对照 24.4s→20.1s（1.21x）；代价是 ASR 被两个 WASM 的 CPU 争抢拖慢 2.1s。`--serial` 可强制串行。见 [ADR-0006](docs/ADR-0006-pipeline-concurrency.md)。
- **流程并发化**：拼图（逐页 montage）与补帧（逐帧 ffmpeg）改成进程池，分页 21.6s→5.0s、60 张补帧 9.9s；15s 片总耗时 42.3s→33.8s。见 [ADR-0006](docs/ADR-0006-pipeline-concurrency.md)。
- **TransNet 窗口步长 50 → 100**（窗口不重叠）：三视频合计 97.9s → 49.9s，切点结果完全一致（CONCAT 5.8/11.8/17.8、anti-late 18.2、羽毛球 0）。见 [ADR-0005](docs/ADR-0005-transnet-sampling.md)。
- **B 站视频下载改分片并发**：实测同一 6.28 MB 视频，单连接 32.2 秒（0.20 MB/s），
  4 片并发 5.7 秒（1.1 MB/s），提速约 5.6 倍。B 站 CDN 支持 Range
  （`Accept-Ranges: bytes` / 206），直接复用模型下载的 `downloadToFile`；
  服务器不支持 Range 时自动回退单连接。
  实测整体：85.2 秒 → 57~64 秒（网络部分从约 62 秒降到 34~40 秒）。
- 尝试关闭 undici 的 `autoSelectFamily`：独立脚本里有效（B 站首页 37.8s → 3.7s），
  但在 DSH 进程内**无效**（undici Agent 在插件模块加载前已初始化，模块级设置太晚）。
  代码保留该设置（无副作用），**不计入已完成的优化**。详见 [ADR-0002](docs/ADR-0002-bilibili-download.md)。

## [0.2.0] - 2026-11-01

### 新增
- 启动时回收残留临时文件（`downloads` 超过 2 小时、`out` 超过 7 天），
  应对进程被强杀时 `finally` 跑不到的情况。

## [0.1.9] - 2026-11-01

### 修复
- ASR 运行时改用 WASM 版 `sherpa-onnx`（纯 JS + wasm，全平台一致），
  不再依赖原生二进制包 `sherpa-onnx-node`（后者在 Android 上装不起来，且与 `asr.mjs` 的
  `require('sherpa-onnx')` 对不上）。
- 包管理器自动降级：优先 `npm`，不可用时退回 `pnpm`。

## [0.1.8] - 2026-11-01

### 新增
- **侧栏面板可检测并管理模型**：OCR 与 ASR 两个开关左边显示资源状态——
  未下载时是「需要下载」，点击后后台下载并显示进度（`x/y MB`），下完变成「删除」，
  删除后回到「需要下载」。
  - OCR 资源：TransNetV2 + PP-OCRv4 det/rec + 字典，约 44.7 MB
  - ASR 资源：paraformer（int8）+ tokens，约 216.8 MB；另外会检查 `sherpa-onnx` 运行时是否就位
- 下载源优先国内镜像 `hf-mirror.com`，失败回退 HuggingFace；逐字节校验大小，失败自动清理 `.part`。

### 说明
- 下载在后台进行，不阻塞 HTTP 请求；面板每 2 秒轮询一次状态。
- 正在下载时拒绝删除，避免文件竞争。

## [0.1.7] - 2026-10-31

### 新增
- **B 站链接可直接分析**：先请求一次首页取得匿名 cookie（`buvid3` 等）再调 view/playurl，并把 UA 换成完整浏览器 UA。此前裸请求会收到 `412 request was banned`。
- **下载的视频用完即删**：`video_analyze` / `video_frame` 在 `finally` 里删除临时下载目录；另外每次分析前清理 `storages/dsh-video-kit/downloads` 下超过 6 小时的残留（进程崩溃等异常路径兜底）。
- 桌面端可配置 ASR 运行时目录：`DSH_ASR_APP_DIR`，非 Android 平台默认 `~/.dsh/asr-app`。

### 修复
- `asr.mjs` 把运行时路径写死成 Android 私有目录，导致桌面端一开语音识别就报 `Cannot find module 'sherpa-onnx'`；现在路径可配置，且找不到时给出可读提示而不是原始堆栈。
- ffmpeg 9 已移除 `-vsync`，抽帧改为 `-fps_mode passthrough`。
- Windows 上 `onnxruntime-web` 的 `wasmPaths` 传的是 `D:\...` 绝对路径，Node ESM loader 只接受 URL；改为 `pathToFileURL(...).href`。
- 插件给子进程拼 PATH 时用 `:` 作分隔符，Windows 会因此拼出一条无效 PATH；改为 `path.delimiter`。
- Windows + ImageMagick 7 没有 `convert`/`montage`/`identify`/`compare` 独立命令：新增自动适配，把这些命令名映射到 `magick.exe`（按 `argv[0]` 分派），DLL 由 ImageMagick 安装目录提供。

## [未发布]

只调整工程结构，不改变视频分析行为与输出格式。

### 变更
- **单真源**：根目录的 `pipeline.mjs`、`subs.mjs`、`asr.mjs`、`download-models.mjs`、`lib/ocr-pp.mjs`、`lib/transnet-lib.mjs` 是唯一可编辑源；`dsh-plugin/lib/videokit/` 里的同名文件由 `scripts/sync-videokit.mjs` 生成，首行带「勿手改」横幅。
  校验命令 `node scripts/sync-videokit.mjs --check`，不一致时退出码为 1。
  此前两份代码需要提交两遍（如 `3c01787` / `5bd8441`），漏改一侧会让 CLI 与插件行为分叉。
- 根 `package.json` 版本从 `0.1.0` 对齐到 `0.1.6`，并新增 `sync` / `sync:check` 脚本。
- 文档目录 `docx/` 更名为 `docs/`：内容都是 Markdown，原名容易误会成 Word 格式。
- 删除 `dsh-plugin/.npmignore`：包内容由 `package.json` 的 `files` 白名单决定，该文件冗余。
- 新增 `.gitattributes`：仓库内统一 LF 存储与检出，避免跨平台的整文件假 diff 影响真源/副本比对。

## [0.1.6] - 2026-10-31

### 修复
- npm 包体积从 72 MB 降到 98 KB：模型权重与嵌套 `node_modules` 不再打进包。

### 文档
- README 补充 DSH 手机版仓库地址。

## [0.1.5] - 2026-10-30

### 新增
- ASR 长语音段等分：单段音频超过 25s 时按句切分后再识别。
- 语气词过滤；静音阈值开放环境变量 `ASR_SILENCE_DB`（默认值不变）。

### 修复
- 段尾用 `end: null` 表示「直到结尾」，原判断 `Number(null) === 0` 会把一个 124s 的段当成 0 秒直接放过。改为显式判空后，同一部 210s 动画的转写从 8 条 / 120s 变为 13 条 / 87.4s。

### 文档
- 新增 `docs/ADR-0001-asr-segmentation.md` 与 `docs/EXPERIMENT-2026-10-30-asr-ocr.md`。

## [0.1.4] - 2026-10-30

### 新增
- OCR 预探测：先抽少量帧试跑，命中 0 条就跳过全量 OCR。无硬字幕的 15s 素材字幕提取耗时 7.2s，而全量 OCR 约 0.53s/帧。

## [0.1.3] - 2026-10-30

### 新增
- 侧栏控制面板：开关硬字幕 OCR、语音识别，调整基础抽帧率（1–12 fps），配置存 `storages/dsh-video-kit/config.json`，改完下一次调用即生效。
- `video_analyze` 返回值外露 ASR 结果（`asrCount` / `asr`），与只统计硬字幕的 `subsCount` 分开。

### 修复
- OCR 坐标：几何阈值此前按 `ffprobe` 原始分辨率计算，而检测框位于缩放帧坐标系，导致有硬字幕的片子整片输出 0 条。

## [0.1.2]

未发布。仓库内没有该版本的 tag 与版本提交，`0.1.1` 之后的修复直接进入 `0.1.3`。

## [0.1.1] - 2026-10-28

### 新增
- DSH 插件版：把工具包包成 `video_analyze` 与 `video_frame` 两个原生工具（`d669ca4`，2026-10-25）。

### 修复
- 拒绝破坏性输出清理：目标目录非空时不再自动删除。
- Bilibili URL 限制主机白名单，不支持任意 HTTP 直链。
- 子进程日志缓冲加上限，避免长时间分析时内存持续增长。
- 预览服务转义输出，并限制只能服务输出目录内的文件。
- TransNetV2 模型路径改为可移植解析。
- 帧差解码改为流式；修正帧缓冲比较与 ffmpeg `select` 过滤器引号。
- 输入校验正则修正；声明运行时依赖与模型下载步骤。

## [0.1.0] - 2026-10-19

首个版本：5–15 fps 抽帧 + TransNetV2 镜头分组 + 网格页 + PP-OCRv4 字幕 + sherpa-onnx 语音识别，输出 `index.json` 与可回查的帧/页索引；附 `PROMPT.md` 供 AI 助手按证据纪律读视频。
