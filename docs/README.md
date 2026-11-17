# 决策与实验记录

这里保存架构决策（ADR）和设备实测。早期 ADR 记录的是当时的方案，后续决策可能取代其中的实现；阅读当前行为时，请先看 ADR-0018 和 ADR-0019，再对照代码。

## 当前有效决策

| 文档 | 当前结论 |
|---|---|
| [ADR-0016 采样取舍](ADR-0016-sampling-final-tradeoff.md) | 采样策略的实验与权衡记录；默认参数之后仍有更新，以当前 pipeline.mjs 为准 |
| [ADR-0018 帧级去重](ADR-0018-frame-level-dedup.md) | 分组分页前做帧级去重，再由页级去重处理跨页重复 |
| [ADR-0019 删除 OCR](ADR-0019-remove-ocr.md) | 硬字幕 OCR 已删除；字幕条带作为图像供读图模型查看，软字幕轨和 ASR 是独立来源 |

## 历史决策

以下记录仍保留作背景。涉及 OCR 的旧方案不代表当前实现。

| 文档 | 内容 / 状态 |
|---|---|
| [ADR-0001 ASR 分段与过滤](ADR-0001-asr-segmentation.md) | ASR 切分、静音过滤与降噪实验 |
| [ADR-0002 B 站下载](ADR-0002-bilibili-download.md) | 下载耗时、并发与网络栈问题 |
| [ADR-0003 运动强度抽帧](ADR-0003-motion-based-frame-sampling.md) | 帧差与光流的取舍 |
| [ADR-0004 动作采样](ADR-0004-action-sampling.md) | 网格浏览、补抽与动作定位 |
| [ADR-0005 TransNet 采样](ADR-0005-transnet-sampling.md) | 镜头边界对采样的作用 |
| [ADR-0006 流程并发](ADR-0006-pipeline-concurrency.md) | 主流程并发设计 |
| [ADR-0007 OCR 并行](ADR-0007-ocr-parallel.md) | 已被 ADR-0019 取代的 OCR 并行方案 |
| [ADR-0008 负载感知并发](ADR-0008-load-aware-concurrency.md) | Android CPU 拓扑与负载回退 |
| [ADR-0009 并发度标定](ADR-0009-concurrency-calibration.md) | 设备并发标定方法 |
| [ADR-0010 温度保护](ADR-0010-thermal-protection.md) | 温度优先的降档策略 |
| [ADR-0011 视觉门禁](ADR-0011-vision-gate.md) | 逐页视觉核验与阅读率口径 |
| [ADR-0012 网格去重](ADR-0012-grid-dedup.md) | 页级视觉去重与代表页比较 |
| [ADR-0013 OCR 候选窗口](ADR-0013-ocr-candidate-windows.md) | 已废弃的硬字幕与画面文字 OCR 双路方案 |
| [ADR-0014 字幕带投票](ADR-0014-subtitle-band-vote.md) | 失败后撤回的字幕带投票实验 |
| [ADR-0015 OCR 与视觉解耦](ADR-0015-ocr-visual-decoupling.md) | OCR 时代的架构边界；文字不再反馈视觉去重 |
| [ADR-0017 画面文字区域追踪](ADR-0017-screen-region-tracking.md) | Proposed 方案；在 OCR 删除后未实现，见 ADR-0019 |

## 实验记录

| 文档 | 内容 |
|---|---|
| [实验 2026-10-30 ASR/OCR](EXPERIMENT-2026-10-30-asr-ocr.md) | OCR 坐标、探测与 ASR 参数的历史对照 |
| [实验 2026-11-03 帧细节](EXPERIMENT-2026-11-03-frame-detail.md) | 网格、关键帧和补抽对照 |
| [实验 2026-11-10 并发 A/B](EXPERIMENT-2026-11-10-concurrency-ab.md) | 不同并发档位与运行温度 |
| [实验 2026-11-10 重叠对照](EXPERIMENT-2026-11-10-overlap.md) | 并行重叠未带来总耗时收益的对照 |

## 代码与文档的阅读顺序

1. [项目 README](../README.md) 查看当前处理流程和输出。
2. 阅读 ADR-0018、ADR-0019，了解帧级去重与 OCR 删除后的字幕处理。
3. 遇到历史行为时再读对应旧 ADR 和实验报告。
