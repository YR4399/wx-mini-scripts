/**
 * 益起欢乐走 (yqhlz) 签到 + 浏览/分享刷分脚本
 * 小程序: yqhlz.xiansport.net:9990 (CRMEB lxx 运动模块)
 * 抓包: szminorshort.weixin.qq.com_2026_08_03_01_32_57.har
 *
 * 任务:
 *   1. 每日签到  +1 积分   (GET /lxx/usercenter/sign, 今日已签返空)
 *   2. 浏览/分享 ×7        (GET /lxx/usercenter/share/READ_ARTICLE?noAuth=true, 每次 +1, 到上限返空)
 *
 * 环境变量:
 *   wx_opinion   - openid, 多账号 & 分隔
 *   wx_server_url- WCS 地址 (默认 http://host.docker.internal:18788)
 *   wx_auth      - WCS 认证
 *   PUSH_PLUS_TOKEN / PLUSPLUS_TOKEN - 推送
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const APPID = 'wx617aaaa2b5a28804';
const API_HOST = 'yqhlz.xiansport.net';
const API_PORT = 9990;
const API_BASE = '/front/api/front';
const WX_SERVER_URL = process.env.wx_server_url || 'http://host.docker.internal:18788';
const WX_AUTH = process.env.wx_auth || '';
const UA = 'Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 MicroMessenger/8.0.64.2940(0x2800403b) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android';

const COLORS = { R: '\x1b[0m', RED: '\x1b[31m', GREEN: '\x1b[32m', YELLOW: '\x1b[33m', CYAN: '\x1b[36m', BOLD: '\x1b[1m' };
function log(msg, color) { console.log(`${COLORS.BOLD}[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]${COLORS.R} ${COLORS[color] || ''}${msg}${COLORS.R}`); }
const delay = ms => new Promise(r => setTimeout(r, ms));

// 通用请求: 按 URL 协议自动选 http/https (WCS 是 HTTP 明文, API 是 HTTPS)
function rawRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, headers, rejectUnauthorized: false, timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, json, raw: d });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function request(method, path, token, bodyObj) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': UA,
    'Referer': `https://servicewechat.com/${APPID}/29/page-frame.html`,
  };
  if (token) headers['authori-zation'] = token;
  let body = '';
  if (bodyObj) body = JSON.stringify(bodyObj);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await rawRequest(`https://${API_HOST}:${API_PORT}${API_BASE}${path}`, method, headers, body);
    } catch (e) {
      if (attempt < 4) { await delay(1500 * attempt); continue; }
      throw e;
    }
  }
}

async function getWxCode(openid) {
  const res = await rawRequest(`${WX_SERVER_URL}/wx/code`, 'POST',
    { 'auth': WX_AUTH, 'Content-Type': 'application/json' },
    JSON.stringify({ openid, appid: APPID }));
  if (res.json && res.json.status && res.json.data && res.json.data.code) return res.json.data.code;
  throw new Error('WCS code 失败: ' + (res.raw || '').slice(0, 120));
}

// WCS 获取手机号授权数据 (encryptedData/iv)
async function getPhoneNumber(openid) {
  const res = await rawRequest(`${WX_SERVER_URL}/wx/getphonenumber`, 'POST',
    { 'auth': WX_AUTH, 'Content-Type': 'application/json' },
    JSON.stringify({ openid, appid: APPID }));
  if (res.json && res.json.status && res.json.data && res.json.data.raw) {
    return res.json.data.raw; // {encryptedData, iv, data:{mobile}}
  }
  throw new Error('WCS 手机号获取失败: ' + (res.raw || '').slice(0, 120));
}

async function login(openid) {
  // 1. 首次登录
  let code = await getWxCode(openid);
  const res = await request('POST', `/wechat/authorize/program/login?code=${encodeURIComponent(code)}`, '', {
    code, spread_spid: 0, avatar: '', nickName: '微信用户', type: 'routine',
  });
  if (res.json && res.json.code === 200 && res.json.data && res.json.data.token) {
    return { token: res.json.data.token, uid: res.json.data.uid, nick: res.json.data.nikeName || '' };
  }
  // 2. register → 手机号绑定 (WCS getphonenumber + 新登录 code)
  if (res.json && res.json.code === 200 && res.json.data && res.json.data.type === 'register' && res.json.data.key) {
    const key = res.json.data.key;
    log(`📱 检测到新账号，自动绑定手机号注册...`, 'YELLOW');
    const pn = await getPhoneNumber(openid);
    if (!pn || !pn.encryptedData) throw new Error('无法获取手机号授权数据');
    code = await getWxCode(openid); // 新登录 code (binding/phone 需要)
    const bind = await request('POST', `/wechat/register/binding/phone`, '', {
      encryptedData: pn.encryptedData, iv: pn.iv, code, key, type: 'routine',
    });
    if (bind.json && bind.json.code === 200 && bind.json.data && bind.json.data.token) {
      log(`✅ 注册绑定成功 (手机 ${bind.json.data.phone || ''})`, 'GREEN');
      return { token: bind.json.data.token, uid: bind.json.data.uid, nick: bind.json.data.nikeName || '' };
    }
    throw new Error('绑定手机号失败: ' + ((bind.json && bind.json.message) || (bind.raw || '').slice(0, 120)));
  }
  throw new Error('登录失败: ' + (res.raw || '').slice(0, 150));
}

async function runAccount(openid, idx) {
  const tag = `账号${idx} (${openid.slice(0, 10)}...)`;
  const res = { tag, sign: '—', readCount: 0, readGain: 0, integral: null, errors: [] };
  log(`\n========== ${tag} ==========`, 'BOLD');

  // 1. 登录
  let token, uid, nick;
  try {
    const lo = await login(openid);
    token = lo.token; uid = lo.uid; nick = lo.nick;
    log(`✅ 登录成功 uid=${uid} ${nick}`, 'GREEN');
  } catch (e) {
    log(`❌ 登录失败: ${e.message}`, 'RED');
    res.errors.push(e.message);
    res.sign = '登录失败';
    return res;
  }
  await delay(800);

  // 2. 用户信息 + 当前积分
  try {
    const u = await request('GET', '/user', token);
    if (u.json && u.json.code === 200) {
      res.integral = u.json.data.integral;
      log(`👤 ${u.json.data.nickname || nick || '-'} | 当前积分 ${res.integral}`, 'CYAN');
    }
  } catch (e) {}
  await delay(800);

  // 3. 每日签到 (GET /lxx/usercenter/sign; 今日已签返回空 data, 未签会执行)
  try {
    const s = await request('GET', '/lxx/usercenter/sign', token);
    if (s.json && s.json.code === 200) {
      const d = s.json.data || {};
      if (d && typeof d === 'object' && Object.keys(d).length > 0 && (d.integral !== undefined || d.id || d.linkId)) {
        res.sign = `签到成功 +${d.integral ?? 1}分`;
        log(`✅ ${res.sign}`, 'GREEN');
      } else {
        res.sign = '今日已签到';
        log(`✅ 今日已签到(或已处理)`, 'GREEN');
      }
    } else {
      res.sign = '签到异常: ' + ((s.json && s.json.message) || s.raw.slice(0, 60));
      log(`⚠️ ${res.sign}`, 'YELLOW');
    }
  } catch (e) {
    res.errors.push('sign:' + e.message);
    log(`⚠️ 签到异常: ${e.message}`, 'YELLOW');
  }
  await delay(1000);

  // 4. 浏览/分享刷分 (READ_ARTICLE ×7, 每次 +1, 到上限返回空 data)
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await request('GET', '/lxx/usercenter/share/READ_ARTICLE?noAuth=true', token);
      const d = (r.json && r.json.data) || {};
      if (r.json && r.json.code === 200 && (d.integral !== undefined || Object.keys(d).length > 0)) {
        const got = d.integral !== undefined ? d.integral : 1;
        res.readCount++;
        res.readGain += got;
        log(`📖 浏览/分享 ${i}/5 次 -> +${got}分`, 'GREEN');
      } else {
        log(`📖 浏览/分享 ${i}/5 次 -> 已达上限(空响应)，停止`, 'YELLOW');
        break;
      }
    } catch (e) {
      log(`📖 浏览/分享 ${i}/5 次 -> ${e.message}`, 'YELLOW');
    }
    await delay(1200);
  }

  // 5. 最终积分
  try {
    const u = await request('GET', '/integral/user', token);
    if (u.json && u.json.code === 200) res.integral = u.json.data.integral;
  } catch (e) {}
  log(`💰 最终积分: ${res.integral ?? '?'}`, 'CYAN');
  return res;
}

function push(title, content) {
  return new Promise(resolve => {
    const tk = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || '';
    if (!tk) { log('⚠️ 未配置推送 token', 'YELLOW'); return resolve(); }
    const body = JSON.stringify({ token: tk, title, content, template: 'txt' });
    const req = https.request({ hostname: 'www.pushplus.plus', port: 443, path: '/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, rejectUnauthorized: false, timeout: 10000 },
      res => { res.on('data', () => {}); res.on('end', () => { log('✅ 推送已发送', 'CYAN'); resolve(); }); });
    req.on('error', () => { log('⚠️ 推送失败', 'YELLOW'); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  log('🔔 益起欢乐走,开始');
  const accounts = (process.env.wx_opinion || '').split('&').map(s => s.trim()).filter(Boolean);
  if (accounts.length === 0) { log('❌ 未配置 wx_opinion', 'RED'); return; }
  log(`ℹ️ 共 ${accounts.length} 个账号`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    results.push(await runAccount(accounts[i], i + 1));
  }

  log('\n📊 汇总', 'BOLD');
  const lines = results.map(r =>
    `【${r.tag}】\n` +
    `签到: ${r.sign}\n` +
    `浏览/分享: ${r.readCount}次 +${r.readGain}分\n` +
    `当前积分: ${r.integral ?? '?'}` + (r.errors.length ? `\n异常: ${r.errors.join('; ')}` : '')
  );
  console.log(lines.join('\n\n'));
  await push('益起欢乐走签到', lines.join('\n\n'));
  log('🔔 益起欢乐走,结束');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
