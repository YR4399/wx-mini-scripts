/*
cron: 30 8 * * *
new Env('赵钱孙李-签到任务');
脚本位置: aaa微信code/zqsl_sign.js

赵钱孙李（国民养老小程序）自动化脚本
appid: wxfeb453e6377c3137

功能：
  1. 微信登录（通过 wechatserver 获取 code → 登录国民养老后端）
  2. 游戏后端登录（getToken 获取游戏 token）
  3. 每日签到（签到获得国小豆）
  4. 自动做任务（获取任务列表 → 完成 → 领取奖励）
  5. 连续签到 + 任务里程碑奖励

【环境变量】
  wx_server_url  = WCS 地址（默认 http://172.17.0.3:8787）
  wx_auth        = WCS 认证 Key
  wx_opinion     = 微信 openid，多账号用 & 分隔

【算法说明】
  游戏后端使用 AES-192-ECB + RSA 混合加密
  - preInit 响应用 AES 解密获取 RSA 密钥对
  - 签到/完成任务用 RSA 公钥加密参数
*/

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '赵钱孙李'; }
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
  WX_SERVER: process.env.wx_server_url || process.env.wxcodeurl || 'http://172.17.0.3:8787',
  WX_AUTH: process.env.wx_auth || process.env.WXAPIKEY || process.env.WX_SERVER_APIKEY || '',
  OPENIDS: parseOpenids(),
  APPID: 'wxfeb453e6377c3137',
  GAME_HOST: 'gm-pension-map.weijuju.com',
  MINI_HOST: 'lfsplanning.guominpension.com',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781',
};

function parseOpenids() {
  const raw = process.env.wx_opinion || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}

// ==================== Token 缓存 ====================
const CACHE_FILE = path.join(__dirname, '.zqsl_token_cache.json');
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
function wcsReq(method, path, headers, body) {
  return new Promise((resolve) => {
    const wcsUrl = CFG.WX_SERVER.replace(/\/$/, '');
    const u = new URL(wcsUrl + path);
    const isTls = u.protocol === 'https:';
    const lib = isTls ? https : http;
    const bodyStr = body || '';
    const opts = {
      hostname: u.hostname, port: u.port || (isTls ? 443 : 80),
      path: u.pathname, method, rejectUnauthorized: false,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'User-Agent': CFG.UA,
      }, headers || {}),
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, raw: d, headers: res.headers }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function httpReq(method, hostname, path, headers, body) {
  return new Promise((resolve) => {
    const u = new URL('https://' + hostname + path);
    const isTls = true;
    const lib = isTls ? https : http;
    const bodyStr = body ? (typeof body === 'string' ? body : qs.stringify(body)) : '';
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname, method, rejectUnauthorized: false,
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': CFG.UA,
      }, headers || {}),
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, raw: d, headers: res.headers }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function gamePost(path, body, extraHeaders, cookie) {
  const headers = Object.assign({
    'Origin': 'https://gm-pension-map.weijuju.com',
    'Referer': 'https://servicewechat.com/' + CFG.APPID + '/67/page-frame.html',
  }, extraHeaders || {});
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  return httpReq('POST', CFG.GAME_HOST, path, headers, body);
}

function miniPost(path, body, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});
  return httpReq('POST', CFG.MINI_HOST, path, headers, body);
}

// ==================== 加密/解密 ====================
const AES_KEY = 'h2sAxtVPjufWKF+vj8RvFQ==';

/** AES-192-ECB 解密（解密 preInit 响应） */
function aesDecrypt(ciphertext) {
  const keyBytes = Buffer.from(AES_KEY, 'utf8');
  const decipher = crypto.createDecipheriv('aes-192-ecb', keyBytes, Buffer.alloc(0));
  decipher.setAutoPadding(true);
  let dec = decipher.update(ciphertext, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return JSON.parse(dec);
}

/** AES-192-ECB 加密 */
function aesEncrypt(obj) {
  const plaintext = JSON.stringify(obj);
  const keyBytes = Buffer.from(AES_KEY, 'utf8');
  const cipher = crypto.createCipheriv('aes-192-ecb', keyBytes, Buffer.alloc(0));
  cipher.setAutoPadding(true);
  let enc = cipher.update(plaintext, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

/** RSA 公钥加密（匹配 JSEncrypt.encryptLong 行为：先 Base64 编码再加密） */
function rsaEncrypt(plaintext, publicKey) {
  const pemKey = '-----BEGIN PUBLIC KEY-----\n' + publicKey + '\n-----END PUBLIC KEY-----';
  const MAX_LEN = 117; // RSA 1024: 128 - 11 (PKCS1 padding) = 117
  // JSEncrypt 先 Base64 编码再加密
  const base64Input = Buffer.from(plaintext, 'utf8').toString('base64');
  const buffer = Buffer.from(base64Input, 'utf8');
  const chunks = [];
  for (let i = 0; i < buffer.length; i += MAX_LEN) {
    const chunk = buffer.slice(i, i + MAX_LEN);
    const encrypted = crypto.publicEncrypt({ key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING }, chunk);
    chunks.push(encrypted);
  }
  return Buffer.concat(chunks).toString('base64');
}

/** RSA 私钥解密（匹配 JSEncrypt.decryptLong 行为） */
function rsaDecrypt(ciphertext, privateKey) {
  const pemKey = '-----BEGIN RSA PRIVATE KEY-----\n' + privateKey + '\n-----END RSA PRIVATE KEY-----';
  const buffer = Buffer.from(ciphertext, 'base64');
  const KEY_SIZE = 128; // RSA 1024
  const chunks = [];
  for (let i = 0; i < buffer.length; i += KEY_SIZE) {
    const chunk = buffer.slice(i, i + KEY_SIZE);
    const decrypted = crypto.privateDecrypt({ key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING }, chunk);
    chunks.push(decrypted);
  }
  // 解密后是 Base64 字符串，需解码
  return Buffer.from(Buffer.concat(chunks).toString('utf8'), 'base64').toString('utf8');
}

// ==================== Mini-program 登录 ====================
async function miniLogin(openid, cache) {
  // 1. 通过 WCS 获取 wx.login code
  $.info(`[${openid}] 获取微信 code...`);
  const codeResp = await wcsReq('POST', '/wx/code',
    { 'auth': CFG.WX_AUTH },
    JSON.stringify({ openid, appid: CFG.APPID })
  );

  if (!codeResp.data || !codeResp.data.status || !codeResp.data.data || !codeResp.data.data.code) {
    $.err(`获取 code 失败: ${JSON.stringify(codeResp.data)}`);
    return null;
  }
  const code = codeResp.data.data.code;
  $.ok('Code 获取成功');

  // 2. get_wx_userinfo
  $.info('获取用户信息...');
  let r = await miniPost('/user/api/user_login/mobile/v1/get_wx_userinfo',
    JSON.stringify({ code }),
    { 'Content-Type': 'application/json;charset=UTF-8', 'Referer': `https://servicewechat.com/${CFG.APPID}/67/page-frame.html` }
  );
  if (!r.data || r.data.code !== '00000000') {
    $.err(`get_wx_userinfo 失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  const loginCode = r.data.data.loginCode;
  const hashedOpenId = r.data.data.openId;

  // 3. login (需要 openId, loginCode, channelCode, inviteCode, activityId)
  $.info('登录国民养老...');
  r = await miniPost('/user/api/user_login/mobile/v1/login',
    JSON.stringify({
      openId: hashedOpenId,
      loginCode,
      channelCode: '',
      inviteCode: '',
      activityId: '',
    }),
    { 'Content-Type': 'application/json;charset=UTF-8', 'Referer': `https://servicewechat.com/${CFG.APPID}/67/page-frame.html` }
  );
  if (!r.data || r.data.code !== '00000000') {
    $.err(`登录失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  const authCode = r.data.data.token;
  const userId = JSON.parse(Buffer.from(authCode.split('.')[1], 'base64').toString()).sub.userId;
  $.ok(`登录成功! userId=${userId}`);

  // Save to cache
  cache[openid] = { authCode, userId, hashedOpenId, cachedAt: Date.now() };
  saveCache(cache);

  return { authCode, userId, hashedOpenId };
}

// ==================== Game Backend ====================
async function gameLogin(authCode) {
  $.info('获取游戏 Token...');
  const r = await gamePost('/app/getToken', { authCode });
  if (!r.data || r.data.code !== 200) {
    $.err(`getToken 失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  $.ok('游戏 Token 获取成功');
  return r.data.data.token;
}

async function getRsaKeys(gameToken) {
  const r = await gamePost('/app/preInit', '', { token: gameToken });
  if (!r.data || r.data.code !== 200) {
    $.err(`preInit 失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  // AES 解密响应
  const decrypted = aesDecrypt(r.data.data);
  return {
    publicKey: decrypted.frontPublicKey,
    privateKey: decrypted.afterPrivateKey,
  };
}

async function gameInit(gameToken) {
  const r = await gamePost('/app/init', '', { token: gameToken });
  if (!r.data || r.data.code !== 200) {
    $.err(`init 失败: ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data.data;
}

async function gameTaskList(gameToken) {
  const r = await gamePost('/app/taskList', '', { token: gameToken });
  if (!r.data || r.data.code !== 200) {
    $.err(`taskList 失败: ${JSON.stringify(r.data)}`);
    return [];
  }
  return r.data.data || [];
}

async function gameSign(gameToken, rsaKeys) {
  $.info('执行签到...');
  const signPayload = JSON.stringify({ timestamp: Date.now(), loginToken: gameToken });
  const dataSign = rsaEncrypt(signPayload, rsaKeys.publicKey);
  const r = await gamePost('/app/sign', { dataSign }, { token: gameToken });
  if (!r.data) { $.err('签到请求失败'); return null; }
  if (r.data.code === 200) {
    // 响应 data 可能被 RSA 加密
    let resData = r.data.data;
    if (resData && typeof resData === 'string') {
      try { resData = JSON.parse(rsaDecrypt(resData, rsaKeys.privateKey)); }
      catch { /* keep as is */ }
    }
    $.ok(`签到成功! ${JSON.stringify(resData)}`);
    return resData;
  }
  $.err(`签到失败: ${r.data.msg} (${r.data.code})`);
  return null;
}

async function gameCompleteTask(gameToken, taskId, rsaKeys) {
  const encryptedTaskId = rsaEncrypt(taskId, rsaKeys.publicKey);
  const signPayload = JSON.stringify({ timestamp: Date.now(), loginToken: gameToken });
  const dataSign = rsaEncrypt(signPayload, rsaKeys.publicKey);
  const body = 'taskId=' + encodeURIComponent(encryptedTaskId) + '&dataSign=' + encodeURIComponent(dataSign);
  const r = await httpReq('POST', CFG.GAME_HOST, '/app/completeTask', 
    { token: gameToken, 'X-Request-By': '/app/completeTask' }, body);
  if (!r.data) return null;
  if (r.data.code !== 200) $.err(`completeTask响应: ${r.data.code} ${r.data.msg}`);
  return r.data;
}

async function gameReceiveTaskAward(gameToken, taskId, rsaKeys) {
  const encryptedTaskId = rsaEncrypt(taskId, rsaKeys.publicKey);
  const signPayload = JSON.stringify({ timestamp: Date.now(), loginToken: gameToken });
  const dataSign = rsaEncrypt(signPayload, rsaKeys.publicKey);
  const r = await gamePost('/app/receiveTaskAward',
    { taskId: encryptedTaskId, dataSign }, { token: gameToken });
  if (!r.data) return null;
  return r.data;
}

// ==================== 任务类型 ====================
const TASK_TYPE_MAP = { 0: '分享', 1: '浏览', 2: '跳转', 3: '邀请' };
const TASK_TYPES_SKIP = [0, 3]; // 分享类(需微信分享回调)和邀请类任务跳过

// ==================== 单账号处理 ====================
async function processAccount(openid, cache) {
  $.info(`\n======== 账号: ${openid} ========`);
  const summary = { sign: false, tasks: 0, taskAwards: 0, points: 0, dice: 0, diceRolled: 0 };

  // Step 1: Mini-program login (with cache)
  let authData = cache[openid];
  if (authData && authData.authCode) {
    $.info('使用缓存的登录凭证...');
  } else {
    authData = await miniLogin(openid, cache);
    if (!authData) { $.err('登录失败，跳过此账号'); return summary; }
  }

  // Step 2: Game backend login
  const gameToken = await gameLogin(authData.authCode);
  if (!gameToken) { $.err('游戏登录失败，跳过此账号'); return summary; }

  // Step 3: Get RSA keys
  const rsaKeys = await getRsaKeys(gameToken);
  if (!rsaKeys) { $.err('获取 RSA 密钥失败，跳过此账号'); return summary; }
  $.info('RSA 密钥对已就绪');

  // Step 4: Init (check status)
  const initData = await gameInit(gameToken);
  if (!initData) { $.err('初始化失败，跳过此账号'); return summary; }

  $.info(`当前状态: todaySigned=${initData.todaySigned}, points=${initData.userPointCount}, dice=${initData.diceCount}, tasks=${initData.userTaskTotalCount}`);

  // Step 5: 签到
  if (!initData.todaySigned) {
    await gameSign(gameToken, rsaKeys);
    summary.sign = true;
  } else {
    $.log('今日已签到，跳过');
    summary.sign = true;
  }

  // Step 6: 摇骰子（有骰子就摇）
  let currentDice = initData.diceCount;
  if (currentDice > 0) {
    $.info(`🎲 当前有 ${currentDice} 个骰子，开始摇...`);
    let rolled = 0;
    while (currentDice > 0) {
      const signPayload = JSON.stringify({ timestamp: Date.now(), loginToken: gameToken });
      const dataSign = rsaEncrypt(signPayload, rsaKeys.publicKey);
      const rr = await gamePost('/app/board/roll', { dataSign }, { token: gameToken });
      if (rr.data && rr.data.code === 200) {
        rolled++;
        // 响应 data 可能是 RSA 加密的
        let resData = rr.data.data;
        if (resData && typeof resData === 'string') {
          try { resData = JSON.parse(rsaDecrypt(resData, rsaKeys.privateKey)); }
          catch { /* keep as is */ }
        }
        $.ok(`🎲 第 ${rolled} 次: ${JSON.stringify(resData).substring(0, 80)}`);
      } else if (rr.data && rr.data.code === -5000) {
        $.log('骰子用完了');
        break;
      } else {
        $.err(`摇骰子失败: ${rr.data?.msg} (${rr.data?.code})`);
        break;
      }
      currentDice--;
      await $.wait(800);
    }
    if (rolled > 0) $.ok(`摇骰子完成，共 ${rolled} 次`);
    summary.diceRolled = rolled;

    // 刷新状态
    const updatedInit = await gameInit(gameToken);
    if (updatedInit) currentDice = updatedInit.diceCount;
  } else {
    $.log('无可用骰子，跳过摇骰子');
  }

  // Step 7: 获取任务列表并完成
  const tasks = await gameTaskList(gameToken);
  if (tasks.length === 0) { $.log('无可用任务'); return summary; }
  $.info(`获取到 ${tasks.length} 个任务`);

  for (const task of tasks) {
    // 跳过不可脚本化的任务类型（分享需微信回调，邀请需好友操作）
    if (TASK_TYPES_SKIP.includes(task.taskType)) {
      $.log(`跳过: ${task.taskName} (${TASK_TYPE_MAP[task.taskType] || task.taskType}类 不可脚本化)`);
      continue;
    }
    if (task.taskCompleteCount >= task.taskCompleteLimit) {
      $.log(`跳过: ${task.taskName} (已完成 ${task.taskCompleteCount}/${task.taskCompleteLimit})`);
      continue;
    }

    $.info(`--- ${task.taskName} (${TASK_TYPE_MAP[task.taskType] || task.taskType}) ---`);

    // 完成/进入任务
    const completeR = await gameCompleteTask(gameToken, task.taskId, rsaKeys);
    if (completeR && completeR.code === 200) {
      $.ok(`任务完成: ${task.taskName}`);
      await $.wait(1000);

      // 领取奖励
      const awardR = await gameReceiveTaskAward(gameToken, task.taskId, rsaKeys);
      if (awardR && awardR.code === 200) {
        $.ok(`奖励领取成功! 国小豆+${task.rewardPointCount || 0}`);
        summary.tasks++;
        summary.taskAwards += (task.rewardPointCount || 0);
      } else {
        $.err(`奖励领取失败: ${awardR?.msg || 'unknown'}`);
      }
    } else {
      $.err(`任务失败: ${completeR?.msg || 'unknown'}`);
    }
    await $.wait(1500);
  }

  // Step 8: 任务里程碑奖励 (RSA 加密 milestoneIndex 暂不可用，仅尝试)
  const finalInit = await gameInit(gameToken);
  if (finalInit && finalInit.taskMilestoneList) {
    for (const ms of finalInit.taskMilestoneList) {
      if (ms.receiveStatus === 0 && finalInit.userTaskTotalCount >= ms.milestoneCount) {
        $.info(`尝试领取里程碑奖励 (${ms.milestoneCount}任务→${ms.milestoneDice}骰子)...`);
        const signPayload = JSON.stringify({ timestamp: Date.now(), loginToken: gameToken });
        const dataSign = rsaEncrypt(signPayload, rsaKeys.publicKey);
        // milestoneIndex 需要 RSA 加密，目前 Node crypto 与后端不兼容
        const encIdx = rsaEncrypt(String(ms.milestoneCount), rsaKeys.publicKey);
        const r = await gamePost('/app/receiveTaskMilestoneAward',
          { dataSign, milestoneIndex: encIdx }, { token: gameToken });
        if (r.data && r.data.code === 200) {
          $.ok(`里程碑奖励领取成功! +${ms.milestoneDice}骰子`);
          summary.diceRolled = (summary.diceRolled || 0) + ms.milestoneDice;
        } else {
          $.log(`里程碑 ${ms.milestoneCount}: ${r.data?.msg} (${r.data?.code})`);
        }
        await $.wait(500);
      }
    }
  }

  summary.points = finalInit ? finalInit.userPointCount : 0;
  summary.dice = finalInit ? finalInit.diceCount : 0;
  $.ok(`👤 ${openid} 完成! 签到:${summary.sign} 骰子:${summary.dice} 国小豆:${summary.points}`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【赵钱孙李·签到任务】 ${t}`);

  if (!CFG.WX_AUTH) { $.err('未配置 wx_auth'); return; }
  if (CFG.OPENIDS.length === 0) { $.err('未配置 wx_opinion'); return; }

  const cache = loadCache();
  $.info(`共 ${CFG.OPENIDS.length} 个账号`);

  let totalSign = 0, totalTasks = 0, totalPoints = 0;
  for (let i = 0; i < CFG.OPENIDS.length; i++) {
    const r = await processAccount(CFG.OPENIDS[i], cache);
    if (r.sign) totalSign++;
    totalTasks += r.tasks;
    totalPoints = Math.max(totalPoints, r.points);
    if (i < CFG.OPENIDS.length - 1) await $.wait(2000);
  }

  console.log(`\n========================================`);
  console.log(`📊 汇总: 签到 ${totalSign}/${CFG.OPENIDS.length} | 任务 ${totalTasks} 个 | 最高国小豆 ${totalPoints}`);
  $.ok('所有任务执行完毕！🎉');
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
