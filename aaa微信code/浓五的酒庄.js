/*
cron: 30 8,12,18 * * *
new Env('浓五的酒庄-农场助手');
脚本位置: 青龙/wx/nxjz_auto.js

浓五的酒庄（农小姐小程序）自动化脚本
appid: wx7ce1afa12935c862 | API: https://nxjz-api.plsbd.com/v8
签名算法已从小程序 JS 中逆向提取，来源: nxjz.wxapkg (Cocos Creator)

功能：
  1. 每日签到
  2. 每日答题（自动从 voteTopicList 获取正确答案后提交）
  3. 灭虫/抗旱（检测 farm/index 天气灾害，虫害→买杀虫药喷洒，旱灾→用水车）
  4. 一键收获
  5. 自动种植（从可选作物池随机选一种）
  6. 一键浇水
  7. 一键施肥
  8. 幸运转盘（每日免费1次）
  9. 砸金蛋（每日/每周免费）
  10. 酿酒坊（检查原浆酒/碎片状态，收获→继续酿酒→产碎片）
  11. 种植基地（basememberlist 检查各基地产出状态，收获已到期的）
  12. Token 缓存：自动检测过期并续期

【统一环境变量（呆呆面板）】
  wx_server_url = WCS 地址
  wx_auth       = WCS 认证 Key
  wx_opinion    = 微信 openid，多账号用 & 分隔

【手动 Token 模式】
  nxjzCode  = 手动填入微信 code
  nxjzToken = 手动填入 JWT token

【可选环境变量】
  nxjzSeedIds   : 作物池 crop_id 列表，逗号分隔
                  默认 "1,2,3,4,5"（全部五种）
                  ID: 1=高粱 2=小麦 3=大米 4=玉米 5=糯米
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
const fs = require('fs');
const path = require('path');

class Env {
  constructor(name) { this.name = name; }
  log(msg) { console.log(`📌 [${this.ts()}] ${msg}`); }
  ok(msg) { console.log(`✅ [${this.ts()}] ${msg}`); }
  err(msg) { console.log(`❌ [${this.ts()}] ${msg}`); }
  info(msg) { console.log(`🔧 [${this.ts()}] ${msg}`); }
  ts() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env();

// ==================== Token 缓存 ====================
const CACHE_FILE = path.join(__dirname, '.nxjz_token_cache.json');
function loadTokenCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) { $.err(`读取 token 缓存失败: ${e.message}`); }
  return {};
}
function saveTokenCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch (e) { $.err(`保存 token 缓存失败: ${e.message}`); }
}
function isTokenValid(entry) {
  if (!entry || !entry.token) return false;
  return (Date.now() - entry.cachedAt) < 36 * 60 * 60 * 1000;
}

// ==================== 配置 ====================
function parseOpenids() {
  const raw = process.env.wx_opinion
    || process.env.nxjzWxOpenids || process.env.nxjzWxOpenid || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}
function parseSeedIds() {
  const raw = process.env.nxjzSeedIds || '1,2,3,4,5';
  return raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
}
const SEED_IDS = parseSeedIds();

const CFG = {
  WX_SERVER: process.env.wx_server_url || process.env.wxcodeurl
    || process.env.WECHAT_WX_SERVER_URL || process.env.nxjzWxServer || '',
  WX_AUTH: process.env.wx_auth || process.env.WXAPIKEY
    || process.env.WX_SERVER_APIKEY || process.env.nxjzWxAuth || '',
  WX_OPENIDS: parseOpenids(),
  MANUAL_CODE: process.env.nxjzCode || '',
  MANUAL_TOKEN: process.env.nxjzToken || '',
  APPID: process.env.nxjzAppid || 'wx7ce1afa12935c862',
  NOTIFY: (process.env.NJZ_NOTIFY || 'false') === 'true',
  API_HOST: 'nxjz-api.plsbd.com',
  API_VERSION: 'v8',
  API_KEY: '60f18189-e974-4f92-9bff-5a392ff8be13',
  GAME_ID: '1',
  NPC_STORE_PESTICIDE_PID: 9,       // 杀虫药 PID
  NPC_STORE_WATERWHEEL_PID: 10,     // 水车道具 PID
  NPC_PESTICIDE_LABEL: 'weather_3', // 杀虫药 label
  NPC_WATERWHEEL_LABEL: 'weather_4',// 水车 label
  NPC_QTY: 1,                        // 每次买 1 个
};

// ==================== 签名算法 ====================
// sign = MD5(bbcKey + timestamp + MD5(JSON.stringify(body)))
function computeSign(postBody) {
  const time = Math.floor(Date.now() / 1000);
  const bodyStr = JSON.stringify(postBody || {});
  const bodyHash = crypto.createHash('md5').update(bodyStr).digest('hex');
  const raw = CFG.API_KEY + time + bodyHash;
  const sign = crypto.createHash('md5').update(raw).digest('hex');
  return { sign, time: String(time) };
}

// ==================== HTTP 工具 ====================
const http_lib = require('http');
const https_lib = require('https');

function http(method, fullUrl, extraHeaders, body) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const u = new URL(fullUrl);
    const isTls = u.protocol === 'https:';
    const lib = isTls ? https_lib : http_lib;
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, port: u.port || (isTls ? 443 : 80),
      method, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', ...extraHeaders, 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: null, raw: d }); } });
    });
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function apiUrl(path) {
  return `https://${CFG.API_HOST}/${CFG.API_VERSION}${path}`;
}

/** 向 nxjz-api 发送带签名的 POST 请求 */
async function signedPost(path, postBody = {}, token) {
  const url = apiUrl(path);
  const { sign, time } = computeSign(postBody || {});
  const headers = {
    'x-auth-id': CFG.GAME_ID, 'x-auth-time': time, 'x-auth-sign': sign, 'token': token,
    'Referer': `https://servicewechat.com/${CFG.APPID}/79/page-frame.html`,
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 23078RKD5C) AppleWebKit/537.36 MicroMessenger/8.0.74 Mobile',
  };
  const r = await http('POST', url, headers, postBody);
  if (!r.body) { $.err(`${path}: ${r.error || r.raw}`); return null; }
  if (r.body.resultCode !== 200) {
    if (r.body.resultCode === 1000) return r.body; // 过期标记
    $.err(`${path}: ${r.body.resultMessage} (${r.body.resultCode})`);
    return r.body;
  }
  return r.body;
}

function isTokenExpired(resp) {
  return resp && resp.resultCode === 1000;
}

// ==================== 登录 ====================
async function loginWithCode(code) {
  $.info('正在登录...');
  const initToken = crypto.createHash('md5').update(code).digest('hex');
  const body = { code, nickname: 'y', avatar: '', longitude: '', latitude: '', invitation: 0, invite_type: 0 };
  const { sign, time } = computeSign(body);
  const headers = {
    'x-auth-id': CFG.GAME_ID, 'x-auth-time': time, 'x-auth-sign': sign, 'token': initToken,
  };
  const r = await http('POST', apiUrl('/member/login'), headers, body);
  if (r.body?.resultCode === 200 && r.body.data?.token) {
    const info = r.body.data.info || {};
    $.ok(`登录成功! ${info.member_name} 金币:${info.coin}`);
    return { token: r.body.data.token, info };
  }
  $.err(`登录失败: ${JSON.stringify(r.body)}`);
  return null;
}

async function getAuthForOpenid(openid) {
  const cache = loadTokenCache();
  const cached = cache[openid];
  if (isTokenValid(cached)) {
    $.log(`使用缓存 token (${new Date(cached.cachedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    return { token: cached.token, info: cached.info || {} };
  }
  $.info(`获取账号 ${openid} 的 Code...`);
  const r = await http('POST', `${CFG.WX_SERVER}/wx/code`,
    { 'auth': CFG.WX_AUTH }, { openid, appid: CFG.APPID });
  if (r.body?.status === true && r.body.data?.code) {
    $.ok('Code 获取成功');
    const result = await loginWithCode(r.body.data.code);
    if (result) {
      cache[openid] = { token: result.token, info: result.info, cachedAt: Date.now() };
      saveTokenCache(cache);
      return result;
    }
  } else {
    $.err(`WechatServer ${openid}: ${JSON.stringify(r.body)}`);
  }
  return null;
}

// ==================== 农场操作 ====================

/** 每日签到 */
async function dailySignIn(token) {
  $.info('\n====== 每日签到 ======');
  const r = await signedPost('/task/signIn', {}, token);
  if (!r) return null;
  if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
  if (r.data?.num >= 0) { $.ok(`签到成功! 第 ${r.data.num} 天`); }
  return r;
}

/** 每日答题 */
async function dailyQuiz(token) {
  $.info('\n====== 每日答题 ======');
  const topics = await signedPost('/task/voteTopicList', {}, token);
  if (!topics) return null;
  if (isTokenExpired(topics)) return 'TOKEN_EXPIRED';
  if (!topics.data || topics.data.length === 0) { $.log('暂无题目'); return null; }
  
  for (const topic of topics.data) {
    const opts = JSON.parse(topic.vote_option || '[]');
    const correct = opts.find(o => o.iscorrent === 1);
    const answer = correct ? correct.op : 'A';
    $.log(`🔍 题目: ${topic.name} → 正确答案: ${answer}`);
    
    const r2 = await signedPost('/task/push', { task_id: 1 }, token);
    if (!r2) continue;
    if (isTokenExpired(r2)) return 'TOKEN_EXPIRED';
    if (r2.resultCode === 200) {
      $.ok(`🎉 答题完成! 金币+${r2.data?.coin_num || 0}, 种子+${r2.data?.seed_num || 0}`);
    } else if (r2.resultMessage) {
      $.log(r2.resultMessage);
    }
  }
}

/** 检测灾害（虫害/干旱）并处理 */
async function disasterControl(token) {
  $.info('\n====== 灾害检测 ======');
  const index = await signedPost('/farm/index', {}, token);
  if (!index) return null;
  if (isTokenExpired(index)) return 'TOKEN_EXPIRED';
  if (!index.data) return null;
  
  const weather = index.data.weather || {};
  const disaster = weather.disaster || '';
  const rate = parseInt(weather.rate || 0);
  
  if (!disaster || rate <= 0) { $.ok('✅ 无灾害'); return; }
  
  $.info(`⚠️ 检测到 ${disaster}! 概率:${rate}%`);
  
  // 仓库中已有灾害对应道具则直接使用
  let propLabel = '';
  let buyPid = 0;
  if (disaster === '虫害') { propLabel = CFG.NPC_PESTICIDE_LABEL; buyPid = CFG.NPC_STORE_PESTICIDE_PID; }
  else if (disaster === '干旱') { propLabel = CFG.NPC_WATERWHEEL_LABEL; buyPid = CFG.NPC_STORE_WATERWHEEL_PID; }
  else { $.log(`跳过未知灾害: ${disaster}`); return; }
  
  // 检查仓库是否已有对应道具
  const wh = index.data.warehouse || [];
  const existing = wh.find(w => w.name_label === propLabel);
  if (existing && existing.yield > 0) {
    $.ok(`仓库已有 ${existing.name || propLabel} x${existing.yield}，直接使用`);
  } else {
    // 购买道具
    $.info(`购买 ${disaster === '虫害' ? '杀虫药' : '水车'}...`);
    const buy = await signedPost('/farm/npcstore/buy',
      { pid: buyPid, num: CFG.NPC_QTY }, token);
    if (!buy) return null;
    if (isTokenExpired(buy)) return 'TOKEN_EXPIRED';
    if (buy.resultCode === 200) {
      $.ok(`购买成功! ${buy.data?.name || disaster === '虫害' ? '杀虫药' : '水车'}`);
    } else {
      $.err(`购买失败: ${buy.resultMessage}`);
      return null;
    }
    await $.wait(1000);
  }
  
  // 使用道具
  $.info(`使用 ${disaster === '虫害' ? '杀虫药' : '水车'}...`);
  const set = await signedPost('/farm/weather/set',
    { name_label: propLabel, other_member_id: '' }, token);
  if (!set) return null;
  if (isTokenExpired(set)) return 'TOKEN_EXPIRED';
  if (set.resultCode === 200) {
    $.ok(`✅ ${disaster === '虫害' ? '灭虫' : '抗旱'}成功!`);
  } else {
    $.err(`处理失败: ${set.resultMessage}`);
  }
}

/** 一键收获 */
async function harvest(token) {
  $.info('\n====== 一键收获 ======');
  const r = await signedPost('/farm/autoHarvest', {}, token);
  if (!r) return null;
  if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
  const items = r.data?.item || [];
  if (items.length === 0) { $.log('无作物可收获'); return items; }
  const total = items.reduce((s, i) => s + (i.yield || 0), 0);
  $.ok(`收获 ${items.length} 块地, 共 ${total.toFixed(1)} 单位`);
  return items;
}

/** 自动种植 */
async function plant(token) {
  $.info(`\n====== 自动种植（种子池: [${SEED_IDS}]） ======`);
  const r = await signedPost('/farm/acreCycle', { other_member_id: '' }, token);
  if (!r) return null;
  if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
  if (!r.data) return;

  let cnt = 0;
  for (const plot of r.data) {
    const c = plot.AcreCycle || {};
    if (c.IsHarvest || !c.crop_id) {
      const randomCropId = SEED_IDS[Math.floor(Math.random() * SEED_IDS.length)];
      await signedPost('/farm/acrecrop', { acre_id: plot.id, crop_id: randomCropId }, token);
      cnt++;
      await $.wait(500);
    }
  }
  $.ok(cnt > 0 ? `种植 ${cnt} 块地` : '无需种植');
}

/** 一键浇水（通过 IsWatering 判断是否需要继续） */
async function water(token) {
  $.info('\n====== 一键浇水 ======');
  let round = 0;
  while (round < 20) {
    // 查地块状态，看 IsWatering 是否需要继续浇水
    const cyc = await signedPost('/farm/acreCycle', { other_member_id: '' }, token);
    if (!cyc) break;
    if (isTokenExpired(cyc)) return 'TOKEN_EXPIRED';
    
    // 所有地块 IsWatering 均为 true 表示需要浇水
    const plots = cyc.data || [];
    const needWater = plots.some(p => p.AcreCycle?.IsWatering === true);
    if (!needWater) {
      $.log('所有地块浇灌已满，无需继续');
      break;
    }
    
    const r = await signedPost('/farm/autoWatering', {}, token);
    if (!r) break;
    if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
    round++;
    $.log(`第 ${round} 次浇水完成`);
    await $.wait(600);
  }
  if (round > 0) $.ok(`✅ 浇水完成，共 ${round} 次`);
  else $.log('无需浇水');
}

/** 一键施肥（通过 IsManure 判断是否需要继续） */
async function fertilize(token) {
  $.info('\n====== 一键施肥 ======');
  let round = 0;
  while (round < 20) {
    // 查地块状态，看 IsManure 是否需要继续施肥
    const cyc = await signedPost('/farm/acreCycle', { other_member_id: '' }, token);
    if (!cyc) break;
    if (isTokenExpired(cyc)) return 'TOKEN_EXPIRED';
    
    // 所有地块 IsManure 均为 true 表示需要施肥
    const plots = cyc.data || [];
    const needManure = plots.some(p => p.AcreCycle?.IsManure === true);
    if (!needManure) {
      $.log('所有地块施肥已满，无需继续');
      break;
    }
    
    const r = await signedPost('/farm/autoManure', {}, token);
    if (!r) break;
    if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
    round++;
    $.log(`第 ${round} 次施肥完成`);
    await $.wait(600);
  }
  if (round > 0) $.ok(`✅ 施肥完成，共 ${round} 次`);
  else $.log('无需施肥');
}

/** 幸运转盘（GET /rotor/general 查配置，POST /rotor/lottery 抽奖） */
async function rotorLottery(token) {
  $.info('\n====== 幸运转盘 ======');
  
  // rotor/general 需用 GET，无 body 但需签名 header
  const cfgUrl = apiUrl('/rotor/general');
  const { sign, time } = computeSign({});
  const headers = {
    'x-auth-id': CFG.GAME_ID, 'x-auth-time': time, 'x-auth-sign': sign, 'token': token,
    'Referer': `https://servicewechat.com/${CFG.APPID}/79/page-frame.html`,
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 23078RKD5C) AppleWebKit/537.36 MicroMessenger/8.0.74 Mobile',
  };
  const cfgResp = await http('GET', cfgUrl, headers, null);
  if (!cfgResp.body) { $.err(`/rotor/general: ${cfgResp.error || cfgResp.raw}`); return null; }
  if (isTokenExpired(cfgResp.body)) return 'TOKEN_EXPIRED';
  
  const d = cfgResp.body.data;
  if (!d) return;
  
  // 从 game_config 获取免费次数，free 字段判断今日是否可免费抽
  const gcfg = d.game_config || {};
  const freeToday = d.free === true;
  const totalDaily = parseInt(gcfg.lottery_number || '1');
  // 查看 records（今日已抽次数）
  const records = d.records || [];
  const todayRecords = records.filter(r => {
    const t = r.created_at || '';
    return t.startsWith(new Date().toISOString().substring(0, 10));
  });
  const usedCount = todayRecords.length;
  const canFree = freeToday && usedCount < totalDaily;
  
  $.log(`免费 ${freeToday ? '✅' : '❌'} (${usedCount}/${totalDaily} 次/日)`);
  if (!canFree) { $.log('今日免费次数已用完'); return; }
  
  const r = await signedPost('/rotor/lottery', {}, token);
  if (r && !isTokenExpired(r)) {
    const prizeId = r.data;
    const prizes = d.prizes || [];
    const prize = prizes.find(p => p.id === prizeId);
    $.ok(`🎉 中奖: ${prize?.name || 'ID:'+prizeId} x${prize?.number || ''}`);
  } else if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
}

/** 砸金蛋 */
async function goldenEgg(token) {
  $.info('\n====== 砸金蛋 ======');
  const c = await signedPost('/activity/goldeggs/config', {}, token);
  if (!c) return null;
  if (isTokenExpired(c)) return 'TOKEN_EXPIRED';
  if (!c.data) return;
  const used = (c.data.asset || {}).yield || 0;
  const cfg = c.data.config || [];
  const free = parseInt(cfg.find(x => x.k === 'global_activity_a_weekly_giving')?.v || '1');
  $.log(`免费 ${free} 次/周, 已用 ${used} 次`);
  if (used >= free) { $.log('本周已用完'); return; }
  const r = await signedPost('/activity/goldeggs/push', {}, token);
  if (r && !isTokenExpired(r)) $.ok(`🎉 ${r.data?.prop_name || '奖品'} x${r.data?.yield || 1}`);
  else if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
}

// ==================== 酿酒坊 ====================

/** 酿酒坊 - 收货 & 继续酿造 */
async function wineWorkshop(token) {
  $.info('\n====== 酿酒坊 ======');
  
  // 1. 查状态
  const state = await signedPost('/wine/debris/state', { other_member_id: '' }, token);
  if (!state) return null;
  if (isTokenExpired(state)) return 'TOKEN_EXPIRED';
  if (!state.data) { $.log('无酿酒坊数据'); return; }
  
  const d = state.data;
  const wine = d.wine || null;
  const debris = d.debris || null;
  
  // 2. 收原浆酒（若成熟）
  if (wine && wine.state === 2) {
    $.info(`原浆酒已熟成! 预计产量:${wine.expect_yield || '?'}, 收获中...`);
    const hw = await signedPost('/wine/harvest', { uuid: wine.uuid }, token);
    if (hw && hw.resultCode === 200) {
      $.ok(`✅ 原浆酒收获! +${hw.data?.yield || wine.expect_yield} 单位`);
    } else if (hw) {
      $.err(`原浆酒收获失败: ${hw.resultMessage}`);
    }
    await $.wait(1000);
  } else if (wine && wine.state === 1) {
    $.log(`原浆酒酿造中... 预计完成: ${wine.end_time}`);
  } else {
    $.log('无原浆酒在酿');
  }
  
  // 3. 收碎片（若成熟）
  if (debris && debris.state === 2) {
    $.info('碎片已产成, 收获中...');
    const hd = await signedPost('/debris/harvest', { uuid: debris.uuid }, token);
    if (hd && hd.resultCode === 200) {
      $.ok(`✅ ${debris.name || '碎片'} 收获!`);
    } else if (hd) {
      $.err(`碎片收获失败: ${hd.resultMessage}`);
    }
    await $.wait(1000);
  } else if (debris && debris.state === 1) {
    $.log(`碎片生产中... 预计完成: ${debris.end_time}`);
  } else {
    $.log('无碎片在生产');
  }
  
  // 4. 查当前酿酒状态，判断能否启动新一轮
  const state2 = await signedPost('/wine/debris/state', { other_member_id: '' }, token);
  if (!state2) return null;
  if (isTokenExpired(state2)) return 'TOKEN_EXPIRED';
  
  const d2 = state2.data;
  const canBrew = (!d2.wine || d2.wine.state === 3); // state=3 已完成或空闲
  const canDebris = (!d2.debris || d2.debris.state === 3);
  
  if (canBrew) {
    // 查配方和库存，看能酿什么
    const cfg = await signedPost('/wine/config', {}, token);
    if (!cfg) return null;
    if (isTokenExpired(cfg)) return 'TOKEN_EXPIRED';
    if (cfg.data) {
      // 解析可用配方
      let wConfig;
      try { wConfig = JSON.parse(cfg.data.config || '{}'); } catch { wConfig = { data: [] }; }
      const recipes = (wConfig.data || []).filter(r => r.num > 0); // num是所需数量
      // 配方示例: {name:"高粱", name_label:"sorghum", num:72, pid:11}
      // 查看仓库(warehouse)中有多少粮食
      const index = await signedPost('/farm/index', {}, token);
      if (!index) { $.log('查库存失败，跳过酿酒'); return null; }
      if (isTokenExpired(index)) return 'TOKEN_EXPIRED';
      const wh = index.data?.warehouse || [];
      
      // 检查是否有足够粮食 (解锁的)
      const whUnlock = wh.filter(w => w.type === 1 && w.is_lock === 0);
      
      // 使用仓库中总粮食或按配方最低要求
      const totalGrain = whUnlock.reduce((s, w) => s + (w.yield || 0), 0);
      
      if (totalGrain > 0) {
        $.info(`仓库解锁粮食总计约 ${totalGrain.toFixed(1)} 单位，开始酿酒`);
        
        // 调用 wine/protoplasmic 酿原浆酒
        const proto = await signedPost('/wine/protoplasmic', {}, token);
        if (proto && proto.resultCode === 200) {
          const yieldVal = (proto.data?.item || [{}])[0]?.yield || 0;
          $.ok(`✅ 原浆酒酿造中! 预计产量:${yieldVal} 单位`);
        } else if (proto) {
          $.err(`酿酒失败: ${proto.resultMessage}`);
        }
        await $.wait(1000);
      } else {
        $.log('仓库解锁粮食不足，无法酿酒');
      }
    }
  } else {
    $.log('有原浆酒/碎片正在生产中，跳过继续酿酒');
  }
  
  // 5. 启动碎片生产 (若有原浆酒在酿，调用 debris/add 产碎片)
  const state3 = await signedPost('/wine/debris/state', { other_member_id: '' }, token);
  if (!state3) return null;
  if (isTokenExpired(state3)) return 'TOKEN_EXPIRED';
  
  const d3 = state3.data;
  if (d3.wine && d3.wine.state === 1 && (!d3.debris || d3.debris.state === 3)) {
    $.info('有原浆酒在酿且碎片位空闲，启动碎片生产...');
    const da = await signedPost('/debris/add', {}, token);
    if (da && da.resultCode === 200) {
      $.ok('✅ 碎片生产中!');
    } else if (da) {
      $.err(`碎片生产失败: ${da.resultMessage}`);
    }
  } else if (d3.debris && d3.debris.state === 1) {
    $.log('碎片已在生产中');
  } else if (d3.wine && d3.wine.state === 1) {
    $.log('原浆酒还在酿，等成熟后才能产碎片');
  }
}

// ==================== 种植基地 ====================

/** 种植基地 - 收获已到期的基地产出 */
async function baseHarvest(token) {
  $.info('\n====== 种植基地 ======');
  
  // 获取基地列表
  const list = await signedPost('/farm/acre/basememberlist', {}, token);
  if (!list) return null;
  if (isTokenExpired(list)) return 'TOKEN_EXPIRED';
  if (!list.data || list.data.length === 0) { $.log('无可用的种植基地'); return; }
  
  // 过滤已开放且到期的基地
  const now = new Date().toISOString();
  let harvested = 0;
  
  for (const base of list.data) {
    if (!base.is_open) {
      $.log(`${base.base_name} 未开放，跳过`);
      continue;
    }
    
    // last_reward_time 上次收获时间, num_time=8小时产出间隔
    const lastTime = new Date(base.last_reward_time || '0001-01-01T00:00:00Z').getTime();
    const nowTime = new Date().getTime();
    const elapsedHours = (nowTime - lastTime) / (1000 * 60 * 60);
    
    if (elapsedHours >= base.num_time) {
      $.info(`${base.base_name}(${base.crop_name}) 可收获! 上次:${base.last_reward_time?.substring(0,19) || '从未'}`);
      
      const r = await signedPost('/farm/acre/baserecordreward', { pid: base.id }, token);
      if (!r) continue;
      if (isTokenExpired(r)) return 'TOKEN_EXPIRED';
      if (r.resultCode === 200 && r.data) {
        $.ok(`✅ ${base.crop_name} x${r.data.yield || 0}`);
        harvested++;
      } else if (r.resultMessage) {
        $.err(`${base.base_name}收获失败: ${r.resultMessage}`);
      }
      await $.wait(1000);
    } else {
      const remaining = Math.round((base.num_time - elapsedHours) * 10) / 10;
      $.log(`${base.base_name}(${base.crop_name}) 还需约 ${remaining} 小时`);
    }
  }
  
  if (harvested > 0) { $.ok(`种植基地收获完成，共 ${harvested} 块基地`); }
  else { $.log('无到期基地可收获'); }
}

// ==================== 单账号任务执行（带 token 自动续期） ====================
async function runTasks(getTokenFn, label) {
  let token = await getTokenFn();
  $.info(`\n======== 账号: ${label} ========`);

  async function withRefresh(fn) {
    const result = await fn(token);
    if (result === 'TOKEN_EXPIRED') {
      $.info('Token 已过期，正在刷新...');
      token = await getTokenFn(true);
      if (token) { $.ok('Token 刷新成功，重试操作'); return await fn(token); }
    }
    return result;
  }

  const operations = [
    { name: '签到', fn: dailySignIn },
    { name: '答题', fn: dailyQuiz },
    { name: '灾害', fn: disasterControl },
    { name: '收获', fn: harvest },
    { name: '种植', fn: plant },
    { name: '浇水', fn: water },
    { name: '施肥', fn: fertilize },
    { name: '转盘', fn: rotorLottery },
    { name: '金蛋', fn: goldenEgg },
    { name: '酿酒坊', fn: wineWorkshop },
    { name: '基地', fn: baseHarvest },
  ];

  for (const op of operations) {
    $.info(`--- ${op.name} ---`);
    await withRefresh(op.fn);
    await $.wait(1500);
  }

  $.ok(`👤 ${label} 全部任务完成！`);
}

// ==================== 主流程 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【浓五的酒庄·农场助手】 ${t}`);
  console.log(`随机种植作物池: [${SEED_IDS}]`);

  if (CFG.WX_SERVER && CFG.WX_OPENIDS.length > 0) {
    const tokenProviders = CFG.WX_OPENIDS.map((openid) => {
      let cached = null;
      return async (forceRefresh = false) => {
        if (!forceRefresh && cached && isTokenValid(cached)) return cached.token;
        $.info(`[${openid}] ${forceRefresh ? '强制刷新' : '获取'} token...`);
        const result = await getAuthForOpenid(openid);
        if (result) { cached = { token: result.token, cachedAt: Date.now() }; return result.token; }
        return null;
      };
    });
    $.info(`共 ${CFG.WX_OPENIDS.length} 个账号`);
    for (let i = 0; i < CFG.WX_OPENIDS.length; i++) {
      await runTasks(tokenProviders[i], CFG.WX_OPENIDS[i]);
      if (i < CFG.WX_OPENIDS.length - 1) await $.wait(3000);
    }
  } else if (CFG.MANUAL_CODE) {
    $.info('手动 Code 模式');
    const result = await loginWithCode(CFG.MANUAL_CODE);
    if (result) await runTasks(async () => result.token, '手动Code');
  } else if (CFG.MANUAL_TOKEN) {
    $.info('手动 Token 模式');
    await runTasks(async () => CFG.MANUAL_TOKEN, '手动Token');
  } else {
    $.err('未配置账号。请设置 wx_opinion（或 nxjzCode/nxjzToken）；WCS 用 wx_server_url + wx_auth');
  }
  $.ok('所有任务执行完毕！🎉');
  await sendToPushPlus("浓五的酒庄", notifyLines.join("\n"));
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); });
}
module.exports = { main, signedPost };
