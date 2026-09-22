/**
 * 甘肃烟草/白加黑 签到脚本
 * HAR: szextshort.weixin.qq.com (2026-07-25)
 *
 * 签到奖励: 7天循环 2->3->5->5->7->8->10 飞天币
 *
 * 环境变量:
 *   SJY_TOKEN:  userToken (必填，手机验证码登录后获取)
 *   SJY_CODE:   WeChat code (签到必填，小程序登录获取)
 *   SJY_PHONE:  手机号 (用于登录，可选)
 */

const https = require('https');
const axios = require('axios');
const { ICON, L, sectionLine, humanDelay } = require("./_decor");

const BASE = 'https://gszy.baijqr.cn';
const UA = 'Mozilla/5.0 (Linux; Android 16; V2405A Build/BP2A.250605.031.A3_V000L1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 Mobile Safari/537.36 MicroMessenger/8.0.76.3140(0x28004C31) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64';

const api = axios.create({
  baseURL: BASE, timeout: 15000,
  headers: { 'User-Agent': UA, 'X-Requested-With': 'com.tencent.mm', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

const now = () => Math.floor(Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseEnv(name) {
  const v = (process.env[name] || '').trim();
  return v ? v.split(/[\n&@;]+/).map(s => s.trim()).filter(Boolean) : [];
}

function getAccounts() {
  const tokens = parseEnv('SJY_TOKEN');
  const codes  = parseEnv('SJY_CODE');
  const phones = parseEnv('SJY_PHONE');
  if (!tokens.length) { L.fail('未找到 SJY_TOKEN'); return []; }
  return tokens.map((t, i) => ({ idx: i+1, token: t, code: codes[i]||'', phone: phones[i]||'' }));
}

async function api_get(path, params = {}) {
  try {
    const r = await api.get(path, { params });
    return r.data;
  } catch (e) {
    L.fail(path + ': ' + e.message);
    return null;
  }
}

async function getSm4Key() {
  const r = await api_get('/api/cloud2.member.api/sm4/query', { t: now() });
  if (r && r.code === 200) return r.data;
  L.fail('SM4密钥失败: ' + (r ? r.msg : 'N/A'));
  return null;
}

async function getUserInfo(token) {
  const r = await api_get('/api/cloud2.member.api/member/userInfo/getCurLoginUser', { userToken: token, t: now() });
  if (r && r.code === 200) return r.data;
  return null;
}

async function getSignInRecord(token) {
  const r = await api_get('/api/cloud2.member.api/userSignInPointMall/getSignInRecord', { time: now(), userToken: token });
  if (r && r.code === 200) return r.data;
  return null;
}

async function getSignInConfig(token) {
  const r = await api_get('/api/cloud2.member.api/signInConfig/getSignInConfig', { userToken: token });
  if (r && r.code === 200) return r.data;
  return [];
}

async function checkSignInInterrupt(token) {
  const r = await api_get('/api/cloud2.member.api/userSignInPointMall/checkSignInInterrupt', { time: now(), userToken: token });
  return r && r.data;
}

async function doSignIn(token, code) {
  const r = await api_get('/api/cloud2.member.api/userSignInPointMall/signIn', { code, userToken: token });
  if (r && r.code === 200) return r.data;
  L.fail('signIn失败: ' + (r ? r.msg : 'N/A'));
  return null;
}

async function saveUserVisit(token) {
  const r = await api_get('/api/cloud2.member.api/userVisitSystem/saveUserVisit', { userToken: token, t: now() });
  return r && r.code === 200;
}

async function getPopup(token) {
  const r = await api_get('/api/cloud2.member.api/userGivePoint/popup', { userToken: token, t: now() });
  return (r && r.code === 200) ? r.data : [];
}

async function runAccount(a) {
  const { idx, token, code } = a;
  sectionLine('账号[' + idx + '] ' + token.slice(0,8) + '...', '甘肃烟草');

  const sm4 = await getSm4Key();
  if (sm4) L.info('SM4密钥: ' + sm4);

  const info = await getUserInfo(token);
  if (info) {
    L.info('用户: ' + info.phone + ' | uid=' + info.id + ' | 积分: ' + (info.pointValue||0) + ' | 等级: ' + (info.gradeName||'珍品会员'));
  }

  const record = await getSignInRecord(token);
  let signed = false, prizeNum = 0, keepDays = 0;
  if (record) {
    keepDays = record.keepSignInDays || 0;
    const today = new Date().toISOString().slice(0,10);
    if (record.signInRecords && record.signInRecords.includes(today)) {
      L.info('今日已签到，连签 ' + keepDays + ' 天');
    if (typeof logPoints === 'function') logPoints(null, info.pointValue, "sjy", 1, "签到成功");
      signed = true;
    } else {
      const last = record.lastSignInDate ? new Date(parseInt(record.lastSignInDate)).toISOString().slice(0,10) : '无';
      L.info('尚未签到，连签 ' + keepDays + ' 天，上次: ' + last);
    }
  }

  const config = await getSignInConfig(token);
  if (config.length) {
    L.info('配置: ' + config.map(c => c.configName + ':' + c.prizeNum).join(', '));
  }

  if (!signed && code) {
    const interrupt = await checkSignInInterrupt(token);
    if (interrupt) L.fail('签到被中断');
    L.act('执行签到...');
    const sr = await doSignIn(token, code);
    if (sr) {
      signed = true;
      prizeNum = sr.prizeNum || 0;
      keepDays = sr.keepSignInDays || 0;
      L.ok('签到成功! +' + prizeNum + ' 飞天币，连签 ' + keepDays + ' 天 (' + sr.configName + ')');
    }
  } else if (!signed && !code) {
    L.fail('缺少 SJY_CODE (WeChat code)，无法签到');
  }

  if (await saveUserVisit(token)) {
    L.ok('访问签到成功');
  }

  const popups = await getPopup(token);
  popups.forEach(p => L.info((p.read ? '已读' : '未读') + ': ' + p.msg));

  await humanDelay('account');

  return {
    idx: idx,
    token: token.slice(0,8) + '...',
    signed: signed,
    prizeNum: prizeNum,
    keepDays: keepDays,
    pointValue: info ? (info.pointValue||0) : 0,
    unreadPopups: popups.filter(p=>!p.read).length,
    sm4Key: sm4,
  };
}

function buildTable(summaries) {
  let lines = ['📱 甘肃烟草/白加黑 签到结果', '', '| # | 账号 | 签到 | 连签 | 奖励 | 积分 | 弹窗 |', '|---|------|------|------|------|------|------|'];
  summaries.forEach(s => {
    lines.push('| ' + s.idx + ' | ' + s.token + ' | ' + (s.signed ? ICON.ok + '已签' : ICON.fail + '未签') + ' | ' + s.keepDays + '天 | ' + (s.prizeNum>0 ? '+' + s.prizeNum + '飞天币' : '-') + ' | ' + s.pointValue + ' | ' + s.unreadPopups + '个 |');
  });
  const ok = summaries.filter(s=>s.signed).length;
  lines.push('');
  lines.push('共 ' + summaries.length + ' 个账号，签到成功 ' + ok + ' 个');
  if (summaries.some(s=>!s.signed)) lines.push('');
  if (summaries.some(s=>!s.signed)) lines.push(ICON.warn + ' 未签到账号需配置 SJY_CODE');
  return lines.join('\n');
}

async function push(title, content) {
  try {
    const { sendPush } = require("./std_report");
    return await sendPush(title, content);
  } catch (e) { console.warn("[push] 失败(忽略):", e.message); }
}


// ===== 统一积分日志/推送 (自动注入 v2: 仅打印, 脚本自带末次汇总推送) =====
let _lpApp = '';
function digPoints(obj) {
  if (obj == null) return null;
  const keys = ['point','points','score','scores','integral','growth','coin','beans','bean','balance','addScore','getScore','addPoint','todayScore','signScore','awardScore','awardAmount','awardVipcoinTotal','vipGrow','VipGrow','currentIntegral','changeIntegeral','totalPoint','totalPoints','credit','credits','exp','growthValue','keepScore','signScore'];
  let found = null;
  const walk = (o, depth) => {
    if (found != null || depth > 4 || !o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const lk = k.toLowerCase();
      if (keys.includes(lk) && (typeof o[k] === 'number' || (typeof o[k] === 'string' && o[k] !== '' && !isNaN(Number(o[k]))))) { found = Number(o[k]); return; }
      if (typeof o[k] === 'object') walk(o[k], depth + 1);
      if (found != null) return;
    }
  };
  walk(obj, 0);
  return found;
}
async function doPush(title, content) {
  try {
    await require('./std_report').sendPush(title, content);
  } catch (e) {}
}
function logPoints(todayPoints, totalPoints, app, idx) {
  const tp = Number(todayPoints) || 0;
  const tot = Number(totalPoints) || 0;
  const tpStr = tp > 0 ? '今日+' + tp + '积分' : '签到完成';
  const totStr = tot > 0 ? '累计' + tot + '积分' : '';
  const line = tpStr + (totStr ? ' | ' + totStr : '');
  console.log('📊 账号[' + idx + '] ' + app + ': ' + line);
}


async function main() {
  sectionLine('甘肃烟草/白加黑 签到脚本', '');

  const accounts = getAccounts();
  if (!accounts.length) process.exit(1);
  L.info('共 ' + accounts.length + ' 个账号');

  const summaries = [];
  for (const a of accounts) {
    try { summaries.push(await runAccount(a)); }
    catch(e) {
      L.fail('账号[' + a.idx + '] 异常: ' + e.message);
      summaries.push({ idx: a.idx, token: a.token.slice(0,8)+'...', signed: false, prizeNum: 0, keepDays: 0, pointValue: 0, unreadPopups: 0, sm4Key: null });
    }
  }

  sectionLine('执行完毕', ICON.done + ' 所有账号处理完成');
  L.info('成功: ' + summaries.filter(s=>s.signed).length + '/' + summaries.length);

  const table = buildTable(summaries);
  L.info(table);
  await push('甘肃烟草签到', table);
}

main().catch(e => { L.fail('致命错误: ' + e.message); process.exit(1); });
