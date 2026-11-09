# Video Understanding Kit

**Video Understanding Kit** 将视频转换为带时间戳的采样帧、镜头分组、网格图和可选的字幕/语音转写，供 AI 快速浏览并回查画面证据。项目同时提供命令行流水线和 DSH 插件。

> 项目主要面向 DSH 环境。桌面、服务器及其他 Android 环境尚未完成系统验证。识别结果用于定位候选内容，关键画面、文字和台词仍应回看核验。

## 工作流程（简要版）

![Video Understanding Kit 工作流程](workflow.svg)

基础流程抽取视频帧、检测镜头边界、生成分组和网格页。硬字幕 OCR 与语音 ASR 可分别启用；启用 ASR 时，TransNet 镜头检测可在 worker 线程中与主线程工作重叠。镜头边界和帧差只用于时间导航，不代表语义场景或动作结论。

## 能力

- **镜头时间线**：TransNetV2 检测镜头边界，并把采样帧整理成内容组。
- **网格与证据回查**：输出网格页、组级导航图、源帧 ID 和时间戳。
- **硬字幕 OCR（可选）**：PP-OCRv4 从画面中提取烧录字幕候选，并标记需要复核的文本。
- **语音 ASR（可选）**：通过本地 sherpa-onnx Paraformer 识别台词并输出时间戳。
- **补充取帧**：可根据时间点重新提取原始帧；Bilibili 输入支持直接下载分析。
- **DSH 插件**：提供 `video_analyze`、`video_frame` 两个工具和一个侧栏面板。面板可设置 OCR、ASR 默认开关及基础抽帧率，并管理模型文件。

OCR 字幕和 ASR 台词是两条独立的识别结果。硬字幕数为 0 不代表视频没有语音；语音转写也不能代替画面核验。

## 环境要求

- Node.js 20 或更新版本
- pnpm
- FFmpeg、ImageMagick
- 使用 DSH 插件时，需要可运行 Cordis 插件的 DSH 环境

## 安装模型

在仓库根目录安装依赖并下载镜头检测和 OCR 模型：

```bash
pnpm install
pnpm run models
```

视觉模型约 47 MB，下载到本地模型目录，不随 Git 仓库分发。首次下载需要网络连接。

### 可选：语音识别

ASR 还需要 sherpa-onnx 运行时和中文 Paraformer int8 模型，模型约 217 MB。它与视觉模型分开下载；未准备运行时和模型时不要启用 `--asr`。详细说明见 [asr.mjs](asr.mjs) 和 [DSH 插件文档](dsh-plugin/README.md)。

## 命令行使用

```bash
# 生成镜头分组和网格
node pipeline.mjs --video video.mp4 --out out

# 同时提取画面硬字幕
node pipeline.mjs --video video.mp4 --out out --subs

# 启用语音识别（需要 sherpa-onnx 和 Paraformer 模型）
node pipeline.mjs --video video.mp4 --out out --asr

# 同时启用 OCR 和 ASR
node pipeline.mjs --video video.mp4 --out out --subs --asr

# 强制串行运行 TransNet，用于对照或排查 worker 问题
node pipeline.mjs --video video.mp4 --out out --asr --serial

# 启动本地预览（默认读取 ./out）
node serve-preview.mjs out
# 打开 http://127.0.0.1:3329
```

CLI 中 OCR 和 ASR 默认关闭。输出目录非空时程序会拒绝覆盖；只有确认要清空该输出目录时才传入 `--force`。

常用参数：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `--video` | 必填 | 输入视频路径 |
| `--out` | `out` | 输出目录 |
| `--subs` | 关闭 | 启用硬字幕 OCR |
| `--asr` | 关闭 | 启用语音识别 |
| `--base-fps` | 5 | 基础呈现帧采样率 |
| `--diff-threshold` | 8 | 帧差候选阈值 |
| `--serial` | 关闭 | 禁用 TransNet worker 并行 |
| `--force` | 关闭 | 清空并覆盖已有输出目录 |

## DSH 插件

插件位于 [dsh-plugin/](dsh-plugin/)，提供以下工具：

- `video_analyze`：接收本地视频路径或 Bilibili 链接，返回时间线、网格图片路径、OCR 字幕、ASR 台词和分段耗时。
- `video_frame`：按时间提取原始帧，支持裁剪和缩放。
- **侧栏「视频理解」**：设置 OCR、ASR 默认值及 1–12 fps 的基础抽帧率，也可下载或删除模型。

插件支持 Bilibili 链接（含 `b23.tv` 短链），暂不支持任意 HTTP 直链。通过链接分析的视频会下载到临时目录，处理完成后清理。具体安装步骤、配置项和数据目录见 [插件说明](dsh-plugin/README.md)。

## 输出结构

```text
out/
├── index.json   # 时间线、分组、OCR/ASR 候选、边界、耗时与检查结果
├── base/        # 基础采样帧
├── extra/       # 候选区间的补充帧
├── grids/       # 网格页与组级导航图
├── subs/        # 启用 OCR 时的中间帧
└── audio/       # 启用 ASR 时的音频
```

`index.json` 中的 `groups[].pages[].frames[]` 记录每个格子的时间戳、源帧 ID 和提取 ID；`timings` 记录各处理阶段耗时。

## 性能与边界

0.2.2 的性能优化包括：TransNet 窗口步长从 50 调到 100，测试素材的切点结果保持一致；TransNet worker 与主线程处理重叠；补帧和网格拼图改用并发进程池；Bilibili 下载改为分片并发。15 秒测试素材上，TransNet 并行对照平均总耗时从 24.4 秒降至 20.1 秒；这只是 vivo V2405A 上的小样本结果，不代表其他设备的运行时间。ASR 与 TransNet 并行时会争用 CPU，ASR 本身可能变慢。

当前系统不保证准确识别所有动作或文字：

- 低帧率采样可能错过很短的动作、镜头或字幕。
- 帧差峰值可能来自转场或镜头运动，不能直接当成动作发生时刻。
- 网格适合浏览和定位；快速动作可能因为关键帧没有采到而无法判断。
- OCR 与 ASR 可能漏字、错字或漏掉台词；专名、数字和关键语句请回看原帧或音频。

关于采样策略和性能取舍的实验记录见 [ADR 与实验索引](docs/README.md)。项目的演进记录见 [CHANGELOG](CHANGELOG.md)。

## 开发与同步

根目录的 `pipeline.mjs`、`subs.mjs`、`asr.mjs` 和 `lib/` 是视频处理代码的真源；插件内对应副本由同步脚本生成。

```bash
pnpm run sync        # 更新插件内的处理代码副本
pnpm run sync:check  # 检查副本与真源是否一致
```

修改处理逻辑后，请同步副本并运行 `sync:check`，再提交两处代码。

## 模型与许可

程序代码采用 MIT 许可。TransNetV2、PP-OCRv4、相关字典和 ASR 模型各有自己的许可条款；使用前请分别核对模型及权重许可。

- [TransNetV2](https://github.com/soCzech/TransNetV2)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
