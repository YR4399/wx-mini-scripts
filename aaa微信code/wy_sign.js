/*
cron: 30 9 * * *
new Env('丸丫甄选-签到');
脚本位置: aaa微信code/wy_sign.js

丸丫甄选（有赞店铺小程序）签到脚本
appid: wx35322299c6492f6e | 有赞 kdt_id: 100939936

功能：
  1. 每日签到（+5积分，连续签到额外奖励）
  2. 签到状态查询
  3. 连续签到奖励（7天+50, 14天+100, 30天+300）
  4. 积分余额查询

【环境变量】
  wx_server_url   = WCS 地址
  wx_auth         = WCS 认证 Key
  wx_opinion      = 微信 openid，多账号用 & 分隔
  wy_access_token = 有赞 access_token（可从抓包获取）
  wy_sid         = 有赞 sessionId（可选，从抓包的 Extra-Data header 获取 sid 字段）
                   不填则通过 UIC 自动登录
  wy_kdt_id       = 有赞店铺 ID（默认 100939936）
*/

const crypto = require('crypto');
const notifyLines = [];
const _origLog = console.log;
console.log = function (...args) {
  try { notifyLines.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(" ")); } catch (e) {}
  _origLog.apply(console, args);
};
async function sendToPushPlus(title, content) {
  const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN || "";
  if (!token || !content.trim()) return;
    if (content.length > 6000) content = content.slice(-6000);
  const payload = { token, title, content, template: "txt" };
  try {
    if (typeof axios !== "undefined") {
      await axios.post("https://www.pushplus.plus/send", payload, { timeout: 10000 });
    } else {
      const data = JSON.stringify(payload);
      await new Promise((resolve, reject) => {
        const req = https.request("https://www.pushplus.plus/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: 10000,
        }, (res) => { res.resume(); res.on("end", resolve); });
        req.on("error", reject); req.write(data); req.end();
      });
    }
    _origLog("✅ PushPlus推送成功: " + title);
  } catch (e) { _origLog("❌ PushPlus推送失败: " + (e.message || e)); }
}
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '丸丫甄选'; }
  log(msg) { console.log(`📌 [${this.ts()}] ${msg}`); }
  ok(msg) { console.log(`✅ [${this.ts()}] ${msg}`); }
  err(msg) { console.log(`❌ [${this.ts()}] ${msg}`); }
  info(msg) { console.log(`🔧 [${this.ts()}] ${msg}`); }
  ts() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env();

// ==================== 配置 ====================
const CFG = {
  WX_SERVER: (process.env.wx_server_url || process.env.wxcodeurl || 'http://host.docker.internal:18788').replace(/\/$/, ''),
  WX_AUTH: process.env.wx_auth || process.env.WXAPIKEY || process.env.WX_SERVER_APIKEY || '',
  OPENIDS: parseOpenids(),
  APPID: 'wx35322299c6492f6e',
  KDT_ID: process.env.wy_kdt_id || '100939936',
  ACCESS_TOKEN: process.env.wy_access_token || '',
  APP_VERSION: '49',
  USER_VERSION: process.env.wy_user_version || '2.219.11.101',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
};

function parseOpenids() {
  const raw = process.env.wx_opinion || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}

// ==================== Token 缓存 ====================
const CACHE_FILE = path.join(__dirname, '.wy_token_cache.json');
function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { $.err(`读取缓存失败: ${e.message}`); }
  return {};
}
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  catch (e) { $.err(`保存缓存失败: ${e.message}`); }
}

// ==================== HTTP 工具 ====================
function httpGet(urlStr, extraHeaders) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const isTls = u.protocol === 'https:';
    const lib = isTls ? https : http;
    const headers = Object.assign({
      'User-Agent': CFG.UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://servicewechat.com/${CFG.APPID}/${CFG.APP_VERSION}/page-frame.html`,
    }, extraHeaders || {});
    const opts = { hostname: u.hostname, port: u.port || (isTls ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, rejectUnauthorized: false };
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, raw: d, headers: res.headers }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}

function httpPost(urlStr, body, extraHeaders) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const isTls = u.protocol === 'https:';
    const lib = isTls ? https : http;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
    const headers = Object.assign({
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': CFG.UA,
      'Accept': 'application/json, text/plain, */*',
      'Content-Length': Buffer.byteLength(bodyStr),
    }, extraHeaders || {});
    const opts = { hostname: u.hostname, port: u.port || (isTls ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers, rejectUnauthorized: false };
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, raw: d, headers: res.headers }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

// ==================== 有赞登录 ====================
async function youzanLogin(openid, cache) {
  // 优先使用手动配置的 sid
  const manualSid = process.env.wy_sid || '';
  if (manualSid) {
    $.info('使用手动配置的 sid...');
    cache[openid] = { sid: manualSid, cachedAt: Date.now() };
    saveCache(cache);
    return { sid: manualSid };
  }
  
  // 检查缓存
  const cached = cache[openid];
  if (cached && cached.sid && (Date.now() - cached.cachedAt) < 12 * 60 * 60 * 1000) {
    $.info('使用缓存的 Youzan Session...');
    return { sid: cached.sid };
  }

  // 通过 WCS 获取 wx.login code (POST with JSON body)
  $.info(`[${openid}] 获取微信 code...`);
  const codeResp = await httpPost(`${CFG.WX_SERVER}/wx/code`,
    JSON.stringify({ openid, appid: CFG.APPID }),
    {
      'auth': CFG.WX_AUTH,
      'Content-Type': 'application/json',
    }
  );

  if (!codeResp.data || !codeResp.data.status || !codeResp.data.data || !codeResp.data.data.code) {
    $.err(`获取 code 失败: ${JSON.stringify(codeResp.data)}`);
    return null;
  }
  const code = codeResp.data.data.code;
  $.ok('Code 获取成功');

  // UIC 登录
  $.info('UIC 登录中...');
  const authResp = await httpPost('https://uic.youzan.com/passport/general/auth.json', {
    appId: CFG.APPID,
    code,
    platformName: 'weapp',
    signature: 'Windows',
  });

  if (!authResp.data || (authResp.data.code !== 0 && authResp.data.code !== 200)) {
    $.err(`UIC 登录失败: ${JSON.stringify(authResp.data)}`);
    return null;
  }

  const sid = authResp.data.data?.sessionId || authResp.data.data?.sid || authResp.data.data?.SessionId || '';
  if (!sid) {
    $.err(`UIC 未返回 sessionId: ${JSON.stringify(authResp.data.data).substring(0,200)}`);
    return null;
  }
  $.ok(`UIC 登录成功! sid=${sid.substring(0,20)}...`);

  // 缓存
  cache[openid] = { sid, nickname: authResp.data.data?.nickName || '', cachedAt: Date.now() };
  saveCache(cache);

  return { sid, data: authResp.data.data };
}

// ==================== Youzan API 调用 ====================
function buildYzUrl(path, params) {
  const allParams = Object.assign({
    app_id: CFG.APPID,
    kdt_id: CFG.KDT_ID,
    access_token: CFG.ACCESS_TOKEN,
  }, params || {});
  const queryStr = qs.stringify(allParams);
  return `https://h5.youzan.com${path}?${queryStr}`;
}

function buildExtraData(sid) {
  const now = Date.now();
  return JSON.stringify({
    is_weapp: 1,
    sid: sid,
    version: CFG.USER_VERSION,
    client: 'weapp',
    bizEnv: 'wsc',
    uuid: `cv3so7yuBdzE${now}`,
    ftime: now,
  });
}

async function yzGet(path, params, sid) {
  const url = buildYzUrl(path, params);
  const headers = {
    'Extra-Data': buildExtraData(sid),
  };
  return httpGet(url, headers);
}

// ==================== 签到相关 ====================

/** 获取签到活动信息 */
async function getCheckinInfo(sid) {
  const r = await yzGet('/wscump/checkin/check-in-info.json', {}, sid);
  if (!r.data || r.data.code !== 0) {
    $.err(`获取签到信息失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data.data; // { checkInId, activityOwnerKdtId }
}

/** 获取签到状态 */
async function getCheckinStatus(checkinId, sid) {
  const r = await yzGet('/wscump/checkin/get_activity_by_yzuid_v2.json', { checkinId }, sid);
  if (!r.data || r.data.code !== 0) {
    $.err(`获取签到状态失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data.data;
}

/** 执行签到 */
async function doCheckin(checkinId, sid) {
  const r = await yzGet('/wscump/checkin/checkinV2.json', { checkinId }, sid);
  if (!r.data) {
    $.err('签到请求失败');
    return null;
  }
  return r.data;
}

/** 获取月度签到记录 */
async function getMonthlyCheckin(checkinId, sid) {
  const now = new Date();
  const r = await yzGet('/wscump/checkin/find_checkin_info_by_month.json', {
    checkin_id: checkinId,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  }, sid);
  if (!r.data || r.data.code !== 0) {
    return null;
  }
  return r.data.data;
}

/** 获取积分余额 */
async function getPoints(sid) {
  const r = await yzGet('/wscuser/membercenter/init-data.json', {}, sid);
  if (!r.data || r.data.code !== 0) {
    return null;
  }
  return r.data.data;
}

// ==================== 单账号处理 ====================
async function processAccount(openid, cache) {
  $.info(`\n======== 账号: ${openid} ========`);
  const summary = { sign: false, points: 0, continuesDay: 0 };

  // Step 1: Youzan 登录
  const loginResult = await youzanLogin(openid, cache);
  if (!loginResult) { $.err('登录失败，跳过此账号'); return summary; }
  const sid = loginResult.sid;

  // Step 2: 获取签到配置
  const checkinInfo = await getCheckinInfo(sid);
  if (!checkinInfo) { $.err('获取签到配置失败'); return summary; }
  const checkinId = checkinInfo.checkInId;
  $.info(`签到活动 ID: ${checkinId}`);

  // Step 3: 查询签到状态
  const status = await getCheckinStatus(checkinId, sid);
  if (!status) { $.err('查询签到状态失败'); return summary; }

  $.info(`签到状态: ${status.isCheckin ? '已签到' : '未签到'}, 连续: ${status.continuesDay}天`);

  // Step 4: 执行签到
  if (!status.isCheckin) {
    const result = await doCheckin(checkinId, sid);
    if (result && result.code === 0) {
      const award = result.data?.list?.[0];
      const awardDesc = award?.infos?.title || '未知';
      $.ok(`签到成功! 获得: ${awardDesc}`);
      summary.sign = true;
    } else if (result && (result.msg?.includes('已签到') || result.msg?.includes('重复') || result.msg?.includes('次数'))) {
      $.log('今日已签到（重复）');
      summary.sign = true;
    } else {
      $.err(`签到失败: ${result?.msg || 'unknown'}`);
    }
  } else {
    $.log('今日已签到');
    summary.sign = true;
  }

  // Step 5: 查看连续签到奖励
  if (status.rewards) {
    const unclaimed = status.rewards.filter(r => !r.fetched && status.continuesDay >= parseInt(r.duration));
    if (unclaimed.length > 0) {
      $.info(`可领取连续签到奖励: ${unclaimed.map(r => `${r.duration}天→${r.prize[0]?.desc?.middle || '?'}积分`).join(', ')}`);
    }
    summary.continuesDay = status.continuesDay;
  }

  // Step 6: 积分查询
  const pointsData = await getPoints(sid);
  if (pointsData && pointsData.member) {
    summary.points = pointsData.member.stats?.points || 0;
    $.info(`当前积分余额: ${summary.points}`);
  }

  $.ok(`👤 ${openid} 完成! 签到:${summary.sign} 积分:${summary.points} 连续:${summary.continuesDay}天`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【丸丫甄选·签到】 ${t}`);

  if (!CFG.WX_AUTH) { $.err('未配置 wx_auth'); return; }
  if (!CFG.ACCESS_TOKEN) { $.err('未配置 wy_access_token（有赞 access_token），请从抓包获取'); return; }
  if (CFG.OPENIDS.length === 0) { $.err('未配置 wx_opinion'); return; }

  const cache = loadCache();
  $.info(`共 ${CFG.OPENIDS.length} 个账号`);

  let totalSign = 0, maxPoints = 0;
  for (let i = 0; i < CFG.OPENIDS.length; i++) {
    const r = await processAccount(CFG.OPENIDS[i], cache);
    if (r.sign) totalSign++;
    if (r.points > maxPoints) maxPoints = r.points;
    if (i < CFG.OPENIDS.length - 1) await $.wait(2000);
  }

  console.log(`\n========================================`);
  console.log(`📊 汇总: 签到 ${totalSign}/${CFG.OPENIDS.length} | 最高积分 ${maxPoints}`);
  $.ok('所有任务执行完毕！');
  await sendToPushPlus("丸丫甄选", notifyLines.join("\n"));
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
