/**
 * Browser half of `keylessmodels2dsh` for DSH Desktop (`v0.12.1+`) and `dsh web`.
 *
 * Contributes the "Keyless Free Models" page to `settings.section`.
 * Zero external runtime dependencies: consumes `react` from `window.__ModuleLoader__`
 * and styles exclusively with `--dsw-alias-*` theme tokens for native Dark/Light fidelity.
 *
 * Includes full German (`de`), English (`en`), and Chinese (`zh`) UI copy with automatic
 * browser/OS language detection plus a 1-click language switch inside the panel.
 *
 * Every boundary (`locale`, `slots.inject`, `slots.register`, HTTP fetch) is wrapped in
 * `guard()` so a host seam change can never crash the renderer or trigger Safe Mode.
 */

window.__ModuleLoader__.load({
  id: 'keylessmodels2dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'settings.keylessmodels2dsh'
    const API_BASE = '/api/keylessmodels2dsh'
    const STYLE_ATTR = 'keylessmodels2dsh-styles'

    const COPY = {
      de: {
        nav: 'Keyless Free Models',
        subtitle:
          'Alle verifizierten kostenlosen KI-Modelle ohne API-Key oder Registrierung — inkl. Kilo Gateway, OVHcloud EU, Vireonix, ch.at, LLM7, Rewind AI, Free.ai, VLM Run, BlockRun, Pollinations, ChatJimmy & lokalen Servern.',
        tabOverview: 'Übersicht & Smart-Router',
        tabProviders: 'Provider & Modelle',
        tabCustom: 'Eigener Endpunkt & Proxy',
        tabSettings: 'Einstellungen & Audit',
        statProviders: 'Aktive Provider',
        statModels: 'Verfügbare Gratis-Modelle',
        statRequests: 'Anfragen (OK / Failover)',
        statTokens: 'Tokens (In / Out)',
        btnRefresh: 'Kataloge aktualisieren',
        btnSyncShelf: 'Stillworks Live-Feed laden',
        btnScanLocal: 'Lokale Server scannen',
        btnResetCooldowns: 'Cooldowns zurücksetzen',
        working: 'Wird ausgeführt…',
        virtualTitle: 'Intelligente Auto-Router (empfohlen im Modellwähler unter „Keyless Free Models“)',
        searchPlaceholder: 'Provider oder Modell suchen (z. B. kilo, qwen, vision, coder)…',
        probeBtn: 'Ping-Test',
        probing: 'Teste…',
        hideBtn: 'Ausblenden',
        showBtn: 'Einblenden',
        customTitle: 'Eigenen Keyless-Endpunkt hinzufügen (OpenAI / Ollama kompatibel)',
        customName: 'Anzeigename',
        customId: 'Kurz-ID (z. B. mein-vllm)',
        customUrl: 'Base-URL (z. B. http://127.0.0.1:8000/v1)',
        customModels: 'Statische Modelle (kommagetrennt, optional wenn /models existiert)',
        customAdd: 'Endpunkt speichern',
        customDelete: 'Entfernen',
        proxyTitle: 'Lokaler OpenAI-Proxy für externe Windows-Tools (VS Code, Cursor, Cline, Aider)',
        proxyDesc:
          'Bindet ausschließlich auf 127.0.0.1, damit andere Tools denselben Keyless-Pool und das automatische Failover mitnutzen können.',
        proxyEnable: 'Lokalen OpenAI-Proxy aktivieren',
        proxyPort: 'Lokaler Port',
        proxyKey: 'Lokaler Schutz-Key',
        settingsTitle: 'Routing- & Schutz-Einstellungen',
        optEnabled: 'Plugin-Modellrouten aktivieren',
        optPerProvider: 'Zusätzlich einzelne Provider-Gruppen (keyless-kilo, keyless-ovh, …) im Modellwähler anzeigen',
        optAutoDiscover: 'Modellkataloge automatisch beim Start aktualisieren (/models ohne Token-Verbrauch)',
        optSticky: 'Session-Stickiness für Auto-Router (bleibt beim zuletzt erfolgreichen Modell)',
        optConcreteFallback: 'Auch bei konkreter Modellwahl (z. B. kilo/...) bei HTTP 429/503 automatisch auf Ersatzmodell ausweichen',
        optStillworks: 'Beim Start Stillworks Live-Keyless-Feed synchronisieren',
        optMaxAttempts: 'Maximale Failover-Versuche pro Anfrage',
        optCooldown429: 'Standard-Cooldown nach HTTP 429 (Sekunden)',
        optMaxTokens: 'Standard-Max-Output-Tokens',
        recentTitle: 'Letzte Anfragen & Failover-Protokoll',
        auditTitle: 'Geprüfte & ausgeschlossene Schein-Keyless-Dienste (Stand Okt. 2026)',
        noTurns: 'Noch keine Anfragen in dieser Sitzung protokolliert.',
        loadError: 'Host-API nicht erreichbar. Bitte prüfen Sie, ob der Harness-Prozess läuft.',
      },
      en: {
        nav: 'Keyless Free Models',
        subtitle:
          'All verified zero-key free AI models without API keys or sign-up — unifying Kilo Gateway, OVHcloud EU, Vireonix, ch.at, LLM7, Rewind AI, Free.ai, VLM Run, BlockRun, Pollinations, ChatJimmy & local servers.',
        tabOverview: 'Overview & Smart Router',
        tabProviders: 'Providers & Models',
        tabCustom: 'Custom Endpoint & Proxy',
        tabSettings: 'Settings & Audit',
        statProviders: 'Active Providers',
        statModels: 'Available Free Models',
        statRequests: 'Requests (OK / Failovers)',
        statTokens: 'Tokens (In / Out)',
        btnRefresh: 'Refresh Catalogs',
        btnSyncShelf: 'Sync Stillworks Live Feed',
        btnScanLocal: 'Scan Local Servers',
        btnResetCooldowns: 'Reset Cooldowns',
        working: 'Running…',
        virtualTitle: 'Smart Auto-Routers (select under "Keyless Free Models" in the Model Picker)',
        searchPlaceholder: 'Filter providers or models (e.g. kilo, qwen, vision, coder)…',
        probeBtn: 'Ping Probe',
        probing: 'Probing…',
        hideBtn: 'Hide',
        showBtn: 'Show',
        customTitle: 'Add Custom Keyless Endpoint (OpenAI / Ollama compatible)',
        customName: 'Display Name',
        customId: 'Short ID (e.g. my-vllm)',
        customUrl: 'Base URL (e.g. http://127.0.0.1:8000/v1)',
        customModels: 'Static Models (comma-separated, optional if /models exists)',
        customAdd: 'Save Endpoint',
        customDelete: 'Remove',
        proxyTitle: 'Local OpenAI Proxy for External Tools (VS Code, Cursor, Cline, Aider)',
        proxyDesc:
          'Binds strictly to 127.0.0.1 so external apps can share the exact same keyless pool and automatic failover.',
        proxyEnable: 'Enable local OpenAI proxy',
        proxyPort: 'Local Port',
        proxyKey: 'Local Guard Key',
        settingsTitle: 'Routing & Resilience Preferences',
        optEnabled: 'Enable plugin model routes',
        optPerProvider: 'Also expose individual provider groups (keyless-kilo, keyless-ovh, …) in Model Picker',
        optAutoDiscover: 'Automatically refresh /models catalogs on startup (zero quota cost)',
        optSticky: 'Session stickiness for Auto-Routers (reuse last healthy model)',
        optConcreteFallback: 'Auto-failover to backup provider on HTTP 429/503 even when a concrete model was selected',
        optStillworks: 'Sync Stillworks live keyless feed on startup',
        optMaxAttempts: 'Max failover attempts per turn',
        optCooldown429: 'Default HTTP 429 cooldown (seconds)',
        optMaxTokens: 'Default max output tokens',
        recentTitle: 'Recent Turns & Failover Trace',
        auditTitle: 'Audited & Excluded Non-Working Claims (Oct 2026)',
        noTurns: 'No turns recorded yet.',
        loadError: 'Could not reach Host API. Make sure the Harness backend is running.',
      },
      zh: {
        nav: 'Keyless 免费模型池',
        subtitle:
          '聚合全部经实测免 API Key 免费模型（Kilo Gateway、OVHcloud、Vireonix、ch.at、LLM7、Rewind AI、Free.ai、VLM Run、BlockRun、Pollinations、ChatJimmy 及本地免密服务），内置智能路由与跨渠道故障转移。',
        tabOverview: '总览与智能路由',
        tabProviders: '渠道与模型清单',
        tabCustom: '自定义端点与本地代理',
        tabSettings: '路由设置与审计清单',
        statProviders: '已启用渠道',
        statModels: '可用免费模型',
        statRequests: '请求数（成功 / 故障转移）',
        statTokens: 'Token 统计（输入 / 输出）',
        btnRefresh: '刷新模型目录',
        btnSyncShelf: '同步 Stillworks 实时源',
        btnScanLocal: '扫描本地零配置服务',
        btnResetCooldowns: '清除全部冷却状态',
        working: '执行中…',
        virtualTitle: '智能虚拟路由模型（在模型选择器的 Keyless Free Models 分组中选用）',
        searchPlaceholder: '搜索渠道或模型（例如 kilo、qwen、vision、coder）…',
        probeBtn: '轻量探测',
        probing: '探测中…',
        hideBtn: '隐藏',
        showBtn: '显示',
        customTitle: '添加自定义免密钥端点（兼容 OpenAI / Ollama）',
        customName: '显示名称',
        customId: '简短 ID（如 my-vllm）',
        customUrl: 'Base URL（如 http://127.0.0.1:8000/v1）',
        customModels: '静态模型列表（逗号分隔，若支持 /models 可留空）',
        customAdd: '保存端点',
        customDelete: '删除',
        proxyTitle: '本地 OpenAI 兼容转发端口（供 VS Code / Cursor / Cline 共享）',
        proxyDesc: '仅监听 127.0.0.1 回环地址，让本机其它开发工具共享同一免费模型池与自动降级。',
        proxyEnable: '启用本地 OpenAI 转发端口',
        proxyPort: '监听端口',
        proxyKey: '本地访问密钥',
        settingsTitle: '路由与容错策略',
        optEnabled: '启用本插件模型路由',
        optPerProvider: '同时在模型选择器中按渠道单独分组展示（keyless-kilo、keyless-ovh 等）',
        optAutoDiscover: '启动时自动拉取各渠道 /models 清单（不消耗对话配额）',
        optSticky: 'Auto 智能路由会话粘滞（优先复用上次成功的模型）',
        optConcreteFallback: '指定单模型遇到 429/503 时也允许跨渠道自动兜底',
        optStillworks: '启动时自动同步 Stillworks 实时免密源',
        optMaxAttempts: '单次对话最大故障转移次数',
        optCooldown429: 'HTTP 429 默认冷却秒数',
        optMaxTokens: '默认最大输出 Token 数',
        recentTitle: '最近请求与故障转移记录',
        auditTitle: '已审计并排除的失效/需鉴权接口（2026-10 实测）',
        noTurns: '暂无请求记录。',
        loadError: '无法连接插件后端接口，请确认 Harness 正在运行。',
      },
    }

    const CSS_TEXT = `
      .km2dsh-root { box-sizing: border-box; max-width: 960px; display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary, #e2e8f0); font-size: 13.5px; line-height: 1.5; padding-bottom: 32px; }
      .km2dsh-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .km2dsh-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.35; }
      .km2dsh-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 13px; max-width: 760px; }
      .km2dsh-langbar { display: inline-flex; gap: 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25)); border-radius: 10px; padding: 3px; background: var(--dsw-alias-bg-layer-2, rgba(30,41,59,.4)); }
      .km2dsh-langbtn { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #94a3b8); padding: 3px 9px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; }
      .km2dsh-langbtn.active { background: var(--dsw-alias-button-primary-fill, #38bdf8); color: var(--dsw-alias-label-primary-foreground, #0f172a); }
      .km2dsh-tabs { display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); padding-bottom: 10px; }
      .km2dsh-tab { border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.24)); background: transparent; color: var(--dsw-alias-label-secondary, #94a3b8); border-radius: 16px; padding: 6px 14px; font-size: 13px; font-weight: 500; cursor: pointer; }
      .km2dsh-tab.active { background: var(--dsw-alias-button-primary-fill, #38bdf8); color: var(--dsw-alias-label-primary-foreground, #0f172a); border-color: transparent; }
      .km2dsh-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(195px, 1fr)); gap: 12px; }
      .km2dsh-card { border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.22)); background: var(--dsw-alias-bg-module-platform, rgba(15,23,42,.35)); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
      .km2dsh-stat-label { font-size: 12px; color: var(--dsw-alias-label-tertiary, #94a3b8); }
      .km2dsh-stat-val { font-size: 22px; font-weight: 700; }
      .km2dsh-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .km2dsh-btn { height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid var(--dsw-alias-border-l3, rgba(148,163,184,.35)); background: transparent; color: var(--dsw-alias-label-primary, #e2e8f0); font-size: 13px; font-weight: 500; cursor: pointer; }
      .km2dsh-btn.primary { background: var(--dsw-alias-button-primary-fill, #38bdf8); color: var(--dsw-alias-label-primary-foreground, #0f172a); border-color: transparent; }
      .km2dsh-btn.sm { height: 26px; padding: 0 10px; font-size: 12px; border-radius: 13px; }
      .km2dsh-btn:disabled { opacity: 0.5; cursor: default; }
      .km2dsh-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.28)); color: var(--dsw-alias-label-secondary, #cbd5e1); }
      .km2dsh-badge.ok { color: #34d399; border-color: rgba(52,211,153,.4); }
      .km2dsh-badge.warn { color: #fbbf24; border-color: rgba(251,191,36,.4); }
      .km2dsh-badge.err { color: #f87171; border-color: rgba(248,113,113,.4); }
      .km2dsh-input { box-sizing: border-box; height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l3, rgba(148,163,184,.35)); background: var(--dsw-alias-bg-layer-1, rgba(15,23,42,.5)); color: var(--dsw-alias-label-primary, #f8fafc); font-size: 13px; width: 100%; }
      .km2dsh-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
      .km2dsh-model-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1, rgba(15,23,42,.28)); border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.14)); flex-wrap: wrap; }
      .km2dsh-notice { padding: 10px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(56,189,248,.35)); font-size: 12.5px; color: var(--dsw-alias-label-secondary, #cbd5e1); }
      .km2dsh-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    `

    function guard(label, fn) {
      try {
        return fn()
      } catch (err) {
        console.error(`[keylessmodels2dsh] client guard caught error in ${label}:`, err)
        return undefined
      }
    }

    function detectInitialLanguage() {
      try {
        const saved = globalThis.localStorage?.getItem('keylessmodels2dsh.lang')
        if (saved && COPY[saved]) return saved
        const nav = String(globalThis.navigator?.language || 'de').toLowerCase()
        if (nav.startsWith('de')) return 'de'
        if (nav.startsWith('zh')) return 'zh'
        return 'en'
      } catch {
        return 'de'
      }
    }

    function mountStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      let el = document.querySelector(`style[data-plugin-css="${STYLE_ATTR}"]`)
      if (!el) {
        el = document.createElement('style')
        el.dataset.pluginCss = STYLE_ATTR
        el.textContent = CSS_TEXT
        document.head.appendChild(el)
      }
      return () => {
        try {
          el?.remove()
        } catch {}
      }
    }

    async function callApi(path, method = 'GET', body) {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      return json
    }

    function KeylessSettingsPage() {
      const [lang, setLang] = useState(detectInitialLanguage)
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [banner, setBanner] = useState('')
      const [filter, setFilter] = useState('')
      const [expandedProviders, setExpandedProviders] = useState({ kilo: true, ovh: true, vireonix: true })
      const [probeState, setProbeState] = useState({})
      const [customDraft, setCustomDraft] = useState({
        id: '',
        name: '',
        baseUrl: '',
        wire: 'openai',
        staticModels: '',
      })

      const c = COPY[lang] || COPY.de

      const switchLang = (next) => {
        setLang(next)
        try {
          globalThis.localStorage?.setItem('keylessmodels2dsh.lang', next)
        } catch {}
      }

      const loadState = useCallback(async () => {
        try {
          const snap = await callApi('/state', 'GET')
          setData(snap)
          setBanner('')
        } catch (err) {
          setBanner(`${c.loadError} (${err instanceof Error ? err.message : String(err)})`)
        }
      }, [c.loadError])

      useEffect(() => {
        void loadState()
      }, [loadState])

      const runAction = async (label, path, payload = {}) => {
        setBusy(label)
        setBanner('')
        try {
          const res = await callApi(path, 'POST', payload)
          if (res?.state) setData(res.state)
          else await loadState()
          if (label === 'shelf' && res?.ok) {
            setBanner(`Stillworks Live-Feed synchronisiert (${res.totalRows ?? 0} Einträge geprüft).`)
          } else if (label === 'local' && Array.isArray(res?.detected)) {
            const onCount = res.detected.filter((d) => d.online).length
            setBanner(`Lokaler Scan abgeschlossen: ${onCount} lokale Zero-Key-Server aktiv.`)
          }
        } catch (err) {
          setBanner(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy('')
        }
      }

      const updateSetting = (patch) => runAction('settings', '/settings', patch)

      const runProbe = async (compositeId) => {
        setProbeState((prev) => ({ ...prev, [compositeId]: { loading: true } }))
        try {
          const res = await callApi('/probe', 'POST', { compositeId })
          if (res?.state) setData(res.state)
          setProbeState((prev) => ({
            ...prev,
            [compositeId]: res.ok
              ? { ok: true, msg: `OK · ${res.ttftMs}ms` }
              : { ok: false, msg: res.error || 'Failed' },
          }))
        } catch (err) {
          setProbeState((prev) => ({
            ...prev,
            [compositeId]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
          }))
        }
      }

      const providers = data?.providers ?? []
      const activeProviderCount = providers.filter((p) => p.enabled).length
      const availableModelCount = providers
        .filter((p) => p.enabled)
        .reduce((acc, p) => acc + (p.models?.filter((m) => !m.hidden).length || 0), 0)
      const stats = data?.stats ?? {}
      const settings = data?.settings ?? {}

      const q = filter.trim().toLowerCase()
      const filteredProviders = providers.filter((p) => {
        if (!q) return true
        if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) return true
        return (p.models ?? []).some(
          (m) => m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
        )
      })

      return h(
        'div',
        { className: 'km2dsh-root' },
        // Header + Language Switch
        h(
          'div',
          { className: 'km2dsh-header' },
          h(
            'div',
            null,
            h('h2', { className: 'km2dsh-title' }, `${c.nav} ${data?.version ? `v${data.version}` : ''}`),
            h('p', { className: 'km2dsh-sub' }, c.subtitle),
          ),
          h(
            'div',
            { className: 'km2dsh-langbar' },
            ['de', 'en', 'zh'].map((code) =>
              h(
                'button',
                {
                  key: code,
                  type: 'button',
                  className: `km2dsh-langbtn ${lang === code ? 'active' : ''}`,
                  onClick: () => switchLang(code),
                },
                code.toUpperCase(),
              ),
            ),
          ),
        ),

        banner ? h('div', { className: 'km2dsh-notice' }, banner) : null,

        // Tabs
        h(
          'div',
          { className: 'km2dsh-tabs' },
          [
            ['overview', c.tabOverview],
            ['providers', `${c.tabProviders} (${availableModelCount})`],
            ['custom', c.tabCustom],
            ['settings', c.tabSettings],
          ].map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                className: `km2dsh-tab ${tab === id ? 'active' : ''}`,
                onClick: () => setTab(id),
              },
              label,
            ),
          ),
        ),

        // TAB 1: OVERVIEW
        tab === 'overview'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
              h(
                'div',
                { className: 'km2dsh-grid' },
                h(
                  'div',
                  { className: 'km2dsh-card' },
                  h('span', { className: 'km2dsh-stat-label' }, c.statProviders),
                  h('span', { className: 'km2dsh-stat-val' }, `${activeProviderCount} / ${providers.length}`),
                ),
                h(
                  'div',
                  { className: 'km2dsh-card' },
                  h('span', { className: 'km2dsh-stat-label' }, c.statModels),
                  h('span', { className: 'km2dsh-stat-val' }, String(availableModelCount)),
                ),
                h(
                  'div',
                  { className: 'km2dsh-card' },
                  h('span', { className: 'km2dsh-stat-label' }, c.statRequests),
                  h(
                    'span',
                    { className: 'km2dsh-stat-val' },
                    `${stats.successfulRequests ?? 0} / ${stats.failovers ?? 0}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'km2dsh-card' },
                  h('span', { className: 'km2dsh-stat-label' }, c.statTokens),
                  h(
                    'span',
                    { className: 'km2dsh-stat-val' },
                    `${stats.inputTokens ?? 0} / ${stats.outputTokens ?? 0}`,
                  ),
                ),
              ),
              h(
                'div',
                { className: 'km2dsh-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'km2dsh-btn primary',
                    disabled: Boolean(busy),
                    onClick: () => void runAction('refresh', '/refresh'),
                  },
                  busy === 'refresh' ? c.working : c.btnRefresh,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'km2dsh-btn',
                    disabled: Boolean(busy),
                    onClick: () => void runAction('shelf', '/sync-shelf'),
                  },
                  busy === 'shelf' ? c.working : c.btnSyncShelf,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'km2dsh-btn',
                    disabled: Boolean(busy),
                    onClick: () => void runAction('local', '/scan-local'),
                  },
                  busy === 'local' ? c.working : c.btnScanLocal,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'km2dsh-btn',
                    disabled: Boolean(busy),
                    onClick: () => void runAction('cooldown', '/reset-cooldowns'),
                  },
                  c.btnResetCooldowns,
                ),
              ),
              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.virtualTitle),
                ...(data?.virtualModels ?? []).map((vm) =>
                  h(
                    'div',
                    { key: vm.id, className: 'km2dsh-model-row' },
                    h(
                      'div',
                      null,
                      h('strong', null, vm.name),
                      h('span', { className: 'km2dsh-mono', style: { marginLeft: '8px', opacity: 0.75 } }, `keyless-free / ${vm.id}`),
                      h('div', { style: { fontSize: '12px', opacity: 0.82 } }, vm.description),
                    ),
                    h(
                      'div',
                      { className: 'km2dsh-actions' },
                      vm.tools ? h('span', { className: 'km2dsh-badge ok' }, 'Tools') : null,
                      vm.vision ? h('span', { className: 'km2dsh-badge ok' }, 'Vision') : null,
                      vm.reasoning ? h('span', { className: 'km2dsh-badge' }, 'Reasoning') : null,
                    ),
                  ),
                ),
              ),
            )
          : null,

        // TAB 2: PROVIDERS & MODELS
        tab === 'providers'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('input', {
                type: 'search',
                className: 'km2dsh-input',
                placeholder: c.searchPlaceholder,
                value: filter,
                onChange: (e) => setFilter(e.target.value),
              }),
              ...filteredProviders.map((p) => {
                const open = Boolean(expandedProviders[p.id] || q.length > 0)
                const models = (p.models ?? []).filter(
                  (m) =>
                    !q ||
                    p.name.toLowerCase().includes(q) ||
                    m.modelId.toLowerCase().includes(q) ||
                    m.name.toLowerCase().includes(q),
                )
                return h(
                  'div',
                  { key: p.id, className: 'km2dsh-card' },
                  h(
                    'div',
                    { className: 'km2dsh-row' },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(p.enabled),
                        onChange: (e) =>
                          void updateSetting({ providerToggle: { id: p.id, enabled: e.target.checked } }),
                      }),
                      h('strong', null, p.name),
                      h('span', { className: 'km2dsh-badge' }, p.category),
                      h('span', { className: 'km2dsh-badge' }, `${models.length} Modelle`),
                      p.cooldownCount > 0
                        ? h('span', { className: 'km2dsh-badge warn' }, `${p.cooldownCount} Cooldown`)
                        : null,
                    ),
                    h(
                      'div',
                      { className: 'km2dsh-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'km2dsh-btn sm',
                          onClick: () =>
                            setExpandedProviders((prev) => ({ ...prev, [p.id]: !open })),
                        },
                        open ? '▲ Einklappen' : '▼ Modelle zeigen',
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: { fontSize: '12px', opacity: 0.8 } },
                    `${p.rateLimitNote} · `,
                    h('span', { className: 'km2dsh-mono' }, p.baseUrl),
                  ),
                  p.privacyNote
                    ? h('div', { style: { fontSize: '11.5px', opacity: 0.68 } }, p.privacyNote)
                    : null,
                  open
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' } },
                        ...models.map((m) => {
                          const ps = probeState[m.compositeId]
                          return h(
                            'div',
                            { key: m.compositeId, className: 'km2dsh-model-row' },
                            h(
                              'div',
                              null,
                              h(
                                'span',
                                {
                                  className: 'km2dsh-mono',
                                  style: {
                                    fontWeight: 600,
                                    textDecoration: m.hidden ? 'line-through' : 'none',
                                    opacity: m.hidden ? 0.5 : 1,
                                  },
                                },
                                m.compositeId,
                              ),
                              h(
                                'span',
                                { style: { marginLeft: '8px', fontSize: '12px', opacity: 0.75 } },
                                `${Math.round((m.contextWindow || 0) / 1024)}K ctx`,
                              ),
                              m.tools ? h('span', { className: 'km2dsh-badge ok', style: { marginLeft: '6px' } }, 'Tools') : null,
                              m.vision ? h('span', { className: 'km2dsh-badge ok', style: { marginLeft: '6px' } }, 'Vision') : null,
                              m.reasoning ? h('span', { className: 'km2dsh-badge', style: { marginLeft: '6px' } }, 'Reasoning') : null,
                              m.health?.coolingDown
                                ? h(
                                    'span',
                                    { className: 'km2dsh-badge warn', style: { marginLeft: '6px' } },
                                    `Cooldown ${Math.ceil(m.health.cooldownRemainingMs / 1000)}s`,
                                  )
                                : m.health?.ttftMs
                                  ? h(
                                      'span',
                                      { className: 'km2dsh-badge ok', style: { marginLeft: '6px' } },
                                      `${m.health.ttftMs}ms`,
                                    )
                                  : null,
                              ps && !ps.loading
                                ? h(
                                    'span',
                                    {
                                      className: `km2dsh-badge ${ps.ok ? 'ok' : 'err'}`,
                                      style: { marginLeft: '6px' },
                                    },
                                    ps.msg,
                                  )
                                : null,
                            ),
                            h(
                              'div',
                              { className: 'km2dsh-actions' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'km2dsh-btn sm',
                                  disabled: Boolean(ps?.loading),
                                  onClick: () => void runProbe(m.compositeId),
                                },
                                ps?.loading ? c.probing : c.probeBtn,
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'km2dsh-btn sm',
                                  onClick: () =>
                                    void updateSetting({
                                      modelVisibility: { compositeId: m.compositeId, hidden: !m.hidden },
                                    }),
                                },
                                m.hidden ? c.showBtn : c.hideBtn,
                              ),
                            ),
                          )
                        }),
                      )
                    : null,
                )
              }),
            )
          : null,

        // TAB 3: CUSTOM ENDPOINT & LOCAL PROXY
        tab === 'custom'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.customTitle),
                h(
                  'div',
                  { className: 'km2dsh-grid' },
                  h('input', {
                    className: 'km2dsh-input',
                    placeholder: c.customId,
                    value: customDraft.id,
                    onChange: (e) => setCustomDraft({ ...customDraft, id: e.target.value }),
                  }),
                  h('input', {
                    className: 'km2dsh-input',
                    placeholder: c.customName,
                    value: customDraft.name,
                    onChange: (e) => setCustomDraft({ ...customDraft, name: e.target.value }),
                  }),
                  h('input', {
                    className: 'km2dsh-input',
                    placeholder: c.customUrl,
                    value: customDraft.baseUrl,
                    onChange: (e) => setCustomDraft({ ...customDraft, baseUrl: e.target.value }),
                  }),
                  h(
                    'select',
                    {
                      className: 'km2dsh-input',
                      value: customDraft.wire,
                      onChange: (e) => setCustomDraft({ ...customDraft, wire: e.target.value }),
                    },
                    h('option', { value: 'openai' }, 'OpenAI (/chat/completions)'),
                    h('option', { value: 'ollama' }, 'Ollama (/api/generate)'),
                  ),
                ),
                h('input', {
                  className: 'km2dsh-input',
                  placeholder: c.customModels,
                  value: customDraft.staticModels,
                  onChange: (e) => setCustomDraft({ ...customDraft, staticModels: e.target.value }),
                }),
                h(
                  'div',
                  { className: 'km2dsh-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'km2dsh-btn primary',
                      onClick: () => {
                        const staticModels = customDraft.staticModels
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                        void runAction('custom', '/custom-provider', {
                          provider: { ...customDraft, staticModels },
                        })
                        setCustomDraft({ id: '', name: '', baseUrl: '', wire: 'openai', staticModels: '' })
                      },
                    },
                    c.customAdd,
                  ),
                ),
                ...(settings.customProviders ?? []).map((cp) =>
                  h(
                    'div',
                    { key: cp.id, className: 'km2dsh-model-row' },
                    h(
                      'span',
                      null,
                      h('strong', null, cp.name),
                      ` (${cp.id}) · `,
                      h('span', { className: 'km2dsh-mono' }, cp.baseUrl),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'km2dsh-btn sm',
                        onClick: () =>
                          void runAction('custom-del', '/custom-provider', { action: 'delete', id: cp.id }),
                      },
                      c.customDelete,
                    ),
                  ),
                ),
              ),

              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.proxyTitle),
                h('div', { style: { fontSize: '12.5px', opacity: 0.82 } }, c.proxyDesc),
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(settings.localProxyEnabled),
                    onChange: (e) => void updateSetting({ localProxyEnabled: e.target.checked }),
                  }),
                  c.proxyEnable,
                ),
                h(
                  'div',
                  { className: 'km2dsh-grid' },
                  h(
                    'div',
                    null,
                    h('div', { className: 'km2dsh-stat-label' }, c.proxyPort),
                    h('input', {
                      type: 'number',
                      className: 'km2dsh-input',
                      value: settings.localProxyPort ?? 18788,
                      onChange: (e) => void updateSetting({ localProxyPort: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'km2dsh-stat-label' }, c.proxyKey),
                    h('input', {
                      type: 'text',
                      className: 'km2dsh-input km2dsh-mono',
                      value: settings.localProxyKey ?? 'sk-keyless-dsh-local',
                      onChange: (e) => void updateSetting({ localProxyKey: e.target.value }),
                    }),
                  ),
                ),
                data?.proxy?.running
                  ? h(
                      'div',
                      { className: 'km2dsh-notice km2dsh-mono' },
                      `Aktiv: ${data.proxy.baseUrl}  (Modelle: auto, auto-coding, kilo/kilo-auto/free, …)`,
                    )
                  : data?.proxy?.error
                    ? h('div', { className: 'km2dsh-notice' }, `Proxy-Fehler: ${data.proxy.error}`)
                    : null,
              ),
            )
          : null,

        // TAB 4: SETTINGS & AUDIT
        tab === 'settings'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.settingsTitle),
                ...[
                  ['enabled', c.optEnabled],
                  ['exposePerProviderRoutes', c.optPerProvider],
                  ['autoDiscoverModels', c.optAutoDiscover],
                  ['stickyAutoRouting', c.optSticky],
                  ['fallbackOnConcreteModel429', c.optConcreteFallback],
                  ['syncStillworksShelf', c.optStillworks],
                ].map(([field, label]) =>
                  h(
                    'label',
                    { key: field, style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(settings[field]),
                      onChange: (e) => void updateSetting({ [field]: e.target.checked }),
                    }),
                    label,
                  ),
                ),
                h(
                  'div',
                  { className: 'km2dsh-grid', style: { marginTop: '8px' } },
                  h(
                    'div',
                    null,
                    h('div', { className: 'km2dsh-stat-label' }, c.optMaxAttempts),
                    h('input', {
                      type: 'number',
                      className: 'km2dsh-input',
                      value: settings.maxFailoverAttempts ?? 5,
                      onChange: (e) => void updateSetting({ maxFailoverAttempts: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'km2dsh-stat-label' }, c.optCooldown429),
                    h('input', {
                      type: 'number',
                      className: 'km2dsh-input',
                      value: settings.cooldown429Seconds ?? 180,
                      onChange: (e) => void updateSetting({ cooldown429Seconds: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'km2dsh-stat-label' }, c.optMaxTokens),
                    h('input', {
                      type: 'number',
                      className: 'km2dsh-input',
                      value: settings.defaultMaxTokens ?? 8192,
                      onChange: (e) => void updateSetting({ defaultMaxTokens: Number(e.target.value) }),
                    }),
                  ),
                ),
                data?.dshHome
                  ? h(
                      'div',
                      { className: 'km2dsh-mono', style: { opacity: 0.7, marginTop: '4px' } },
                      `DSH_HOME: ${data.dshHome} (${data.platform})`,
                    )
                  : null,
              ),

              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.recentTitle),
                (stats.recentTurns ?? []).length === 0
                  ? h('div', { style: { opacity: 0.7 } }, c.noTurns)
                  : (stats.recentTurns ?? []).slice(0, 12).map((turn, idx) =>
                      h(
                        'div',
                        { key: `${turn.at}-${idx}`, className: 'km2dsh-model-row' },
                        h(
                          'span',
                          { className: 'km2dsh-mono' },
                          `${turn.ok ? '✓' : '✗'} ${turn.requestedModel} → ${turn.resolvedModel}`,
                        ),
                        h(
                          'span',
                          { style: { fontSize: '12px', opacity: 0.8 } },
                          turn.ok
                            ? `${turn.latencyMs}ms${turn.failovers ? ` (${turn.failovers} Failover)` : ''}`
                            : `${turn.errorCode}: ${turn.error}`,
                        ),
                      ),
                    ),
              ),

              h(
                'div',
                { className: 'km2dsh-card' },
                h('strong', null, c.auditTitle),
                ...(data?.rejectedClaims ?? []).map((item) =>
                  h(
                    'div',
                    { key: item.name, className: 'km2dsh-model-row' },
                    h(
                      'div',
                      null,
                      h('strong', null, item.name),
                      h('div', { style: { fontSize: '12px', opacity: 0.8 } }, item.reason),
                    ),
                    h('span', { className: 'km2dsh-badge err' }, `HTTP ${item.status}`),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      guard('mount styles', () => {
        const unmount = mountStyles()
        if (typeof ctx?.effect === 'function') {
          ctx.effect(() => unmount, 'keylessmodels2dsh: styles')
        }
      })

      guard('register locale dictionaries', () => {
        if (ctx?.locale && typeof ctx.locale.register === 'function' && typeof ctx?.effect === 'function') {
          ctx.effect(
            () =>
              ctx.locale.register(NS, {
                en: { nav: COPY.en.nav },
                zh: { nav: COPY.zh.nav },
              }),
            'keylessmodels2dsh: locale',
          )
        }
      })

      const labelText = () => {
        const currentLang = detectInitialLanguage()
        return (COPY[currentLang] || COPY.de).nav
      }

      guard('register settings section', () => {
        if (!ctx?.slots || typeof ctx.slots.inject !== 'function') return
        const registerSlot = () =>
          ctx.slots.inject('settings.section', () =>
            guard('settings.section callback', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'keylessmodels2dsh',
                  order: 48,
                  label: labelText,
                },
                KeylessSettingsPage,
              ),
            ),
          )

        if (typeof ctx.effect === 'function') {
          ctx.effect(registerSlot, 'keylessmodels2dsh: settings section')
        } else {
          registerSlot()
        }
      })
    }

    return {
      inject,
      apply,
    }
  },
})
