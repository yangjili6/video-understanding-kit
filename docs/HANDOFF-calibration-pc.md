# 交接：视频管线并发度标定（2026-11-06）

> 给 PC 端的 DeepSeek：这篇是手机端做完的并发改造与标定，**需要你在电脑上复现一遍并回答几个问题**。
> 仓库：`yangjili6/video-understanding-kit`，当前 `main` 在 `08858f5`。

## 背景（一分钟看完）

手机端（vivo V2405A，Android 16，1+3+4 八核）上有一条约 60s 的视频分析管线。今天做了四件事：

1. **TransNet 窗口步长 50→100**（不重叠）：切点结果完全一致，耗时减半。见 ADR-0005。
2. **拼图 / 补帧改进程池**：分页 21.6s→5.0s。见 ADR-0006。
3. **TransNet 移到 worker 线程**：与 ASR/OCR 并行，三轮对照 1.21x。见 ADR-0006。
4. **PP-OCR 检测分片并行**：det 单项 2.4~2.8x，整段字幕提取 1.4~1.6x。见 ADR-0007。

最后做了一套**并发度标定工具**（`tools/calibrate.mjs`）：不猜、直接实测几路最快。见 ADR-0009。

## 你要跑什么

### 1. 拉代码、装依赖

```bash
git clone https://github.com/yangjili6/video-understanding-kit.git
cd video-understanding-kit
pnpm install            # 或 npm install
cd dsh-plugin && pnpm install && cd ..
node scripts/sync-videokit.mjs --check   # 应报「9 个文件一致」
```

需要 `ffmpeg`、`ffprobe`、`magick`（ImageMagick）在 PATH 上。

### 2. 跑一次标定

```bash
# 24 帧 × 3 次（约 2-3 分钟）
node tools/calibrate.mjs <任意一个 15~30 秒、有硬字幕的本地视频>

# 或者用参数控制
PROBE_FRAMES=24 REPS=5 TOLERANCE=0.08 node tools/calibrate.mjs <视频>
```

输出形如：

```
并发  中位耗时   加速   效率   极差
  1   13.30s      1x   100%     5%
  2   11.80s   1.13x    56%     9%
  3    9.03s   1.47x    49%     1%
  4    9.91s   1.34x    34%    14%
建议 OCR 并发度 = 3
```

结果同时落到 `tmp/calibrate-result.json`（含每档原始样本）。

### 3. 跑一次完整管线，看分段耗时

```bash
node dsh-plugin/lib/videokit/pipeline.mjs --video <视频> --out /tmp/out1 --subs
node dsh-plugin/lib/videokit/pipeline.mjs --video <视频> --out /tmp/out2 --subs --serial
```

关注 `[timing]` 那几行和 `index.json` 里的 `timings`，特别是：

- `字幕提取` / `det` 各多少
- `TransNet 镜头检测` 的等待时间（并行版应接近 0）
- `[load]` 那行有没有触发串行

## 手机端已知数据（供对比，别当基准）

**拓扑**：8 核 = 4 能效核（capacity≈500）+ 3 性能核（≈880）+ 1 超大核（1024）。

**标定（24 帧 × 3 次）**：

| 并发 | 中位数 | 加速 | 效率 | 极差 |
|---|---|---|---|---|
| 1 | 13.30s | 1.00x | 100% | 5% |
| 2 | 11.80s | 1.13x | 56% | 9% |
| 3 | 9.03s | 1.47x | 49% | 1% |
| 4 | 9.91s | 1.34x | 34% | 14% |

**推荐 3 路**（手机端）。注意：手机 CPU 会热降频，同配置不同时段能差 40%。

## 需要你回答的问题

这几个问题手机端答不了，必须看电脑的数据：

### Q1. 电脑上的并行效率是多少？

手机端 4 路只有 34~40% 效率（4 个大核互相拖）。**电脑（桌面 CPU + 更宽的核）应该高得多。**
请报：每档中位数、加速比、效率，以及你的 CPU 型号 / 核心数。

### Q2. 4 路之后还有收益吗？

手机端 4 路就到顶了（甚至变慢）。请测到 **8 路或 16 路**（`--max 16`），看：
- 加速曲线在哪里开始平
- 有没有「超过某档反而变慢」的拐点

```bash
node tools/calibrate.mjs <视频> --max 16 --frames 48
```

### Q3. 每 worker 的内部线程数是多少？

**这一条最重要。** 我一直没核对：`onnxruntime-web` 每个 worker 实例内部会不会自己开线程（`ort.env.wasm.numThreads`）。

如果每个 worker 内部还开 N 线程，那「4 路」实际是「4×N 个线程抢核」——**这能解释手机端 4 路效率骤降到 34%**。

请看 `lib/ocr-pp.mjs` 和 `dsh-plugin/lib/videokit/lib/ocr-pp.mjs` 里 `ort.env.wasm.numThreads` 的设置，并在电脑上验证：**是否存在多层并行互抢**。

### Q4. 帧数对效率的影响

手机端测过 24 帧和 52 帧，效率 35.85% / 39.51%（未舍入），**但没有离散度，不敢下结论**。
请在同一台机器上固定帧数跑 24 / 48 / 96 三组，各 3 次，看效率是否随帧数变化。

### Q5. 「距最快档 ≤8%」这个规则在电脑上选几路？

用标定输出验证：电脑上 TOLERANCE=0.08 会推荐几路？和「直接选最快」差多少？

## 已知的坑（省你时间）

| 坑 | 说明 |
|---|---|
| `os.cpus()` 在 Android 返回空数组 | 所以 `lib/cpu.mjs` 改读 `/sys/.../cpu_capacity`；**电脑上走 `os.cpus()` 分支，不受影响** |
| 仓库根的 `lib/` 没有 `node_modules` | `tools/calibrate.mjs` 默认从 `VK_DIR`（安装目录）加载 OCR 依赖，可用环境变量覆盖 |
| worker 文件必须在 `package.json` 的 `files` 里 | 曾漏掉导致 npm 包静默缺文件、并行失效 |
| `sync-videokit.mjs` 的 FILES 清单 | 新增模块要加进去，否则 `sync` 不认 |
| 测耗时要看设备状态 | 手机端因热降频出现过同配置 45.3s / 63.4s；**电脑上注意后台负载和睿频** |

## 别做的事

- **别把手机端的绝对耗时当基准**——只有相对提速可跨设备比较。
- **别用单次测量选并发档**——至少 3 次取中位数。
- **别用四舍五入后的数字做阈值判断**（我犯过：39.51% 显示成 40% 就当达标）。

## 产出物

跑完把这些发回来：

1. `tmp/calibrate-result.json`（标定原始数据）
2. 完整管线的 `timings`（并行 vs 串行各一次）
3. Q1~Q5 的答案，特别是 Q3（worker 内部线程数）
