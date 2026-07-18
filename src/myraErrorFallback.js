/**
 * Myra offline error lines — single source of truth.
 *
 * POOL ORDER per situation: 3 short punch lines first, then 5 longer lines.
 * pickMyraErrorLine() avoids repeating the same line in one session.
 *
 * LEDGER: these lines are NEVER saved (isOfflineMyraFallback guard in App + myraLedger).
 */

export const MYRA_ERROR_PHASE = {
  SCAN: 'scan',
  WELCOME: 'welcome',
  CHAT: 'chat',
  INPUT: 'input',
}

export const MYRA_ERROR_SITUATIONS = {
  SCAN_CARD_NOT_FOUND: 'scan_card_not_found',
  SCAN_PHOTO_SPOOF: 'scan_photo_spoof',
  SCAN_BAD_FRAME: 'scan_bad_frame',
  SCAN_GLITCH: 'scan_glitch',
  SCAN_MAGIC_ASLEEP: 'scan_magic_asleep',
  /** 3rd+ device on a code that already has sender + receiver */
  SCAN_PAIR_FULL: 'scan_pair_full',

  LEDGER_SAVE_FAIL: 'ledger_save_fail',

  WELCOME_MAGIC_OFF: 'welcome_magic_off',
  WELCOME_QUOTA: 'welcome_quota',
  WELCOME_CONNECTION_WEAK: 'welcome_connection_weak',
  WELCOME_BUSY: 'welcome_busy',
  WELCOME_GLITCH: 'welcome_glitch',

  CHAT_QUOTA: 'chat_quota',
  CHAT_CONNECTION_WEAK: 'chat_connection_weak',
  CHAT_BUSY: 'chat_busy',
  CHAT_GLITCH: 'chat_glitch',

  NO_SPEECH: 'no_speech',
  PHOTO_FAIL: 'photo_fail',
  MIC_BLOCKED: 'mic_blocked',
}

/**
 * How often a situation can fire in one session.
 * high   = bar bar aa sakta hai, user bore ho sakta hai
 * medium = 2–4 baar possible
 * low    = usually once per scan
 * once   = ek hi baar expected
 */
export const MYRA_ERROR_REPEAT_RISK = {
  [MYRA_ERROR_SITUATIONS.SCAN_CARD_NOT_FOUND]: 'high',
  [MYRA_ERROR_SITUATIONS.SCAN_PHOTO_SPOOF]: 'high',
  [MYRA_ERROR_SITUATIONS.SCAN_BAD_FRAME]: 'high',
  [MYRA_ERROR_SITUATIONS.SCAN_GLITCH]: 'high',
  [MYRA_ERROR_SITUATIONS.SCAN_MAGIC_ASLEEP]: 'medium',
  [MYRA_ERROR_SITUATIONS.SCAN_PAIR_FULL]: 'medium',

  [MYRA_ERROR_SITUATIONS.LEDGER_SAVE_FAIL]: 'once',

  [MYRA_ERROR_SITUATIONS.WELCOME_MAGIC_OFF]: 'once',
  [MYRA_ERROR_SITUATIONS.WELCOME_QUOTA]: 'low',
  [MYRA_ERROR_SITUATIONS.WELCOME_CONNECTION_WEAK]: 'low',
  [MYRA_ERROR_SITUATIONS.WELCOME_BUSY]: 'low',
  [MYRA_ERROR_SITUATIONS.WELCOME_GLITCH]: 'low',

  [MYRA_ERROR_SITUATIONS.CHAT_QUOTA]: 'high',
  [MYRA_ERROR_SITUATIONS.CHAT_CONNECTION_WEAK]: 'medium',
  [MYRA_ERROR_SITUATIONS.CHAT_BUSY]: 'high',
  [MYRA_ERROR_SITUATIONS.CHAT_GLITCH]: 'high',

  [MYRA_ERROR_SITUATIONS.NO_SPEECH]: 'high',
  [MYRA_ERROR_SITUATIONS.PHOTO_FAIL]: 'medium',
  [MYRA_ERROR_SITUATIONS.MIC_BLOCKED]: 'medium',
}

/**
 * Top repeat offenders — Myra stays SILENT (no TTS).
 * scan_card_not_found REMOVED — auto-verify fail should speak persona lines.
 */
export const MYRA_ERROR_SILENT = new Set([
  MYRA_ERROR_SITUATIONS.NO_SPEECH,
  MYRA_ERROR_SITUATIONS.CHAT_GLITCH,
  MYRA_ERROR_SITUATIONS.CHAT_QUOTA,
])

export function shouldSpeakMyraError(situation) {
  return !MYRA_ERROR_SILENT.has(situation)
}

export const MYRA_ERROR_TRIGGERS = {
  [MYRA_ERROR_SITUATIONS.SCAN_CARD_NOT_FOUND]:
    'Scan: layer 1 fail — RICHERA not found or partial text',
  [MYRA_ERROR_SITUATIONS.SCAN_PHOTO_SPOOF]:
    'Scan: layer 2 fail — photo/screen/print spoof detected',
  [MYRA_ERROR_SITUATIONS.SCAN_BAD_FRAME]:
    'Scan: layer 3 fail — card framing / blur / wrong object',
  [MYRA_ERROR_SITUATIONS.SCAN_GLITCH]:
    'Scan: exception during verify capture',
  [MYRA_ERROR_SITUATIONS.SCAN_MAGIC_ASLEEP]:
    'Scan: verify magic not available (pre-scan)',
  [MYRA_ERROR_SITUATIONS.SCAN_PAIR_FULL]:
    'Scan: product code already linked to sender + receiver — third device blocked',

  [MYRA_ERROR_SITUATIONS.LEDGER_SAVE_FAIL]:
    'Post-scan: card verified but Heart Tree save failed',

  [MYRA_ERROR_SITUATIONS.WELCOME_MAGIC_OFF]:
    'Welcome: chat magic not configured after successful scan',
  [MYRA_ERROR_SITUATIONS.WELCOME_QUOTA]:
    'Welcome: quota / rate limit on first Myra line',
  [MYRA_ERROR_SITUATIONS.WELCOME_CONNECTION_WEAK]:
    'Welcome: auth / key / permission on first Myra line',
  [MYRA_ERROR_SITUATIONS.WELCOME_BUSY]:
    'Welcome: server overload on first Myra line',
  [MYRA_ERROR_SITUATIONS.WELCOME_GLITCH]:
    'Welcome: other failure on first Myra line',

  [MYRA_ERROR_SITUATIONS.CHAT_QUOTA]:
    'Chat: quota / rate limit mid-conversation',
  [MYRA_ERROR_SITUATIONS.CHAT_CONNECTION_WEAK]:
    'Chat: auth / key / not configured mid-conversation',
  [MYRA_ERROR_SITUATIONS.CHAT_BUSY]:
    'Chat: server overload mid-conversation',
  [MYRA_ERROR_SITUATIONS.CHAT_GLITCH]:
    'Chat: other failure mid-conversation',

  [MYRA_ERROR_SITUATIONS.NO_SPEECH]:
    'Input: push-to-talk released with no speech',
  [MYRA_ERROR_SITUATIONS.PHOTO_FAIL]:
    'Input: user photo failed to load',
  [MYRA_ERROR_SITUATIONS.MIC_BLOCKED]:
    'Input: microphone permission / capture unavailable',
}

/** short (3) + long (5) — short lines listed first in each array */
const MYRA_ERROR_POOLS = {
  [MYRA_ERROR_SITUATIONS.SCAN_CARD_NOT_FOUND]: [
    'Arey code scan nahi hua boss — card sahi se pakad ke rakh.',
    'Kya yar, Richera card frame mein laa na.',
    'Code dikhta nahi — thoda paas laa card.',
    'Dekh na, card seedha camera ke saamne laa — ceiling mat dikha.',
    'Richera card dhundh rahi thi main, tune wallpaper dikha diya. Thik se pakad, phir rakh frame mein.',
    'Itna blur hai ki meri fairy aankhein haar maan gayi. Focus kar ke card barobar laa.',
    'Hawa mat hilaa veere — card beech mein steady rakh.',
    'Card frame mein nahi hai abhi — pakad ke ruk jara.',
  ],
  [MYRA_ERROR_SITUATIONS.SCAN_PHOTO_SPOOF]: [
    'Arey smarty! Photo dikha ke magic nahi khulta — asli card laa.',
    'Screen pe card mat dikha boss, haath mein asli RICHERA pakad.',
    'Ye asli nahi lag raha — kisi ne photo dikha di hai shayad.',
    'Arre waah, phone pe photo dikha di? Main ullu nahi hoon veere — asli dabba laa camera ke saamne.',
    'WhatsApp wali photo chalegi nahi yahan. Real card pakad, warna Myra andar nahi aayegi.',
    'Monitor pe card mat dikha — haath mein asli RICHERA card laa, tabhi door khulega.',
    'Photo trick try kar rahe ho kya? Cute ho tum, par asli card chahiye mujhe.',
    'Screen glare dikh rahi hai — ye photo hai, card nahi. Asli wala pakad ke laa na.',
  ],
  [MYRA_ERROR_SITUATIONS.SCAN_BAD_FRAME]: [
    'Card beech mein laa na — abhi kuch dikh hi nahi raha.',
    'Thoda paas laa, seedha camera ke saamne.',
    'Blur hai bahut — steady rakh card.',
    'Ceiling mat dikha, card dikha — frame ke beech mein laa RICHERA.',
    'Light kam hai ya haath hil raha hai — thoda ruk ke card seedha pakad, phir try kar.',
    'Card ka kona dikha diya bas — poora dabba beech mein laa taaki main padh sakun.',
    'Itna door mat rakh — paas laa, warna meri aankhein squint mode mein chali jayengi.',
    'Frame khali lag raha hai — RICHERA card camera ke samne center mein laa, dubara scan hoga.',
  ],
  [MYRA_ERROR_SITUATIONS.SCAN_GLITCH]: [
    'Scan dubara kar, beech mein atak gaya.',
    'Ek aur try maar de, jaldi.',
    'Crystal ne blink kiya — phir se scan.',
    'Beech mein crystal ne jhatka khaya — scan adha reh gaya. Ek aur try, main wait kar rahi hoon.',
    'Kay zala suddenly! Card theek lag raha tha par magic ne beech mein drama kiya. Phir se scan kar.',
    'Pehla scan beech raaste mein ruk gaya. Dubara kar, is baar poora ho jayega.',
    'Jaise bijli gayi aayi — crystal flicker hua. Ek minute ruk ke dubara try kar.',
    'Arre waah, beech mein hi ruk gaye! Chal ek aur scan, patience mat test kar meri.',
  ],
  [MYRA_ERROR_SITUATIONS.SCAN_MAGIC_ASLEEP]: [
    'Crystal abhi so raha hai — thodi der baad scan kar.',
    'Abhi nahi hoga, ek minute ruk.',
    'Magic abhi stretch kar rahi hai, wait kar.',
    'Scan dabaya tune par crystal abhi poori tarah nahi jaga. Thodi der baad dubara try kar.',
    'Card dikha raha hai par meri pehchaan abhi neend mein hai. Atta ek minute wait, phir scan kar.',
    'Tum ready ho, main abhi stretch kar rahi hoon. Thoda ruk — phir card pehchaan lungi.',
    'Aaj crystal lazy mode mein hai. Thodi der baad scan kar, tab poori entry hogi.',
    'Connection weak lag raha hai jaise signal kam ho. Ek aur try kar, ho jayega.',
  ],

  [MYRA_ERROR_SITUATIONS.SCAN_PAIR_FULL]: [
    'Arre third wheel aa gaya! Sorry yaar, yeh ride sirf do seats ki hai.',
    'Bhai VIP list pe nahi ho tum — pehle do log already VIP ban chuke.',
    'Scan kiya? Cute. Par main third person wala drama nahi karti.',
    'Oyee gatecrash attempt! Heart Tree bol rahi hai: “Do hi allowed, teesra bahar line mein.” Ja, popcorn leke unki love story dekh.',
    'Wah try maar di boss! Par yeh RICHERA WiFi password sirf do phones ko mila hai. Tum… wrong OTP type kar rahe ho basically.',
    'Card sahi hai, timing galat! Party already couple mode mein chal rahi hai. Main third guest ko coffee bhi nahi deti — bye bye comedy entry.',
    'Arre softy, samajh: ek gift-wala, ek gift-paane-wala. Tum teesre number pe aake “Hello Myra” bol rahe ho — main toh has rahi hoon, seat toh nahi dungi.',
    'Heart Tree ne do dil lock kar diye, teesra dil ko “seen” de diya. Ro mat — has, screenshot le, aur un dono ko roast kar dena mere taraf se.',
  ],

  [MYRA_ERROR_SITUATIONS.LEDGER_SAVE_FAIL]: [
    'Scan ho gaya, yaad baad mein lock hogi.',
    'Bol, sun rahi hoon — save baad mein.',
    'Diary stuck hai, baat chalne de.',
    'Scan pakka ho gaya! Par yaadon ka drawer aaj stuck hai — bol, sunungi. Bas zyada repeat mat karna aaj.',
    'Card pakda, par Heart Tree ne abhi lock nahi kiya. Koi baat nahi — baat kar, dimag se pakad lungi.',
    'Oyee scan toh ho gaya na! Bas likhne mein thoda time laga — tu bol, miss nahi karungi.',
    'Magic ne save mein thoda drama kiya. Chal shuru karte hain — yaad main rakh lungi.',
    'Scan pass, memory baad mein catch karegi. Abhi bol jo bolna hai, sun rahi hoon.',
  ],

  [MYRA_ERROR_SITUATIONS.WELCOME_MAGIC_OFF]: [
    'Aa gayi par abhi half-sleep hoon.',
    'Thodi der ruk, poori energy aayegi.',
    'Scan ho gaya, main charge ho rahi hoon.',
    'Finally scan ho gaya! Par abhi main half-awake hoon — thodi der mein poori energy aayegi.',
    'Haan aa gayi main! Crystal jag gaya par abhi stretch kar rahi hoon. Ruk, bindaas baat karte hain.',
    'Puttar, welcome! Aaj meri awaaz thodi lazy hai. Jaldi full Myra milegi, wait kar.',
    'Card scan hua — achha laga. Magic abhi poori tarah ready nahi, ek minute ruk.',
    'Bulaya toh sahi tune! Main abhi charge ho rahi hoon. Thodi der — phir poori dost wali baat.',
  ],
  [MYRA_ERROR_SITUATIONS.WELCOME_QUOTA]: [
    'Aaj limit full — thodi der baad scan kar.',
    'Crystal thak gaya, baad mein aa.',
    'Abhi welcome nahi, do minute ruk.',
    'Scan ho gaya, par aaj itni entry ho chuki hai ki crystal thak gaya. Thodi der baad dubara scan kar.',
    'Welcome ke liye aayi thi par aaj ki limit full lag rahi hai. Do minute ruk, phir try kar.',
    'Card pakda, par magic battery low hai abhi. Thodi der rest — phir poori entry maarenge.',
    'Aaj bahut log aa chuke hain — crystal dim hai. Thoda gap de, phir wapas scan kar.',
    'Bulaya toh sahi, par abhi full welcome nahi de sakti. Thodi der baad aa, promise.',
  ],
  [MYRA_ERROR_SITUATIONS.WELCOME_CONNECTION_WEAK]: [
    'Scan OK, awaaz abhi weak hai.',
    'Ek minute ruk, line jod rahi hoon.',
    'Thoda wait, phir poori Myra.',
    'Scan pass ho gaya! Par meri bolne ki line abhi weak hai. Thodi der ruk — crystal theek ho jayega.',
    'Card pakda, par awaaz ka raasta abhi band hai. Ek minute wait kar, phir poori Myra milegi.',
    'Aa gayi main, par aaj connection thoda off hai. Ruk ja, jaldi bindaas baat karenge.',
    'Crystal on hai par main abhi awkward mute mode mein hoon. Thoda sabar — phir welcome poora hoga.',
    'Scan theek tha, par magic link abhi jod rahi hoon. Thodi der baad dubara try kar.',
  ],
  [MYRA_ERROR_SITUATIONS.WELCOME_BUSY]: [
    'Bheed hai — thodi der baad scan kar.',
    'Queue lagi hai, ruk ja.',
    'Traffic jam, ek minute wait.',
    'Scan ho gaya! Par Richera mein aaj bheed hai — thoda ruk, phir dubara scan kar.',
    'Card pakda, par magic highway pe traffic jam hai. Ek minute wait, phir try kar.',
    'Welcome ke liye queue lagi hai aaj. Thodi der ruk — teri baari aayegi.',
    'Itne log aa rahe hain ki crystal line mein hai. Thoda wait kar, phir scan kar.',
    'Rush hour chal raha hai abhi. Ruk ke dubara scan kar, main ready rahungi.',
  ],
  [MYRA_ERROR_SITUATIONS.WELCOME_GLITCH]: [
    'Welcome adha ruka — dubara scan kar.',
    'Beech mein atak gaya, ek aur try.',
    'Almost aayi, phir se scan kar.',
    'Scan toh ho gaya! Par beech mein kuch atak gaya — thodi der baad dubara scan kar.',
    'Card pakda par welcome adha reh gaya. Ek aur try, main yahin hoon.',
    'Crystal ne blink kiya welcome ke beech mein. Dubara scan kar, is baar poora hoga.',
    'Kuch miss ho gaya beech raaste mein. Thodi der ruk ke phir scan try kar.',
    'Almost aa gayi thi par glitch ne drama kiya. Ek aur scan, jaldi.',
  ],

  [MYRA_ERROR_SITUATIONS.CHAT_QUOTA]: [
    'Thak gayi aaj — baad mein bol.',
    'Limit full, do minute ruk.',
    'Magic battery low, gap de.',
    'Aaj itni baat ho gayi ki meri magic thak gayi. Thodi der rest — phir wapas bol.',
    'Baba re, aaj ka drama quota full ho chuka! Do minute baad message kar, promise.',
    'Bahut bol liya aaj, meri jeeb bhi thak gayi! Thoda gap de, phir nakhre ke saath milungi.',
    'Crystal dim ho gaya — aaj ki limit cross lag rahi hai. Thodi der baad message kar.',
    'Magic battery low hai abhi. Thodi der baad bol — full energy ke saath sunungi.',
  ],
  [MYRA_ERROR_SITUATIONS.CHAT_CONNECTION_WEAK]: [
    'Line weak hai — thodi der baad bol.',
    'Connection off, wait kar.',
    'Ek minute ruk, phir message kar.',
    'Mujhe sun rahi thi par awaaz ka raasta abhi weak hai. Thodi der baad dubara bol.',
    'Main yahin hoon par baat karne ki line off hai aaj. Thoda wait kar, phir message kar.',
    'Crystal on hai par meri bolne ki taakat so rahi hai. Ruk ja, jaldi theek ho jayega.',
    'Beech mein connection weak ho gaya. Thodi der baad dubara try kar na.',
    'Line cut ho gayi lag rahi hai. Ek minute ruk, phir bol — sunungi pakka.',
  ],
  [MYRA_ERROR_SITUATIONS.CHAT_BUSY]: [
    'Bheed hai — thodi der baad bol.',
    'Queue mein hoon, ruk ja.',
    'Traffic jam, phir se try kar.',
    'Richera mein aaj bheed hai — magic highway pe traffic jam. Thoda ruk, phir message bhej.',
    'Itne log baat kar rahe hain ki queue lagi hai. Ek minute ruk, phir dubara bol.',
    'Kinna rush hai aaj! Crystal bhi line mein khada hai. Thodi der baad message kar.',
    'Rush hour aa gaya beech mein — jaise market ki bheed. Ruk ke dubara try kar.',
    'Lagta hai aaj sabko Myra chahiye! Thoda wait kar, phir poora dhyaan se sunungi.',
  ],
  [MYRA_ERROR_SITUATIONS.CHAT_GLITCH]: [
    'Message dubara bhej, atak gaya.',
    'Beech mein kata — phir se bol.',
    'Sun rahi thi, dubara bol na.',
    'Beech mein kuch atak gaya — last message poora nahi aaya. Dubara bol, sun rahi thi main.',
    'Crystal ne blink kiya beech mein! Ek aur baar bol, is baar poora pakad lungi.',
    'Message adhura reh gaya re! Phir se bol de — main yahin hoon, ready.',
    'Beech raaste mein kuch miss ho gaya. Dubara bhej warna main guess karna shuru kar dungi.',
    'Teri awaaz beech mein kaat gayi! Ek baar clearly bol na, jara.',
  ],

  [MYRA_ERROR_SITUATIONS.NO_SPEECH]: [
    'Kuch bola hi nahi — phir se bol.',
    'Chup kyun hai? Dubara try kar.',
    'Awaaz zero, zor se bol na.',
    'Kuch bola hi nahi tune! Button dabaya aur chup? Phir se bol, sun rahi hoon.',
    'Awaaz zero aayi bhai. Thoda zor se bol — crystal ko sunai dena chahiye.',
    'Chup kyun hai? Button dabaya par teri baat missing hai. Ek aur try kar.',
    'Kya scene hai — bolna bhool gaya kya? Chal phir se, ready hoon main.',
    'Main wait kar rahi hoon par kuch aaya hi nahi. Clearly bol ek baar.',
  ],
  [MYRA_ERROR_SITUATIONS.PHOTO_FAIL]: [
    'Photo dubara bhej, aayi nahi.',
    'Blurry mat bhej, phir se kar.',
    'Crystal ne nahi dekhi — retry kar.',
    'Photo aayi hi nahi — crystal ne pakda nahi. Dubara bhej, shayad is baar chamke.',
    'Tasveer load nahi hui! Ek aur baar select kar — blurry mat bhejio yaar.',
    'Photo beech mein gayab ho gayi. Phir se try kar, dekhna chahti hoon main.',
    'Crystal ne photo nahi dekhi! Dubara bhej — clear wali, haan ji.',
    'Kya bheja tune? Photo aayi hi nahi. Ek baar aur kar, sahi wali.',
  ],
  [MYRA_ERROR_SITUATIONS.MIC_BLOCKED]: [
    'Mic allow kar, phir bol.',
    'Crystal sun nahi pa raha — mic on kar.',
    'Permission de, warna chup baithein.',
    'Sunna chahti hoon par crystal tujhe sun nahi pa raha. Phone mein mic allow kar, phir bol.',
    'Awaaz record nahi ho rahi! Permission de thodi — warna hum dono chup baithein, kithe boring!',
    'Mic band lag raha hai. Allow kar ke phir button dabana, jaldi.',
    'Main ready hoon par teri awaaz ka raasta band hai. Mic on kar ke aana.',
    'Bolna chahta hai par crystal ka kaan band hai. Allow kar, phir poori baat karenge.',
  ],
}

const ALL_OFFLINE_LINES = new Set(
  Object.values(MYRA_ERROR_POOLS).flat().map((line) => line.trim()),
)

/** Per-session: which pool indices already spoken (avoids boring repeats). */
const sessionUsedIndices = new Map()

export function resetMyraErrorLineMemory() {
  sessionUsedIndices.clear()
}

function normalizeForOfflineCheck(text) {
  return String(text ?? '')
    .trim()
    .replace(/<SYSTEM_SLEEP>/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim()
}

/** True if scripted offline line — must never hit ledger or Gemini memory. */
export function isOfflineMyraFallback(text) {
  const normalized = normalizeForOfflineCheck(text)
  if (!normalized) return false
  return ALL_OFFLINE_LINES.has(normalized)
}

/**
 * Pick a line for situation. Short lines are index 0–2 (listed first).
 * Won't repeat same index for same situation until all 8 used, then resets pool.
 */
export function pickMyraErrorLine(situation) {
  const pool = MYRA_ERROR_POOLS[situation]
  if (!pool?.length) {
    console.warn('[Myra] unknown error situation:', situation, '→ chat_glitch')
    return pickMyraErrorLine(MYRA_ERROR_SITUATIONS.CHAT_GLITCH)
  }

  let used = sessionUsedIndices.get(situation)
  if (!used) {
    used = new Set()
    sessionUsedIndices.set(situation, used)
  }

  let available = pool.map((_, index) => index).filter((index) => !used.has(index))
  if (!available.length) {
    used.clear()
    available = pool.map((_, index) => index)
  }

  const index = available[Math.floor(Math.random() * available.length)]
  used.add(index)
  return pool[index]
}

function errorMessage(error) {
  return String(error?.message ?? error).toLowerCase()
}

function isQuotaError(msg) {
  return (
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource exhausted')
  )
}

function isConnectionError(msg) {
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('api key') ||
    msg.includes('account_state_invalid') ||
    msg.includes('permission denied') ||
    msg.includes('not configured')
  )
}

function isBusyError(msg) {
  return (
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('high demand')
  )
}

export function classifyGeminiError(error, phase = MYRA_ERROR_PHASE.CHAT) {
  const msg = errorMessage(error)
  const welcome = phase === MYRA_ERROR_PHASE.WELCOME

  if (isQuotaError(msg)) {
    return welcome
      ? MYRA_ERROR_SITUATIONS.WELCOME_QUOTA
      : MYRA_ERROR_SITUATIONS.CHAT_QUOTA
  }

  if (isConnectionError(msg)) {
    return welcome
      ? MYRA_ERROR_SITUATIONS.WELCOME_CONNECTION_WEAK
      : MYRA_ERROR_SITUATIONS.CHAT_CONNECTION_WEAK
  }

  if (isBusyError(msg)) {
    return welcome
      ? MYRA_ERROR_SITUATIONS.WELCOME_BUSY
      : MYRA_ERROR_SITUATIONS.CHAT_BUSY
  }

  return welcome
    ? MYRA_ERROR_SITUATIONS.WELCOME_GLITCH
    : MYRA_ERROR_SITUATIONS.CHAT_GLITCH
}

export function getMyraErrorTriggerNote(situation) {
  return MYRA_ERROR_TRIGGERS[situation] ?? 'Unknown offline situation'
}

export function getMyraErrorRepeatRisk(situation) {
  return MYRA_ERROR_REPEAT_RISK[situation] ?? 'low'
}
