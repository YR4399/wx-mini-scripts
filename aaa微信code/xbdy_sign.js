/*
cron: 30 9 * * *
new Env('小白智慧打印-抽奖');
脚本位置: aaa微信code/xbdy_sign.js

小白智慧打印旗舰店（有赞小程序）抽奖脚本
appid: wxfb4fb840f87fef41 | 有赞 kdt_id: 18440888

功能：
  1. UIC登录获取 session
  2. 查询抽奖点数余额
  3. 查询抽奖状态（剩余次数）
  4. 自动参与抽奖
  5. 查询中奖结果

【环境变量】
  wx_server_url    = WCS 地址
  wx_auth          = WCS 认证 Key
  wx_opinion       = 微信 openid，多账号用 & 分隔
  xbdy_access_token = 有赞 access_token（从抓包获取）
  xbdy_sid          = 有赞 sessionId（可选，从抓包 Extra-Data 获取）
                      不填则通过 UIC 自动登录（部分接口需手机号授权）
  xbdy_lottery_alias= 抽奖活动 alias（默认 CRXvaL6AyXDg）
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '小白智慧打印'; }
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
  WX_SERVER: (process.env.wx_server_url || process.env.wxcodeurl || 'http://172.17.0.3:8787').replace(/\/$/, ''),
  WX_AUTH: process.env.wx_auth || process.env.WXAPIKEY || '',
  OPENIDS: parseOpenids(),
  APPID: 'wxfb4fb840f87fef41',
  KDT_ID: process.env.xbdy_kdt_id || '18440888',
  ACCESS_TOKEN: process.env.xbdy_access_token || '',
  LOTTERY_ALIAS: process.env.xbdy_lottery_alias || 'CRXvaL6AyXDg',
  APP_VERSION: '163',
  USER_VERSION: process.env.xbdy_user_version || '2.240.7',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
};

function parseOpenids() {
  const raw = process.env.wx_opinion || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}

// ==================== Token 缓存 ====================
const CACHE_FILE = path.join(__dirname, '.xbdy_token_cache.json');
function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { $.err(`读取缓存失败: ${e.message}`); }
  return {};
}
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); }
  catch (e) { $.err(`保存缓存失败: ${e.message}`); }
}

// ==================== HTTP ====================
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
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
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
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

// ==================== 有赞 API ====================
function buildExtraData(sid) {
  const now = Date.now();
  return JSON.stringify({
    is_weapp: 1,
    sid: sid,
    version: CFG.USER_VERSION,
    client: 'weapp',
    bizEnv: 'wsc',
    uuid: `xbdy_${now}`,
    ftime: now,
  });
}

function yzGet(path, params, sid) {
  const allParams = Object.assign({
    app_id: CFG.APPID,
    kdt_id: CFG.KDT_ID,
    access_token: CFG.ACCESS_TOKEN,
  }, params || {});
  const url = `https://h5.youzan.com${path}?${qs.stringify(allParams)}`;
  return httpGet(url, { 'Extra-Data': buildExtraData(sid) });
}

// ==================== UIC 登录 ====================
// ==================== 有赞登录 ====================
async function youzanLogin(openid, cache) {
  // 优先使用手动配置的 sid
  const manualSid = process.env.xbdy_sid || '';
  if (manualSid) {
    $.info('使用手动配置的 sid...');
    cache[openid] = { sid: manualSid, cachedAt: Date.now() };
    saveCache(cache);
    return { sid: manualSid };
  }

  const cached = cache[openid];
  if (cached && cached.sid && (Date.now() - cached.cachedAt) < 12 * 60 * 60 * 1000) {
    $.info('使用缓存的 Youzan Session...');
    return { sid: cached.sid };
  }

  $.info(`[${openid}] 获取微信 code...`);
  const codeResp = await httpPost(`${CFG.WX_SERVER}/wx/code`,
    JSON.stringify({ openid, appid: CFG.APPID }),
    { 'auth': CFG.WX_AUTH, 'Content-Type': 'application/json' }
  );
  if (!codeResp.data || !codeResp.data.status || !codeResp.data.data || !codeResp.data.data.code) {
    $.err(`获取 code 失败: ${JSON.stringify(codeResp.data)}`);
    return null;
  }

  $.ok('Code 获取成功');
  $.info('UIC 登录中...');
  const authResp = await httpPost('https://uic.youzan.com/passport/general/auth.json', {
    appId: CFG.APPID,
    code: codeResp.data.data.code,
    platformName: 'weapp',
    signature: 'Windows',
  });

  if (!authResp.data || (authResp.data.code !== 0 && authResp.data.code !== 200)) {
    $.err(`UIC 登录失败: ${JSON.stringify(authResp.data)}`);
    return null;
  }

  const sid = authResp.data.data?.sessionId || '';
  if (!sid) { $.err('未获取到 sessionId'); return null; }
  $.ok(`UIC 登录成功!`);

  cache[openid] = { sid, cachedAt: Date.now() };
  saveCache(cache);
  return { sid };
}

// ==================== 抽奖 API ====================
async function getPoints(sid) {
  const r = await yzGet('/wscump/lottery/get-user-points.json', {}, sid);
  if (!r.data || r.data.code !== 0) return null;
  return r.data.data;
}

async function getLotteryStatus(sid) {
  const r = await yzGet('/wscump/lottery/check-status.json', { alias: CFG.LOTTERY_ALIAS, kdtId: CFG.KDT_ID }, sid);
  if (!r.data || r.data.code !== 0) return null;
  return r.data.data;
}

async function joinLottery(sid) {
  const r = await yzGet('/wscump/lottery/join-lottery.json', { alias: CFG.LOTTERY_ALIAS, kdtId: CFG.KDT_ID }, sid);
  if (!r.data || r.data.code !== 0) { $.err(`joinLottery: ${r.data?.code} ${r.data?.msg}`); return null; }
  return r.data.data;
}

// ==================== 签到 API ====================
async function getCheckinInfo(sid) {
  const r = await yzGet('/wscump/checkin/check-in-info.json', {}, sid);
  if (!r.data || r.data.code !== 0) return null;
  return r.data.data;
}

async function getCheckinStatus(checkinId, sid) {
  const r = await yzGet('/wscump/checkin/get_activity_by_yzuid_v2.json', { checkinId }, sid);
  if (!r.data || r.data.code !== 0) return null;
  return r.data.data;
}

async function doCheckin(checkinId, sid) {
  const r = await yzGet('/wscump/checkin/checkinV2.json', { checkinId }, sid);
  if (!r.data) return null;
  return r.data;
}

// ==================== 单账号处理 ====================
async function processAccount(openid, cache) {
  $.info(`\n======== 账号: ${openid} ========`);
  const summary = { points: 0, draws: 0, prizes: [], signed: false };

  // Step 1: 登录
  const loginResult = await youzanLogin(openid, cache);
  if (!loginResult) return summary;
  const sid = loginResult.sid;

  // Step 2: 签到
  const checkinInfo = await getCheckinInfo(sid);
  if (checkinInfo) {
    const cid = checkinInfo.checkInId;
    $.info(`签到活动 ID: ${cid}`);
    const cStatus = await getCheckinStatus(cid, sid);
    if (cStatus) {
      $.info(`签到状态: ${cStatus.isCheckin ? '已签到' : '未签到'}, 连续: ${cStatus.continuesDay}天, 每日奖励: ${(cStatus.dailyRewards||[]).map(r=>r.desc).join(',')}`);
      if (!cStatus.isCheckin) {
        const cr = await doCheckin(cid, sid);
        if (cr && cr.code === 0) {
          const award = cr.data?.list?.[0]?.infos?.title || '奖励';
          $.ok(`签到成功! ${award}`);
          summary.signed = true;
        } else if (cr && (cr.msg?.includes('已签到') || cr.msg?.includes('重复'))) {
          $.log('今日已签到');
          summary.signed = true;
        } else {
          $.log(`签到: ${cr?.msg || 'unknown'} (${cr?.code})`);
        }
      } else {
        $.log('今日已签到');
        summary.signed = true;
      }
    }
  }

  // Step 3: 积分
  const points = await getPoints(sid);
  if (points) {
    summary.points = points.currentPoints || 0;
    $.info(`积分余额: ${summary.points}`);
  }

  // Step 4: 抽奖状态
  const status = await getLotteryStatus(sid);
  if (!status) { $.err('获取抽奖状态失败'); return summary; }
  $.info(`抽奖次数: ${status.joinTimeSurplus} | 可分享: ${status.shareTimeSurplus} | 明天可抽: ${status.canJoinTomorrow}`);

  // Step 4: 抽奖
  const joinTimes = status.joinTimeSurplus || 0;
  if (joinTimes > 0) {
    $.info(`开始抽奖 (${joinTimes} 次)...`);
    for (let i = 0; i < joinTimes; i++) {
      const result = await joinLottery(sid);
      if (result) {
        summary.draws++;
        if (result.isWinning && result.awardList) {
          result.awardList.forEach(a => {
            $.ok(`🎉 中奖: ${a.prizeName} (${a.prizeDesc || ''})`);
            summary.prizes.push(a);
          });
        } else if (result.isWinning === false) {
          $.log('本次未中奖');
        }
      }
      await $.wait(1500);
    }
  } else {
    $.log('今日已无抽奖次数');
  }

  // Step 6: 任务（分享）
  if (status.tasks) {
    status.tasks.forEach(t => {
      if (!t.finished) {
        $.log(`任务: ${t.title} (${t.tags?.join(',')}) - 需微信分享，不可脚本化`);
      }
    });
  }

  $.ok(`👤 ${openid} 完成! 签到:${summary.signed} 抽奖:${summary.draws}次 积分:${summary.points}`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【小白智慧打印·抽奖】 ${t}`);

  if (!CFG.WX_AUTH) { $.err('未配置 wx_auth'); return; }
  if (!CFG.ACCESS_TOKEN) { $.err('未配置 xbdy_access_token'); return; }
  if (CFG.OPENIDS.length === 0) { $.err('未配置 wx_opinion'); return; }

  const cache = loadCache();
  $.info(`共 ${CFG.OPENIDS.length} 个账号`);

  let totalDraws = 0, maxPoints = 0;
  for (let i = 0; i < CFG.OPENIDS.length; i++) {
    const r = await processAccount(CFG.OPENIDS[i], cache);
    totalDraws += r.draws;
    if (r.points > maxPoints) maxPoints = r.points;
    if (i < CFG.OPENIDS.length - 1) await $.wait(2000);
  }

  console.log(`\n========================================`);
  console.log(`📊 汇总: 抽奖 ${totalDraws} 次 | 最高积分 ${maxPoints}`);
  $.ok('所有任务执行完毕！');
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
