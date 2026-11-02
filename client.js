window.__ModuleLoader__.load({
  id: 'dsh-github-connectivity',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const NS = 'github-connectivity-doctor'
    const ROUTE = '/plugin/github-connectivity'

    const zh = {
      nav: 'GitHub 连接',
      title: 'GitHub 连接诊断',
      desc: '逐层探测 DNS / TCP / TLS，判定卡片在哪一层，并给出可直接复制的修复命令。',
      refresh: '重新检测',
      loading: '正在探测 github.com 及备用 IP…',
      error: '检测失败',
      errorHint: '出现“Host 侧未注册”说明客户端的界面加载了、但服务端插件行没启动：到 设置 → 插件 确认 Github Connectivity 处于启用状态，或先升级 Harness。临时可用 /github 命令或直接问智能体。',
      diagnosis: '结论',
      endpoints: '端点探测',
      candidates: '备用 IP',
      env: '本机环境',
      fixes: '建议修复',
      copy: '复制',
      copied: '已复制',
      apply: '一键应用',
      working: '正在处理…',
      confirm: '确认应用',
      confirmUac: '确认（会弹 UAC）',
      revert: '撤销',
      applied: '已应用',
      asAdmin: '需要管理员权限',
      verify: '验证',
      revert: '撤销',
      note: '注意',
      gitProxy: 'git 代理',
      proxyEnv: '代理环境变量',
      proxyPorts: '本机代理端口',
      ssh443: 'SSH 走 443',
      none: '无',
      notSet: '未配置',
      yes: '已配置',
      no: '未配置',
      limits: '边界',
    }

    const en = {
      nav: 'GitHub',
      title: 'GitHub Connectivity Doctor',
      desc: 'Probes DNS / TCP / TLS layer by layer, names the blocking layer, and prints copy-ready fixes.',
      refresh: 'Re-check',
      loading: 'Probing github.com and candidate IPs…',
      error: 'Check failed',
      errorHint: 'If it keeps failing, run /github in the composer to check from the Host side.',
      diagnosis: 'Verdict',
      endpoints: 'Endpoints',
      candidates: 'Candidate IPs',
      env: 'Local environment',
      fixes: 'Suggested fixes',
      copy: 'Copy',
      copied: 'Copied',
      apply: 'Apply',
      working: 'Working…',
      confirm: 'Confirm',
      confirmUac: 'Confirm (UAC prompt)',
      revert: 'Revert',
      applied: 'Applied',
      asAdmin: 'needs admin',
      verify: 'Verify',
      revert: 'Revert',
      note: 'Note',
      gitProxy: 'git proxy',
      proxyEnv: 'proxy env',
      proxyPorts: 'local proxy ports',
      ssh443: 'SSH over 443',
      none: 'none',
      notSet: 'not set',
      yes: 'configured',
      no: 'not set',
      limits: 'Limits',
    }

    const tone = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      fail: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '4px 0 24px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '1.6',
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      desc: { margin: '4px 0 0', color: 'var(--dsw-alias-label-secondary)' },
      section: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      sectionTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.02em' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto', marginTop: '6px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      code: {
        display: 'block',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '8px 10px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
      },
      fix: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      fixHead: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' },
      tag: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    function tr(t, key, fallback) {
      let value
      try {
        value = t(key)
      } catch {
        value = undefined
      }
      return typeof value === 'string' && value !== '' && value !== key ? value : fallback
    }

    function statusOf(probe) {
      if (probe && probe.tls && probe.tls.ok) return 'ok'
      if (probe && probe.tcp && probe.tcp.ok) return 'warn'
      return 'fail'
    }

    function statusText(probe) {
      if (probe && probe.tls && probe.tls.ok) return `TLS ${probe.tls.ms}ms · HTTP ${probe.tls.status}`
      if (probe && probe.tcp && probe.tcp.ok) return `TCP ${probe.tcp.ms}ms · TLS ${probe.tls ? probe.tls.error : '未执行'}`
      return `TCP ${probe && probe.tcp ? probe.tcp.error : '未执行'}`
    }

    function CopyButton(props) {
      const [copied, setCopied] = useState(false)
      const onClick = useCallback(() => {
        const text = props.text
        const done = () => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
            return
          }
        } catch {
          /* fall through to the textarea path */
        }
        const area = document.createElement('textarea')
        area.value = text
        document.body.appendChild(area)
        area.select()
        try {
          document.execCommand('copy')
        } catch {
          /* nothing else to try */
        }
        document.body.removeChild(area)
        done()
      }, [props.text])
      return h('button', { type: 'button', style: styles.button, onClick }, copied ? props.copiedLabel : props.label)
    }

    function codeBlock(label, lines, t) {
      const text = lines.join('\n')
      return h('div', { key: label, style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
        h('div', { key: 'head', style: { ...styles.row, justifyContent: 'space-between' } }, [
          h('span', { key: 'label', style: styles.muted }, label),
          h(CopyButton, { key: 'copy', text, label: tr(t, 'copy', '复制'), copiedLabel: tr(t, 'copied', '已复制') }),
        ]),
        h('code', { key: 'code', style: styles.code }, text),
      ])
    }

    function FixCard(props) {
      const fix = props.fix
      const t = props.t
      const onDone = props.onDone
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)

      const call = useCallback((action) => {
        setBusy(true)
        setResult(null)
        fetch(`${ROUTE}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fixId: fix.id, ...(fix.payload || {}) }),
        }).then(async (response) => {
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
          setResult({ ok: true, text: data.message })
          if (typeof onDone === 'function') onDone()
        }).catch((error) => {
          setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
        }).finally(() => {
          setBusy(false)
        })
      }, [fix.id, fix.payload, onDone])

      let action = null
      if (fix.applicable !== false) {
        action = fix.applied
          ? h('button', { key: 'revert', type: 'button', style: styles.button, disabled: busy, onClick: () => call('revert') }, tr(t, 'revert', '撤销'))
          : h('button', { key: 'apply', type: 'button', style: styles.button, disabled: busy, onClick: () => call('apply') }, busy ? tr(t, 'working', '正在处理…') : tr(t, 'apply', '一键应用'))
      }

      return h('div', { style: styles.fix }, [
        h('div', { key: 'head', style: styles.fixHead }, [
          h('div', { key: 'left', style: styles.row }, [
            h('strong', { key: 'title', style: { fontSize: '13px' } }, fix.title),
            fix.applied ? h('span', { key: 'applied', style: { ...styles.tag, color: tone.ok, borderColor: tone.ok } }, tr(t, 'applied', '已应用')) : null,
            fix.elevated ? h('span', { key: 'admin', style: styles.tag }, tr(t, 'asAdmin', '需要管理员权限')) : null,
          ]),
          action,
        ]),
        result ? h('div', { key: 'result', style: { color: result.ok ? tone.ok : tone.fail, fontSize: '12px' } }, result.text) : null,
        h('div', { key: 'why', style: styles.muted }, fix.why),
        codeBlock(tr(t, 'fixes', '建议修复'), fix.commands, t),
        fix.verify && fix.verify.length > 0 ? codeBlock(tr(t, 'verify', '验证'), fix.verify, t) : null,
        fix.revert && fix.revert.length > 0 ? codeBlock(tr(t, 'revert', '撤销'), fix.revert, t) : null,
        fix.note ? h('div', { key: 'note', style: { ...styles.muted, ...styles.mono } }, `${tr(t, 'note', '注意')}：${fix.note}`) : null,
      ])
    }

    function Banner(props) {
      const recommendation = props.recommendation
      const t = props.t
      const onDone = props.onDone
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)

      const applyNow = useCallback(() => {
        setBusy(true)
        setResult(null)
        fetch(`${ROUTE}/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fixId: recommendation.fixId, ip: recommendation.ip, ips: recommendation.ips }),
        }).then(async (response) => {
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
          setResult({ ok: true, text: data.message })
          if (typeof onDone === 'function') onDone()
        }).catch((error) => {
          setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
        }).finally(() => {
          setBusy(false)
        })
      }, [recommendation.fixId, recommendation.ip, onDone])

      const accent = {
        'fix-now': tone.warn,
        'refresh-ip': tone.warn,
        settled: tone.ok,
        none: tone.ok,
        'use-proxy': tone.idle,
        'no-ip': tone.fail,
      }[recommendation.kind] || tone.idle

      // 一次点击即可：UAC 弹窗本身就是那次「用户同意」，不再叠一层确认。
      let action = null
      if (recommendation.fixId) {
        action = h('button', {
          key: 'apply',
          type: 'button',
          style: { ...styles.button, borderColor: accent, color: accent },
          disabled: busy,
          onClick: applyNow,
        }, busy ? tr(t, 'working', '正在处理…') : (recommendation.action || tr(t, 'apply', '一键应用')))
      }

      return h('div', { style: { ...styles.section, borderColor: accent } }, [
        h('div', { key: 'title', style: { ...styles.row, fontWeight: 600, color: accent } }, [
          h('span', { key: 'dot', style: { ...styles.dot, background: accent } }),
          h('span', { key: 'text' }, recommendation.title),
        ]),
        h('div', { key: 'detail', style: styles.muted }, recommendation.detail),
        recommendation.command
          ? h('div', { key: 'cmd', style: styles.row }, [
            h('code', { key: 'code', style: styles.code }, recommendation.command),
            h(CopyButton, { key: 'copy', text: recommendation.command, t }),
          ])
          : null,
        result ? h('div', { key: 'result', style: { color: result.ok ? tone.ok : tone.fail, fontSize: '12px' } }, result.text) : null,
        action ? h('div', { key: 'action' }, [action]) : null,
      ])
    }

    function Panel(props) {
      const t = props.t || (() => '')
      const [state, setState] = useState({ status: 'loading' })

      const load = useCallback((force) => {
        setState({ status: 'loading' })
        let cancelled = false
        const url = force ? `${ROUTE}?refresh=1` : ROUTE
        fetch(url, { cache: 'no-store' }).then((response) => {
          // 404 说明 Host 侧的插件行没起来（客户端 bundle 与 Host 行是分开加载的），
          // 直接报“HTTP 404”会让人以为网络有问题，这里把含义写清楚。
          if (response.status === 404) throw new Error(`Host 侧未注册 ${ROUTE}（插件行没有启动）`)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        }).then((report) => {
          if (!cancelled) setState({ status: 'ready', report })
        }).catch((error) => {
          if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        return () => { cancelled = true }
      }, [])

      useEffect(() => load(false), [load])

      // Hooks must run in the same order on every render: this stays above the
      // loading/error early returns, or the ready render runs one hook more
      // than the loading render and React throws.
      const refreshAfterApply = useCallback(() => { load(false) }, [load])

      const header = h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
        h('div', { key: 'row', style: styles.head }, [
          h('h2', { key: 'title', style: styles.title }, tr(t, 'title', 'GitHub 连接诊断')),
          h('button', { key: 'refresh', type: 'button', style: styles.button, onClick: () => load(true) }, tr(t, 'refresh', '重新检测')),
        ]),
        h('p', { key: 'desc', style: styles.desc }, tr(t, 'desc', '逐层探测 DNS / TCP / TLS，判定卡在哪一层，并给出可直接复制的修复命令。')),
      ])

      if (state.status === 'loading') {
        return h('div', { style: styles.root }, [header, h('div', { key: 'loading', style: styles.muted }, tr(t, 'loading', '正在探测…'))])
      }

      if (state.status === 'error') {
        return h('div', { style: styles.root }, [
          header,
          h('div', { key: 'error', style: styles.section }, [
            h('div', { key: 'msg', style: { color: tone.fail } }, `${tr(t, 'error', '检测失败')}：${state.message}`),
            h('div', { key: 'hint', style: styles.muted }, tr(t, 'errorHint', '可以在对话框输入 /github 走 Host 侧检测。')),
          ]),
        ])
      }

      const report = state.report
      const banner = report.recommendation
        ? h(Banner, { key: 'banner', recommendation: report.recommendation, t, onDone: refreshAfterApply })
        : null
      const verdictTone = report.diagnosis.severity === 'ok' ? tone.ok : report.diagnosis.severity === 'error' ? tone.fail : tone.warn

      const verdict = h('div', { key: 'verdict', style: { ...styles.section, borderColor: verdictTone } }, [
        h('div', { key: 'title', style: { ...styles.row, fontWeight: 600, color: verdictTone } }, [
          h('span', { key: 'dot', style: { ...styles.dot, background: verdictTone } }),
          h('span', { key: 'text' }, report.diagnosis.title),
        ]),
        h('div', { key: 'detail', style: styles.muted }, report.diagnosis.detail),
      ])

      const endpoints = h('div', { key: 'endpoints', style: styles.section }, [
        h('div', { key: 'title', style: styles.sectionTitle }, tr(t, 'endpoints', '端点探测')),
        ...report.endpoints.map((endpoint) => {
          const status = statusOf(endpoint)
          return h('div', { key: endpoint.id, style: { ...styles.row, alignItems: 'flex-start' } }, [
            h('span', { key: 'dot', style: { ...styles.dot, background: tone[status] } }),
            h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column' } }, [
              h('span', { key: 'host', style: styles.mono }, `${endpoint.host} → ${endpoint.ip || '解析失败'}`),
              h('span', { key: 'detail', style: { ...styles.muted, ...styles.mono } }, statusText(endpoint)),
            ]),
          ])
        }),
      ])

      const working = report.candidates.filter((entry) => entry.tls && entry.tls.ok)
      const candidates = report.candidates.length === 0 ? null : h('div', { key: 'candidates', style: styles.section }, [
        h('div', { key: 'title', style: styles.sectionTitle }, `${tr(t, 'candidates', '备用 IP')} · ${working.length}/${report.candidates.length}`),
        ...report.candidates.map((entry) => {
          const status = statusOf(entry)
          return h('div', { key: entry.ip, style: styles.row }, [
            h('span', { key: 'dot', style: { ...styles.dot, background: tone[status] } }),
            h('span', { key: 'ip', style: styles.mono }, entry.ip),
            h('span', { key: 'detail', style: { ...styles.muted, ...styles.mono } }, statusText(entry)),
          ])
        }),
      ])

      const proxyEnvText = Object.keys(report.proxyEnv || {}).length > 0 ? JSON.stringify(report.proxyEnv) : tr(t, 'none', '无')
      const env = h('div', { key: 'env', style: styles.section }, [
        h('div', { key: 'title', style: styles.sectionTitle }, tr(t, 'env', '本机环境')),
        h('div', { key: 'git', style: styles.row }, [
          h('span', { key: 'k', style: styles.muted }, tr(t, 'gitProxy', 'git 代理')),
          h('span', { key: 'v', style: styles.mono }, report.git.proxy || tr(t, 'notSet', '未配置')),
        ]),
        h('div', { key: 'penv', style: styles.row }, [
          h('span', { key: 'k', style: styles.muted }, tr(t, 'proxyEnv', '代理环境变量')),
          h('span', { key: 'v', style: styles.mono }, proxyEnvText),
        ]),
        h('div', { key: 'ports', style: styles.row }, [
          h('span', { key: 'k', style: styles.muted }, tr(t, 'proxyPorts', '本机代理端口')),
          h('span', { key: 'v', style: styles.mono }, report.proxies.length > 0 ? report.proxies.join(', ') : tr(t, 'none', '无')),
        ]),
        h('div', { key: 'ssh', style: styles.row }, [
          h('span', { key: 'k', style: styles.muted }, tr(t, 'ssh443', 'SSH 走 443')),
          h('span', { key: 'v', style: styles.mono }, report.ssh.over443 ? tr(t, 'yes', '已配置') : tr(t, 'no', '未配置')),
        ]),
        h('div', { key: 'stamp', style: { ...styles.muted, ...styles.mono } }, report.generatedAt),
      ])

      const fixes = h('div', { key: 'fixes', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('div', { key: 'title', style: styles.sectionTitle }, tr(t, 'fixes', '建议修复')),
        ...report.fixes.map((fix) => h(FixCard, { key: fix.id, fix, t, onDone: refreshAfterApply })),
      ])

      const limits = h('div', { key: 'limits', style: { ...styles.muted, fontSize: '12px' } },
        (report.limits || []).join(' '))

      return h('div', { style: styles.root }, [header, banner, verdict, endpoints, candidates, env, fixes, limits])
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'github-connectivity-doctor: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: 'github-connectivity',
          order: 35,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, Panel)
      })
    }

    return { apply, inject: ['slots', 'locale'], name: 'dsh-github-connectivity' }
  },
})
