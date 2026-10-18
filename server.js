// WA Scheduler — جدولة رسائل واتساب، يعمل 24/24 على الهاتف داخل Termux
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  DisconnectReason,
  Browsers
} from 'baileys'
import pino from 'pino'
import QRCode from 'qrcode'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.WA_DATA_DIR || path.join(ROOT, 'data')
const AUTH_DIR = path.join(DATA, 'auth')
const UPLOADS = path.join(DATA, 'uploads')
const JOBS_FILE = path.join(DATA, 'jobs.json')
const CONTACTS_FILE = path.join(DATA, 'contacts.json')
const CONFIG_FILE = path.join(DATA, 'config.json')
const LOG_FILE = path.join(DATA, 'log.txt')
const PUBLIC = path.join(ROOT, 'public')

const PORT = Number(process.env.PORT || 8080)
const GRACE_MS = 3 * 60 * 60 * 1000 // رسالة فات موعدها بأكثر من 3 ساعات لا تُرسل تلقائياً
const MAX_UPLOAD = 100 * 1024 * 1024
const MIN_FREE_SPACE = 60 * 1024 * 1024
const TICK_MS = 10_000

for (const d of [DATA, AUTH_DIR, UPLOADS]) fs.mkdirSync(d, { recursive: true })

// ---------- log ----------
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  process.stdout.write(line)
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 300_000) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}
const baileysLogger = pino({ level: 'warn' }, {
  write: s => {
    try { const o = JSON.parse(s); log('[wa]', o.msg || '', o.err?.message || o.trace?.split('\n')[0] || '') } catch { log('[wa]', s.trim()) }
  }
})

// ---------- json storage ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1))
  fs.renameSync(tmp, file)
}

const config = Object.assign({ countryCode: '212', passwordHash: null, tokens: [] }, readJson(CONFIG_FILE, {}))
const saveConfig = () => writeJson(CONFIG_FILE, config)
let jobs = readJson(JOBS_FILE, [])
const saveJobs = () => writeJson(JOBS_FILE, jobs)
let contacts = readJson(CONTACTS_FILE, [])
const saveContacts = () => writeJson(CONTACTS_FILE, contacts)

// إذا انطفأ السيرفر أثناء الإرسال، نعيد الرسالة لقائمة الانتظار
for (const j of jobs) if (j.status === 'sending') j.status = 'pending'
saveJobs()

// ---------- auth (كلمة سر الواجهة) ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex')
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':')
  const test = crypto.scryptSync(pw, salt, 32).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'))
}
function newToken() {
  const t = crypto.randomBytes(24).toString('hex')
  config.tokens = [t, ...config.tokens].slice(0, 15)
  saveConfig()
  return t
}

// ---------- phone helpers ----------
function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+')) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0') && config.countryCode) d = config.countryCode + d.slice(1)
  d = d.replace(/\D/g, '')
  return d.length >= 8 && d.length <= 15 ? d : null
}

// ---------- WhatsApp connection ----------
const wa = {
  sock: null,
  status: 'idle', // idle | connecting | open | closed | logged_out
  qr: null,
  qrDataUrl: null,
  pairingCode: null,
  me: null,
  lastError: null,
  retries: 0,
  reconnectTimer: null,
  registered: false
}
const msgCache = new Map() // للرد على طلبات إعادة الإرسال من واتساب
const groupCache = new Map()
let groupsList = []

function cacheMessage(msg) {
  if (!msg?.key?.id) return
  msgCache.set(msg.key.id, msg.message)
  if (msgCache.size > 300) msgCache.delete(msgCache.keys().next().value)
}

async function connect() {
  clearTimeout(wa.reconnectTimer)
  if (wa.sock) { try { wa.sock.ev.removeAllListeners(); wa.sock.end(undefined) } catch {} }
  wa.status = 'connecting'
  wa.qr = wa.qrDataUrl = null

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  wa.registered = !!state.creds.account
  let version
  try {
    const v = await Promise.race([fetchLatestWaWebVersion({}), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))])
    version = v.version
  } catch {}

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false, // حتى تبقى إشعارات واتساب تصل للهاتف
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async key => msgCache.get(key.id),
    cachedGroupMetadata: async jid => groupCache.get(jid)
  })
  wa.sock = sock

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('groups.update', updates => {
    for (const u of updates) if (u.id && groupCache.has(u.id)) groupCache.set(u.id, { ...groupCache.get(u.id), ...u })
  })

  sock.ev.on('connection.update', async u => {
    if (sock !== wa.sock) return
    if (u.qr) {
      wa.qr = u.qr
      try { wa.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) } catch {}
    }
    if (u.connection === 'open') {
      wa.status = 'open'
      wa.registered = true
      wa.retries = 0
      wa.qr = wa.qrDataUrl = wa.pairingCode = null
      wa.lastError = null
      wa.me = sock.user ? { id: sock.user.id, name: sock.user.name || sock.user.verifiedName || '' } : null
      log('متصل بواتساب', wa.me?.id || '')
      refreshGroups().catch(() => {})
      tick()
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      wa.lastError = `${code || ''} ${u.lastDisconnect?.error?.message || ''}`.trim()
      log('انقطع الاتصال', wa.lastError)
      wa.qr = wa.qrDataUrl = null

      if (code === DisconnectReason.loggedOut) {
        wa.status = 'logged_out'
        wa.registered = false
        wa.me = null
        await fsp.rm(AUTH_DIR, { recursive: true, force: true })
        fs.mkdirSync(AUTH_DIR, { recursive: true })
        log('تم فصل الجهاز من واتساب — يجب الربط من جديد')
        return
      }
      if (!wa.registered && code !== DisconnectReason.restartRequired) {
        // لم يتم الربط بعد: لا نعيد المحاولة إلى ما لا نهاية، ننتظر المستخدم
        wa.status = 'idle'
        wa.pairingCode = null
        return
      }
      wa.status = 'closed'
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** Math.min(wa.retries, 5))
      wa.retries++
      wa.reconnectTimer = setTimeout(() => connect().catch(e => log('خطأ في الاتصال', e.message)), delay)
    }
  })
}

async function refreshGroups() {
  if (wa.status !== 'open') return groupsList
  const all = await wa.sock.groupFetchAllParticipating()
  groupsList = Object.values(all).map(g => {
    groupCache.set(g.id, g)
    return { id: g.id, name: g.subject, size: g.participants?.length || 0 }
  }).sort((a, b) => a.name.localeCompare(b.name, 'ar'))
  return groupsList
}

async function waitForQr(ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (wa.qr || wa.status === 'open') return
    await sleep(300)
  }
  throw new Error('لم يتمكن من الاتصال بخوادم واتساب، تأكد من الإنترنت')
}

async function startPairing(phone) {
  if (wa.status === 'open') throw new Error('الحساب مربوط بالفعل')
  if (wa.registered) throw new Error('الحساب مربوط بالفعل، انتظر الاتصال')
  if (!wa.sock || wa.status !== 'connecting') await connect()
  await waitForQr()
  if (!phone) return null
  const code = await wa.sock.requestPairingCode(phone)
  wa.pairingCode = code
  log('تم طلب رمز الربط')
  return code
}

// ---------- scheduling ----------
const sleep = ms => new Promise(r => setTimeout(r, ms))
const randBetween = (a, b) => a + Math.random() * (b - a)

function zonedParts(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second }
}
function zonedToEpoch(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi)
  let t = wall
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(t, tz)
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t
    t = wall - offset
  }
  return t
}
function nextOccurrence(job, from) {
  let tz = job.tz || 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { tz = 'UTC' }
  const base = zonedParts(job.anchor || job.sendAt, tz)
  let t = job.sendAt
  let n = 0
  while (t <= from && n < 2000) {
    n++
    const cur = zonedParts(t, tz)
    let { y, m, d } = cur
    if (job.repeat === 'daily') d += 1
    else if (job.repeat === 'weekly') d += 7
    else if (job.repeat === 'monthly') { m += 1; d = base.d }
    else return null
    // تطبيع التاريخ (مثلاً 31 فبراير → آخر الشهر)
    if (job.repeat === 'monthly') {
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate()
      if (d > dim) d = dim
    }
    const norm = new Date(Date.UTC(y, m - 1, d))
    t = zonedToEpoch(norm.getUTCFullYear(), norm.getUTCMonth() + 1, norm.getUTCDate(), base.h, base.mi, tz)
  }
  return t
}

async function resolveRecipient(r) {
  if (r.jid.endsWith('@g.us')) return r.jid
  try {
    const res = await wa.sock.onWhatsApp(r.jid)
    if (Array.isArray(res) && res.length && res[0].exists === false) throw new Error('NOT_ON_WA')
    if (Array.isArray(res) && res.length === 0) throw new Error('NOT_ON_WA')
    return res?.[0]?.jid || r.jid
  } catch (e) {
    if (e.message === 'NOT_ON_WA') throw new Error('هذا الرقم غير موجود على واتساب')
    return r.jid
  }
}

function buildContent(job) {
  const text = job.text?.trim() || ''
  if (!job.file) return [{ text }]
  const f = job.file
  const filePath = path.join(UPLOADS, f.id)
  if (!fs.existsSync(filePath)) throw new Error('الملف المرفق غير موجود على الهاتف')
  const mime = f.mime || 'application/octet-stream'
  if (!job.asDocument && /^image\/(jpeg|png|webp|gif)$/.test(mime)) return [{ image: { url: filePath }, caption: text || undefined, mimetype: mime === 'image/gif' ? 'image/gif' : mime }]
  if (!job.asDocument && /^video\//.test(mime)) return [{ video: { url: filePath }, caption: text || undefined, mimetype: mime }]
  if (!job.asDocument && /^audio\//.test(mime)) {
    const out = [{ audio: { url: filePath }, mimetype: mime }]
    if (text) out.push({ text })
    return out
  }
  return [{ document: { url: filePath }, mimetype: mime, fileName: f.name, caption: text || undefined }]
}

let busy = false
async function runJob(job) {
  job.status = 'sending'
  job.results = job.results || {}
  saveJobs()
  let contents
  try { contents = buildContent(job) } catch (e) {
    job.status = 'failed'
    job.error = e.message
    saveJobs()
    return
  }
  for (const r of job.recipients) {
    if (job.results[r.jid]?.ok) continue
    if (wa.status !== 'open') { job.status = 'pending'; saveJobs(); return } // يكمل عند رجوع الاتصال
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const jid = await resolveRecipient(r)
        for (const c of contents) {
          const sent = await wa.sock.sendMessage(jid, c)
          cacheMessage(sent)
        }
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        if (/غير موجود/.test(e.message) || wa.status !== 'open') break
        await sleep(4000)
      }
    }
    if (!lastErr) job.results[r.jid] = { ok: true, at: Date.now() }
    else if (wa.status === 'open') job.results[r.jid] = { ok: false, at: Date.now(), error: lastErr.message }
    else { job.status = 'pending'; saveJobs(); return }
    saveJobs()
    if (job.recipients.length > 1) await sleep(randBetween(3000, 8000)) // فاصل عشوائي ضد الحظر
  }

  const okCount = job.recipients.filter(r => job.results[r.jid]?.ok).length
  const runStatus = okCount === job.recipients.length ? 'done' : okCount === 0 ? 'failed' : 'partial'
  log(`أرسلت الرسالة ${job.id}: ${okCount}/${job.recipients.length}`)
  job.lastRun = { at: Date.now(), status: runStatus, ok: okCount, total: job.recipients.length, results: job.results }

  if (job.repeat && job.repeat !== 'none') {
    job.sendAt = nextOccurrence(job, Date.now())
    job.results = {}
    job.status = 'pending'
    job.runs = (job.runs || 0) + 1
  } else {
    job.status = runStatus
    cleanupFile(job)
  }
  saveJobs()
}

function cleanupFile(job) {
  if (!job.file) return
  const stillUsed = jobs.some(j => j !== job && j.file?.id === job.file.id && ['pending', 'sending', 'missed'].includes(j.status))
  if (stillUsed) return
  fsp.rm(path.join(UPLOADS, job.file.id), { force: true }).catch(() => {})
  fsp.rm(path.join(UPLOADS, job.file.id + '.json'), { force: true }).catch(() => {})
  job.file.deleted = true
}

async function tick() {
  if (busy) return
  busy = true
  try {
    const now = Date.now()
    for (const job of jobs) {
      if (job.status !== 'pending' || job.sendAt > now) continue
      const late = now - job.sendAt
      const resumed = job.results && Object.keys(job.results).length > 0
      if (late > GRACE_MS && !resumed && !job.forceNow) {
        if (job.repeat && job.repeat !== 'none') {
          log(`فات موعد ${job.id} — ننتقل للموعد التالي`)
          job.missedRuns = (job.missedRuns || 0) + 1
          job.sendAt = nextOccurrence(job, now)
        } else {
          job.status = 'missed'
        }
        saveJobs()
        continue
      }
      if (wa.status !== 'open') break
      delete job.forceNow
      await runJob(job)
    }
  } catch (e) {
    log('خطأ في الجدولة', e.message)
  } finally {
    busy = false
  }
}
setInterval(tick, TICK_MS)

// ---------- HTTP ----------
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string'
  res.writeHead(code, { 'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(isBuf ? body : JSON.stringify(body))
}
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('الطلب كبير جداً'), { status: 413 })
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return raw ? JSON.parse(raw) : {} } catch { throw Object.assign(new Error('بيانات غير صالحة'), { status: 400 }) }
}
async function freeSpace() {
  try { const s = await fsp.statfs(DATA); return s.bavail * s.bsize } catch { return null }
}
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
}

function parseRecipients(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const raw = typeof item === 'string' ? item : item?.jid || item?.phone || ''
    const label = typeof item === 'object' ? item.label || '' : ''
    let jid
    if (String(raw).endsWith('@g.us')) jid = raw
    else {
      const p = normalizePhone(raw)
      if (!p) throw Object.assign(new Error(`رقم غير صالح: ${raw}`), { status: 400 })
      jid = p + '@s.whatsapp.net'
    }
    if (seen.has(jid)) continue
    seen.add(jid)
    out.push({ jid, label })
  }
  if (!out.length) throw Object.assign(new Error('أضف مستلماً واحداً على الأقل'), { status: 400 })
  return out
}

function jobFromBody(b, existing) {
  const recipients = parseRecipients(b.recipients)
  const text = String(b.text || '').slice(0, 60000)
  let file = null
  if (b.file?.id) {
    const id = String(b.file.id).replace(/[^a-f0-9]/g, '')
    const meta = readJson(path.join(UPLOADS, id + '.json'), null)
    if (!meta) throw Object.assign(new Error('الملف المرفق غير موجود'), { status: 400 })
    file = meta
  }
  if (!text.trim() && !file) throw Object.assign(new Error('اكتب رسالة أو أرفق ملفاً'), { status: 400 })
  const sendAt = b.sendNow ? Date.now() : Number(b.sendAt)
  if (!Number.isFinite(sendAt)) throw Object.assign(new Error('حدد وقت الإرسال'), { status: 400 })
  const repeat = ['daily', 'weekly', 'monthly'].includes(b.repeat) ? b.repeat : 'none'
  return {
    ...(existing || {}),
    id: existing?.id || crypto.randomBytes(5).toString('hex'),
    createdAt: existing?.createdAt || Date.now(),
    recipients,
    text,
    file,
    asDocument: !!b.asDocument,
    sendAt,
    anchor: sendAt,
    tz: typeof b.tz === 'string' ? b.tz.slice(0, 60) : 'UTC',
    repeat,
    status: 'pending',
    results: {},
    forceNow: !!b.sendNow,
    error: undefined
  }
}

const routes = {
  'GET /api/status': async () => ({
    status: wa.status,
    registered: wa.registered,
    me: wa.me,
    qr: wa.qrDataUrl,
    pairingCode: wa.pairingCode,
    lastError: wa.lastError,
    freeSpace: await freeSpace(),
    countryCode: config.countryCode,
    lan: lanAddresses().map(a => `http://${a}:${PORT}`),
    pending: jobs.filter(j => j.status === 'pending').length,
    now: Date.now()
  }),
  'POST /api/pair': async (req) => {
    const b = await readBody(req)
    const phone = b.phone ? normalizePhone(b.phone) : null
    if (b.phone && !phone) throw Object.assign(new Error('رقم الهاتف غير صالح'), { status: 400 })
    const code = await startPairing(phone)
    return { pairingCode: code, qr: wa.qrDataUrl }
  },
  'POST /api/logout': async () => {
    try { await wa.sock?.logout() } catch {}
    wa.status = 'logged_out'
    wa.registered = false
    wa.me = null
    await fsp.rm(AUTH_DIR, { recursive: true, force: true })
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    return { ok: true }
  },
  'GET /api/groups': async () => {
    try { return await refreshGroups() } catch { return groupsList }
  },
  'GET /api/jobs': async () => [...jobs].sort((a, b) => {
    const pa = ['pending', 'sending'].includes(a.status) ? 0 : 1
    const pb = ['pending', 'sending'].includes(b.status) ? 0 : 1
    return pa - pb || (pa === 0 ? a.sendAt - b.sendAt : (b.lastRun?.at || b.sendAt) - (a.lastRun?.at || a.sendAt))
  }),
  'POST /api/jobs': async (req) => {
    const job = jobFromBody(await readBody(req))
    jobs.push(job)
    saveJobs()
    setTimeout(tick, 200)
    return job
  },
  'PUT /api/jobs/:id': async (req, id) => {
    const i = jobs.findIndex(j => j.id === id)
    if (i < 0) throw Object.assign(new Error('غير موجودة'), { status: 404 })
    if (jobs[i].status === 'sending') throw Object.assign(new Error('الرسالة قيد الإرسال الآن'), { status: 409 })
    const old = jobs[i]
    jobs[i] = jobFromBody(await readBody(req), { id: old.id, createdAt: old.createdAt, runs: old.runs, lastRun: old.lastRun })
    if (old.file && old.file.id !== jobs[i].file?.id) cleanupFile(old)
    saveJobs()
    setTimeout(tick, 200)
    return jobs[i]
  },
  'DELETE /api/jobs/:id': async (req, id) => {
    const job = jobs.find(j => j.id === id)
    if (!job) return { ok: true }
    if (job.status === 'sending') throw Object.assign(new Error('الرسالة قيد الإرسال الآن'), { status: 409 })
    jobs = jobs.filter(j => j !== job)
    cleanupFile(job)
    saveJobs()
    return { ok: true }
  },
  'POST /api/jobs/:id/send-now': async (req, id) => {
    const job = jobs.find(j => j.id === id)
    if (!job) throw Object.assign(new Error('غير موجودة'), { status: 404 })
    if (job.status === 'sending') return job
    if (job.file?.deleted) throw Object.assign(new Error('الملف المرفق حُذف بعد الإرسال، أنشئ رسالة جديدة'), { status: 400 })
    if (job.repeat && job.repeat !== 'none') {
      // رسالة متكررة: نرسل نسخة الآن ونترك الموعد الأصلي كما هو
      const copy = { ...job, id: crypto.randomBytes(5).toString('hex'), repeat: 'none', sendAt: Date.now(), anchor: Date.now(), results: {}, lastRun: undefined, runs: undefined, forceNow: true, status: 'pending', createdAt: Date.now() }
      jobs.push(copy)
      saveJobs()
      setTimeout(tick, 100)
      return copy
    }
    // إعادة الإرسال: للفاشلين فقط إن كانت جزئية
    if (job.status !== 'partial') job.results = {}
    job.sendAt = Date.now()
    job.forceNow = true
    job.status = 'pending'
    saveJobs()
    setTimeout(tick, 100)
    return job
  },
  'POST /api/jobs/clear-finished': async () => {
    const finished = jobs.filter(j => ['done', 'failed', 'partial', 'missed'].includes(j.status))
    jobs = jobs.filter(j => !finished.includes(j))
    finished.forEach(cleanupFile)
    saveJobs()
    return { removed: finished.length }
  },
  'POST /api/upload': async (req, _id, url) => {
    const name = (url.searchParams.get('name') || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150)
    const mime = (url.searchParams.get('mime') || 'application/octet-stream').slice(0, 100)
    const size = Number(req.headers['content-length'] || 0)
    if (size > MAX_UPLOAD) throw Object.assign(new Error('الملف أكبر من 100 ميغا'), { status: 413 })
    const free = await freeSpace()
    if (free != null && free - size < MIN_FREE_SPACE) throw Object.assign(new Error('لا توجد مساحة كافية على الهاتف'), { status: 507 })
    const id = crypto.randomBytes(12).toString('hex')
    const dest = path.join(UPLOADS, id)
    let written = 0
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest)
      req.on('data', c => {
        written += c.length
        if (written > MAX_UPLOAD) { req.destroy(); out.destroy(); reject(Object.assign(new Error('الملف أكبر من 100 ميغا'), { status: 413 })) }
      })
      req.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
      req.on('error', reject)
    }).catch(async e => { await fsp.rm(dest, { force: true }); throw e })
    const meta = { id, name, mime, size: written }
    writeJson(path.join(UPLOADS, id + '.json'), meta)
    return meta
  },
  'GET /api/contacts': async () => contacts,
  'POST /api/contacts': async (req) => {
    const b = await readBody(req)
    const name = String(b.name || '').trim().slice(0, 80)
    const phone = normalizePhone(b.phone)
    if (!name || !phone) throw Object.assign(new Error('الاسم أو الرقم غير صالح'), { status: 400 })
    contacts = contacts.filter(c => c.phone !== phone)
    contacts.push({ name, phone })
    contacts.sort((a, b) => a.name.localeCompare(b.name, 'ar'))
    saveContacts()
    return contacts
  },
  'DELETE /api/contacts/:id': async (req, id) => {
    contacts = contacts.filter(c => c.phone !== id)
    saveContacts()
    return contacts
  },
  'POST /api/settings': async (req) => {
    const b = await readBody(req)
    if (b.countryCode != null) {
      const cc = String(b.countryCode).replace(/\D/g, '').slice(0, 4)
      if (cc) config.countryCode = cc
    }
    if (b.newPassword) {
      if (String(b.newPassword).length < 4) throw Object.assign(new Error('كلمة السر قصيرة'), { status: 400 })
      config.passwordHash = hashPassword(String(b.newPassword))
      config.tokens = []
      saveConfig()
      return { token: newToken() }
    }
    saveConfig()
    return { ok: true }
  },
  'GET /api/log': async () => {
    try { return fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-150).join('\n') } catch { return '' }
  }
}

function matchRoute(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [m, p] = key.split(' ')
    if (m !== method) continue
    if (p === pathname) return [routes[key], null]
    if (p.includes(':id')) {
      const re = new RegExp('^' + p.replace(':id', '([^/]+)') + '$')
      const mm = pathname.match(re)
      if (mm) return [routes[key], decodeURIComponent(mm[1])]
    }
  }
  return [null, null]
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (!url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const full = path.join(PUBLIC, path.normalize(file))
      if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found')
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
      res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' })
      return fs.createReadStream(full).pipe(res)
    }

    // تسجيل الدخول / إنشاء كلمة السر
    if (url.pathname === '/api/auth-state' && req.method === 'GET') {
      const t = req.headers['x-token']
      return send(res, 200, { hasPassword: !!config.passwordHash, valid: !!t && config.tokens.includes(t) })
    }
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (config.passwordHash) return send(res, 403, { error: 'كلمة السر موجودة مسبقاً' })
      const b = await readBody(req)
      if (String(b.password || '').length < 4) return send(res, 400, { error: 'كلمة السر يجب أن تكون 4 أحرف على الأقل' })
      config.passwordHash = hashPassword(String(b.password))
      saveConfig()
      return send(res, 200, { token: newToken() })
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req)
      await sleep(400)
      if (!config.passwordHash || !checkPassword(String(b.password || ''), config.passwordHash)) return send(res, 401, { error: 'كلمة السر خاطئة' })
      return send(res, 200, { token: newToken() })
    }

    const token = req.headers['x-token']
    if (!token || !config.tokens.includes(token)) return send(res, 401, { error: 'unauthorized' })

    const [handler, id] = matchRoute(req.method, url.pathname)
    if (!handler) return send(res, 404, { error: 'not found' })
    const result = await handler(req, id, url)
    send(res, 200, typeof result === 'string' ? result : result ?? { ok: true })
  } catch (e) {
    if (!e.status) log('خطأ', req.method, url.pathname, e.stack || e.message)
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'خطأ' })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  log(`السيرفر يعمل: http://localhost:${PORT}`, lanAddresses().map(a => `http://${a}:${PORT}`).join(' '))
})

// نتصل تلقائياً إذا كان الحساب مربوطاً من قبل
if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
  const creds = readJson(path.join(AUTH_DIR, 'creds.json'), {})
  if (creds.account) connect().catch(e => log('خطأ في الاتصال', e.message))
}

process.on('unhandledRejection', e => log('unhandledRejection', e?.stack || String(e)))
process.on('uncaughtException', e => {
  log('uncaughtException', e?.stack || String(e))
  setTimeout(() => process.exit(1), 300) // run.sh يعيد التشغيل تلقائياً
})
