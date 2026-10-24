# 网格法手机DSH视频理解工具包（video-understanding-kit）让你的AI更好的去看视频

> ⚠️ **仅适用于 DSH 手机版（DSH Mobile）环境。** 本项目依赖 DSH 手机版的工具链（ffmpeg / ImageMagick / Node）与目录约定，其他环境（桌面、服务器、其他 Android 发行版）未验证，请勿直接套用。注意：你的AI必须支持识图，否则无法正常使用

> **为 AI 看视频时提供可回查的时序网格、字幕转写与证据索引，降低漏看和无依据描述的风险。**

把视频拆成**内容组 → 网格图 → 可回查的原始帧**，让 AI 用「看图 + 回查」的方式理解视频，而不是把几千帧塞进上下文。

## 🎁 附带：DSH 插件版（`dsh-plugin/`）

本仓库还附带一个 **DSH 原生插件**，把工具包包成 AI 能直接看见的两个工具——
解决「AI 不知道有这个工具包，只会在手边找 ffmpeg」的可发现性问题。

| 工具 | 作用 |
|---|---|
| `video_analyze` | B站链接 / 本地视频 → 字幕时间线 + 内容分组 + 网格页路径 |
| `video_frame` | 按时间点取原帧，支持 crop 只取字幕带 |

装法：把 `dsh-plugin/` 放到 profile 的 `node_modules` 下（或用 `link:` 安装），
再按 `dsh-plugin/README.md` 拉模型（约 47MB）。详见 [dsh-plugin/README.md](./dsh-plugin/README.md)。

## 为什么是网格法

视觉 token 按「图」计价，不按「帧」：一张图里塞 1 帧还是 36 帧，成本几乎不变；而 agent 每轮重发历史，图的数量决定平方级消耗。

所以：**把帧拼进网格图 → 图数量降一个量级 → 上下文不爆（并且省token）**

## 工作流

```
视频
 ├─ 5fps 基础帧（原分辨率，带时间戳）
 ├─ TransNetV2 镜头边界检测（预训练模型，ONNX/WASM）
 ├─ 分组（镜头 = 内容组）
 ├─ 网格页（6 帧/页，3×2，JPG）
 ├─ 组级拼图（每组一张导航图，≤12 页/张）
 ├─ [可选] 字幕提取（PP-OCRv4 det+rec，输出时间线 + 疑点标记）
 └─ [可选] ASR（sherpa-onnx 本地识别，有旁白时用）
```

## 安装

依赖：

- Node.js ≥ 20
- ffmpeg（抽帧）
- ImageMagick（拼接网格/裁剪）
- npm 包：`onnxruntime-web`（OCR/TransNet 推理）

```bash
pnpm add onnxruntime-web    # 或 npm install onnxruntime-web
node download-models.mjs    # 下载模型（约 47MB）
```

### 可选：ASR（语音识别）

`--asr` 需要 sherpa-onnx 运行时和中文 paraformer 模型（约 227MB）：

```bash
# 参考 asr.mjs 顶部注释，或前往 https://github.com/k2-fsa/sherpa-onnx 获取
```

未安装时 `--asr` 会报错，基础功能（分组/网格/字幕）不受影响。

模型（共约 47MB）：
- TransNetV2（镜头检测，31MB）
- PP-OCRv4 det/rec（15MB）
- PP-OCR 字典（26KB）

**注意**：ASR（sherpa-onnx）模型另计（约 227MB），不包含在这 47MB 里。

## 使用

```bash
# 基础：分组 + 网格
node pipeline.mjs --video video.mp4 --out out

# 带字幕提取（画面有字幕/文字时）
node pipeline.mjs --video video.mp4 --out out --subs

# 带语音识别（有旁白/对话时）
node pipeline.mjs --video video.mp4 --out out --asr

# 预览（本地 HTTP，浏览器打开）
node serve-preview.mjs   # http://127.0.0.1:3329
```

## 输出结构

```
out/
 ├─ index.json           # 组/页/字幕/ASR/镜头边界
 ├─ frames/              # 采样帧
 └─ grids/
     ├─ g01-p01.jpg      # 组 1 第 1 页（6 帧，3×2）
     ├─ g01-p02.jpg
     ├─ g01-sheet-1.jpg  # 组 1 导航拼图（≤12 页/张）
     └─ ...
```

`index.json` 关键字段：

- `groups[]`：组（from/to、pages、sheets）
- `pages[].frames[]`：每格的时间戳与源帧 ID（**可回查**）
- `subs[]`：字幕时间线（`review` 标出疑点：低置信/含数字/过短）
- `candidates[]`：ASR 转写
- `cuts[]`：TransNet 镜头边界

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--video` | — | 输入视频路径 |
| `--out` | — | 输出目录 |
| `--subs` | 关 | 字幕提取（PP-OCR） |
| `--asr` | 关 | 语音识别（sherpa-onnx） |
| `--base-fps` | 5 | 基础帧率 |
| `--diff-threshold` | 8 | 帧差阈值（补帧用） |
| `--page-scale` | 1.8 | 网格页面缩放 |

环境变量：`SUBS_SKIP_TH`（字幕跳帧阈值，默认 3.0）、`DET_MAX_SIDE`（det 长边上限，默认 720）。

## 模型来源与许可

| 模型 | 来源 | 许可 |
|---|---|---|
| TransNetV2 | [soCzech/TransNetV2](https://github.com/soCzech/TransNetV2)，ONNX 转换 [elya5/transnetv2](https://huggingface.co/elya5/transnetv2) | MIT |
| PP-OCRv4 det/rec | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)（经 [RapidOCR](https://github.com/RapidAI/RapidOCR) 提供 ONNX） | Apache-2.0 |
| PP-OCR 字典 | PaddleOCR 官方 | Apache-2.0 |
| sherpa-onnx（ASR，可选） | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 |

使用前请自行确认各模型在目标场景下的许可条款。

## 已知局限

**分组**
- 分组主要辅助镜头与时间组织，不保证等同于语义场景；单长镜头仍可能包含多个内容状态

**采样与网格**
- 基础采样可能遗漏短动作、短镜头或短字幕；完整展示采样帧不等于完整覆盖源视频
- 拼图缩放可能损失小物体、细动作和文字细节，需要展开核验

**OCR**
- 对艺术字、生僻字、低清文字可能误识别，且高置信结果也可能出错；已观察到「爻→交」等案例

**跳帧**
- 当前基于底部区域灰度差的跳帧策略，在已测试的动态 HUD 游戏录屏中收益很低

**ASR**
- 可能误识别同音词、专名（「鲸鲸」→「晶晶」），也不保证说话人归属正确

**性能**
- AI思考时间约为视频时长的1.5~2.5倍**当前测试环境下的观测范围**（CPU/WASM、单线程、中端 Android 设备，ASR与OCR全开），不同设备时间不同（高端的可能会快一些）

## 给 AI 的提示词

见 [PROMPT.md](PROMPT.md)——**遇到不确定必须回看帧**，这是这个项目的核心纪律。
