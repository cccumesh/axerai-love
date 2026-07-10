import { useEffect, useState } from 'react'
import {
  fetchDashboardThreads,
  isLedgerConfigured,
  parseConversationForDashboard,
} from './myraLedger.js'

const DEFAULT_CODE = 'R'

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

export default function AdminDashboard() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [threads, setThreads] = useState([])
  const [selectedThread, setSelectedThread] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!isLedgerConfigured()) {
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
  }, [code, reloadKey])

  if (!isLedgerConfigured()) {
    return (
      <div className="admin-dash">
        <p>Supabase keys missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env</p>
      </div>
    )
  }

  const bubbles = selectedThread
    ? parseConversationForDashboard(selectedThread.conversation)
    : []

  return (
    <div className="admin-dash">
      <header className="admin-dash__header">
        <div>
          <h1>Axerai Dashboard</h1>
          <p>2 threads per code — sender + receiver conversations</p>
        </div>
        <a href="/" className="admin-dash__back">
          ← Back to app
        </a>
      </header>

      <div className="admin-dash__toolbar">
        <label>
          Verification code
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
          Refresh
        </button>
      </div>

      {loading ? <p className="admin-dash__muted">Loading…</p> : null}

      <div className="admin-dash__grid">
        <section className="admin-dash__panel">
          <h2>Threads ({threads.length}/2)</h2>
          {threads.length === 0 ? (
            <p className="admin-dash__muted">No ledger rows yet for {code}.</p>
          ) : (
            <ul className="admin-dash__scan-list">
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    className={`admin-dash__scan${selectedThread?.id === thread.id ? ' admin-dash__scan--active' : ''}`}
                    onClick={() => setSelectedThread(thread)}
                  >
                    <strong>{roleLabel(thread.role)}</strong>
                    <span>Scans: {thread.scan_count}</span>
                    <span>{thread.device_id ? `${thread.device_id.slice(0, 8)}…` : 'Waiting for scan'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="admin-dash__panel">
          <h2>Conversation</h2>
          {!selectedThread ? (
            <p className="admin-dash__muted">Select a thread to view chat.</p>
          ) : (
            <>
              <div className="admin-dash__meta">
                <p>
                  <strong>Code:</strong> {selectedThread.verification_code}
                </p>
                <p>
                  <strong>Role:</strong> {roleLabel(selectedThread.role)}
                </p>
                <p>
                  <strong>Device:</strong>{' '}
                  {selectedThread.device_id ? `${selectedThread.device_id.slice(0, 12)}…` : '— (not scanned yet)'}
                </p>
                <p>
                  <strong>Scan count:</strong> {selectedThread.scan_count}
                </p>
              </div>
              <div className="admin-dash__chat">
                {bubbles.length === 0 ? (
                  <p className="admin-dash__muted">No messages in this thread yet.</p>
                ) : (
                  bubbles.map((msg) => (
                    <div
                      key={msg.key}
                      className={`admin-dash__bubble admin-dash__bubble--${msg.speaker}`}
                    >
                      {msg.speaker !== 'session-end' ? (
                        <strong>{bubbleLabel(msg.speaker)}:</strong>
                      ) : null}
                      <p>{msg.text}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="admin-dash__summaries">
                <h3>Session summaries</h3>
                {selectedThread.session_summaries?.trim() ? (
                  <pre className="admin-dash__summaries-pre">{selectedThread.session_summaries}</pre>
                ) : (
                  <p className="admin-dash__muted">No session summaries yet — exit after chat to save.</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
