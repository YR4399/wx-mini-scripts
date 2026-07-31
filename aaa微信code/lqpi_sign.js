/*
cron: 30 10 * * *
new Env('漓泉啤酒-签到');
脚本位置: aaa微信code/lqpi_sign.js

漓泉啤酒生态营地小程序签到脚本
appid: wx08dabaec2783f4e9 | API: api.mbr.liquan.com

功能：
  1. WCS 微信登录获取 Token
  2. 每日签到（+5生态币，连续签到递增）
  3. 签到列表/周签到状态
  4. 积分/会员信息查询
  5. 任务列表

【环境变量】
  wx_server_url = WCS 地址
  wx_auth       = WCS 认证 Key
  wx_opinion    = 微信 openid，多账号用 & 分隔
  lqpi_station_id = 站点ID（默认 74）
*/

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '漓泉啤酒'; }
  log(msg) { console.log(`📌 [${this.ts()}] ${msg}`); }
  ok(msg) { console.log(`✅ [${this.ts()}] ${msg}`); }
  err(msg) { console.log(`❌ [${this.ts()}] ${msg}`); }
  warn(msg) { console.log(`⚠️ [${this.ts()}] ${msg}`); }
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
  APPID: 'wx08dabaec2783f4e9',
  HOST: 'api.mbr.liquan.com',
  STATION_ID: process.env.lqpi_station_id || '74',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
};

function parseOpenids() {
  const raw = process.env.wx_opinion || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}

// ==================== Token 缓存 ====================
const CACHE_FILE = path.join(__dirname, '.lqpi_token_cache.json');
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
function api(method, hostname, path, body, headers) {
  return new Promise((resolve) => {
    const isTls = hostname === CFG.HOST;
    const lib = isTls ? https : http;
    const [h, p] = hostname.split(':');
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: h, port: parseInt(p) || (isTls ? 443 : 80),
      path, method, rejectUnauthorized: false,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'User-Agent': CFG.UA,
        'Referer': `https://servicewechat.com/${CFG.APPID}/236/page-frame.html`,
      }, headers || {}),
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function yzApi(method, path, body, token) {
  const headers = {};
  if (token) headers['Token'] = token;
  return api(method, CFG.HOST, path, body, headers);
}

// ==================== WCS 登录 ====================
async function wxLogin(openid, cache) {
  const cached = cache[openid];
  if (cached && cached.token && (Date.now() - cached.cachedAt) < 24 * 60 * 60 * 1000) {
    // 验证 token 是否仍有效
    const r = await yzApi('GET', '/api/b2c/member/info', null, cached.token);
    if (r.data && (r.data.code === 200 || r.data.errcode === 0)) {
      $.info('使用缓存的 Token...');
      return { token: cached.token, info: r.data.data?.memberInfo };
    }
    $.info('缓存 Token 已过期，重新登录...');
  }

  // 获取 wx.login code
  $.info('获取微信 code...');
  const codeResp = await api('POST', CFG.WX_SERVER.replace(/^https?:\/\//, ''), '/wx/code',
    { openid, appid: CFG.APPID },  // 传对象，不预序列化
    { 'auth': CFG.WX_AUTH }
  );
  const code = codeResp.data?.data?.code;
  if (!code) { $.err(`获取 code 失败: ${JSON.stringify(codeResp.data)}`); return null; }
  $.ok('Code 获取成功');

  // 微信登录
  $.info('WX Login 中...');
  const loginResp = await yzApi('GET', `/api/mbr/members/wxLogin/${code}`, null, null);
  if (!loginResp.data || loginResp.data.errcode !== 0) {
    $.err(`登录失败: ${JSON.stringify(loginResp.data)}`);
    return null;
  }

  const token = loginResp.data.data?.token;
  const info = loginResp.data.data;
  $.ok(`登录成功! 会员: ${info.memberMobile || ''}`);

  cache[openid] = { token, cachedAt: Date.now() };
  saveCache(cache);
  return { token, info };
}

// ==================== API ====================
async function doSign(token) {
  const r = await yzApi('POST', '/api/b2c/member/sign/task', {}, token);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data?.signRes;
}

async function getSignList(token) {
  const r = await yzApi('GET', '/api/b2c/member/sign/task/list', null, token);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data?.signRes;
}

async function getMemberInfo(token) {
  const r = await yzApi('GET', '/api/b2c/member/info', null, token);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data?.memberInfo;
}

async function getPoints(token) {
  const r = await yzApi('GET', `/api/b2c/member/pointsAndCouponCardNumAndShopCardInfo?stationId=${CFG.STATION_ID}`, null, token);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function getTaskList(token) {
  const r = await yzApi('POST', '/api/b2c/member/task/list', {}, token);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

// ==================== 单账号处理 ====================
async function processAccount(openid, cache) {
  $.info(`\n======== 账号: ${openid} ========`);
  const summary = { sign: false, points: 0 };

  // Step 1: WCS 登录
  const loginResult = await wxLogin(openid, cache);
  if (!loginResult) return summary;
  const token = loginResult.token;

  // Step 2: 会员信息
  const info = await getMemberInfo(token);
  if (info) {
    $.info(`会员: ${info.memberTrueName || '未知'} | ${info.memberMobile || ''} | ${info.memberLevelName || ''} | 积分:${info.memberPoints || 0}`);
  }

  // Step 3: 签到
  const signList = await getSignList(token);
  if (signList) {
    const todayStr = new Date().toISOString().substring(0, 10);
    const today = (signList.taskSignDtoList || []).find(s => s.signTime === todayStr);
    if (today && today.signStatus !== 'no_sign') {
      $.log(`今日已签到 (连续第${signList.weekNum}天, +${signList.rewardNum}生态币)`);
      summary.sign = true;
    } else {
      $.info('执行签到...');
      const signResult = await doSign(token);
      if (signResult && signResult.sign) {
        $.ok(`签到成功! 连续第${signResult.weekNum}天`);
        summary.sign = true;
      }
    }
  }

  // Step 4: 积分
  const pts = await getPoints(token);
  if (pts) summary.points = pts.memberPoints || pts.memberNum || 0;

  // Step 5: 任务
  const tasks = await getTaskList(token);
  if (tasks && tasks.taskResDtoList) {
    $.info(`任务 ${tasks.taskResDtoList.length} 个:`);
    for (const t of tasks.taskResDtoList) {
      const icon = t.finishStatus === 'finish' ? '✅' : (t.taskStatus === 'receive' ? '📌' : '❌');
      $.log(`  ${icon} ${t.taskMsgName}: +${t.rewardNum}生态币`);
    }
  }

  $.ok(`${openid.substring(0,8)} 完成: 签到${summary.sign ? '✅' : '❌'} 积分:${summary.points}`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  console.log(`\n【漓泉啤酒·签到】 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  if (!CFG.WX_AUTH) { $.err('未配置 wx_auth'); return; }
  if (CFG.OPENIDS.length === 0) { $.err('未配置 wx_opinion'); return; }

  const cache = loadCache();
  $.info(`共 ${CFG.OPENIDS.length} 个账号`);

  let totalSign = 0;
  for (let i = 0; i < CFG.OPENIDS.length; i++) {
    const r = await processAccount(CFG.OPENIDS[i], cache);
    if (r.sign) totalSign++;
    if (i < CFG.OPENIDS.length - 1) await $.wait(3000);
  }

  console.log(`\n📊 签到 ${totalSign}/${CFG.OPENIDS.length}`);
  $.ok('完成！');
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
