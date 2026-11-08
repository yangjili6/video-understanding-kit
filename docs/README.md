# 决策与实验记录

这里放两类东西：

- **ADR**（Architecture Decision Record）：某个选择为什么这么定，以及拒绝了哪些备选。改之前先读，免得把已经踩过的坑再踩一遍。
- **实验报告**：带数据的对照实验，用来支撑 ADR 里的结论。报告里的数字都是本机实测，素材、命令都写在文末，可以复现。

| 文档 | 内容 |
|---|---|
| [ADR-0001 分段与过滤](ADR-0001-asr-segmentation.md) | ASR 怎么切段、为什么默认阈值不动、为什么拒绝降噪 |
| [ADR-0002 B 站下载耗时](ADR-0002-bilibili-download.md) | 视频下载分片并发、autoSelectFamily 为什么在进程内失效、还剩哪些没做 |
| [ADR-0003 运动强度抽帧](ADR-0003-motion-based-frame-sampling.md) | 光流 vs 帧差：为什么先选帧差、光流留作后续、收益上限在哪 |
| [ADR-0004 动作采样](ADR-0004-action-sampling.md) | 网格够不够用、补抽为什么有效但定位错、镜头运动怎么排除 |
| [ADR-0005 TransNet 采样](ADR-0005-transnet-sampling.md) | 便宜特征为什么替代不了切点检测（六信号全灭）、STRIDE 减半的零损失提速 |
| [ADR-0006 流程并发](ADR-0006-pipeline-concurrency.md) | 拼图/补帧为什么是隐藏大头、进程池怎么压、为什么暂不上 worker_threads |
| [ADR-0007 OCR 并行](ADR-0007-ocr-parallel.md) | 时间全在检测不在识别、字幕带/降分辨率都不可行、分片并行 1.42x 与 cpus() 返回 0 的坑 |
| [ADR-0008 负载感知](ADR-0008-load-aware-concurrency.md) | Android 只有 cpufreq 可读、1+3+4 拓扑、热时退回串行，以及「并行不一定更快」的实测 |
| [ADR-0009 并发度标定](ADR-0009-concurrency-calibration.md) | 实测选档规则（T(n)≤1.08×min T 的最小 n）、本次推荐 3 路、以及「四舍五入不能参与阈值判断」的教训 |
| [ADR-0010 温度保护](ADR-0010-thermal-protection.md) | 温度优先于吞吐量；电池温度分级降档（38/40/42℃ → 不限/3/2/1 路）；标定是冷机峰值、实际是持续负载 |
| [ADR-0011 视觉强制执行](ADR-0011-vision-gate.md) | 把视觉分析做成强制工作流：Orchestrator（编排）+ Vision Gate（门禁）+ Evidence Ledger（账本在服务端）；不看图拿不到结论 |
| [交接：PC 端标定](HANDOFF-calibration-pc.md) | 给电脑上的 AI：复现标定、回答 5 个问题（并行效率/瓶颈/worker 线程数/帧数影响） |
| [实验 2026-10-30](EXPERIMENT-2026-10-30-asr-ocr.md) | OCR 坐标 bug、OCR 预探测、ASR 分段/阈值/降噪的七组对照 |
| [实验 2026-11-03](EXPERIMENT-2026-11-03-frame-detail.md) | 三组对照：网格够用 / 关键帧没采到 / 补抽有效但峰值错 |

## 测试素材

| 代号 | 片子 | 类型 | 时长 | 特点 |
|---|---|---|---|---|
| `cat` | 美味小猫（BV12tHr6DEkD） | 3D 动画，猫娘 | 15s | 画面无硬字幕，有清晰配音 |
| `fish` | 大肥鱼的上下文超出了（BV17rng6mEmT） | 2D 动画 | 210s | 画面有硬字幕，纯人声配音 |
| `fish-1/3` | 上面前 70s（ffmpeg 截取） | 2D 动画 | 70s | 用来降低实验成本 |
| `small` | 小肥鱼长大了（BV1Bjnr6NEJG） | 真人实拍 + 合成角色 | 30s | 无字幕，底噪 + BGM + 轻声台词 |

## 环境

本机：vivo V2405A / Android 16 / arm64-v8a，整个 Node 引擎跑在 DSH app 沙箱里。

| 组件 | 版本/规格 |
|---|---|
| ASR | sherpa-onnx WASM + paraformer-zh 2024-03-09 int8（227MB） |
| OCR | PP-OCRv4 det + rec（ONNX，随包） |
| 镜头检测 | TransNetV2（ONNX，随包） |
| ffmpeg / ImageMagick | 扩展中心版本 |

## 一句话结论

1. OCR 曾经整片输出 0 条，原因是**几何阈值按原始分辨率算、而 box 在缩放帧坐标系**里 —— 已修。
2. ASR 质量的主要瓶颈不是静音阈值，而是**一次喂给 paraformer 的音频太长**。切成 25s 以内后，同一部片子 8 条 → 13 条，耗时同时下降。
3. 降噪（gtcrn）在本机实测**没有收益**，未采用。

## 图表

- [OCR 并发与温度决策](diagrams/pipeline-core@2x.png)
- [视觉强制执行工作流](diagrams/vision-gate@2x.png) — 由 `tools/draw-vision-gate-svg.mjs` 生成；含方案边界与两次门禁实测。 — 由 `tools/draw-core-svg.mjs` 生成；改数据后重跑脚本即可更新。
