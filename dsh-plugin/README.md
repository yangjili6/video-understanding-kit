# dsh-video-kit 视频理解工具包

把视频拆成**字幕时间线 + 内容分组 + 可回查网格页**，给 Agent 一个能看见、会主动用的工具。

## 为什么做成插件

之前在 `dsh-work/video-tmp` 里跑脚本，Agent 看不见它——**只会在手边找 ffmpeg**，然后肉眼看网格图、读错字幕。
做成 DSH 工具后，`video_analyze` 出现在工具列表里，规划时自然会被选中。

## 两个工具

### `video_analyze`

```
video   本地路径 / B站链接（支持 b23.tv 短链）/ 直链
subs    是否提字幕（默认 true）
asr     是否跑语音识别（需 sherpa-onnx，默认 false）
```

返回：`duration`、`groups`（内容分组）、`subs`（字幕全文 + 时间戳 + 置信度 + 疑点标记）、`outDir`、`indexJson`。

**只返回文本摘要，不返回图片**——省 token。

### `video_frame`

```
video   视频路径
t       时间点（秒）
crop    可选裁剪：WxH+X+Y（只取字幕带时很有用）
scale   可选缩放宽度
```

返回原帧文件路径，用 `read_image` 打开。用于核对字幕/动作细节。

## 工作流

```
video_analyze（文本摘要，几百 token）
  ├─ 字幕够用 → 直接回答
  └─ 有疑点 → video_frame 取原帧 → read_image
```

## 实战经验（2026-10-25 实测）

### 取帧时机：用区间中点，不要用起点

OCR 给的是字幕**区间**（如 `53.5~54.5s`）。取区间**起点**容易抓到淡入瞬间——实测 53.5s 那一帧是空的，54.0s 才有字。**传中点更稳**。

### crop 位置要按视频试

竖屏 720×1280 的字幕实测在 **y≈860~960**（约 70% 处），**不在最底部**。
不同视频字幕位置不同，先用一张**全帧**（不传 crop）确认位置，再裁。

### crop 语法

工具接受 ImageMagick 风格 `WxH+X+Y`（如 `720x160+0+890`），内部自动转成 ffmpeg 的 `W:H:X:Y`。直接写 ffmpeg 的冒号语法也支持。

### 实测数据

| 项目 | 数值 |
|---|---|
| 测试视频 | B站 95 秒竖屏 720×1280 |
| 端到端耗时 | **262 秒**（含下载 + TransNet 检测 + PP-OCR） |
| 产出 | 13 个内容组、28 条字幕、87 张网格页 |
| OCR 准确率 | 大部分 conf > 0.95；已知误读：「逗AI真好玩」被读成「逗A真好玩」 |

## 踩坑记录

1. **DSH 新版工具 `output` 必须是 `{ schema, render }` 对象**，写成函数会被拒（`must declare output { schema, render }`）。
2. **`ffmpeg` 不在引擎 PATH 里**，要用扩展中心的绝对路径；插件里做了自动探测。
3. **crop 语法别混**：ImageMagick 用 `WxH+X+Y`，ffmpeg 用 `W:H:X:Y`。
4. **`index.json` 的 `groups[].from/to` 单位是秒**，不是毫秒。

## 内置

- `lib/videokit/pipeline.mjs` —— video-understanding-kit 完整流程
- TransNetV2 镜头检测（31MB）+ PP-OCRv4 字幕（15MB），模型随包
- onnxruntime-web（复用 dsh-long-memory 的 ort）

## 依赖

- `ffmpeg`、`ImageMagick`（扩展中心安装，或设 `FFMPEG_BIN`）
- Node ≥ 20

## 数据目录

`$DSH_HOME/storages/dsh-video-kit/`（可用 `DSH_VIDEO_KIT_DIR` 覆盖）
- `out/` —— 分析产物（index.json / grids / frames）
- `frames/` —— video_frame 取的原帧
- `downloads/` —— 临时下载（用完即删）

## 许可

MIT。真正的视频处理在 [video-understanding-kit](https://github.com/yangjili6/video-understanding-kit)。
