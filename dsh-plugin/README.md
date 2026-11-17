# dsh-video-kit 视频理解插件

将核心流水线接入 DSH，输出视频时间线、网格页和逐页视觉核验结果。核心处理说明以仓库根目录的 [README](../README.md) 和 [ADR-0019](../docs/ADR-0019-remove-ocr.md) 为准。

## 当前工具

插件入口注册以下四个工具：

| 工具 | 用途 |
|---|---|
| video_analyze | 分析本地视频或 Bilibili 链接，生成时间线、网格和索引 |
| video_look | 返回指定网格页及该页的定位信息；需要据图描述时先打开图像 |
| video_report | 检查本次采样页面的阅读情况；通过不等于原视频无遗漏 |
| video_frame | 按时间点提取原始帧，可指定裁剪和缩放 |

当前入口没有注册 video_read_page 或 video_library；阅读库流程尚未接入 DSH 工具。

## 文字与语音

当前核心流水线已删除硬字幕 OCR。字幕带会以图像条带形式贴到增强页，供读图模型查看，流水线本身不会从硬字幕产生文本。

- 传入 --subs 时，只提取视频内嵌的兼容软字幕轨。
- 开启 ASR 时，设备本地运行 sherpa-onnx Paraformer。
- 插件配置中仍保留名为 OCR 的旧开关；当前核心把该开关映射到 --subs，因此它控制的是软字幕轨提取，不会启动 OCR。
- ASR 与基础帧率由插件配置决定；不确定的文字、数字和动作应回看原始帧或音频。

## 安装

要求 DSH、Node.js 20+、FFmpeg 和 ImageMagick。插件使用 TransNetV2 ONNX 模型；ASR 另需 sherpa-onnx 运行时和 Paraformer 模型。

1. 将 dsh-plugin 目录安装到 DSH 可加载的插件目录，或使用本地 link 安装。
2. 在插件目录安装依赖，并运行模型下载脚本：

       pnpm install
       pnpm models

3. 在 DSH 中通过 install_bundle 加载插件，然后按 DSH 要求重启插件引擎。

FFmpeg 或 ImageMagick 不在引擎 PATH 中时，可在 DSH 扩展目录安装；FFmpeg 也可用 FFMPEG_BIN 指定。

## 输入和数据

- 支持本地视频路径及 Bilibili 视频链接（含 b23.tv 短链）；不支持任意 HTTP 视频直链。
- 本地分析在设备上执行。Bilibili 链接解析与下载需要网络。
- 默认数据目录位于 $DSH_HOME/storages/dsh-video-kit/，可用 DSH_VIDEO_KIT_DIR 覆盖。
- 下载视频会限时保留并定期清理；网格、索引和截帧保存在本机存储中。

具体运行参数、输出字段和边界见 [核心 README](../README.md)。