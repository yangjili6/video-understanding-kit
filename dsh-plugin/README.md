# dsh-video-kit 视频理解插件

把视频整理成时间线、镜头分组和可回查网格页，供 DSH Agent 浏览与核验。

## 能力

插件注册两个工具：

### `video_analyze`

输入本地视频路径或 Bilibili 视频链接（支持 `b23.tv` 短链），返回视频时长、内容组、字幕时间线（硬字幕 OCR + ASR 台词）、输出目录和索引路径。两条识别链的默认开关由**侧栏面板**决定（见下节）；工具参数显式传了则以参数为准：`subs` 控制硬字幕 OCR，`asr` 控制语音识别。

返回值里 `subsCount` 只统计 PP-OCR 硬字幕，`asrCount` / `asr` 是语音台词，两者互不代表 —— 硬字幕为 0 不等于视频没声音。

当前**不支持任意 HTTP 直链**。URL 视频会下载到临时目录，分析结束后临时视频会删除。

### `video_frame`

按时间点截取原始帧，可选裁剪与缩放。输入本地视频路径或 Bilibili 链接；传链接时会重新下载视频后取帧。结果以文件路径返回，可用 DSH 的 `read_image` 打开。

建议流程：

1. 调用 `video_analyze` 浏览时间线与组级导航图。
2. 对不确定的字幕或动作，调用 `video_frame` 定位原帧，或用 `read_image` 打开对应网格页。
3. 将 OCR/ASR 视为候选文本；关键文字、数字和动作细节要回看核验。

## 侧栏面板

侧栏「视频理解」（YouTube 样式图标）打开一个控制面板，开关就是 `video_analyze` 的默认行为：

| 控件 | 作用 |
|---|---|
| 硬字幕提取（OCR） | 用 PP-OCRv4 扫画面烧录字幕。约 0.5s/帧，纯人物画面通常一无所获 |
| 语音识别（ASR） | 本地 sherpa-onnx paraformer 识别台词；视频有配音却没烧录字幕时必开 |
| 基础抽帧率 | 1–12 fps，越高越细也越贵 |

配置存在 `storages/dsh-video-kit/config.json`（全机共用）。工具调用没显式传 `subs` / `asr` 就按面板走；面板改了配置，下一次调用即生效，不需要重启。

面板数据走 `/dsh-video-kit-api`：`GET /config`、`POST /config`、`GET /recent`（最近几次运行的时长/组数/字幕数/台词数）。这个路由是本机免认证的插件路由，跟 WebUI 的认证体系无关。

## 安装

要求 DSH Mobile、Node.js 20 或更新版本、ffmpeg、ImageMagick。

1. 将 `dsh-plugin/` 放进 DSH profile 的 `node_modules` 下（或使用 `link:` 安装）。
2. 安装插件依赖。包声明了 `onnxruntime-web`；若 DSH 的链接安装没有自动安装依赖，请在插件目录运行：

   ```bash
   pnpm install
   ```

3. 下载视觉模型。在插件目录运行：

   ```bash
   pnpm models
   # 或 node lib/videokit/download-models.mjs
   ```

   模型约 **47 MB**，保存到 `lib/videokit/lib/models/`。模型文件不随 Git 仓库分发，也不应提交进仓库。

4. 在 DSH 中执行 `install_bundle target="link:<插件绝对路径>"`，然后重启引擎。插件不支持热重载。

ffmpeg / ImageMagick 若不在引擎的 `PATH` 中，插件会探测 DSH 扩展目录；也可通过 `FFMPEG_BIN` 指定 ffmpeg 可执行文件。

### 可选：ASR

`asr: true` 需要额外安装 sherpa-onnx 和中文 Paraformer 模型（约 217 MB）。模型路径与运行时配置见 `lib/videokit/asr.mjs`。这部分不包含在上述视觉模型包中。

## 数据目录

默认目录为 `$DSH_HOME/storages/dsh-video-kit/`，可用 `DSH_VIDEO_KIT_DIR` 覆盖：

```text
dsh-video-kit/
├── out/        # index.json、base/extra 采样帧、grids、可选 subs/audio
├── frames/     # video_frame 截取的原始帧
└── downloads/  # 分析/取帧期间的临时下载，完成后清理
```

`video_analyze` 的 `out` 参数只接受单级目录名称，产物始终写入插件存储目录下的唯一子目录。`video_frame` 的 `outDir` 也只接受存储区内的子目录名称。

## 数据与网络

- 本地视频由设备上的 ffmpeg、ImageMagick 与 ONNX 模型处理，不会上传到远程推理服务。
- 输入 Bilibili 链接时，插件会访问 Bilibili 短链/API，并下载对应视频流；该路径需要网络。
- 首次准备模型时，从 Hugging Face 与 PaddleOCR 的 GitHub 原始文件地址下载约 47 MB 的模型和字典。
- 临时视频下载会在分析/取帧结束后清理；生成的网格、索引和截帧保存在 DSH 本机存储中，直到用户自行删除。

## 实测记录

2026-10-25 的一段 95 秒竖屏 Bilibili 视频测试：耗时 262 秒（含下载、TransNet 检测和 PP-OCR），得到 13 个内容组、28 条字幕和 87 张网格页。OCR 曾将「逗AI真好玩」识别成「逗A真好玩」。这是单次测试记录，不代表其他设备或视频的性能与准确率。

2026-10-30 修复一处 OCR 全灭的坐标 bug：`subs.mjs` 的几何阈值原按 `ffprobe` 原始分辨率（1280×720）计算，而送检帧是 `scale=960:-1` 缩到 960×540 的，字幕框落在这套坐标里 —— `w > W*0.3`(384) 与 `y0 > H*0.65`(468) 对实际 `w=192 / y0=450` 的字幕恒为假，整片 420 帧输出 0 条。改为按帧坐标判定（宽 >8%、字高 2%~16%、下方 40%、水平居中），并加居中度挡掉角标水印。同一视频前 1/3（70s）实测：修复前 0 条，修复后 20 条，置信度 0.94~1.00。

同日加「预探测」：全量 OCR 前先均匀抽 12 帧试一遍，一帧字幕行都没有就直接收工（12 帧约 6s，换来省掉整轮全量）。实测 15 秒无字幕片：命中 0，9.7s 返回 0 条；有字幕片照常放行（20 条，73.9s）。可用环境变量 `SUBS_PROBE_N=0` 关闭。

同日调 ASR 切分（`asr.mjs`）：

- **超长段等分**（`ASR_MAX_SEG`，默认 25s）。paraformer 是整段一次性解码，喂 80 秒以上会明显跑偏。实测 210s 动画片：原来切出 86s/124s 两段、文本出现「冻筷子」「滑管」，切成 25s 以内后变成 **13 条 / 87.4s**（原来 8 条 / 120s），「我替你们每个人保管过一些东西」这类句子也捞回来了。
- **语气词过滤**：底噪/音乐常被硬识别成「啊」「啊啊」「嗯」，现在直接丢弃（实测实拍片少 1 条噪音）。
- **静音阈值可调**（`ASR_SILENCE_DB`，默认 30；`ASR_MIN_SILENCE`，默认 0.4）。实拍片人声轻时可放宽到 35：30s 实拍样本 3 条 → 5 条；但同一放宽用在动画片上反而少 4 条（段被合并过长），所以默认保持 30。
- 修掉一个 `Number(null) === 0` 的坑：最后一段 `end: null` 表示「到结尾」，原判定会把它算成 0 秒而跳过切分。

## 架构与许可证

完整的视频处理代码位于 `lib/videokit/`，根目录工具包与 DSH 插件内置副本需要保持同步。插件包采用 MIT 许可；模型权重有各自的许可条款，请在使用前核对。
