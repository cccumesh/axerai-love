import { getMyraHistoryText } from './myraPrompt.js'
import { isSupabaseConfigured, supabase } from './supabaseClient.js'

const DEVICE_ID_KEY = 'axerai_device_id'
const DEVICE_COOKIE = 'axerai_device_id'
const MAX_CONVERSATION_CHARS = 50000
const PRAISE_PATTERN =
  /pasand|pyaar|love|cute|amazing|awesome|beautiful|kamaal|kadak|best|tarif|praise|accha laga|bahut accha|mast hai|wow|stunning|gorgeous|perfect|heart/i

let activeThreadId = null
let activeScanNumber = 0
let activeVerificationCode = ''
let activeStartedAt = 0
let ledgerMemoryText = ''
let sessionRole = 'SENDER'
let ledgerWelcomeMode = 'SENDER_FIRST'

function logLedger(message, detail) {
  if (detail !== undefined) console.info(`[Ledger] ${message}`, detail)
  else console.info(`[Ledger] ${message}`)
}

function roleKeyFromSession() {
  return sessionRole === 'RECEIVER' ? 'receiver' : 'sender'
}

function speakerLabelForRole(role) {
  if (role === 'myra') return 'myra'
  return sessionRole === 'RECEIVER' ? 'receiver' : 'sender'
}

export function isLedgerConfigured() {
  return isSupabaseConfigured()
}

/** Call on app start — logs whether Supabase tables are reachable. */
export async function probeLedgerHealth() {
  if (!supabase) {
    console.warn('[Ledger] Supabase keys missing — scan history will NOT save.')
    return false
  }

  const { error } = await supabase
    .from('ledger_threads')
    .select('id', { count: 'exact', head: true })
    .limit(1)

  if (error) {
    console.error('[Ledger] Database unreachable or tables missing:', error.message)
    console.error('[Ledger] Fix: Supabase → SQL Editor → run supabase/migrate_v3_ledger_threads.sql')
    return false
  }

  console.info('[Ledger] Supabase OK — ledger_threads will save (2 rows per code max).')
  return true
}

function readDeviceCookie() {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|; )axerai_device_id=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : null
}

function writeDeviceCookie(id) {
  if (typeof document === 'undefined') return
  document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 365 * 5}; SameSite=Lax`
}

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY) || readDeviceCookie()
    if (!id) {
      id = crypto.randomUUID()
      console.info('[Ledger] New device ID created for this browser URL:', id.slice(0, 8) + '…')
      console.info('[Ledger] Same laptop par hamesha ye URL use karo taaki ID same rahe:', window.location.origin)
    }
    localStorage.setItem(DEVICE_ID_KEY, id)
    writeDeviceCookie(id)
    return id
  } catch {
    const cookieId = readDeviceCookie()
    if (cookieId) return cookieId
    return 'unknown-device'
  }
}

export function getLedgerSessionInfo() {
  return {
    role: sessionRole,
    deviceId: getDeviceId(),
    threadId: activeThreadId,
    scanNumber: activeScanNumber,
    code: activeVerificationCode,
  }
}

/** SENDER = first scanner device or same device returning. RECEIVER = new device on same code. */
export function getSessionRole() {
  return sessionRole
}

export function getLedgerWelcomeMode() {
  return ledgerWelcomeMode
}

function threadHasPriorConversation(thread) {
  return Boolean(String(thread?.conversation ?? '').trim())
}

function resolveWelcomeMode(role, senderThread, receiverThread) {
  if (role === 'RECEIVER') {
    return threadHasPriorConversation(receiverThread) ? 'RECEIVER_RETURN' : 'RECEIVER_FIRST'
  }
  return threadHasPriorConversation(senderThread) ? 'SENDER_RETURN' : 'SENDER_FIRST'
}

function buildBackendScanSignal(mode) {
  switch (mode) {
    case 'SENDER_FIRST':
      return 'Axerai backend: SENDER first scan. Ledger empty — give intro welcome (brand + who Myra is).'
    case 'SENDER_RETURN':
      return 'Axerai backend: SENDER scan again. Read SENDER CONVERSATION below and continue naturally. No boot intro.'
    case 'RECEIVER_FIRST':
      return 'Axerai backend: RECEIVER first scan. Read full SENDER CONVERSATION + RECEIVER CONVERSATION below. Sender history has the gift story.'
    case 'RECEIVER_RETURN':
      return 'Axerai backend: RECEIVER scan again. Read full SENDER CONVERSATION + RECEIVER CONVERSATION below and continue. No repeat boot intro.'
    default:
      return ''
  }
}

function buildPreviousConversationBlock(role, senderThread, receiverThread) {
  const senderBlock = formatThreadBlock('SENDER CONVERSATION (Myra ↔ Sender)', senderThread)
  const receiverBlock = formatThreadBlock('RECEIVER CONVERSATION (Myra ↔ Receiver)', receiverThread)

  if (role === 'RECEIVER') {
    return [
      senderBlock || 'SENDER CONVERSATION (Myra ↔ Sender): (empty)',
      receiverBlock || 'RECEIVER CONVERSATION (Myra ↔ Receiver): (empty)',
    ].join('\n\n')
  }

  return senderBlock || 'No previous conversation saved for this product code yet.'
}

function resolveSessionRole(senderDeviceId, currentDeviceId, hasSenderThread) {
  if (!hasSenderThread) return 'SENDER'
  if (currentDeviceId === senderDeviceId) return 'SENDER'
  return 'RECEIVER'
}

function parseConversationLines(conversation) {
  if (!conversation?.trim()) return []
  return conversation
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^--- session \d+ end ---$/i.test(line)) {
        return { speaker: 'session-end', text: line }
      }
      const metaMatch = line.match(
        /^(session-started|session-ended|session-duration|session-praise):\s*(.+)$/i,
      )
      if (metaMatch) {
        return { speaker: metaMatch[1].toLowerCase(), text: metaMatch[2].trim() }
      }
      const match = line.match(/^(myra|sender|receiver):\s*(.+)$/i)
      if (!match) return { speaker: 'unknown', text: line }
      return { speaker: match[1].toLowerCase(), text: match[2].trim() }
    })
}

function formatLedgerWhen(ts) {
  try {
    return new Date(ts).toLocaleString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

function formatSessionDuration(seconds) {
  if (seconds < 60) return `${seconds} seconds`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins} min ${secs}s` : `${mins} min`
}

function extractCurrentSessionConversation(conversation) {
  const text = String(conversation ?? '').trim()
  if (!text) return ''

  const segments = text.split(/\n--- session \d+ end ---\n/i)
  const lastSegment = (segments[segments.length - 1] ?? '').trim()
  if (!lastSegment) return ''

  return lastSegment
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^--- session \d+ end ---$/i.test(line)) return false
      if (/^session-(started|ended|duration|praise):/i.test(line)) return false
      return true
    })
    .join('\n')
    .trim()
}

/** Times only in conversation — summaries go in session_summaries column. */
function buildSessionConversationFooter({ scanNumber, startedAt, endedAt, durationSeconds, praise }) {
  const lines = [
    `--- session ${scanNumber} end ---`,
    `session-started: ${formatLedgerWhen(startedAt)}`,
    `session-ended: ${formatLedgerWhen(endedAt)}`,
    `session-duration: ${formatSessionDuration(durationSeconds)}`,
  ]
  if (praise?.detected && praise.quote) {
    lines.push(`session-praise: "${praise.quote}"`)
  }
  return lines.join('\n')
}

function buildSessionSummaryEntry({ scanNumber, startedAt, endedAt, durationSeconds, roleKey, summary, praise }) {
  const roleLabel = roleKey === 'receiver' ? 'Receiver' : 'Sender'
  const lines = [
    `--- session ${scanNumber} summary (${roleLabel}) ---`,
    `date: ${formatLedgerWhen(endedAt)}`,
    `started: ${formatLedgerWhen(startedAt)}`,
    `ended: ${formatLedgerWhen(endedAt)}`,
    `duration: ${formatSessionDuration(durationSeconds)}`,
    `summary: ${summary}`,
  ]
  if (praise?.detected && praise.quote) {
    lines.push(`praise: "${praise.quote}"`)
  }
  return lines.join('\n')
}

function detectPraise(userLines) {
  for (const text of userLines) {
    if (PRAISE_PATTERN.test(text)) {
      const quote = String(text).trim().slice(0, 220)
      return { detected: true, quote }
    }
  }
  return { detected: false, quote: '' }
}

function buildSummaryFromConversation(conversation) {
  const sessionOnly = extractCurrentSessionConversation(conversation)
  const lines = parseConversationLines(sessionOnly)
  const userLines = lines
    .filter((line) => line.speaker === 'sender' || line.speaker === 'receiver')
    .map((line) => line.text)
  const myraLines = lines.filter((line) => line.speaker === 'myra').map((line) => line.text)
  const praise = detectPraise(userLines)
  const parts = []

  if (userLines.length) {
    parts.push(`User said ${userLines.length} message(s). Last user: "${userLines[userLines.length - 1].slice(0, 120)}"`)
  }
  if (myraLines.length) {
    parts.push(`Myra replied ${myraLines.length} time(s).`)
  }
  if (praise.detected) {
    parts.push(`Product praise detected: "${praise.quote}"`)
  }

  return {
    summary: parts.join(' ') || 'Session completed with no text captured.',
    praise,
  }
}

function formatThreadBlock(label, thread) {
  if (!thread?.conversation?.trim()) return ''
  return [
    `${label} (device ${String(thread.device_id).slice(0, 8)}…, scans: ${thread.scan_count}):`,
    thread.conversation.trim(),
  ].join('\n')
}

function hasActiveSenderThread(senderThread) {
  if (!senderThread) return false
  return (
    Boolean(String(senderThread.device_id ?? '').trim()) ||
    (senderThread.scan_count ?? 0) > 0 ||
    Boolean(String(senderThread.conversation ?? '').trim())
  )
}

async function ensureThreadRows(verificationCode) {
  if (!supabase || !verificationCode) return

  for (const role of ['sender', 'receiver']) {
    const { data: existing, error: readError } = await supabase
      .from('ledger_threads')
      .select('id')
      .eq('verification_code', verificationCode)
      .eq('role', role)
      .maybeSingle()

    if (readError) {
      console.warn('[Ledger] ensureThreadRows read failed:', readError.message)
      continue
    }

    if (existing) continue

    const { error } = await supabase.from('ledger_threads').insert({
      verification_code: verificationCode,
      device_id: '',
      role,
      scan_count: 0,
      conversation: '',
      session_summaries: '',
    })

    if (error) console.warn(`[Ledger] ensureThreadRows insert ${role} failed:`, error.message)
    else logLedger(`Empty ${role} row ready`, { code: verificationCode })
  }
}

export async function prefetchLedgerMemory(verificationCode) {
  sessionRole = 'SENDER'
  ledgerMemoryText = ''
  ledgerWelcomeMode = 'SENDER_FIRST'

  if (!supabase || !verificationCode) return

  const deviceId = getDeviceId()
  await ensureThreadRows(verificationCode)

  const { data: threads, error } = await supabase
    .from('ledger_threads')
    .select('id, verification_code, device_id, role, scan_count, conversation, session_summaries')
    .eq('verification_code', verificationCode)
    .order('role', { ascending: true })

  if (error) {
    console.warn('[Ledger] prefetch failed:', error.message)
    ledgerMemoryText = `Product code: ${verificationCode}.`
    return
  }

  const senderThread = (threads ?? []).find((row) => row.role === 'sender') ?? null
  const receiverThread = (threads ?? []).find((row) => row.role === 'receiver') ?? null
  const senderDeviceId = String(senderThread?.device_id ?? '').trim() || deviceId

  sessionRole = resolveSessionRole(
    senderDeviceId,
    deviceId,
    hasActiveSenderThread(senderThread),
  )

  if (sessionRole === 'RECEIVER') {
    logLedger('RECEIVER device', {
      yourDevice: deviceId.slice(0, 8) + '…',
      senderDevice: String(senderDeviceId).slice(0, 8) + '…',
    })
  } else {
    logLedger('SENDER device', { device: deviceId.slice(0, 8) + '…' })
  }

  ledgerWelcomeMode = resolveWelcomeMode(sessionRole, senderThread, receiverThread)
  const previousBlock = buildPreviousConversationBlock(sessionRole, senderThread, receiverThread)
  const backendSignal = buildBackendScanSignal(ledgerWelcomeMode)

  ledgerMemoryText = [
    `Product code: ${verificationCode}.`,
    `Session role for this device: ${sessionRole}.`,
    '',
    backendSignal,
    '',
    'LEDGER READ RULE (Rule 13): Lines below are chronological dialogue (older → newer). Read turn-by-turn. Each Myra reply = ONE beat only — never mash unrelated facts in one message.',
    '',
    'PREVIOUS CONVERSATION:',
    previousBlock,
  ].join('\n')

  logLedger('prefetch OK', {
    code: verificationCode,
    role: sessionRole,
    welcomeMode: ledgerWelcomeMode,
    senderLines: parseConversationLines(senderThread?.conversation).length,
    receiverLines: parseConversationLines(receiverThread?.conversation).length,
  })
}

export async function startLedgerScan(verificationCode) {
  if (!supabase || !verificationCode) return null

  const deviceId = getDeviceId()
  const roleKey = roleKeyFromSession()
  activeStartedAt = Date.now()
  activeVerificationCode = verificationCode

  const { data: existing, error: readError } = await supabase
    .from('ledger_threads')
    .select('id, scan_count, device_id')
    .eq('verification_code', verificationCode)
    .eq('role', roleKey)
    .maybeSingle()

  if (readError) {
    console.warn('[Ledger] thread read failed:', readError.message)
    return null
  }

  if (existing) {
    const scanNumber = (existing.scan_count ?? 0) + 1
    activeScanNumber = scanNumber

    const { error } = await supabase
      .from('ledger_threads')
      .update({
        scan_count: scanNumber,
        device_id: deviceId,
      })
      .eq('id', existing.id)

    if (error) {
      console.error('[Ledger] thread update failed:', error.message, error)
      activeThreadId = null
      return null
    }

    activeThreadId = existing.id
    logLedger(`Scan ${scanNumber} resumed`, { code: verificationCode, threadId: activeThreadId, role: roleKey })
    return { scanId: activeThreadId, scanNumber }
  }

  const { data, error } = await supabase
    .from('ledger_threads')
    .insert({
      verification_code: verificationCode,
      device_id: deviceId,
      role: roleKey,
      scan_count: 1,
      conversation: '',
      session_summaries: '',
    })
    .select('id')
    .single()

  if (error) {
    console.error('[Ledger] thread create failed:', error.message, error)
    activeThreadId = null
    return null
  }

  activeThreadId = data.id
  activeScanNumber = 1
  logLedger('Thread created', { code: verificationCode, threadId: activeThreadId, role: roleKey })
  return { scanId: activeThreadId, scanNumber: 1 }
}

export async function appendLedgerMessage(role, text) {
  if (!supabase) {
    console.warn('[Ledger] message skipped — Supabase not configured')
    return false
  }
  if (!activeThreadId) {
    console.warn('[Ledger] message skipped — no active thread (startLedgerScan failed?)')
    return false
  }

  const body = String(text ?? '').trim()
  if (!body) return false

  const speaker = speakerLabelForRole(role)
  const line = `${speaker}: ${body.slice(0, 4000)}`

  const { data: row, error: readError } = await supabase
    .from('ledger_threads')
    .select('conversation')
    .eq('id', activeThreadId)
    .single()

  if (readError) {
    console.error('[Ledger] read conversation failed:', readError.message)
    return false
  }

  const previous = String(row?.conversation ?? '').trim()
  const next = previous ? `${previous}\n${line}` : line

  const { error } = await supabase
    .from('ledger_threads')
    .update({
      conversation: next.slice(0, MAX_CONVERSATION_CHARS),
    })
    .eq('id', activeThreadId)

  if (error) {
    console.error('[Ledger] append failed:', error.message, error)
    return false
  }

  logLedger('line appended', { speaker, threadId: activeThreadId, chars: body.length })
  return true
}

export async function finishLedgerScan() {
  if (!supabase || !activeThreadId) return

  const threadId = activeThreadId
  const endedAt = Date.now()
  const durationSeconds = Math.max(1, Math.round((endedAt - activeStartedAt) / 1000))
  const roleKey = roleKeyFromSession()
  const scanNumber = activeScanNumber

  const { data: row, error: readError } = await supabase
    .from('ledger_threads')
    .select('conversation, session_summaries')
    .eq('id', threadId)
    .single()

  if (readError) {
    console.warn('[Ledger] finish read failed:', readError.message)
  }

  const conversationBeforeFooter = String(row?.conversation ?? '').trim()
  const previousSummaries = String(row?.session_summaries ?? '').trim()
  const { summary, praise } = buildSummaryFromConversation(conversationBeforeFooter)

  const footer = buildSessionConversationFooter({
    scanNumber,
    startedAt: activeStartedAt,
    endedAt,
    durationSeconds,
    praise,
  })

  const conversationWithFooter = conversationBeforeFooter
    ? `${conversationBeforeFooter}\n${footer}`
    : footer

  const summaryEntry = buildSessionSummaryEntry({
    scanNumber,
    startedAt: activeStartedAt,
    endedAt,
    durationSeconds,
    roleKey,
    summary,
    praise,
  })
  const nextSummaries = previousSummaries ? `${previousSummaries}\n\n${summaryEntry}` : summaryEntry

  const { error } = await supabase
    .from('ledger_threads')
    .update({
      conversation: conversationWithFooter.slice(0, MAX_CONVERSATION_CHARS),
      session_summaries: nextSummaries.slice(0, MAX_CONVERSATION_CHARS),
    })
    .eq('id', threadId)

  if (error) console.warn('[Ledger] finish thread failed:', error.message)
  else logLedger(`Thread saved`, { scanNumber, durationSeconds, praise: praise.detected })

  activeThreadId = null
  activeScanNumber = 0
  activeVerificationCode = ''
  activeStartedAt = 0
}

export function getActiveScanNumber() {
  return activeScanNumber
}

/** Full context for Gemini: role + previous chats (DB) + current session (live). */
export function buildGeminiMemoryText() {
  const current = getMyraHistoryText(sessionRole)
  if (!ledgerMemoryText) {
    return `SESSION ROLE: ${sessionRole}\n\nCURRENT SESSION (live):\n${current}`
  }
  return `${ledgerMemoryText}\n\nCURRENT SESSION (live):\n${current}`
}

export async function fetchDashboardThreads(verificationCode = 'R') {
  if (!supabase) return []

  const { data, error } = await supabase
    .from('ledger_threads')
    .select(
      'id, verification_code, device_id, role, scan_count, conversation, session_summaries',
    )
    .eq('verification_code', verificationCode)
    .order('role', { ascending: true })

  if (error) {
    console.warn('[Ledger] dashboard fetch failed:', error.message)
    return []
  }

  return data ?? []
}

/** Parse conversation text into bubble rows for dashboard UI. */
export function parseConversationForDashboard(conversation) {
  return parseConversationLines(conversation).map((line, index) => ({
    speaker: line.speaker,
    text: line.text,
    key: `${line.speaker}-${index}`,
  }))
}

/** @deprecated Use fetchDashboardThreads — kept for compatibility */
export async function fetchDashboardScans(verificationCode = 'R') {
  const threads = await fetchDashboardThreads(verificationCode)
  return threads.map((thread) => ({
    id: thread.id,
    verification_code: thread.verification_code,
    device_id: thread.device_id,
    scan_number: thread.scan_count,
    session_role: thread.role?.toUpperCase(),
    conversation: thread.conversation,
    session_summaries: thread.session_summaries,
  }))
}

/** @deprecated Messages live inside thread.conversation now */
export async function fetchDashboardMessages(_scanId) {
  return []
}
