# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号以 `dsh-plugin/package.json` 的 `version` 为准，根 `package.json` 与之同号。

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
