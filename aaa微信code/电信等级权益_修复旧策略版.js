#!/usr/bin/env node
/* ============================================================================
 * 电信等级权益 · 0 点抢兑（抢购优化版 v2）
 * ----------------------------------------------------------------------------
 * 2026-09-10 那轮失败复盘（服务端原始响应为证）：
 *   服务端返回 {"resoultCode":"1","resoultMsg":"抱歉，奖品已领完，请下次再来哦"}
 *   而原脚本只认「库存不足/已抢完/售罄/已兑换」→ 全落进 else 死循环重试 120 次，
 *   最后静默放弃，日志只有「达到最大重试次数」，连原因都看不到。
 *
 * 原版 5 个硬伤 → 本版逐条修：
 *   1) 判定词不全           → 结果分类器（成功/已领完/限流/未开始/已领过/金豆不足/未知），
 *                             未知一定打印服务端原始响应，永不再静默
 *   2) 用兑换接口(receiverRights)当状态查询（写操作，白烧机会+招风控）
 *                          → 改读 queryLevelRightInfo 的 isReceive 字段
 *   3) 每次请求重新 TCP+TLS 握手（实测单发 ~500ms）
 *                          → keep-alive Agent + 开抢前预热，把连接握在手里
 *   4) 固定 150ms×120 无脑刷 → 触发「操作频繁，请稍后再试」
 *                          → 首轮硬下限 1.2s/次 + 限流指数退避（宁慢勿封）
 *   5) 没对齐服务端时间     → 本机时钟比服务端快 ~2.3s，等于每轮都晚 2.3 秒开枪；
 *                          现在用响应 Date 头算偏移，并按实测热连接 RTT/2 提前发射
 *
 * 实测数据（2026-09-11 00:0x，本机→wappark.189.cn）：
 *   · 冷连接首包 354~381ms；keep-alive 热连接首包 ~89ms  → 预热值 ~270ms，是能不能赶上前 200ms 的关键
 *   · 同账号间隔 250ms 第二次就被「操作频繁」；狂刷（原脚本 242 发）后接口会直接
 *     {"msg":"未授权访问","code":"401"}（换全新账号同样 401 → 应该是 IP 维度被 WAF 盯上了）
 *     → 所以本版刻意不刷：靠「预热 + 对准毫秒」取胜，不靠次数；一旦 401 立刻收手不硬刚
 *   · 权益规则（item.contentOne 原文）：每日限量 102 份、每日 0 点开抢、每账号每月限 1 次话费
 *
 * 用法：
 *   node 电信等级权益_修复旧策略版.js          # 正常：初始化 → 等到目标时刻抢兑 → 推送
 *   node 电信等级权益_修复旧策略版.js test      # 只做登录/权益校验，立刻推送退出
 *   node 电信等级权益_修复旧策略版.js probe     # 立刻对每个账号试一发，打印原始响应与耗时
 * ==========================================================================*/

const axios = require('axios')
const https = require('https')
const CryptoJS = require('crypto-js')
const crypto = require('crypto')
const JSEncrypt = require('node-jsencrypt')
const fs = require('fs')
const path = require('path')

// ========== 无条件清空代理（避免容器死代理阻断出网） ==========
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) process.env[k] = ''

// ========== 运行模式 ==========
const ARGV = process.argv.slice(2)
const isTest = ARGV.includes('test')
const isProbe = ARGV.includes('probe')

// ========== 调优配置（环境变量可覆盖，无需改代码） ==========
const GRAB_HOUR = parseInt(process.env.DX_GRAB_HOUR || '0', 10)          // 开抢小时（默认 0 点）
const GRAB_MINUTE = parseInt(process.env.DX_GRAB_MINUTE || '0', 10)      // 开抢分钟
const GRAB_OFFSET = parseInt(process.env.DX_GRAB_OFFSET || '0', 10)      // 打点余量(ms)，负数=提前抢跑
const WINDOW_MS = parseInt(process.env.DX_WINDOW_MS || '180000', 10)     // 抢购总窗口(ms)，仅在没收到明确 soldout 时兜底
/* 注意：这个接口对同账号连续请求非常敏感（间隔 250ms 就会被「操作频繁」，狂刷会被 401 未授权访问）。
   所以间隔刻意放大，靠「连接预热 + 毫秒级对准」取胜，而不是靠刷的次数。 */
const DENSE_MS = parseInt(process.env.DX_DENSE_MS || '350', 10)          // 前 3s 的尝试间隔
const MED_MS = parseInt(process.env.DX_MED_MS || '900', 10)              // 3~30s 的尝试间隔
const SPARSE_MS = parseInt(process.env.DX_SPARSE_MS || '2500', 10)       // 30s 之后的尝试间隔
const DENSE_UNTIL = parseInt(process.env.DX_DENSE_UNTIL || '3000', 10)   // 密集阶段持续(ms)
const MIN_GAP_MS = parseInt(process.env.DX_MIN_GAP_MS || '1200', 10)     // 两次尝试之间的硬下限（实测 ~250ms 就会被限流）
const MAX_TRIES = parseInt(process.env.DX_MAX_TRIES || '24', 10)         // 每账号总请求数上限（防把接口刷到 401）
const SOLDOUT_GRACE_MS = parseInt(process.env.DX_SOLDOUT_GRACE || '1500', 10) // 开抢后多少 ms 内的「已领完」还要再确认一次；超过即收手不捡漏
const FIRST_SHOTS = Math.max(1, parseInt(process.env.DX_BURST || '1', 10)) // 开抢瞬间同账号齐射数（>1 有触发限流风险）
const SHOT_GAP_MS = parseInt(process.env.DX_SHOT_GAP_MS || '60', 10)     // 齐射之间的错开间隔
const ACCOUNT_GAP_MS = parseInt(process.env.DX_ACCOUNT_GAP_MS || '40', 10) // 多账号首发错开，避免被判「操作频繁」
const PREWARM = !/^(0|false|no)$/i.test(process.env.DX_PREWARM || '1')   // 开抢前预热连接（只打 wappark 根路径，不碰权益接口，零风控风险）
const LEAD_MS = parseInt(process.env.DX_LEAD_MS || '0', 10)              // 提前量(ms)；0=用预热实测 RTT/2 自动算
const DEBUG = !!process.env.DX_DEBUG                                        // 打印预热明细
const KEYWORDS = (process.env.DX_KEYWORD || '话费').split(/[,，|]/).map((s) => s.trim()).filter(Boolean)
const HTTP_TIMEOUT = parseInt(process.env.DX_HTTP_TIMEOUT || '8000', 10)

console.log(
  `⚙️ 抢兑配置: 目标 ${String(GRAB_HOUR).padStart(2, '0')}:${String(GRAB_MINUTE).padStart(2, '0')}:00` +
  ` | 打点余量 ${GRAB_OFFSET}ms | 提前量 ${LEAD_MS || '自动'}ms | 首发 ${FIRST_SHOTS} 发` +
  ` | 阶梯 ${DENSE_MS}/${MED_MS}/${SPARSE_MS}ms(下限${MIN_GAP_MS}) | 窗口 ${Math.round(WINDOW_MS / 1000)}s | 上限 ${MAX_TRIES} 发/账号 | 预热 ${PREWARM ? '开' : '关'}`
)

// ========== 加密密钥（与 Python 版完全对齐） ==========
const DES3_KEY = '1234567`90koiuyhgtfrdews'
const DES3_IV = '\0\0\0\0\0\0\0\0'
const RSA_PUB_KEY_LOGIN = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBkLT15ThVgz6/NOl6s8GNPofdWzWbCkWnkaAm7O2LjkM1H7dMvzkiqdxU02jamGRHLX/ZNMCXHnPcW/sDhiFCBN18qFvy8g6VYb9QtroI09e176s+ZCtiv7hbin2cCTj99iUpnEloZm19lwHyo69u5UMiPMpq0/XKBO8lYhN/gwIDAQAB
-----END PUBLIC KEY-----`
const RSA_PUB_KEY_DATA = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+ugG5A8cZ3FqUKDwM57GM4io6JGcStivT8UdGt67PEOihLZTw3P7371+N47PrmsCpnTRzbTgcupKtUv8ImZalYk65dU8rjC/ridwhw9ffW2LBwvkEnDkkKKRi2liWIItDftJVBiWOh17o6gfbPoNrWORcAdcbpk2L+udld5kZNwIDAQAB
-----END PUBLIC KEY-----`

const UA = 'Mozilla/5.0 (Linux; Android 13; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.97 Mobile Safari/537.36'
const UA_LOGIN = 'Mozilla/5.0 (Linux; Android 12; zh-cn) AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1'
const UA_XML = 'CtClient;10.4.1;Android;13;22081212C;NTQzNzgx!#!MTgwNTg1'
const URL_RECEIVER = 'https://wappark.189.cn/jt-sign/paradise/receiverRights'
const URL_RIGHTS = 'https://wappark.189.cn/jt-sign/paradise/queryLevelRightInfo'

// ========== 账号配置（dxlin：手机号#密码#AndroidID） ==========
let userPhone = []
if (process.env.dxlin) {
  process.env.dxlin.split(/[@&\n]/).forEach((item) => {
    const line = item.trim()
    if (!line || line.split('#').length !== 3) return
    const [phone, password, androidId] = line.split('#').map((v) => v.trim())
    if (phone && password && androidId) userPhone.push({ phone, password, androidId })
  })
} else {
  console.log('未找到环境变量 dxlin')
  console.log('账号格式: 手机号#密码#AndroidID@手机号2#密码2#AndroidID2')
  process.exit(1)
}

// ========== 推送：经 std_report 统一推送 ==========
const { report: _stdReport } = require('./std_report')
let _rpRows = []
let _rpPhoneIdx = {}
let _rpApp = '电信等级权益'
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx, name: '', sign: '', earned: '', total: '', streak: '', tasks: [], lottery: '', taskEarned: '' }
  return _rpRows[idx]
}
function _setName(idx, name) { if (name != null && name !== '') _rpGet(idx).name = String(name) }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx)
  if (sign != null && sign !== '') r.sign = String(sign)
  if (earned != null && earned !== '') r.earned = String(earned)
  if (total != null && total !== '') r.total = String(total)
}
async function flushLogPoints(app) {
  if (_rpFlushed) return
  _rpApp = app || _rpApp
  const rows = _rpRows.filter(Boolean)
  if (!rows.length) return
  _rpFlushed = true
  await _stdReport(_rpApp, rows)
}
let _rpFlushed = false
{
  const _oe = process.exit.bind(process)
  process.exit = function (code) {
    const p = flushLogPoints(_rpApp)
    if (p && typeof p.then === 'function') p.then(() => _oe(code)).catch(() => _oe(code))
    else _oe(code)
  }
}
process.on('beforeExit', () => { flushLogPoints(_rpApp) })

// ========== 连接池：keep-alive，复用到 wappark 的 TCP/TLS（省掉每次 ~几百 ms 握手） ==========
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 64,
  maxFreeSockets: 48,
  scheduling: 'lifo',
})
const api = axios.create({ httpsAgent, timeout: HTTP_TIMEOUT, validateStatus: () => true })

// ========== 工具 ==========
function getTimestamp() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}
function maskPhone(phone) { return String(phone).replace(/^(\d{3})(\d*)(\d{4})$/, '$1****$3') }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function jitter(ms) { return Math.round(ms * (0.75 + Math.random() * 0.5)) }
function nowStamp() { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}` }
function encodeStr(text) { let r = ''; for (let i = 0; i < text.length; i++) r += String.fromCharCode(text.charCodeAt(i) + 2); return r }
function des3Encrypt(text) {
  return CryptoJS.TripleDES.encrypt(CryptoJS.enc.Utf8.parse(text), CryptoJS.enc.Utf8.parse(DES3_KEY), { iv: CryptoJS.enc.Utf8.parse(DES3_IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).ciphertext.toString()
}
function des3Decrypt(text) {
  return CryptoJS.TripleDES.decrypt({ ciphertext: CryptoJS.enc.Hex.parse(text) }, CryptoJS.enc.Utf8.parse(DES3_KEY), { iv: CryptoJS.enc.Utf8.parse(DES3_IV), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8)
}
function rsaEncryptLogin(plaintext) { const e = new JSEncrypt(); e.setPublicKey(RSA_PUB_KEY_LOGIN); return e.encrypt(plaintext) }
function rsaEncryptData(plaintext) {
  if (typeof plaintext !== 'string') plaintext = JSON.stringify(plaintext)
  const pub = crypto.createPublicKey(RSA_PUB_KEY_DATA)
  const max = 117
  const buf = Buffer.from(plaintext, 'utf8')
  let out = Buffer.alloc(0)
  for (let i = 0; i < buf.length; i += max) {
    out = Buffer.concat([out, crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, buf.slice(i, i + max))])
  }
  return out.toString('hex')
}

// ========== 服务端时钟对齐 ==========
let SERVER_OFFSET = 0 // serverMs - localMs
async function syncServerTime(sample = 3) {
  const delays = []
  for (let i = 0; i < sample; i++) {
    const t0 = Date.now()
    try {
      const res = await api.get('https://wappark.189.cn/', { headers: { 'User-Agent': UA }, timeout: 6000 })
      const t1 = Date.now()
      const d = res.headers && res.headers.date
      if (d) {
        const serverMs = new Date(d).getTime()
        if (!isNaN(serverMs)) delays.push(serverMs - Math.round((t0 + t1) / 2))
      }
    } catch (_) { /* ignore */ }
    if (i < sample - 1) await sleep(120)
  }
  if (delays.length) {
    delays.sort((a, b) => a - b)
    SERVER_OFFSET = delays[Math.floor(delays.length / 2)]
    console.log(`🕐 服务端时钟对齐: 偏移 ${SERVER_OFFSET}ms（采样 ${delays.length} 次, min=${delays[0]} max=${delays[delays.length - 1]}）`)
  } else {
    console.log('🕐 服务端时钟对齐失败，按本机时间走')
  }
}
function serverNow() { return Date.now() + SERVER_OFFSET }
/** 到点前粗睡 + 最后 15ms 忙等，避免事件循环把发射时刻拖漂 */
async function sleepUntil(ts) {
  for (;;) {
    const left = ts - Date.now()
    if (left <= 0) return
    if (left > 25) await sleep(Math.min(left - 18, 200))
    else await new Promise((r) => setImmediate(r))
  }
}

// ========== 状态缓存 ==========
let Cache = {}
const CACHE_FILE = path.join(__dirname, 'Cache.json')
function loadCache() { try { Cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch (_) { Cache = {}; saveCache() } }
function saveCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Cache, null, 2), 'utf8') } catch (_) { /* ignore */ } }

// ========== 登录 / ticket / SSO ==========
async function loginPhone(phone, password, androidId, retryCount = 0) {
  const ts = getTimestamp()
  const loginPlain = `Xiaomi 20 8.0.0.${androidId.slice(0, 12)}${phone}${ts}${password}0$$$0.`
  const data = {
    headerInfos: {
      code: 'userLoginNormal', timestamp: ts, broadAccount: '', broadToken: '',
      clientType: '#11.0.0#channel8#Xiaomi 20#', shopId: '20002', source: '110003',
      sourcePassword: 'Sid98s', token: '', userLoginName: encodeStr(phone),
    },
    content: {
      attach: 'test',
      fieldData: {
        loginType: '4', accountType: '', loginAuthCipherAsymmertric: rsaEncryptLogin(loginPlain),
        deviceUid: '', phoneNum: encodeStr(phone), isChinatelecom: '', systemVersion: '8.0.0',
        androidId: encodeStr(androidId), loginAuthCipher: '', authentication: encodeStr(password),
      },
    },
  }
  const res = await api.post('https://appgologin.189.cn:9031/login/client/userLoginNormal', data, { headers: { 'User-Agent': UA_LOGIN } })
  const result = res.data && res.data.responseData && res.data.responseData.data && res.data.responseData.data.loginSuccessResult
  if (!result) {
    console.log(`[${maskPhone(phone)}] 登录响应异常(${retryCount}):`, JSON.stringify(res.data).slice(0, 200))
    return null
  }
  Cache[phone] = { ...result }
  saveCache()
  console.log(`[${maskPhone(phone)}] 登录成功`)
  return { ...Cache[phone] }
}

async function getTicket(phone, userId, token) {
  const ts = getTimestamp()
  const xmlData = `<Request>
<HeaderInfos>
<Code>getSingle</Code>
<Timestamp>${ts}</Timestamp>
<BroadAccount></BroadAccount>
<BroadToken></BroadToken>
<ClientType>#9.6.1#channel50#iPhone 14 Pro Max#</ClientType>
<ShopId>20002</ShopId>
<Source>110003</Source>
<SourcePassword>Sid98s</SourcePassword>
<Token>${token}</Token>
<UserLoginName>${phone}</UserLoginName>
</HeaderInfos>
<Content>
<Attach>test</Attach>
<FieldData>
<TargetId>${des3Encrypt(userId)}</TargetId>
<Url>4a6862274835b451</Url>
</FieldData>
</Content>
</Request>`
  const res = await api.post('https://appgologin.189.cn:9031/map/clientXML', xmlData, { headers: { 'Content-Type': 'application/xml;charset=utf-8', 'User-Agent': UA_XML } })
  const match = String(res.data).match(/<Ticket>(.*?)<\/Ticket>/)
  if (!match) { console.log(`[${maskPhone(phone)}] 获取 ticket 失败:`, String(res.data).slice(0, 200)); return null }
  return des3Decrypt(match[1])
}

async function ssoHomLogin(ticket) {
  const res = await api.get('https://wappark.189.cn/jt-sign/ssoHomLogin?ticket=' + ticket, { headers: { 'User-Agent': UA } })
  if (res.data && res.data.resoultCode === '0') return { sign: res.data.sign, accId: res.data.accId }
  console.log('获取 sign 失败:', JSON.stringify(res.data).slice(0, 200))
  return null
}

// ========== 权益 ==========
async function queryRights(sign, accId) {
  const paraV = rsaEncryptData({ type: 'hg_qd_djqydh', accId, shopId: '20001' })
  const res = await api.post(URL_RIGHTS, { para: paraV }, { headers: { 'Content-Type': 'application/json', 'User-Agent': UA, sign } })
  const data = res.data
  if (!data || typeof data !== 'object') return { err: '响应非 JSON: ' + String(data).slice(0, 120) }
  if (data.code === 401) return { err: 'sign 过期(401)' }
  const key = 'V' + data.currentLevel
  const list = data[key] || []
  return { level: data.currentLevel, list }
}

/** 结果分类：把服务端各种文案收敛成有限几种（原脚本就是漏了「已领完」才静默失败） */
const RULES = [
  ['already', /已兑换|已领取|重复领取|您已领|已参与|请勿重复/],
  ['soldout', /已领完|领完|已抢完|抢完|抢光|售罄|库存不足|无库存|已兑完|已发完|已送完|数量已满/],
  ['throttle', /操作频繁|频繁|稍后再试|稍后重试|请求过快|限流|系统繁忙|手速/],
  ['notopen', /未开始|尚未开始|活动未开始|不在活动时间|还未开始|活动结束|已结束/],
  ['nobean', /金豆不足|积分不足|余额不足|金豆不够/],
  ['auth', /请先登录|登录失效|未登录|无权限|非法请求|参数错误/],
]
function classifyResp(body, httpStatus) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body === undefined ? null : body)
  let code = ''
  let msg = ''
  if (body && typeof body === 'object') {
    code = String(body.resoultCode != null ? body.resoultCode : (body.code != null ? body.code : ''))
    msg = String(body.resoultMsg || body.resoultMessage || body.message || body.msg || '')
  } else if (typeof body === 'string') {
    msg = body
  }
  if (code === '0' || code === '0000') return { kind: 'ok', msg: msg || '兑换成功', raw, code }
  if (code === '401' || httpStatus === 401) return { kind: 'auth', msg: msg || 'sign 过期', raw, code }
  const text = msg || raw
  for (const [kind, re] of RULES) if (re.test(text)) return { kind, msg, raw, code }
  if (/兑换成功|领取成功|success/i.test(text)) return { kind: 'ok', msg: '兑换成功', raw, code }
  return { kind: 'unknown', msg: msg || raw.slice(0, 120), raw, code }
}

/** 单发兑换（para 已预加密，发射路径上只剩一次 HTTP） */
async function attempt(acc, item, preEncrypted) {
  const para = preEncrypted || rsaEncryptData({ id: item.activityId, accId: acc.accId, showType: '9003', showEffect: '8', czValue: '0' })
  const t0 = Date.now()
  let res
  try {
    res = await api.post(URL_RECEIVER, { para }, { headers: { 'Content-Type': 'application/json', 'User-Agent': UA, sign: acc.sign } })
  } catch (e) {
    return { kind: 'net', msg: e.code || e.message, ms: Date.now() - t0, raw: '' }
  }
  const ms = Date.now() - t0
  return Object.assign({ ms, http: res.status }, classifyResp(res.data, res.status))
}

// ========== 抢购主循环（每账号一条） ==========
async function grabWorker(acc, ctx) {
  const items = acc.items.slice()
  const pre = acc.preEncrypted
  const stats = { tries: 0, throttles: 0, firstMs: null, soldoutAt: null, unknowns: [] }
  const t0 = Date.now()
  let idx = 0
  let backoffUntil = 0
  let soldoutCount = 0

  const finish = (kind, extra) => Object.assign({ kind, stats, item: items[idx % items.length] }, extra || {})

  // —— 唯一的一发：提前 lead 毫秒发射，让请求正好落在库存释放那一瞬间
  await sleepUntil(ctx.fireTs)
  const shots = []
  for (let k = 0; k < FIRST_SHOTS; k++) {
    shots.push((async () => {
      if (k) await sleep(k * SHOT_GAP_MS)
      return attempt(acc, items[0], pre[items[0].activityId])
    })())
  }
  const shotResults = await Promise.all(shots)
  stats.tries += shotResults.length
  const shotMs = Math.min(...shotResults.map((r) => r.ms))
  stats.firstMs = shotMs
  const win = shotResults.find((r) => r.kind === 'ok' || r.kind === 'already')
  if (win) return finish(win.kind, { resp: win })
  const authShot = shotResults.find((r) => r.kind === 'auth')
  if (authShot) return finish('auth', { resp: authShot })
  console.log(`[${acc.masked}] 首发 ${shotResults.length} 发 ${nowStamp()} | 首包 ${shotMs}ms | ` +
    shotResults.map((r) => `${r.kind}${r.msg ? '(' + r.msg + ')' : ''}`).join(' / '))

  // —— 阶梯重试：这个接口 ~1 发/秒 就限流，所以首轮至少 MIN_GAP_MS 起步，宁慢勿封
  while (Date.now() < ctx.deadline && stats.tries < MAX_TRIES) {
    const el = Date.now() - t0
    let interval = Math.max(MIN_GAP_MS, el < DENSE_UNTIL ? DENSE_MS : el < 30000 ? MED_MS : SPARSE_MS)
    if (stats.tries > 8) interval = Math.max(interval, 3000)   // 前 8 发没中就明显放慢
    if (stats.tries > 16) interval = Math.max(interval, 7000)  // 之后基本是碰运气了
    if (Date.now() < backoffUntil) { await sleep(Math.min(backoffUntil - Date.now(), 500)); continue }

    const item = items[idx % items.length]
    const r = await attempt(acc, item, pre[item.activityId])
    stats.tries++

    if (r.kind === 'ok' || r.kind === 'already') return finish(r.kind, { resp: r })
    if (r.kind === 'soldout') {
      if (!stats.soldoutAt) stats.soldoutAt = Date.now() - t0
      soldoutCount++
      // 不捡漏：开抢瞬间 1.5s 内的 soldout 再确认一发（防时钟/放货抖动），之后确认即收手
      if (el > SOLDOUT_GRACE_MS || soldoutCount >= 2) return finish('soldout', { resp: r })
    } else if (r.kind === 'throttle') {
      stats.throttles++
      backoffUntil = Date.now() + Math.min(1500 * Math.pow(2, stats.throttles - 1), 8000)
    } else if (r.kind === 'notopen') {
      await sleep(50)
      continue
    } else if (r.kind === 'nobean') {
      return finish('nobean', { resp: r })
    } else if (r.kind === 'auth') {
      // 401 未授权访问 = 服务端风控把这条链路口子关了（继续打只会更糟，立刻收手）
      return finish('auth', { resp: r })
    } else {
      stats.unknowns.push(`http=${r.http} ms=${r.ms} ${String(r.raw).slice(0, 160)}`)
    }
    idx++
    await sleep(jitter(interval))
  }
  return finish('timeout')
}

// ========== 主流程 ==========
async function initAccount(phone, password, androidId, idx) {
  _setName(idx, maskPhone(phone))
  _rpPhoneIdx[phone] = idx

  // 1) token（缓存优先，无则登录）
  let info = Cache[phone]
  if (!info || !info.token || !info.userId) {
    try { info = await loginPhone(phone, password, androidId) } catch (e) { info = null; console.log(`[${maskPhone(phone)}] 登录异常:`, e.message) }
  }
  if (!info) { _setSign(idx, '登录失败'); return null }

  // 2) ticket + sign（失败重试一次，随后强制重新登录）
  const getSign = async () => {
    for (let i = 1; i <= 3; i++) {
      try {
        const tk = await getTicket(phone, info.userId, info.token)
        if (tk) { const s = await ssoHomLogin(tk); if (s) return s }
      } catch (e) { console.log(`[${maskPhone(phone)}] 取 sign 第${i}次失败: ${e.message}`) }
      await sleep(800 * i)
    }
    return null
  }
  let signData = await getSign()
  if (!signData) {
    delete Cache[phone]; saveCache()
    try { info = await loginPhone(phone, password, androidId) } catch (_) { info = null }
    if (info) signData = await getSign()
  }
  if (!signData) { _setSign(idx, '登录失败'); return null }

  // 3) 权益列表：状态读 isReceive，不再用兑换接口当查询
  const q = await queryRights(signData.sign, signData.accId)
  if (q.err) { _setSign(idx, '查询失败: ' + q.err); return null }
  const matched = (q.list || []).filter((it) => KEYWORDS.some((k) => String(it.title || '').includes(k)))
  if (!matched.length) {
    console.log(`[${maskPhone(phone)}] Lv${q.level} 未找到「${KEYWORDS.join('/')}」类权益`)
    _setSign(idx, `未找到${KEYWORDS.join('/')}权益`)
    return null
  }

  const pending = []
  const done = []
  for (const it of matched) {
    if (String(it.isReceive) === 'true') done.push(it.title)
    else pending.push(it)
  }
  console.log(`[${maskPhone(phone)}] Lv${q.level} ${KEYWORDS.join('/')}权益 ${matched.length} 项 | 可兑换 ${pending.length} | 本月已领 ${done.length}`)
  pending.forEach((it) => console.log(`   待兑换: ${it.title}`))
  if (!pending.length) {
    _setSign(idx, '本月已领完', `兑换${done.length}/${matched.length}项`)
    return null
  }

  // 4) 预加密（0 点发射路径上只剩 HTTP）
  const preEncrypted = {}
  for (const it of pending) preEncrypted[it.activityId] = rsaEncryptData({ id: it.activityId, accId: signData.accId, showType: '9003', showEffect: '8', czValue: '0' })

  return {
    phone, password, androidId, idx, masked: maskPhone(phone),
    sign: signData.sign, accId: signData.accId, items: pending, preEncrypted, matchedTotal: matched.length,
  }
}

/** 抢购前 30 秒重取一次 sign，避免 sign 过期白跑 */
async function refreshSigns(accounts) {
  for (const a of accounts) {
    try {
      const info = Cache[a.phone]
      if (!info) continue
      const tk = await getTicket(a.phone, info.userId, info.token)
      if (!tk) continue
      const s = await ssoHomLogin(tk)
      if (s) { a.sign = s.sign; a.accId = s.accId; console.log(`[${a.masked}] sign 已刷新`) }
    } catch (e) { console.log(`[${a.masked}] sign 刷新失败(沿用旧 sign): ${e.message}`) }
  }
}

/* ========== 连接预热 + 实测 RTT ==========
 * 目的：把到 wappark.189.cn 的 TCP/TLS 连接提前建好（实测冷连接首包 ~380ms、热连接 ~90ms），
 * 并用热连接的实测 RTT 反推「提前多久发射」——让 0 点那一发正好落在库存释放的瞬间。
 * 只打根路径，不碰权益接口（该接口 1 发/秒就限流，且刷多会被 401）。 */
const _rtts = []
function prewarmAt(delay, count = 2) {
  if (delay < 0) return
  setTimeout(async () => {
    for (let i = 0; i < count; i++) {
      const t0 = Date.now()
      try {
        await api.get('https://wappark.189.cn/', { headers: { 'User-Agent': UA }, timeout: 4000 })
        const ms = Date.now() - t0
        _rtts.push(ms)
        if (DEBUG) console.log(`   预热 ${ms}ms（第 ${_rtts.length} 个样本${i ? '·复用了连接' : '·建连'}）`)
      } catch (e) {
        if (DEBUG) console.log(`   预热失败: ${e.code || e.message}（${Date.now() - t0}ms）`)
      }
    }
  }, delay)
}
/** 取最小 RTT = 热连接真实往返（首包建连慢，不能进中位数） */
function warmRTT() {
  if (!_rtts.length) return 0
  return Math.min.apply(null, _rtts)
}

async function main() {
  loadCache()
  console.log(`获取账号成功 ${userPhone.length}`)
  console.log()

  const accounts = []
  for (let i = 0; i < userPhone.length; i++) {
    const it = userPhone[i]
    try {
      const acc = await initAccount(it.phone, it.password, it.androidId, i + 1)
      if (acc) accounts.push(acc)
    } catch (e) {
      console.log(`[${maskPhone(it.phone)}] 初始化异常: ${e.stack || e.message}`)
      _setSign(i + 1, '初始化异常')
    }
    if (i < userPhone.length - 1) await sleep(1500)
  }
  await syncServerTime()
  console.log()
  console.log(`初始化完成：${accounts.length} 个账号待抢，共 ${accounts.reduce((n, a) => n + a.items.length, 0)} 项`)

  if (isTest) return
  if (!accounts.length) return

  // 目标时刻（按服务端时钟）
  const sNow = new Date(serverNow())
  let target = new Date(sNow.getFullYear(), sNow.getMonth(), sNow.getDate(), GRAB_HOUR, GRAB_MINUTE, 0, 0)
  if (target.getTime() <= sNow.getTime()) target = new Date(target.getTime() + 86400000)
  const fireLocalTs = Date.now() + (target.getTime() - sNow.getTime()) + GRAB_OFFSET
  console.log(`⏰ 将于服务端 ${target.toLocaleString('zh-CN')} 开抢（本机倒计时 ${Math.round((fireLocalTs - Date.now()) / 1000)}s）`)

  // 抢购前 30s 刷新 sign（sign 有寿命）；前 3.5s 预热连接并实测 RTT
  const toSign = fireLocalTs - 30000 - Date.now()
  if (toSign > 0) setTimeout(() => { refreshSigns(accounts).catch(() => {}) }, toSign)
  if (PREWARM) {
    [3500, 2500, 1500, 800, 300, 120].forEach((ms) => prewarmAt(fireLocalTs - Date.now() - ms, 2))
  }

  const deadline = fireLocalTs + WINDOW_MS
  const workers = accounts.map(async (acc, k) => {
    // 先醒到目标前 300ms，此时预热样本已到齐，再算「提前多久发射」
    await sleepUntil(fireLocalTs - 300 + k * ACCOUNT_GAP_MS)
    const rtt = warmRTT()
    const lead = LEAD_MS > 0 ? LEAD_MS : Math.min(Math.max(Math.round(rtt / 2), 15), 250)
    const fireTs = fireLocalTs - lead + k * ACCOUNT_GAP_MS
    if (k === 0) console.log(`🔥 热连接 RTT ${rtt || '?'}ms → 提前量 ${lead}ms（预定到达服务端 ≈ 目标时刻 +0ms）`)
    console.log(`[${acc.masked}] 就位 ${nowStamp()}，${
      String(Math.max(0, fireTs - Date.now())).padStart(4, ' ')}ms 后发射`)
    const r = await grabWorker(acc, { deadline, fireTs })
    const s = r.stats
    const head = `[${acc.masked}] 尝试 ${s.tries} 次 | 首发 ${s.firstMs}ms | 限流退避 ${s.throttles} 次` +
      (s.soldoutAt != null ? ` | 首次「已领完」在 +${s.soldoutAt}ms` : '')
    if (r.kind === 'ok') {
      console.log(`✅ ${head} → 抢到了：${r.item.title}（${r.resp && r.resp.msg}）`)
      _setSign(acc.idx, `兑换成功(${r.item.title})`, `兑换1/${acc.matchedTotal}项`)
    } else if (r.kind === 'already') {
      console.log(`✅ ${head} → 已领过：${r.item.title}`)
      _setSign(acc.idx, `兑换成功(${r.item.title})`, `兑换1/${acc.matchedTotal}项`)
    } else {
      const why = r.kind === 'soldout' ? '已领完(今日库存没了)'
        : r.kind === 'timeout' ? '窗口内未中' : r.kind === 'throttle' ? '被限流'
        : r.kind === 'nobean' ? '金豆不足' : r.kind === 'auth' ? '被风控拦截(401未授权)'
        : r.kind === 'net' ? '网络异常' : r.kind
      console.log(`❌ ${head} → 未抢到：${why}${r.resp ? ' | ' + r.resp.msg : ''}`)
      s.unknowns.forEach((u) => console.log(`     未知响应样本: ${u}`))
      _setSign(acc.idx, `兑换失败(${why})`, `兑换0/${acc.matchedTotal}项`)
    }
    return r
  })

  await Promise.all(workers)
  console.log('\n全部兑换流程执行完毕')
  await flushLogPoints(_rpApp)
}

async function probe() {
  loadCache()
  for (let i = 0; i < userPhone.length; i++) {
    const it = userPhone[i]
    console.log(`\n======== ${maskPhone(it.phone)} ========`)
    const acc = await initAccount(it.phone, it.password, it.androidId, i + 1)
    if (!acc) continue
    const item = acc.items[0]
    for (let k = 1; k <= 2; k++) {
      const r = await attempt(acc, item, acc.preEncrypted[item.activityId])
      console.log(`  第${k}发 ${r.ms}ms http=${r.http} kind=${r.kind} msg=${r.msg || ''}`)
      console.log(`    原始: ${String(r.raw).slice(0, 200)}`)
      await sleep(250)
    }
  }
}

;(async function start() {
  console.log('========================================')
  console.log('  电信等级权益 · 0点抢兑（抢购优化版 v2）')
  console.log('  环境变量 dxlin：手机号#密码#AndroidID')
  if (isTest) console.log('🧪 测试模式：只做登录与权益校验，不等待抢兑')
  if (isProbe) console.log('🔎 探针模式：立刻试发，打印服务端原始响应')
  console.log('========================================')
  console.log()
  try {
    if (isProbe) { await probe() } else { await main() }
    await flushLogPoints(_rpApp)
  } catch (err) {
    console.log(`💥 脚本全局异常：${err.stack || err.message}`)
    await flushLogPoints(_rpApp)
    process.exit(1)
  }
})()
