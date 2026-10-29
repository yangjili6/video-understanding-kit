/**
 * dsh-video-kit — 视频理解 · Client 半边（侧栏控制面板）。
 *
 * 指挥官 2026-10-29 的需求：「改为左侧栏有一个视频插件控制的 UI，
 * 让其他人可以自行选择 OCR 与 ASR 是否开启」。
 *
 * 为什么要这个面板：
 *   video_analyze 的两个开关（subs=硬字幕 OCR / asr=语音识别）原来只能靠调用方
 *   在参数里传，默认值又都是「不传就按插件写死的」—— 结果漏开 ASR 时，
 *   返回体只说「没有字幕」，很容易把「有配音但没开识别」误判成「视频没声音」。
 *   把开关搬到面板上：默认行为可见、可改，且写进 storages 全局生效。
 *
 * 数据走 Host 的 /dsh-video-kit-api（无 RPC 依赖，与 dsh-quiz 同款）。
 * 注册 id 必须等于 loader entry 名（dsh-video-kit），否则 ModuleLoader 报
 * "loaded without registering dsh-video-kit"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-kit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const API = '/dsh-video-kit-api'

    const CSS = [
      '.dvk-wrap{display:flex;flex-direction:column;height:100%;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary);overflow:auto}',
      '.dvk-head{padding:16px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dvk-title{font-size:15px;font-weight:600;margin:0 0 4px}',
      '.dvk-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dvk-section{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dvk-section-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;margin-bottom:10px}',
      '.dvk-row{display:flex;align-items:flex-start;gap:12px;padding:10px 0}',
      '.dvk-row+.dvk-row{border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.dvk-row-main{flex:1;min-width:0}',
      '.dvk-row-name{font-size:13px;line-height:1.4}',
      '.dvk-row-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin-top:3px}',
      '.dvk-switch{flex:none;width:42px;height:23px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;transition:background .16s ease,border-color .16s ease}',
      '.dvk-switch::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .16s ease,background .16s ease}',
      '.dvk-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dvk-switch.on::after{transform:translateX(19px);background:#fff}',
      '.dvk-switch[disabled]{opacity:.45;cursor:not-allowed}',
      '.dvk-num{flex:none;width:64px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px;font-size:12.5px;text-align:center}',
      '.dvk-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:0 16px 12px}',
      '.dvk-note.warn{color:#d97706}',
      '.dvk-note.err{color:#ef4444}',
      '.dvk-runs{padding:14px 16px}',
      '.dvk-run{display:flex;gap:8px;align-items:baseline;padding:7px 0;font-size:12px;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.dvk-run:first-of-type{border-top:none}',
      '.dvk-run-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dvk-run-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dvk-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:6px 0}',
      '.dvk-foot{padding:12px 16px 18px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;word-break:break-all}',
      // 侧栏图标：图形只用 currentColor，hover/激活由框架的 panelRow 驱动。
      '.dvk-glyph{display:block;color:inherit}',
    ].join('')

    const styleId = 'dsh-video-kit-style'
    if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
      const el = document.createElement('style')
      el.id = styleId
      el.textContent = CSS
      document.head.appendChild(el)
    }

    function statusText(s) {
      if (!s) return ''
      if (s.summary) {
        const parts = []
        parts.push(`${Number(s.summary.duration || 0).toFixed(1)}s`)
        parts.push(`${s.summary.groups} 组`)
        parts.push(`${s.summary.subs} 条字幕`)
        if (s.summary.asr !== null && s.summary.asr !== undefined) parts.push(`${s.summary.asr} 段台词`)
        return parts.join(' · ')
      }
      return ''
    }

    async function apiCall(path, options) {
      const res = await fetch(API + path, {
        method: (options && options.method) || 'GET',
        headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `HTTP ${res.status}`)
      }
      return data
    }

    /**
     * 侧栏图标：YouTube 样式 —— 宽扁圆角矩形 + 实心播放三角。
     * 比例照 YouTube logo：矩形 20×13.6（约 1.47:1），圆角约占高度 30%，
     * 三角底边竖直、高 5.6、宽 4.9，视觉重心落在矩形中心（12,12）。
     * 只有 currentColor，hover / 选中由框架的 panelRow 驱动。
     */
    function FilmGlyph(props) {
      const size = (props && props.size) || 18
      return React.createElement(
        'svg',
        {
          className: 'dvk-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 2, y: 5.2, width: 20, height: 13.6, rx: 4.2 }),
        React.createElement('path', { d: 'M10.3 9.2v5.6l4.9-2.8z', fill: 'currentColor', stroke: 'none' }),
      )
    }

    function Switch(props) {
      const { on, disabled, onToggle, label } = props
      return React.createElement('button', {
        type: 'button',
        className: 'dvk-switch' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        disabled: !!disabled,
        onClick: onToggle,
      })
    }

    function Panel(props) {
      const [cfg, setCfg] = React.useState(null)
      const [recent, setRecent] = React.useState([])
      const [err, setErr] = React.useState('')
      const [savedAt, setSavedAt] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        let alive = true
        ;(async () => {
          try {
            const [c, r] = await Promise.all([apiCall('/config'), apiCall('/recent')])
            if (!alive) return
            setCfg(c.config)
            setRecent(r.runs || [])
            setErr('')
          } catch (e) {
            if (alive) setErr(String((e && e.message) || e))
          }
        })()
        return () => {
          alive = false
          mounted.current = false
        }
      }, [])

      async function patch(part) {
        if (busy) return
        setBusy(true)
        try {
          const data = await apiCall('/config', { method: 'POST', body: part })
          if (mounted.current) {
            setCfg(data.config)
            setErr('')
            setSavedAt(Date.now())
          }
        } catch (e) {
          if (mounted.current) setErr(String((e && e.message) || e))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      const h = React.createElement
      const loading = !cfg

      const ocrOn = !!(cfg && cfg.ocr)
      const asrOn = !!(cfg && cfg.asr)

      return h(
        'div',
        { className: 'dvk-wrap' },
        h(
          'div',
          { className: 'dvk-head' },
          h('div', { className: 'dvk-title' }, '视频理解'),
          h(
            'div',
            { className: 'dvk-sub' },
            '这里设的是 video_analyze 的默认行为。工具参数显式传了就以参数为准。',
          ),
        ),

        h(
          'div',
          { className: 'dvk-section' },
          h('div', { className: 'dvk-section-title' }, '识别开关'),
          h(
            'div',
            { className: 'dvk-row' },
            h(
              'div',
              { className: 'dvk-row-main' },
              h('div', { className: 'dvk-row-name' }, '硬字幕提取（OCR）'),
              h(
                'div',
                { className: 'dvk-row-desc' },
                '读画面上烧录的字幕。贵在慢：按 2fps 抓帧逐张识别，纯人像画面通常一无所获。',
              ),
            ),
            h(Switch, {
              on: ocrOn,
              disabled: loading || busy,
              label: '硬字幕提取',
              onToggle: () => patch({ ocr: !ocrOn, updatedBy: 'panel' }),
            }),
          ),
          h(
            'div',
            { className: 'dvk-row' },
            h(
              'div',
              { className: 'dvk-row-main' },
              h('div', { className: 'dvk-row-name' }, '语音识别（ASR）'),
              h(
                'div',
                { className: 'dvk-row-desc' },
                '本地 paraformer 识别台词。视频有配音却没烧录字幕时，不开就只剩画面。',
              ),
            ),
            h(Switch, {
              on: asrOn,
              disabled: loading || busy,
              label: '语音识别',
              onToggle: () => patch({ asr: !asrOn, updatedBy: 'panel' }),
            }),
          ),
          h(
            'div',
            { className: 'dvk-row' },
            h(
              'div',
              { className: 'dvk-row-main' },
              h('div', { className: 'dvk-row-name' }, '基础抽帧率'),
              h('div', { className: 'dvk-row-desc' }, '1–12 fps。越高越细，成本也越高。'),
            ),
            h('input', {
              className: 'dvk-num',
              type: 'number',
              min: 1,
              max: 12,
              step: 1,
              disabled: loading || busy,
              value: cfg ? String(cfg.baseFps) : '',
              onChange: (e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 1 && v <= 12) patch({ baseFps: v, updatedBy: 'panel' })
              },
            }),
          ),
          savedAt
            ? h('div', { className: 'dvk-note' }, `已保存 ${new Date(savedAt).toLocaleTimeString()}，下次调用生效`)
            : null,
          err ? h('div', { className: 'dvk-note err' }, `出错了：${err}`) : null,
          !cfg && !err ? h('div', { className: 'dvk-note' }, '正在读取配置…') : null,
        ),

        h(
          'div',
          null,
          h('div', { className: 'dvk-section-title', style: { padding: '14px 16px 0' } }, '最近运行'),
          recent.length
            ? h(
                'div',
                { className: 'dvk-runs' },
                recent.map((r) =>
                  h(
                    'div',
                    { className: 'dvk-run', key: r.name },
                    h('div', { className: 'dvk-run-name', title: r.name }, r.name.replace(/-[0-9a-f-]{20,}$/i, '')),
                    h('div', { className: 'dvk-run-meta' }, statusText(r) || '—'),
                  ),
                ),
              )
            : h('div', { className: 'dvk-empty', style: { padding: '8px 16px 0' } }, '还没有运行记录。'),
        ),

        h('div', { className: 'dvk-foot' }, cfg ? `存储：${cfg.storageRoot || ''}` : ''),
      )
    }

    /** 侧栏 occupant：框架传 { size, active }，点击切面板/文字标签都归框架。 */
    function Rail(props) {
      return React.createElement(FilmGlyph, { size: props && props.size, active: props && props.active })
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: 'dsh-video-kit', order: 45, label: '视频理解' }, Rail),
      )

      slots.inject('main', () =>
        slots.register({ name: 'main', key: 'dsh-video-kit' }, () => React.createElement(Panel, { ctx })),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
