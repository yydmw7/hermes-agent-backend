import {
  Activity,
  Archive,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  Shield,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import './App.css'

type StatusResponse = {
  app: {
    name: string
    uptimeSeconds: number
    platform: string
    node: string
    configPath: string
    hostProfile: boolean
  }
  hermes: {
    root: string
    rootExists: boolean
    health: {
      configured: boolean
      online: boolean
      status: number | null
      latencyMs: number | null
      body: string
    }
    logFile: string
    logCommand: string
    logExists: boolean
    service: {
      name: string
      scope: string
    }
    commandsConfigured: Record<string, boolean>
  }
  system: {
    hostname: string
    cpus: number
    loadAverage: number[]
    totalMemory: number
    freeMemory: number
  }
  backup: {
    dir: string
    include: string[]
    keepLast: number
  }
  security: {
    tokenRequired: boolean
  }
}

type EnvironmentInfo = {
  kind: string
  platform: string
  hostname: string
  distro: string
  isWsl: boolean
  hostId: string
  systemd: {
    available: boolean
    version: string
    error: string
  }
}

type SetupState = {
  needsSetup: boolean
  hostProfileExists: boolean
  activePath: string
  hostProfilePath: string
  environment: EnvironmentInfo
  reasons: string[]
}

type Candidate = {
  name?: string
  scope?: string
  path?: string
  command?: string
  url?: string
  description?: string
  confidence: number
  confidenceLabel: string
  source?: string
  status?: number | null
}

type DetectionResponse = {
  environment: EnvironmentInfo
  candidates: {
    services: Candidate[]
    roots: Candidate[]
    logs: Candidate[]
    health: Candidate[]
    backups: Candidate[]
  }
  recommended: {
    service: Candidate | null
    root: Candidate | null
    log: Candidate | null
    health: Candidate | null
    backup: Candidate | null
  }
}

type Backup = {
  id: string
  name: string
  size: number
  createdAt: string
  modifiedAt: string
  manifest?: {
    checksum?: string
    include?: string[]
  } | null
}

type BackupsResponse = {
  backups: Backup[]
  dir: string
}

type ConfigResponse = {
  path: string
  raw: string
  parsed: {
    security: {
      adminToken: string
    }
  }
}

const api = {
  async getStatus() {
    return fetchJson<StatusResponse>('/api/status')
  },
  async getBackups() {
    return fetchJson<BackupsResponse>('/api/backups')
  },
  async getConfig() {
    return fetchJson<ConfigResponse>('/api/config')
  },
  async getSetupState() {
    return fetchJson<SetupState>('/api/setup/state')
  },
  async detectSetup() {
    return fetchJson<DetectionResponse>('/api/setup/detect')
  },
  async applySetup(selection: Record<string, Candidate | null>, token: string) {
    return fetchJson<{ ok: boolean; path: string }>('/api/setup/apply', {
      method: 'POST',
      headers: writeHeaders(token),
      body: JSON.stringify({ selection }),
    })
  },
  async control(action: string, token: string) {
    return fetchJson<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>(`/api/control/${action}`, {
      method: 'POST',
      headers: writeHeaders(token),
    })
  },
  async createBackup(include: string[], token: string) {
    return fetchJson<{ ok: boolean; backup: Backup; error?: string }>('/api/backups', {
      method: 'POST',
      headers: writeHeaders(token),
      body: JSON.stringify({ include }),
    })
  },
  async deleteBackup(id: string, token: string) {
    return fetchJson<{ ok: boolean }>(`/api/backups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: writeHeaders(token),
    })
  },
  async verifyBackup(id: string, token: string) {
    return fetchJson<{ ok: boolean; checksum: string; matchesManifest: boolean | null }>(
      `/api/backups/${encodeURIComponent(id)}/verify`,
      {
        method: 'POST',
        headers: writeHeaders(token),
      },
    )
  },
  async saveConfig(raw: string, token: string) {
    return fetchJson<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      headers: writeHeaders(token),
      body: JSON.stringify({ raw }),
    })
  },
}

function writeHeaders(token: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['x-admin-token'] = token
  return headers
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `请求失败：HTTP ${response.status}`)
  }
  return payload
}

function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [backups, setBackups] = useState<BackupsResponse | null>(null)
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [setupState, setSetupState] = useState<SetupState | null>(null)
  const [detection, setDetection] = useState<DetectionResponse | null>(null)
  const [setupSelection, setSetupSelection] = useState({ service: 0, root: 0, log: 0, health: 0, backup: 0 })
  const [configDraft, setConfigDraft] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [selectedIncludes, setSelectedIncludes] = useState<string[]>([])
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const memoryUsed = useMemo(() => {
    if (!status) return 0
    return status.system.totalMemory - status.system.freeMemory
  }, [status])

  const handleError = useCallback((nextError: unknown) => {
    setError(nextError instanceof Error ? nextError.message : String(nextError))
    window.setTimeout(() => setError(''), 6000)
  }, [])

  const refresh = useCallback(async () => {
    const [nextStatus, nextBackups, nextConfig, nextSetupState] = await Promise.all([
      api.getStatus(),
      api.getBackups(),
      api.getConfig(),
      api.getSetupState(),
    ])
    setStatus(nextStatus)
    setBackups(nextBackups)
    setConfig(nextConfig)
    setSetupState(nextSetupState)
    setConfigDraft(current => (current ? current : nextConfig.raw))
    setSelectedIncludes(current => (current.length ? current : nextStatus.backup.include))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh().catch(handleError)
    }, 0)
    const interval = window.setInterval(() => refresh().catch(handleError), 10000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [handleError, refresh])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/logs`)
    socket.onmessage = event => {
      const payload = JSON.parse(event.data)
      if (payload.type === 'snapshot') setLogs(payload.lines || [])
      if (payload.type === 'append') {
        setLogs(current => [...current, ...String(payload.text || '').split(/\r?\n/)].slice(-500))
      }
      if (payload.type === 'missing') setLogs([`未找到日志文件：${payload.file}`])
    }
    socket.onerror = () => setLogs(current => (current.length ? current : ['日志流暂不可用。']))
    return () => socket.close()
  }, [])

  const runAction = async (action: string) => {
    setBusy(action)
    setNotice('')
    try {
      const result = await api.control(action, token)
      setNotice(result.stdout || result.stderr || `${actionName(action)} 已完成。`)
      await refresh()
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const createBackup = async () => {
    setBusy('backup')
    setNotice('')
    try {
      const result = await api.createBackup(selectedIncludes, token)
      setNotice(`已创建备份：${result.backup.name}`)
      await refresh()
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const deleteBackup = async (id: string) => {
    if (!window.confirm(`确定删除备份 ${id} 吗？`)) return
    setBusy(id)
    try {
      await api.deleteBackup(id, token)
      setNotice(`已删除备份：${id}`)
      await refresh()
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const verifyBackup = async (id: string) => {
    setBusy(id)
    try {
      const result = await api.verifyBackup(id, token)
      setNotice(
        result.matchesManifest === null
          ? `校验值：${result.checksum}`
          : `校验值${result.matchesManifest ? '与' : '不与'} manifest 匹配。`,
      )
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const saveConfig = async () => {
    setBusy('config')
    try {
      await api.saveConfig(configDraft, token)
      setNotice('配置已保存。')
      await refresh()
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const runDetection = async () => {
    setBusy('detect')
    setNotice('')
    try {
      const result = await api.detectSetup()
      setDetection(result)
      setSetupSelection({ service: 0, root: 0, log: 0, health: 0, backup: 0 })
      setNotice('检测完成。')
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const applySetup = async () => {
    if (!detection) return
    setBusy('apply-setup')
    try {
      const selection = {
        service: detection.candidates.services[setupSelection.service] || null,
        root: detection.candidates.roots[setupSelection.root] || null,
        log: detection.candidates.logs[setupSelection.log] || null,
        health: detection.candidates.health[setupSelection.health] || null,
        backup: detection.candidates.backups[setupSelection.backup] || null,
      }
      const result = await api.applySetup(selection, token)
      setNotice(`主机配置已保存：${result.path}`)
      setDetection(null)
      setConfigDraft('')
      await refresh()
    } catch (nextError) {
      handleError(nextError)
    } finally {
      setBusy(null)
    }
  }

  const toggleInclude = (item: string) => {
    setSelectedIncludes(current =>
      current.includes(item) ? current.filter(value => value !== item) : [...current, item],
    )
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hermes 管理台</p>
          <h1>{status?.app.name || 'Hermes 管理器'}</h1>
        </div>
        <div className="top-actions">
          {status?.security.tokenRequired ? (
            <label className="token-field">
              <Shield size={16} />
              <input
                type="password"
                value={token}
                placeholder="管理令牌"
                onChange={event => setToken(event.target.value)}
              />
            </label>
          ) : (
            <span className="soft-pill"><Shield size={16} /> 本机模式</span>
          )}
          <button className="icon-button" type="button" onClick={() => refresh().catch(handleError)} title="刷新">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="guide-panel">
        <div className="guide-title">
          <BookOpen size={20} />
          <div>
            <h2>使用教学</h2>
            <p>先确认程序运行位置，再执行检测。当前桌面 exe 是 Windows 程序，直接检测到的是 Windows 环境。</p>
          </div>
        </div>
        <ol>
          <li>如果 Hermes 在 WSL 里，当前版本需要后续加入 WSL 桥接后才能从 Windows exe 直接控制 systemd。</li>
          <li>如果在 WSL 内用 Web 模式运行，进入项目目录后执行 `npm run detect` 和 `npm run setup:local`。</li>
          <li>检测结果正确后，再使用启动、停止、日志、备份功能。</li>
          <li>换到另一台电脑使用时，优先带走单文件 exe；配置会在那台电脑首次运行时重新生成。</li>
        </ol>
      </section>

      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      {(setupState?.needsSetup || detection) && (
        <section className="setup-panel">
          <div className="setup-copy">
            <p className="eyebrow">本机初始化</p>
            <h2>{setupState?.environment.kind === 'wsl' ? 'WSL 主机配置' : '主机配置'}</h2>
            <p>
              {setupState?.environment.hostname || 'Current host'} - {setupState?.environment.distro || setupState?.environment.platform}
              {setupState?.environment.systemd.available ? ' - 已检测到 systemd' : ' - 未检测到 systemd'}
            </p>
            {setupState?.environment.kind === 'windows' && (
              <p className="setup-warning">当前检测到的是 Windows 环境，不是 WSL 内部环境。若 Hermes 安装在 WSL 里，需要使用 WSL 桥接版或在 WSL 内运行 Web 模式。</p>
            )}
            {setupState?.reasons.length ? (
              <ul>
                {setupState.reasons.map(reason => <li key={reason}>{translateReason(reason)}</li>)}
              </ul>
            ) : null}
          </div>
          <div className="setup-actions">
            <button className="secondary" type="button" disabled={busy === 'detect'} onClick={runDetection}>
              {busy === 'detect' ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
              自动检测
            </button>
            {detection && (
              <button className="primary" type="button" disabled={busy === 'apply-setup'} onClick={applySetup}>
                {busy === 'apply-setup' ? <Loader2 className="spin" size={17} /> : <Settings2 size={17} />}
                应用配置
              </button>
            )}
          </div>
          {detection && (
            <div className="candidate-grid">
              <CandidateSelect
                label="服务"
                value={setupSelection.service}
                candidates={detection.candidates.services}
                onChange={value => setSetupSelection(current => ({ ...current, service: value }))}
              />
              <CandidateSelect
                label="Hermes目录"
                value={setupSelection.root}
                candidates={detection.candidates.roots}
                onChange={value => setSetupSelection(current => ({ ...current, root: value }))}
              />
              <CandidateSelect
                label="日志"
                value={setupSelection.log}
                candidates={detection.candidates.logs}
                onChange={value => setSetupSelection(current => ({ ...current, log: value }))}
              />
              <CandidateSelect
                label="健康检查"
                value={setupSelection.health}
                candidates={detection.candidates.health}
                onChange={value => setSetupSelection(current => ({ ...current, health: value }))}
              />
              <CandidateSelect
                label="备份位置"
                value={setupSelection.backup}
                candidates={detection.candidates.backups}
                onChange={value => setSetupSelection(current => ({ ...current, backup: value }))}
              />
            </div>
          )}
        </section>
      )}

      <section className="status-grid">
        <Metric
          icon={<Activity size={20} />}
          label="健康状态"
          value={status?.hermes.health.online ? '在线' : '离线'}
          detail={status?.hermes.health.status ? `HTTP ${status.hermes.health.status}` : status?.hermes.health.body || '未就绪'}
          tone={status?.hermes.health.online ? 'good' : 'bad'}
        />
        <Metric
          icon={<Server size={20} />}
          label="Hermes目录"
          value={status?.hermes.rootExists ? '已找到' : '未找到'}
          detail={status?.hermes.root || '加载中'}
          tone={status?.hermes.rootExists ? 'good' : 'warn'}
        />
        <Metric
          icon={<HardDrive size={20} />}
          label="内存"
          value={formatBytes(memoryUsed)}
          detail={status ? `剩余 ${formatBytes(status.system.freeMemory)}` : '加载中'}
          tone="neutral"
        />
        <Metric
          icon={<Archive size={20} />}
          label="备份"
          value={`${backups?.backups.length || 0}`}
          detail={backups?.dir || '加载中'}
          tone="neutral"
        />
      </section>

      <section className="workspace">
        <div className="panel control-panel">
          <div className="panel-heading">
            <div>
              <h2>服务控制</h2>
              <p>只执行配置文件中的白名单命令。</p>
            </div>
          </div>
          <div className="control-row">
            <ActionButton
              icon={<Play size={17} />}
              label="启动"
              disabled={!status?.hermes.commandsConfigured.start}
              loading={busy === 'start'}
              onClick={() => runAction('start')}
            />
            <ActionButton
              icon={<Square size={17} />}
              label="停止"
              disabled={!status?.hermes.commandsConfigured.stop}
              loading={busy === 'stop'}
              onClick={() => runAction('stop')}
            />
            <ActionButton
              icon={<RotateCcw size={17} />}
              label="重启"
              disabled={!status?.hermes.commandsConfigured.restart}
              loading={busy === 'restart'}
              onClick={() => runAction('restart')}
            />
          </div>
          <dl className="details">
            <div>
              <dt>健康检查</dt>
              <dd>{status?.hermes.health.configured ? status.hermes.health.latencyMs + ' ms' : '未配置'}</dd>
            </div>
            <div>
              <dt>服务</dt>
              <dd>{status?.hermes.service.name || '未配置'}</dd>
            </div>
            <div>
              <dt>主机</dt>
              <dd>{status?.system.hostname || '加载中'}</dd>
            </div>
          </dl>
        </div>

        <div className="panel backup-panel">
          <div className="panel-heading">
            <div>
              <h2>备份中心</h2>
              <p>按已配置路径创建 tar.gz 快照。</p>
            </div>
            <button className="primary" type="button" disabled={busy === 'backup'} onClick={createBackup}>
              {busy === 'backup' ? <Loader2 className="spin" size={17} /> : <Archive size={17} />}
              立即备份
            </button>
          </div>
          <div className="include-list">
            {status?.backup.include.map(item => (
              <label key={item} className="check-row">
                <input
                  type="checkbox"
                  checked={selectedIncludes.includes(item)}
                  onChange={() => toggleInclude(item)}
                />
                <span>{item}</span>
              </label>
            ))}
          </div>
          <div className="backup-list">
            {(backups?.backups || []).map(backup => (
              <div className="backup-row" key={backup.id}>
                <div>
                  <strong>{backup.name}</strong>
                  <span>{formatBytes(backup.size)} - {formatDate(backup.modifiedAt)}</span>
                </div>
                <div className="row-actions">
                  <a className="icon-button" href={`/api/backups/${encodeURIComponent(backup.id)}/download`} title="下载">
                    <Download size={17} />
                  </a>
                  <button className="icon-button" type="button" title="校验" onClick={() => verifyBackup(backup.id)}>
                    <CheckCircle2 size={17} />
                  </button>
                  <button className="icon-button danger" type="button" title="删除" onClick={() => deleteBackup(backup.id)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
            {backups?.backups.length === 0 && <p className="empty">暂无备份。</p>}
          </div>
        </div>
      </section>

      <section className="workspace lower">
        <div className="panel logs-panel">
          <div className="panel-heading">
            <div>
              <h2>日志</h2>
              <p>{status?.hermes.logFile || status?.hermes.logCommand || '等待配置'}</p>
            </div>
            {status?.hermes.logExists || status?.hermes.logCommand ? <CheckCircle2 className="ok" size={18} /> : <XCircle className="not-ok" size={18} />}
          </div>
          <pre className="log-view">{logs.join('\n')}</pre>
        </div>

        <div className="panel config-panel">
          <div className="panel-heading">
            <div>
              <h2>配置</h2>
              <p>{config?.path || '加载中'}</p>
            </div>
            <button className="secondary" type="button" disabled={busy === 'config'} onClick={saveConfig}>
              {busy === 'config' ? <Loader2 className="spin" size={17} /> : <FileText size={17} />}
              保存
            </button>
          </div>
          <textarea
            spellCheck={false}
            value={configDraft}
            onChange={event => setConfigDraft(event.target.value)}
          />
        </div>
      </section>
    </main>
  )
}

function CandidateSelect({
  label,
  value,
  candidates,
  onChange,
}: {
  label: string
  value: number
  candidates: Candidate[]
  onChange: (value: number) => void
}) {
  return (
    <label className="candidate-select">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(Number(event.target.value))}>
        {candidates.length === 0 ? (
          <option value={0}>未找到候选项</option>
        ) : candidates.map((candidate, index) => (
          <option key={`${label}-${index}`} value={index}>
            {candidateLabel(candidate)} ({confidenceText(candidate)})
          </option>
        ))}
      </select>
    </label>
  )
}

function candidateLabel(candidate: Candidate) {
  return candidate.name
    || candidate.path
    || candidate.command
    || candidate.url
    || candidate.description
    || '未知'
}

function confidenceText(candidate: Candidate) {
  const label = candidate.confidenceLabel
  if (label === 'high') return '高可信'
  if (label === 'medium') return '中等可信'
  if (label === 'low') return '低可信'
  return `${candidate.confidence}`
}

function translateReason(reason: string) {
  const map: Record<string, string> = {
    'No host profile exists for this machine.': '这台电脑还没有生成主机配置。',
    'Hermes root is still a default placeholder.': 'Hermes 目录仍是默认占位路径。',
    'System control commands are not configured.': '启动、停止、重启命令尚未配置。',
  }
  return map[reason] || reason
}

function actionName(action: string) {
  const map: Record<string, string> = {
    start: '启动',
    stop: '停止',
    restart: '重启',
    status: '状态检查',
  }
  return map[action] || action
}

function Metric({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode
  label: string
  value: string
  detail: string
  tone: 'good' | 'bad' | 'warn' | 'neutral'
}) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  loading,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  loading: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button className="action-button" type="button" disabled={disabled || loading} onClick={onClick}>
      {loading ? <Loader2 className="spin" size={17} /> : icon}
      {label}
    </button>
  )
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let next = value
  let unit = 0
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024
    unit += 1
  }
  return `${next.toFixed(next >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export default App
