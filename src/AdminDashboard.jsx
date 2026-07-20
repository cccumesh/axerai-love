import { useEffect, useMemo, useState } from 'react'
import {
  buildDashboardAnalytics,
  buildElevenLabsUsageAnalytics,
  buildGeminiUsageAnalytics,
  fetchDashboardThreads,
  formatDashboardDuration,
  isLedgerConfigured,
  parseConversationForDashboard,
} from './myraLedger.js'

function formatTokenCount(value) {
  return Number(value || 0).toLocaleString('en-IN')
}

function callTypeLabel(call) {
  if (call === 'verify') return 'Verify'
  if (call === 'chat') return 'Chat'
  if (call === 'welcome') return 'Welcome'
  if (call === 'summary') return 'Summary'
  return call || 'Other'
}

const DEFAULT_CODE = 'R'
const AUTH_KEY = 'axerai_dash_auth'
const DASHBOARD_PATH = String(import.meta.env.VITE_DASHBOARD_PATH || 'axerai-insights-7k2m').replace(
  /^\/+|\/+$/g,
  '',
)
const DASHBOARD_PASSWORD = String(import.meta.env.VITE_DASHBOARD_PASSWORD ?? '').trim()
const DASHBOARD_REQUIRES_PASSWORD = import.meta.env.PROD || Boolean(DASHBOARD_PASSWORD)

function roleLabel(role) {
  if (role === 'sender') return 'Sender'
  if (role === 'receiver') return 'Receiver'
  return role || '—'
}

function bubbleLabel(speaker) {
  if (speaker === 'session-end') return '—'
  if (speaker === 'session-started') return 'Session started'
  if (speaker === 'session-ended') return 'Session ended'
  if (speaker === 'session-duration') return 'Duration'
  if (speaker === 'session-praise') return 'Praise'
  if (speaker === 'sender-summary') return 'Sender summary'
  if (speaker === 'receiver-summary') return 'Receiver summary'
  return speaker
}

function DashboardBrand({ subtitle }) {
  return (
    <div className="admin-dash__brand">
      <span className="admin-dash__brand-mark">RICHERA</span>
      <h1 className="admin-dash__brand-title">Axerai Insights</h1>
      {subtitle ? <p className="admin-dash__brand-sub">{subtitle}</p> : null}
    </div>
  )
}

function DashboardLogin({ onSuccess }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    if (!DASHBOARD_PASSWORD) {
      setError('Password set nahi hai — .env me VITE_DASHBOARD_PASSWORD daalo.')
      return
    }
    if (password === DASHBOARD_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, '1')
      onSuccess()
      return
    }
    setError('Galat password.')
  }

  return (
    <div className="admin-dash admin-dash--gate">
      <form className="admin-dash__gate" onSubmit={handleSubmit}>
        <DashboardBrand subtitle="Private business dashboard — sirf tumhare liye" />
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Enter password"
          />
        </label>
        {error ? <p className="admin-dash__gate-error">{error}</p> : null}
        <button type="submit">Open dashboard</button>
      </form>
    </div>
  )
}

export default function AdminDashboard() {
  useEffect(() => {
    document.documentElement.classList.add('admin-dash-page')
    return () => {
      document.documentElement.classList.remove('admin-dash-page')
    }
  }, [])

  const [authed, setAuthed] = useState(() => {
    if (!DASHBOARD_REQUIRES_PASSWORD) return true
    if (!DASHBOARD_PASSWORD) return false
    return sessionStorage.getItem(AUTH_KEY) === '1'
  })
  const [code, setCode] = useState(DEFAULT_CODE)
  const [threads, setThreads] = useState([])
  const [selectedThread, setSelectedThread] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!isLedgerConfigured() || !authed) {
      setLoading(false)
      return
    }

    let cancelled = false
    ;(async () => {
      setLoading(true)
      const rows = await fetchDashboardThreads(code)
      if (!cancelled) {
        setThreads(rows)
        setSelectedThread(rows[0] ?? null)
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, reloadKey, authed])

  const analytics = useMemo(() => buildDashboardAnalytics(threads), [threads])
  const tokenStats = useMemo(() => buildGeminiUsageAnalytics(threads), [threads])
  const elevenStats = useMemo(() => buildElevenLabsUsageAnalytics(threads), [threads])

  if (DASHBOARD_REQUIRES_PASSWORD && !DASHBOARD_PASSWORD) {
    return (
      <div className="admin-dash admin-dash--gate">
        <div className="admin-dash__gate">
          <DashboardBrand />
          <p className="admin-dash__gate-error">
            Dashboard lock ke liye <code>VITE_DASHBOARD_PASSWORD</code> .env me set karo, phir dev
            server restart karo.
          </p>
        </div>
      </div>
    )
  }

  if (!authed) {
    return <DashboardLogin onSuccess={() => setAuthed(true)} />
  }

  if (!isLedgerConfigured()) {
    return (
      <div className="admin-dash">
        <div className="admin-dash__shell">
          <p>Supabase keys missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env</p>
        </div>
      </div>
    )
  }

  const bubbles = selectedThread
    ? parseConversationForDashboard(selectedThread.conversation)
    : []

  return (
    <div className="admin-dash">
      <div className="admin-dash__shell">
        <header className="admin-dash__hero">
          <DashboardBrand subtitle={`Product code ${code} · scans · talk time · brand praise`} />
          <div className="admin-dash__header-actions">
            <button
              type="button"
              className="admin-dash__btn admin-dash__btn--ghost"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Refresh
            </button>
            <button
              type="button"
              className="admin-dash__btn admin-dash__btn--ghost"
              onClick={() => {
                sessionStorage.removeItem(AUTH_KEY)
                setAuthed(false)
              }}
            >
              Logout
            </button>
            <a href="/" className="admin-dash__back">
              ← App
            </a>
          </div>
        </header>

        <div className="admin-dash__toolbar">
          <label className="admin-dash__field">
            <span>Verification code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          {loading ? <span className="admin-dash__loading-pill">Loading…</span> : null}
        </div>

        <section className="admin-dash__stats">
          <article className="admin-dash__stat-card">
            <span className="admin-dash__stat-label">Total scans</span>
            <strong className="admin-dash__stat-value">{analytics.totalScans}</strong>
          </article>
          <article className="admin-dash__stat-card">
            <span className="admin-dash__stat-label">Talk time</span>
            <strong className="admin-dash__stat-value">
              {formatDashboardDuration(analytics.totalTalkTimeSeconds)}
            </strong>
          </article>
          <article className="admin-dash__stat-card admin-dash__stat-card--praise">
            <span className="admin-dash__stat-label">Brand praise</span>
            <strong className="admin-dash__stat-value">{analytics.positiveCount}</strong>
          </article>
          <article className="admin-dash__stat-card">
            <span className="admin-dash__stat-label">Threads</span>
            <strong className="admin-dash__stat-value">{threads.length}/2</strong>
          </article>
          <article className="admin-dash__stat-card admin-dash__stat-card--wide">
            <span className="admin-dash__stat-label">Last scan</span>
            <strong className="admin-dash__stat-value admin-dash__stat-value--small">
              {analytics.lastScanDate || '—'}
            </strong>
          </article>
        </section>

        <section className="admin-dash__panel admin-dash__panel--tokens">
          <h2 className="admin-dash__panel-title">Axerai AI tokens — code {code}</h2>
          <div className="admin-dash__token-stats">
            <article className="admin-dash__stat-card admin-dash__stat-card--token">
              <span className="admin-dash__stat-label">Axerai AI tokens</span>
              <strong className="admin-dash__stat-value">
                {formatTokenCount(tokenStats.totalTokens)}
              </strong>
            </article>
            <article className="admin-dash__stat-card">
              <span className="admin-dash__stat-label">Prompt in</span>
              <strong className="admin-dash__stat-value admin-dash__stat-value--small">
                {formatTokenCount(tokenStats.promptTokens)}
              </strong>
            </article>
            <article className="admin-dash__stat-card">
              <span className="admin-dash__stat-label">Output out</span>
              <strong className="admin-dash__stat-value admin-dash__stat-value--small">
                {formatTokenCount(tokenStats.outputTokens)}
              </strong>
            </article>
            <article className="admin-dash__stat-card">
              <span className="admin-dash__stat-label">API calls</span>
              <strong className="admin-dash__stat-value admin-dash__stat-value--small">
                {tokenStats.callCount}
              </strong>
            </article>
          </div>
          <div className="admin-dash__token-breakdown">
            <span>Verify {formatTokenCount(tokenStats.byCall.verify)}</span>
            <span>Welcome {formatTokenCount(tokenStats.byCall.welcome)}</span>
            <span>Chat {formatTokenCount(tokenStats.byCall.chat)}</span>
            <span>Summary {formatTokenCount(tokenStats.byCall.summary)}</span>
          </div>
          {tokenStats.entries.length === 0 ? (
            <p className="admin-dash__empty">
              Abhi koi AI token log nahi — scan / chat / exit ke baad yahan dikhega. (Naya setup: Supabase me{' '}
              <code>fresh_start.sql</code> run karo.)
            </p>
          ) : (
            <div className="admin-dash__table-wrap">
              <table className="admin-dash__table admin-dash__table--tokens">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Role</th>
                    <th>Scan</th>
                    <th>Total</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {[...tokenStats.entries].reverse().map((row, index) => (
                    <tr key={`${row.at}-${row.call}-${index}`}>
                      <td>{row.at ? new Date(row.at).toLocaleString('en-IN') : '—'}</td>
                      <td>{callTypeLabel(row.call)}</td>
                      <td>{roleLabel(row.threadRole)}</td>
                      <td>{row.scan ?? '—'}</td>
                      <td>{formatTokenCount(row.totalTokens)}</td>
                      <td className="admin-dash__muted">{row.model}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="admin-dash__panel admin-dash__panel--tokens">
          <h2 className="admin-dash__panel-title">Axerai voice tokens — code {code}</h2>
          <div className="admin-dash__token-stats">
            <article className="admin-dash__stat-card admin-dash__stat-card--token admin-dash__stat-card--axerai">
              <span className="admin-dash__stat-label">Axerai voice tokens</span>
              <strong className="admin-dash__stat-value">
                {formatTokenCount(elevenStats.totalCharacters)}
              </strong>
            </article>
            <article className="admin-dash__stat-card">
              <span className="admin-dash__stat-label">Voice calls</span>
              <strong className="admin-dash__stat-value admin-dash__stat-value--small">
                {elevenStats.callCount}
              </strong>
            </article>
          </div>
          {elevenStats.entries.length === 0 ? (
            <p className="admin-dash__empty">
              Abhi koi voice token log nahi — Myra jab bolegi tab yahan dikhega. (Naya setup: Supabase me{' '}
              <code>fresh_start.sql</code> run karo.)
            </p>
          ) : (
            <div className="admin-dash__table-wrap">
              <table className="admin-dash__table admin-dash__table--tokens">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Role</th>
                    <th>Scan</th>
                    <th>Tokens</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {[...elevenStats.entries].reverse().map((row, index) => (
                    <tr key={`${row.at}-voice-${index}`}>
                      <td>{row.at ? new Date(row.at).toLocaleString('en-IN') : '—'}</td>
                      <td>Voice</td>
                      <td>{roleLabel(row.threadRole)}</td>
                      <td>{row.scan ?? '—'}</td>
                      <td>{formatTokenCount(row.characters)}</td>
                      <td className="admin-dash__muted">{row.model}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {analytics.praiseQuotes.length > 0 ? (
          <section className="admin-dash__panel admin-dash__quotes">
            <h2 className="admin-dash__panel-title">Brand praise — user ne kya kaha</h2>
            <ul className="admin-dash__quote-list">
              {analytics.praiseQuotes.map((item) => (
                <li key={`${item.role}-${item.scanNumber}-${item.quote.slice(0, 24)}`}>
                  <span className="admin-dash__quote-meta">
                    Scan #{item.scanNumber} · {roleLabel(item.role)}
                  </span>
                  <p className="admin-dash__praise">"{item.quote}"</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="admin-dash__panel">
          <h2 className="admin-dash__panel-title">Scan history</h2>
          {analytics.sessions.length === 0 ? (
            <p className="admin-dash__empty">
              Abhi koi completed scan nahi — scan karo, baat karo, exit dabao, phir refresh.
            </p>
          ) : (
            <div className="admin-dash__table-wrap">
              <table className="admin-dash__table">
                <thead>
                  <tr>
                    <th>Scan</th>
                    <th>Role</th>
                    <th>Date</th>
                    <th>Duration</th>
                    <th>Pasand</th>
                    <th>Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.sessions.map((row) => (
                    <tr key={`${row.threadId}-${row.scanNumber}`}>
                      <td>
                        <span className="admin-dash__scan-badge">#{row.scanNumber}</span>
                      </td>
                      <td>
                        <span
                          className={`admin-dash__role-pill admin-dash__role-pill--${row.threadRole}`}
                        >
                          {roleLabel(row.threadRole)}
                        </span>
                      </td>
                      <td>{row.date || '—'}</td>
                      <td>{row.durationText || formatDashboardDuration(row.durationSeconds)}</td>
                      <td>
                        {row.praiseDetected ? (
                          <span className="admin-dash__yes">✓ Haan</span>
                        ) : (
                          <span className="admin-dash__muted">—</span>
                        )}
                      </td>
                      <td className="admin-dash__praise">
                        {row.praiseQuote ? `"${row.praiseQuote}"` : row.userSaid || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="admin-dash__grid">
          <section className="admin-dash__panel">
            <h2 className="admin-dash__panel-title">Threads</h2>
            {threads.length === 0 ? (
              <p className="admin-dash__empty">No ledger rows yet for {code}.</p>
            ) : (
              <ul className="admin-dash__scan-list">
                {threads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className={`admin-dash__scan${selectedThread?.id === thread.id ? ' admin-dash__scan--active' : ''}`}
                      onClick={() => setSelectedThread(thread)}
                    >
                      <span
                        className={`admin-dash__role-pill admin-dash__role-pill--${thread.role}`}
                      >
                        {roleLabel(thread.role)}
                      </span>
                      <strong>{thread.scan_count} scans</strong>
                      <span className="admin-dash__muted">
                        {thread.device_id ? `${thread.device_id.slice(0, 8)}…` : 'Waiting for scan'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="admin-dash__panel admin-dash__panel--chat">
            <h2 className="admin-dash__panel-title">Conversation</h2>
            {!selectedThread ? (
              <p className="admin-dash__empty">Select a thread to view chat.</p>
            ) : (
              <>
                <div className="admin-dash__meta">
                  <span>
                    <strong>Code</strong> {selectedThread.verification_code}
                  </span>
                  <span>
                    <strong>Role</strong> {roleLabel(selectedThread.role)}
                  </span>
                  <span>
                    <strong>Scans</strong> {selectedThread.scan_count}
                  </span>
                </div>
                <div className="admin-dash__chat">
                  {bubbles.length === 0 ? (
                    <p className="admin-dash__empty">No messages in this thread yet.</p>
                  ) : (
                    bubbles.map((msg) => (
                      <div
                        key={msg.key}
                        className={`admin-dash__bubble admin-dash__bubble--${msg.speaker}`}
                      >
                        {msg.speaker !== 'session-end' ? (
                          <strong>{bubbleLabel(msg.speaker)}</strong>
                        ) : null}
                        <p>{msg.text}</p>
                      </div>
                    ))
                  )}
                </div>
                <div className="admin-dash__summaries">
                  <h3>Session summaries</h3>
                  {selectedThread.session_summaries?.trim() ? (
                    <pre className="admin-dash__summaries-pre">
                      {selectedThread.session_summaries}
                    </pre>
                  ) : (
                    <p className="admin-dash__empty">Exit after chat to save summaries.</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
