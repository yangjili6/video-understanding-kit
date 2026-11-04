// ⚠ 自动生成文件，请勿编辑。
// 真源：lib/transnet-worker.mjs（仓库根目录）。改完真源后运行 `pnpm run sync` 重新生成。
// 校验：`pnpm run sync:check`，副本与真源不一致时退出码为 1。
// TransNet 推理 worker：把镜头检测挪出主线程，让它在主线程跑 ASR/OCR 时并行。
// 由 pipeline.mjs 通过 new Worker(...) 启动；消息协议：{ ok, cuts } 或 { ok:false, error }。
import { parentPort, workerData } from 'node:worker_threads'
import { detectCuts } from './transnet-lib.mjs'

const { video, fps, thr } = workerData || {}

try {
  const { cuts } = await detectCuts(video, { fps, thr })
  parentPort.postMessage({
    ok: true,
    cuts,
    // 峰值内存方便主线程记录（MB）
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  })
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error).slice(0, 800) })
}
