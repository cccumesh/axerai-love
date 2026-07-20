import { isSupabaseConfigured, supabase } from './supabaseClient.js'
import { isOfflineMyraFallback } from './myraErrorFallback.js'
import { parseBrandProductPraise, summarizeSessionDialogue, buildLocalStorySummary, extractStoryFromSummary, extractFactsFromSummary, mergeKnownFacts, formatKnownFactsBlock, isFactKnown, inferFactsFromText } from './myraSummarize.js'

/** Offline Myra lines (myraErrorFallback.js) are never appended — only live Gemini text. */

const DEVICE_ID_KEY = 'axerai_device_id'
const DEVICE_COOKIE = 'axerai_device_id'
let activeThreadId = null
let activeScanNumber = 0
let activeVerificationCode = ''
let activeStartedAt = 0
let ledgerMemoryText = ''
let sessionRole = 'SENDER'
let ledgerWelcomeMode = 'SENDER_FIRST'
let cachedSenderThread = null
let cachedReceiverThread = null
let cachedVerificationCode = ''
let ledgerFinishPromise = null

export function isLedgerScanActive() {
  return activeThreadId != null
}

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
      return 'Axerai backend: gift-giver first scan. STEP A boot. Then memories for recipient — love, story, her personality, sender life. Rule 22: rich story = stay in flow. Gap probe only when thin.'
    case 'SENDER_RETURN':
      return 'Axerai backend: SENDER return scan. Gayab tease first. Read KNOWN FACTS — never re-ask known name/gift-for/occasion. Continue ONE next missing beat only. No boot intro.'
    case 'RECEIVER_FIRST':
      return 'Axerai backend: RECEIVER first scan. Read sender KNOWN FACTS + PAST STORY (gift story) + receiver CURRENT SESSION in AXERAI LEDGER. One beat at a time.'
    case 'RECEIVER_RETURN':
      return 'Axerai backend: RECEIVER return scan. Gayab tease first. Only real KNOWN FACTS / STORY — never invent or re-ask known facts. One beat only. No boot intro.'
    default:
      return ''
  }
}

function buildPreviousConversationBlock(role, senderThread, receiverThread) {
  const senderBlock = buildCompactThreadBlock('SENDER CONVERSATION (Myra ↔ Sender)', senderThread)
  const receiverBlock = buildCompactThreadBlock('RECEIVER CONVERSATION (Myra ↔ Receiver)', receiverThread)

  if (role === 'RECEIVER') {
    return [
      senderBlock || 'SENDER CONVERSATION (Myra ↔ Sender): (empty)',
      receiverBlock || 'RECEIVER CONVERSATION (Myra ↔ Receiver): (empty)',
    ].join('\n\n')
  }

  return senderBlock || 'No previous conversation saved for this product code yet.'
}

/**
 * Max 2 devices per product code:
 * 1st = SENDER, 2nd = RECEIVER, 3rd+ = rejected.
 */
function resolveSessionAccess(senderThread, receiverThread, currentDeviceId) {
  const senderDeviceId = String(senderThread?.device_id ?? '').trim()
  const receiverDeviceId = String(receiverThread?.device_id ?? '').trim()
  const hasSender = hasActiveSenderThread(senderThread)

  if (!hasSender || !senderDeviceId) {
    return { allowed: true, role: 'SENDER' }
  }
  if (currentDeviceId === senderDeviceId) {
    return { allowed: true, role: 'SENDER' }
  }
  // Receiver seat free, or same receiver device returning
  if (!receiverDeviceId || currentDeviceId === receiverDeviceId) {
    return { allowed: true, role: 'RECEIVER' }
  }
  return { allowed: false, role: null, reason: 'PAIR_FULL' }
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
      if (/^--- session \d+ start ---$/i.test(line)) {
        return { speaker: 'session-start', text: line }
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
  let lastSegment = (segments[segments.length - 1] ?? '').trim()
  if (!lastSegment) return ''

  const startParts = lastSegment.split(/\n--- session \d+ start ---\n/i)
  lastSegment = (startParts[startParts.length - 1] ?? '').trim()

  return lastSegment
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^--- session \d+ (end|start) ---$/i.test(line)) return false
      if (/^session-(started|ended|duration|praise):/i.test(line)) return false
      return true
    })
    .join('\n')
    .trim()
}

/** Drop offline fallback lines from memory/summaries; dedupe back-to-back identical lines. */
function sanitizeSessionDialogue(dialogue) {
  const lines = parseConversationLines(dialogue)
  const cleaned = []

  for (const line of lines) {
    if (line.speaker !== 'myra' && line.speaker !== 'sender' && line.speaker !== 'receiver') {
      continue
    }

    if (line.speaker === 'myra' && isOfflineMyraFallback(line.text)) {
      continue
    }

    const prev = cleaned[cleaned.length - 1]
    if (prev && prev.speaker === line.speaker && prev.text === line.text) continue

    cleaned.push(line)
  }

  return cleaned.map((line) => `${line.speaker}: ${line.text}`).join('\n').trim()
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
    'summary:',
    String(summary ?? '').trim(),
  ]
  if (praise?.detected && praise.quote) {
    lines.push(`praise: "${praise.quote}"`)
  }
  return lines.join('\n')
}

function buildSummaryFromConversation(conversation, roleKey = 'sender', sessionDialogueOverride = null) {
  const sessionOnly = sanitizeSessionDialogue(
    sessionDialogueOverride ?? extractCurrentSessionConversation(conversation),
  )
  const lines = parseConversationLines(sessionOnly)
  const userSpeaker = roleKey === 'receiver' ? 'receiver' : 'sender'
  const userLines = lines.filter((line) => line.speaker === userSpeaker).map((line) => line.text)
  const myraLines = lines.filter((line) => line.speaker === 'myra').map((line) => line.text)

  return {
    summary: buildLocalStorySummary({ roleKey, userLines, myraLines }),
    praise: { detected: false, quote: '' },
  }
}

async function buildSessionSummaryAndPraise({ sessionDialogue, roleKey, scanNumber }) {
  if (!hasDialogueLines(sessionDialogue)) {
    return buildSummaryFromConversation('', roleKey, sessionDialogue)
  }

  try {
    const geminiSummary = await summarizeSessionDialogue({
      dialogue: sessionDialogue,
      roleKey,
      scanNumber,
    })

    if (geminiSummary?.text) {
      void recordGeminiUsage({
        callType: 'summary',
        model: geminiSummary.model,
        promptTokens: geminiSummary.usage?.promptTokens,
        outputTokens: geminiSummary.usage?.outputTokens,
        totalTokens: geminiSummary.usage?.totalTokens,
        scanNumber,
      })

      return {
        summary: geminiSummary.text,
        praise: parseBrandProductPraise(geminiSummary.text),
        source: 'gemini',
      }
    }
  } catch (error) {
    console.warn('[Ledger] Gemini summary failed:', error?.message ?? error)
  }

  logLedger('local fallback summary — brand praise requires Gemini')
  return {
    ...buildSummaryFromConversation('', roleKey, sessionDialogue),
    source: 'fallback',
  }
}

function hasDialogueLines(dialogue) {
  return /^(myra|sender|receiver):/im.test(String(dialogue ?? ''))
}

function hasSummaryForScan(sessionSummaries, scanNumber) {
  return new RegExp(`--- session ${Number(scanNumber)} summary\\b`, 'i').test(
    String(sessionSummaries ?? ''),
  )
}

function hasEndFooterForScan(conversation, scanNumber) {
  return new RegExp(`--- session ${Number(scanNumber)} end ---`, 'i').test(
    String(conversation ?? ''),
  )
}

/** Last session that started but never got an end footer (tab kill / pagehide race). */
function findOpenSessionNumber(conversation) {
  const starts = [...String(conversation ?? '').matchAll(/--- session (\d+) start ---/gi)]
  if (!starts.length) return null
  const scanNumber = Number(starts[starts.length - 1][1])
  if (!Number.isFinite(scanNumber) || scanNumber < 1) return null
  if (hasEndFooterForScan(conversation, scanNumber)) return null
  return scanNumber
}

/**
 * If previous scan never finished (common when user closes tab and rescans),
 * write a LOCAL summary + end footer BEFORE the next session starts.
 * Gemini async summary on pagehide is too slow / often lost.
 */
async function sealOpenThreadSession(thread, roleKey) {
  if (!supabase || !thread?.id) return thread

  const conversation = String(thread.conversation ?? '').trim()
  const previousSummaries = String(thread.session_summaries ?? '').trim()
  const openScan = findOpenSessionNumber(conversation)
  if (openScan == null) return thread

  const sessionDialogue = sanitizeSessionDialogue(extractCurrentSessionConversation(conversation))
  const endedAt = Date.now()
  const startedAt = endedAt
  const durationSeconds = 1

  let summary = ''
  let praise = { detected: false, quote: '' }
  let source = 'already'

  if (!hasSummaryForScan(previousSummaries, openScan)) {
    const local = buildSummaryFromConversation('', roleKey, sessionDialogue)
    summary = local.summary
    praise = local.praise
    source = 'seal-local'
  }

  const footer = hasEndFooterForScan(conversation, openScan)
    ? ''
    : buildSessionConversationFooter({
        scanNumber: openScan,
        startedAt,
        endedAt,
        durationSeconds,
        praise,
      })

  const conversationWithFooter = footer
    ? conversation
      ? `${conversation}\n${footer}`
      : footer
    : conversation

  let nextSummaries = previousSummaries
  if (summary) {
    const summaryEntry = buildSessionSummaryEntry({
      scanNumber: openScan,
      startedAt,
      endedAt,
      durationSeconds,
      roleKey,
      summary,
    praise,
    })
    nextSummaries = previousSummaries ? `${previousSummaries}\n\n${summaryEntry}` : summaryEntry
  }

  if (conversationWithFooter === conversation && nextSummaries === previousSummaries) {
    return thread
  }

  const { error } = await supabase
    .from('ledger_threads')
    .update({
      conversation: conversationWithFooter,
      session_summaries: nextSummaries,
    })
    .eq('id', thread.id)

  if (error) {
    console.warn('[Ledger] seal open session failed:', error.message)
    return thread
  }

  logLedger('sealed open session before next scan', {
    scanNumber: openScan,
    role: roleKey,
    source,
    hadDialogue: hasDialogueLines(sessionDialogue),
  })

  return {
    ...thread,
    conversation: conversationWithFooter,
    session_summaries: nextSummaries,
  }
}

function parseSessionSummaryEntries(sessionSummaries) {
  const text = String(sessionSummaries ?? '').trim()
  if (!text) return []

  const entries = []
  const regex = /--- session (\d+) summary \(([^)]+)\) ---\n([\s\S]*?)(?=\n--- session \d+ summary|$)/gi
  let match
  while ((match = regex.exec(text))) {
    const scanNumber = Number(match[1])
    const role = match[2].trim()
    const block = match[3].trim()
    const multiline = block.match(/^summary:\s*\n([\s\S]*?)(?=\npraise:\s*|$)/im)
    const singleLine = block.match(/^summary:\s*(.+)$/m)
    entries.push({
      scanNumber,
      role,
      summary: multiline?.[1]?.trim() || singleLine?.[1]?.trim() || block.replace(/^summary:\s*/m, '').trim(),
    })
  }
  return entries.sort((a, b) => a.scanNumber - b.scanNumber)
}

/** Gemini memory: each past scan = its own summary block; current scan = full dialogue only. */
function buildCompactThreadBlock(label, thread) {
  const conversation = String(thread?.conversation ?? '').trim()
  const summariesText = String(thread?.session_summaries ?? '').trim()
  const summaryEntries = parseSessionSummaryEntries(summariesText)
  const currentDialogue = sanitizeSessionDialogue(extractCurrentSessionConversation(conversation))

  if (!conversation && !summariesText) return ''

  const lines = [
    `${label} (device ${String(thread.device_id ?? '').slice(0, 8)}…, scans: ${thread.scan_count ?? 0}):`,
  ]

  const factsFromSummaries = summaryEntries.map((entry) => extractFactsFromSummary(entry.summary))
  const factsFromCurrent = currentDialogue
    ? [...currentDialogue.matchAll(/^(?:sender|receiver):\s*(.+)$/gim)].map((m) =>
        inferFactsFromText(m[1]),
      )
    : []
  const lockedFacts = mergeKnownFacts([...factsFromSummaries, ...factsFromCurrent])
  lines.push('')
  lines.push(formatKnownFactsBlock(lockedFacts))

  if (summaryEntries.length) {
    lines.push('')
    lines.push('PAST SESSIONS (story memory per ended scan — use ONE beat at a time, never dump all):')
    for (const entry of summaryEntries) {
      lines.push(`--- Scan ${entry.scanNumber} [${entry.role} thread] ---`)
      lines.push(entry.summary)
    }
  }

  if (currentDialogue && hasDialogueLines(currentDialogue)) {
    lines.push('')
    lines.push('CURRENT SESSION (full dialogue this scan):')
    lines.push(currentDialogue)
  } else if (!summaryEntries.length) {
    lines.push('')
    lines.push('(no chat yet this session)')
  }

  return lines.join('\n')
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
      axerai_ai_usage: '',
      axerai_voice_usage: '',
    })

    if (error) console.warn(`[Ledger] ensureThreadRows insert ${role} failed:`, error.message)
    else logLedger(`Empty ${role} row ready`, { code: verificationCode })
  }
}

function rebuildLedgerMemoryText() {
  const previousBlock = buildPreviousConversationBlock(
    sessionRole,
    cachedSenderThread,
    cachedReceiverThread,
  )
  const backendSignal = buildBackendScanSignal(ledgerWelcomeMode)
  const code = cachedVerificationCode || 'unknown'

  ledgerMemoryText = [
    `Product code: ${code}. Role: ${sessionRole}.`,
    backendSignal,
    '',
    previousBlock || '(empty — first conversation on this product code)',
  ].join('\n')
}

function updateCachedThreadConversation(roleKey, conversation) {
  const trimmed = String(conversation ?? '').trim()
  if (roleKey === 'sender') {
    cachedSenderThread = cachedSenderThread
      ? { ...cachedSenderThread, conversation: trimmed }
      : { conversation: trimmed, device_id: getDeviceId(), scan_count: activeScanNumber }
  } else {
    cachedReceiverThread = cachedReceiverThread
      ? { ...cachedReceiverThread, conversation: trimmed }
      : { conversation: trimmed, device_id: getDeviceId(), scan_count: activeScanNumber }
  }
  rebuildLedgerMemoryText()
}

export async function prefetchLedgerMemory(verificationCode) {
  sessionRole = 'SENDER'
  ledgerMemoryText = ''
  ledgerWelcomeMode = 'SENDER_FIRST'
  cachedSenderThread = null
  cachedReceiverThread = null
  cachedVerificationCode = verificationCode || ''

  if (!supabase || !verificationCode) {
    return { allowed: true, role: 'SENDER' }
  }

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
    return { allowed: true, role: 'SENDER', degraded: true }
  }

  const senderThread = (threads ?? []).find((row) => row.role === 'sender') ?? null
  const receiverThread = (threads ?? []).find((row) => row.role === 'receiver') ?? null
  const access = resolveSessionAccess(senderThread, receiverThread, deviceId)

  if (!access.allowed) {
    cachedSenderThread = senderThread
    cachedReceiverThread = receiverThread
    logLedger('PAIR FULL — third device rejected', {
      code: verificationCode,
      device: deviceId.slice(0, 8) + '…',
      sender: String(senderThread?.device_id ?? '').slice(0, 8) + '…',
      receiver: String(receiverThread?.device_id ?? '').slice(0, 8) + '…',
    })
    return { allowed: false, reason: 'PAIR_FULL' }
  }

  sessionRole = access.role

  if (sessionRole === 'RECEIVER') {
    logLedger('RECEIVER device', {
      yourDevice: deviceId.slice(0, 8) + '…',
      senderDevice: String(senderThread?.device_id ?? '').slice(0, 8) + '…',
    })
  } else {
    logLedger('SENDER device', { device: deviceId.slice(0, 8) + '…' })
  }

  // Seal any open previous scan FIRST — otherwise return welcome has no PAST summary.
  const sealedSender = await sealOpenThreadSession(senderThread, 'sender')
  const sealedReceiver = await sealOpenThreadSession(receiverThread, 'receiver')

  cachedSenderThread = sealedSender
  cachedReceiverThread = sealedReceiver
  ledgerWelcomeMode = resolveWelcomeMode(sessionRole, sealedSender, sealedReceiver)
  rebuildLedgerMemoryText()

  logLedger('prefetch OK', {
    code: verificationCode,
    role: sessionRole,
    welcomeMode: ledgerWelcomeMode,
    senderLines: parseConversationLines(sealedSender?.conversation).length,
    receiverLines: parseConversationLines(sealedReceiver?.conversation).length,
    senderPastSummaries: parseSessionSummaryEntries(sealedSender?.session_summaries).length,
    receiverPastSummaries: parseSessionSummaryEntries(sealedReceiver?.session_summaries).length,
  })

  return { allowed: true, role: sessionRole }
}

async function appendSessionMarker(markerLine) {
  if (!supabase || !activeThreadId) return false

  const { data: row, error: readError } = await supabase
    .from('ledger_threads')
    .select('conversation')
    .eq('id', activeThreadId)
    .single()

  if (readError) return false

  const previous = String(row?.conversation ?? '').trim()
  if (previous.endsWith(markerLine)) return true

  const next = previous ? `${previous}\n${markerLine}` : markerLine
  const { error } = await supabase
    .from('ledger_threads')
    .update({ conversation: next })
    .eq('id', activeThreadId)

  if (error) return false
  updateCachedThreadConversation(roleKeyFromSession(), next)
  return true
}

export async function startLedgerScan(verificationCode) {
  if (!supabase || !verificationCode) return null

  // Wait for in-flight pagehide finish so we don't open session 2 on half-saved session 1.
  if (ledgerFinishPromise) {
    try {
      await ledgerFinishPromise
    } catch {
      // ignore — seal below still covers orphan sessions
    }
  }

  const deviceId = getDeviceId()
  const roleKey = roleKeyFromSession()
  activeStartedAt = Date.now()
  activeVerificationCode = verificationCode

  const { data: existing, error: readError } = await supabase
    .from('ledger_threads')
    .select('id, scan_count, device_id, conversation, session_summaries')
    .eq('verification_code', verificationCode)
    .eq('role', roleKey)
    .maybeSingle()

  if (readError) {
    console.warn('[Ledger] thread read failed:', readError.message)
    return null
  }

  if (existing) {
    const claimedDevice = String(existing.device_id ?? '').trim()
    // Race guard: receiver/sender seat already taken by another phone
    if (claimedDevice && claimedDevice !== deviceId) {
      logLedger('PAIR FULL — seat already claimed', {
        code: verificationCode,
        role: roleKey,
        claimed: claimedDevice.slice(0, 8) + '…',
        you: deviceId.slice(0, 8) + '…',
      })
      return { rejected: true, reason: 'PAIR_FULL' }
    }

    // Seal orphan session before writing the next start marker.
    const sealed = await sealOpenThreadSession(existing, roleKey)
    if (roleKey === 'sender') cachedSenderThread = { ...(cachedSenderThread ?? {}), ...sealed }
    else cachedReceiverThread = { ...(cachedReceiverThread ?? {}), ...sealed }
    rebuildLedgerMemoryText()

    const scanNumber = (sealed.scan_count ?? existing.scan_count ?? 0) + 1
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
    await appendSessionMarker(`--- session ${scanNumber} start ---`)
    rebuildLedgerMemoryText()
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
      axerai_ai_usage: '',
      axerai_voice_usage: '',
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
  await appendSessionMarker('--- session 1 start ---')
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

  if (speaker === 'myra' && isOfflineMyraFallback(body)) {
    logLedger('offline fallback skipped — not saved to ledger')
    return true
  }

  const next = previous ? `${previous}\n${line}` : line

  const { error } = await supabase
    .from('ledger_threads')
    .update({
      conversation: next,
    })
    .eq('id', activeThreadId)

  if (error) {
    console.error('[Ledger] append failed:', error.message, error)
    return false
  }

  updateCachedThreadConversation(roleKeyFromSession(), next)
  logLedger('line appended', { speaker, threadId: activeThreadId, chars: body.length })
  return true
}

export async function finishLedgerScan(options = {}) {
  if (!supabase || !activeThreadId) return
  if (ledgerFinishPromise) return ledgerFinishPromise

  const fastExit = options.fastExit === true

  ledgerFinishPromise = (async () => {
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
      return
    }

    const conversationBeforeFooter = String(row?.conversation ?? '').trim()
    const previousSummaries = String(row?.session_summaries ?? '').trim()

    // Already sealed by next-scan prefetch (or prior finish) — don't duplicate.
    if (
      hasEndFooterForScan(conversationBeforeFooter, scanNumber) &&
      hasSummaryForScan(previousSummaries, scanNumber)
    ) {
      logLedger('finish skipped — session already sealed', { scanNumber, role: roleKey, fastExit })
      activeThreadId = null
      activeScanNumber = 0
      activeVerificationCode = ''
      activeStartedAt = 0
      return
    }

    const sessionDialogue = sanitizeSessionDialogue(
      extractCurrentSessionConversation(conversationBeforeFooter),
    )

    // pagehide/tab close: local summary only (Gemini is too slow and often never saves).
    let summary
    let praise
    let source
    if (fastExit || hasSummaryForScan(previousSummaries, scanNumber)) {
      const local = buildSummaryFromConversation('', roleKey, sessionDialogue)
      summary = hasSummaryForScan(previousSummaries, scanNumber) ? '' : local.summary
      praise = local.praise
      source = hasSummaryForScan(previousSummaries, scanNumber) ? 'already' : 'fast-local'
    } else {
      ;({ summary, praise, source } = await buildSessionSummaryAndPraise({
        sessionDialogue,
        roleKey,
        scanNumber,
      }))
    }

    if (hasDialogueLines(sessionDialogue) && summary) {
      logLedger('session summary saved', {
        scanNumber,
        role: roleKey,
        chars: summary.length,
        praise: praise.detected,
        source,
        fastExit,
      })
    }

    const footer = hasEndFooterForScan(conversationBeforeFooter, scanNumber)
      ? ''
      : buildSessionConversationFooter({
          scanNumber,
          startedAt: activeStartedAt || endedAt,
          endedAt,
          durationSeconds,
          praise,
        })

    const conversationWithFooter = footer
      ? conversationBeforeFooter
        ? `${conversationBeforeFooter}\n${footer}`
        : footer
      : conversationBeforeFooter

    let nextSummaries = previousSummaries
    if (summary && !hasSummaryForScan(previousSummaries, scanNumber)) {
      const summaryEntry = buildSessionSummaryEntry({
        scanNumber,
        startedAt: activeStartedAt || endedAt,
        endedAt,
        durationSeconds,
        roleKey,
        summary,
        praise,
      })
      nextSummaries = previousSummaries ? `${previousSummaries}\n\n${summaryEntry}` : summaryEntry
    }

    const { error } = await supabase
      .from('ledger_threads')
      .update({
        conversation: conversationWithFooter,
        session_summaries: nextSummaries,
      })
      .eq('id', threadId)

    if (error) console.warn('[Ledger] finish thread failed:', error.message)
    else {
      logLedger(`Thread saved`, { scanNumber, durationSeconds, praise: praise.detected, fastExit })
      const roleKeyCache = roleKey
      if (roleKeyCache === 'sender' && cachedSenderThread) {
        cachedSenderThread = {
          ...cachedSenderThread,
          conversation: conversationWithFooter,
          session_summaries: nextSummaries,
        }
      } else if (roleKeyCache === 'receiver' && cachedReceiverThread) {
        cachedReceiverThread = {
          ...cachedReceiverThread,
          conversation: conversationWithFooter,
          session_summaries: nextSummaries,
        }
      }
      rebuildLedgerMemoryText()
    }

    activeThreadId = null
  activeScanNumber = 0
  activeVerificationCode = ''
  activeStartedAt = 0
  })()

  try {
    await ledgerFinishPromise
  } finally {
    ledgerFinishPromise = null
  }
}

export function getActiveScanNumber() {
  return activeScanNumber
}

/** Full context for Gemini: single Axerai Ledger block (DB, refreshed after each append). */
export function buildGeminiMemoryText() {
  if (!ledgerMemoryText) rebuildLedgerMemoryText()
  return ledgerMemoryText
}

/** Append one Axerai AI token usage row to the active (or matching) ledger thread. */
export async function recordGeminiUsage({
  callType,
  model = 'unknown',
  promptTokens = 0,
  outputTokens = 0,
  totalTokens = 0,
  scanNumber = null,
  verificationCode = null,
}) {
  if (!supabase) return false

  const prompt = Math.max(0, Math.round(Number(promptTokens) || 0))
  const output = Math.max(0, Math.round(Number(outputTokens) || 0))
  const total = Math.max(0, Math.round(Number(totalTokens) || 0)) || prompt + output
  if (total <= 0 && prompt <= 0 && output <= 0) return false

  const code = String(verificationCode ?? activeVerificationCode ?? cachedVerificationCode ?? 'R').trim()
  const roleKey = roleKeyFromSession()
  const scan = scanNumber ?? (activeScanNumber > 0 ? activeScanNumber : null)

  const entry = JSON.stringify({
    at: new Date().toISOString(),
    call: String(callType ?? 'unknown').slice(0, 24),
    scan,
    model: String(model).slice(0, 80),
    prompt,
    output,
    total,
  })

  let threadId = activeThreadId

  if (!threadId) {
    const { data: row, error: lookupError } = await supabase
      .from('ledger_threads')
      .select('id, axerai_ai_usage')
      .eq('verification_code', code)
      .eq('role', roleKey)
      .maybeSingle()

    if (lookupError || !row?.id) {
      logLedger('axerai ai usage skipped — thread row missing', { code, role: roleKey, call: callType })
      return false
    }

    const previous = String(row.axerai_ai_usage ?? '').trim()
    const next = previous ? `${previous}\n${entry}` : entry
    const { error } = await supabase
      .from('ledger_threads')
      .update({ axerai_ai_usage: next })
      .eq('id', row.id)

    if (error) {
      console.warn('[Ledger] axerai ai usage save failed:', error.message)
      return false
    }

    logLedger('axerai ai usage saved', { call: callType, total, model, scan, code })
    return true
  }

  const { data: row, error: readError } = await supabase
    .from('ledger_threads')
    .select('axerai_ai_usage')
    .eq('id', threadId)
    .single()

  if (readError) {
    console.warn('[Ledger] axerai ai usage read failed:', readError.message)
    return false
  }

  const previous = String(row?.axerai_ai_usage ?? '').trim()
  const next = previous ? `${previous}\n${entry}` : entry
  const { error } = await supabase
    .from('ledger_threads')
    .update({ axerai_ai_usage: next })
    .eq('id', threadId)

  if (error) {
    console.warn('[Ledger] axerai ai usage save failed:', error.message)
    return false
  }

  logLedger('axerai ai usage saved', { call: callType, total, model, scan, code })
  return true
}

/** Append one Axerai voice token usage row (TTS characters) to the active ledger thread. */
export async function recordElevenLabsUsage({
  characters = 0,
  model = 'eleven_v3',
  voiceId = '',
  callType = 'tts',
  scanNumber = null,
  verificationCode = null,
}) {
  if (!supabase) return false

  const chars = Math.max(0, Math.round(Number(characters) || 0))
  if (chars <= 0) return false

  const code = String(verificationCode ?? activeVerificationCode ?? cachedVerificationCode ?? 'R').trim()
  const roleKey = roleKeyFromSession()
  const scan = scanNumber ?? (activeScanNumber > 0 ? activeScanNumber : null)

  const entry = JSON.stringify({
    at: new Date().toISOString(),
    call: String(callType ?? 'tts').slice(0, 24),
    scan,
    model: String(model).slice(0, 80),
    voice: String(voiceId || '').slice(0, 64),
    chars,
    total: chars,
  })

  let threadId = activeThreadId

  if (!threadId) {
    const { data: row, error: lookupError } = await supabase
      .from('ledger_threads')
      .select('id, axerai_voice_usage')
      .eq('verification_code', code)
      .eq('role', roleKey)
      .maybeSingle()

    if (lookupError || !row?.id) {
      logLedger('axerai voice usage skipped — thread row missing', { code, role: roleKey, call: callType })
      return false
    }

    const previous = String(row.axerai_voice_usage ?? '').trim()
    const next = previous ? `${previous}\n${entry}` : entry
    const { error } = await supabase
      .from('ledger_threads')
      .update({ axerai_voice_usage: next })
      .eq('id', row.id)

    if (error) {
      console.warn('[Ledger] axerai voice usage save failed:', error.message)
      return false
    }

    logLedger('axerai voice usage saved', { call: callType, chars, model, scan, code })
    return true
  }

  const { data: row, error: readError } = await supabase
    .from('ledger_threads')
    .select('axerai_voice_usage')
    .eq('id', threadId)
    .single()

  if (readError) {
    console.warn('[Ledger] axerai voice usage read failed:', readError.message)
    return false
  }

  const previous = String(row?.axerai_voice_usage ?? '').trim()
  const next = previous ? `${previous}\n${entry}` : entry
  const { error } = await supabase
    .from('ledger_threads')
    .update({ axerai_voice_usage: next })
    .eq('id', threadId)

  if (error) {
    console.warn('[Ledger] axerai voice usage save failed:', error.message)
    return false
  }

  logLedger('axerai voice usage saved', { call: callType, chars, model, scan, code })
  return true
}

export function parseElevenLabsUsageEntries(elevenUsageText) {
  const lines = String(elevenUsageText ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
  const entries = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      const chars = Number(parsed.chars ?? parsed.total ?? 0) || 0
      entries.push({
        at: parsed.at ?? '',
        call: parsed.call ?? 'tts',
        scan: parsed.scan ?? null,
        model: parsed.model ?? 'eleven_v3',
        voice: parsed.voice ?? '',
        characters: chars,
        totalTokens: chars,
        threadRole: parsed.threadRole ?? null,
      })
    } catch {
      // skip malformed lines
    }
  }

  return entries
}

/** Sum Axerai voice tokens across sender + receiver threads for dashboard. */
export function buildElevenLabsUsageAnalytics(threads = []) {
  const entries = []
  let totalCharacters = 0

  for (const thread of threads) {
    for (const entry of parseElevenLabsUsageEntries(thread.axerai_voice_usage)) {
      const row = { ...entry, threadRole: thread.role }
      entries.push(row)
      totalCharacters += entry.characters
    }
  }

  entries.sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || ''))

  return {
    totalCharacters,
    totalTokens: totalCharacters,
    entries,
    callCount: entries.length,
  }
}

export function parseGeminiUsageEntries(geminiUsageText) {
  const lines = String(geminiUsageText ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
  const entries = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      entries.push({
        at: parsed.at ?? '',
        call: parsed.call ?? 'unknown',
        scan: parsed.scan ?? null,
        model: parsed.model ?? 'unknown',
        promptTokens: Number(parsed.prompt ?? 0) || 0,
        outputTokens: Number(parsed.output ?? 0) || 0,
        totalTokens: Number(parsed.total ?? 0) || 0,
        threadRole: parsed.threadRole ?? null,
      })
    } catch {
      // skip malformed lines
    }
  }

  return entries
}

/** Sum Axerai AI tokens across sender + receiver threads for dashboard. */
export function buildGeminiUsageAnalytics(threads = []) {
  const entries = []
  let totalTokens = 0
  let promptTokens = 0
  let outputTokens = 0
  const byCall = {
    verify: 0,
    chat: 0,
    welcome: 0,
    summary: 0,
    other: 0,
  }

  for (const thread of threads) {
    for (const entry of parseGeminiUsageEntries(thread.axerai_ai_usage)) {
      const row = { ...entry, threadRole: thread.role }
      entries.push(row)
      totalTokens += entry.totalTokens
      promptTokens += entry.promptTokens
      outputTokens += entry.outputTokens

      const callKey = String(entry.call ?? '').toLowerCase()
      if (callKey in byCall) byCall[callKey] += entry.totalTokens
      else byCall.other += entry.totalTokens
    }
  }

  entries.sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || ''))

  return {
    totalTokens,
    promptTokens,
    outputTokens,
    byCall,
    entries,
    callCount: entries.length,
  }
}

export async function fetchDashboardThreads(verificationCode = 'R') {
  if (!supabase) return []

  const { data, error } = await supabase
    .from('ledger_threads')
    .select(
      'id, verification_code, device_id, role, scan_count, conversation, session_summaries, axerai_ai_usage, axerai_voice_usage',
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

function parseDurationToSeconds(durationText) {
  const text = String(durationText ?? '').trim().toLowerCase()
  if (!text) return 0

  let total = 0
  const minMatch = text.match(/(\d+)\s*min/)
  if (minMatch) total += Number(minMatch[1]) * 60

  const secMatch = text.match(/(\d+)\s*(?:s|sec|seconds?)\b/)
  if (secMatch) total += Number(secMatch[1])

  if (!minMatch && /^\d+\s*seconds?$/.test(text)) {
    total = Number(text.match(/(\d+)/)[1])
  }

  return total
}

export function formatDashboardDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/** Rich per-scan rows from session_summaries column. */
export function parseSessionSummaryDetails(sessionSummaries) {
  const text = String(sessionSummaries ?? '').trim()
  if (!text) return []

  const entries = []
  const regex = /--- session (\d+) summary \(([^)]+)\) ---\n([\s\S]*?)(?=\n--- session \d+ summary|$)/gi
  let match
  while ((match = regex.exec(text))) {
    const scanNumber = Number(match[1])
    const role = match[2].trim()
    const block = match[3].trim()
    const date = block.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? ''
    const durationText = block.match(/^duration:\s*(.+)$/m)?.[1]?.trim() ?? ''
    const praiseMatch = block.match(/^praise:\s*"(.*)"\s*$/m)
    const multiline = block.match(/^summary:\s*\n([\s\S]*?)(?=\npraise:\s*|$)/im)
    const singleLine = block.match(/^summary:\s*(.+)$/m)
    const summary =
      multiline?.[1]?.trim() || singleLine?.[1]?.trim() || block.replace(/^summary:\s*/m, '').trim()
    const brandPraise = parseBrandProductPraise(summary)
    const praiseQuote = praiseMatch?.[1]?.trim() || brandPraise.quote || ''
    const storyBody = extractStoryFromSummary(summary)
    const userSaidMatch = summary.match(
      /USER SAID:\s*\n([\s\S]*?)(?=\n\nMYRA SAID:|\n\nBRAND PRODUCT PRAISE:|$)/i,
    )
    const legacyUserMatch = !userSaidMatch
      ? summary.match(
          /(?:SENDER|RECEIVER) SAID:\s*\n([\s\S]*?)(?=\n\nMYRA SAID:|\n\nBRAND PRODUCT PRAISE:|\n\nFACTS TO REMEMBER:|$)/i,
        )
      : null
    const legacyUserSaid = (userSaidMatch?.[1] ?? legacyUserMatch?.[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/^(sender|receiver):\s*/i, '').replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean)
      .join(' | ')
    // Prefer story narrative for dashboard / memory snippets; fall back to legacy USER SAID.
    const userSaid = storyBody || legacyUserSaid

    entries.push({
      scanNumber,
      role,
      date,
      durationText,
      durationSeconds: parseDurationToSeconds(durationText),
      praiseDetected: Boolean(praiseQuote) || brandPraise.detected,
      praiseQuote,
      userSaid,
      summary,
    })
  }

  return entries.sort((a, b) => a.scanNumber - b.scanNumber)
}

/** Per-scan rows parsed from conversation footers (fallback / merge). */
export function parseSessionRecordsFromConversation(conversation, roleKey = 'sender') {
  const text = String(conversation ?? '')
  if (!text.trim()) return []

  const userSpeaker = roleKey === 'receiver' ? 'receiver' : 'sender'
  const records = []
  const blockRegex =
    /--- session (\d+) start ---\n([\s\S]*?)--- session \1 end ---\n([\s\S]*?)(?=--- session \d+ start ---|$)/gi
  let match
  while ((match = blockRegex.exec(text))) {
    const scanNumber = Number(match[1])
    const dialogue = match[2]
    const footer = match[3]
    const started = footer.match(/^session-started:\s*(.+)$/m)?.[1]?.trim() ?? ''
    const ended = footer.match(/^session-ended:\s*(.+)$/m)?.[1]?.trim() ?? ''
    const durationText = footer.match(/^session-duration:\s*(.+)$/m)?.[1]?.trim() ?? ''
    const praiseMatch = footer.match(/^session-praise:\s*"(.*)"\s*$/m)
    const praiseQuote = praiseMatch?.[1]?.trim() ?? ''
    const userLines = parseConversationLines(dialogue)
      .filter((line) => line.speaker === userSpeaker)
      .map((line) => line.text)

    records.push({
      scanNumber,
      role: roleKey === 'receiver' ? 'Receiver' : 'Sender',
      date: ended || started,
      started,
      ended,
      durationText,
      durationSeconds: parseDurationToSeconds(durationText),
      praiseDetected: Boolean(praiseQuote),
      praiseQuote,
      userSaid: userLines.join(' | '),
    })
  }

  return records.sort((a, b) => a.scanNumber - b.scanNumber)
}

/** Aggregate stats + merged per-scan table rows for dashboard. */
export function buildDashboardAnalytics(threads = []) {
  const sessions = []

  for (const thread of threads) {
    const roleKey = thread.role === 'receiver' ? 'receiver' : 'sender'
    const fromConversation = parseSessionRecordsFromConversation(thread.conversation, roleKey)
    const fromSummaries = parseSessionSummaryDetails(thread.session_summaries)
    const byScan = new Map()

    for (const row of fromConversation) {
      byScan.set(row.scanNumber, {
        ...row,
        threadRole: roleKey,
        threadId: thread.id,
      })
    }

    for (const row of fromSummaries) {
      const existing = byScan.get(row.scanNumber) ?? {}
      byScan.set(row.scanNumber, {
        ...existing,
        ...row,
        threadRole: roleKey,
        threadId: thread.id,
        userSaid: row.userSaid || existing.userSaid || '',
        praiseDetected: row.praiseDetected || existing.praiseDetected,
        praiseQuote: row.praiseQuote || existing.praiseQuote || '',
        durationSeconds: row.durationSeconds || existing.durationSeconds || 0,
        date: row.date || existing.date || existing.ended || '',
      })
    }

    for (const row of byScan.values()) sessions.push(row)
  }

  sessions.sort((a, b) => {
    const aTime = Date.parse(a.date || a.ended || '') || 0
    const bTime = Date.parse(b.date || b.ended || '') || 0
    if (aTime !== bTime) return aTime - bTime
    return a.scanNumber - b.scanNumber
  })

  const totalScans = threads.reduce((sum, thread) => sum + (thread.scan_count ?? 0), 0)
  const totalTalkTimeSeconds = sessions.reduce((sum, row) => sum + (row.durationSeconds ?? 0), 0)
  const positiveCount = sessions.filter((row) => row.praiseDetected).length
  const praiseQuotes = sessions
    .filter((row) => row.praiseQuote)
    .map((row) => ({
      scanNumber: row.scanNumber,
      role: row.threadRole,
      quote: row.praiseQuote,
    }))

  const lastSession = sessions[sessions.length - 1]
  const lastScanDate = lastSession?.date || lastSession?.ended || ''

  return {
    totalScans,
    totalTalkTimeSeconds,
    positiveCount,
    praiseQuotes,
    lastScanDate,
    sessions,
  }
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
