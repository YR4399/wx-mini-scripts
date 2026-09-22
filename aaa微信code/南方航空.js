/*
南方航空签到脚本（WCS小程序版，兼容旧Cookie）
环境变量格式：export wx_opinion='openid1&openid2'（多账号用&分隔）
旧H5 Cookie格式仍兼容：export wx_opinion='TOKEN=xxx; ...'

@description 南方航空活动签到+抽奖
@author 自动生成
@version 1.0.0
*/

const $ = new Env('南航签到');
const fs = require('fs');
const path = require('path');

const CSAIR_APPID = 'wx729238547ac7a14c';
// wechatserver 接口配置(见 接口文档.txt)
// POST /wx/code  body: {openid, appid}  header: auth  返回 data.code
const wx_server_url = (process.env.wx_server_url || '').replace(/\/$/, '');
const wx_auth = process.env.wx_auth || '';
const CSAIR_MINI_BASE = 'https://wxapi.csair.com';
const CSAIR_MINI_VERSION = '459';
const CACHE_FILE = resolveCacheFile();
const MINI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF';
const H5_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20 MiniProgramEnv/Windows WindowsWechat/WMPF miniProgram/wx729238547ac7a14c';
const H5_REFERER = 'https://wxapi.csair.com/h5/sign/';
const RECEIVABLE_AWARD_STATUSES = new Set(['waitReceive', 'benefitWaitReceive', 'lotteryWaitReceive']);
const FINISHED_AWARD_STATUSES = new Set(['received', 'expired', 'nostock', 'waitSend']);

/**
 * 环境变量名称（统一为 wx_opinion，多账号用&分隔）
 * @type {string}
 * @example
 * const name = ENV_NAME;
 */
const ENV_NAME = 'wx_opinion';

/**
 * 账号列表。可填WCS账号标识，也可填旧H5 Cookie。
 * @type {string[]}
 * @example
 * const list = ACCOUNT_LIST;
 */
const ACCOUNT_LIST = splitAccounts(process.env[ENV_NAME]);

function splitAccounts(raw = '') {
  return String(raw)
    .split('&')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveCacheFile() {
  const custom = process.env.CSAIR_CACHE || '';
  if (!custom) return path.join(__dirname, 'csair_ck_cache.json');
  return path.isAbsolute(custom) ? custom : path.join(__dirname, custom);
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch (error) {
    console.log(`读取CK缓存失败: ${error.message || error}`);
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.log(`写入CK缓存失败: ${error.message || error}`);
  }
}

function getCachedAuth(account) {
  const cache = readCache();
  return cache[account] || null;
}

function saveCachedAuth(account, data) {
  const cache = readCache();
  cache[account] = {
    token: data.token || '',
    sessionId: data.sessionId || '',
    openId: data.openId || '',
    unionId: data.unionId || '',
    updatedAt: new Date().toISOString(),
  };
  writeCache(cache);
}

function removeCachedAuth(account) {
  const cache = readCache();
  if (cache[account]) {
    delete cache[account];
    writeCache(cache);
  }
}

function isCookieAccount(account) {
  return /(^|;\s*)TOKEN=/i.test(account) || account.includes(';');
}

function cookieValue(value) {
  return String(value ?? '').replace(/[;\r\n\t\x00-\x1f\x7f]/g, '');
}

function maskValue(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function maskWcsMessage(message) {
  return String(message || '')
    .replace(/(->\s*)([A-Za-z0-9_-]{10,})/g, (_, prefix, value) => `${prefix}${maskValue(value)}`)
    .replace(/(openid[=:]\s*)([A-Za-z0-9_-]{10,})/gi, (_, prefix, value) => `${prefix}${maskValue(value)}`);
}

function parseJsonBody(body) {
  if (body && typeof body === 'object') return body;
  try {
    return JSON.parse(body || '{}');
  } catch (error) {
    throw new Error(`响应不是JSON: ${String(body || '').slice(0, 120)}`);
  }
}

// 基于 Node 内置 http/https 的请求函数, 替代 got (避免 got v12+ ESM 的 require 兼容问题)
// options: { method, headers, json, timeout }
async function httpRequest(url, options = {}) {
  const https = require('https');
  const http = require('http');
  const urlObj = url instanceof URL ? url : new URL(url);
  const lib = urlObj.protocol === 'https:' ? https : http;
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  let payload = null;

  if (options.json !== undefined && options.json !== null) {
    payload = JSON.stringify(options.json);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method,
        headers,
        timeout: options.timeout || 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMiniUrl(apiPath) {
  const url = new URL(apiPath, CSAIR_MINI_BASE);
  url.searchParams.set('appid', CSAIR_APPID);
  url.searchParams.set('wxchannel', 'wxopen');
  url.searchParams.set('envVersion', 'release');
  return url.toString();
}

function buildWxopenUrl(apiPath) {
  const url = new URL(`/wxopen${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`, CSAIR_MINI_BASE);
  url.searchParams.set('appid', CSAIR_APPID);
  url.searchParams.set('wxchannel', 'wxopen');
  url.searchParams.set('envVersion', 'release');
  return url.toString();
}

function buildH5Url(apiPath) {
  const url = new URL(apiPath, CSAIR_MINI_BASE);
  url.searchParams.set('type', 'APPTYPE');
  url.searchParams.set('chanel', 'ss');
  url.searchParams.set('lang', 'zh');
  return url.toString();
}

function buildH5Cookie(tokenOrCookie) {
  if (isCookieAccount(tokenOrCookie)) return tokenOrCookie;
  const token = cookieValue(tokenOrCookie);
  if (!token) return '';
  return `TOKEN=${token}; cs1246643sso=${token}; channel=csair;`;
}

function h5Headers(cookie) {
  return {
    'User-Agent': H5_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: CSAIR_MINI_BASE,
    Referer: H5_REFERER,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: cookie,
  };
}

function miniHeaders(session = {}) {
  return {
    'User-Agent': MINI_USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: `https://servicewechat.com/${CSAIR_APPID}/${CSAIR_MINI_VERSION}/page-frame.html`,
    sessionId: session.sessionId || '',
    channel: 'ecsair',
    activityChannel: '1',
    unnecessaryParam: session.openId || '',
  };
}

async function postMiniApi(apiPath, data, session = {}) {
  const { body } = await httpRequest(buildMiniUrl(apiPath), {
    method: 'POST',
    headers: miniHeaders(session),
    json: data,
    timeout: 15000,
  });
  return parseJsonBody(body);
}

async function postWxopenApi(apiPath, data, session = {}) {
  const { body } = await httpRequest(buildWxopenUrl(apiPath), {
    method: 'POST',
    headers: miniHeaders(session),
    json: data,
    timeout: 15000,
  });
  return parseJsonBody(body);
}

async function getMiniApi(apiPath, data = {}, session = {}, headerParam = {}) {
  const url = new URL(buildMiniUrl(apiPath));
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const { body } = await httpRequest(url, {
    method: 'GET',
    headers: { ...miniHeaders(session), ...headerParam },
    timeout: 15000,
  });
  return parseJsonBody(body);
}

async function postMiniApiWithParams(apiPath, urlParam = {}, data = {}, session = {}, headerParam = {}) {
  const url = new URL(buildMiniUrl(apiPath));
  Object.entries(urlParam || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const { body } = await httpRequest(url, {
    method: 'POST',
    headers: { ...miniHeaders(session), ...headerParam },
    json: data,
    timeout: 15000,
  });
  return parseJsonBody(body);
}

function assertMiniSession(auth) {
  return !!(auth && auth.sessionId && auth.openId && auth.unionId);
}

async function loadMemberByAuth(auth) {
  if (!assertMiniSession(auth)) throw new Error('小程序登录缓存缺少session/openId/unionId');
  const member = await postMiniApi(
    '/mini/api/login/isLogin',
    { ssoKey: auth.unionId },
    { sessionId: auth.sessionId, openId: auth.openId },
  );
  const token = member && member.token ? member.token : '';
  if (!token) throw new Error(member && (member.message || member.msg) ? member.message || member.msg : '南航isLogin接口未返回会员TOKEN');
  return member;
}

async function getWxCodeFromServer(openid, index) {
  if (!wx_server_url || !wx_auth) throw new Error('未配置 wx_server_url 或 wx_auth 环境变量');
  const { body } = await httpRequest(`${wx_server_url}/wx/code`, {
    method: 'POST',
    headers: { auth: wx_auth, 'Content-Type': 'application/json' },
    json: { openid, appid: CSAIR_APPID },
    timeout: 20000,
  });
  const data = parseJsonBody(body);
  const code = data && data.data ? data.data.code : (data && data.code);
  if (!code) throw new Error(`获取wx_code失败: ${maskWcsMessage(JSON.stringify(data).slice(0, 120))}`);
  console.log(`账号 ${index} 获取wx_code成功: ${maskValue(code)}`);
  return code;
}

async function loginByWcs(account, index) {
  const wxCode = await getWxCodeFromServer(account, index);

  const loginInfo = await postMiniApi('/mini/api/login/login', { code: wxCode });
  const sessionId = loginInfo.sessionId || '';
  const openId = loginInfo.openId || loginInfo.openid || '';
  const unionId = loginInfo.unionId || loginInfo.unionid || '';
  if (!sessionId || !openId || !unionId) {
    throw new Error('南航login接口未返回完整session/openId/unionId');
  }

  const member = await loadMemberByAuth({ sessionId, openId, unionId });
  const token = member.token || '';

  const auth = {
    token,
    sessionId,
    openId,
    unionId,
  };
  saveCachedAuth(account, auth);
  console.log(`账号 ${index} 小程序登录成功: TOKEN=${maskValue(token)}`);
  return { auth, member };
}

async function getMiniAuthForAccount(account, index, forceLogin = false) {
  if (!forceLogin) {
    const cached = getCachedAuth(account);
    if (cached && assertMiniSession(cached)) {
      try {
        const member = await loadMemberByAuth(cached);
        console.log(`账号 ${index} 使用缓存小程序登录态: TOKEN=${maskValue(member.token)}`);
        return { auth: { ...cached, token: member.token || cached.token || '' }, member, fromCache: true };
      } catch (error) {
        console.log(`账号 ${index} 缓存小程序登录态失效: ${error.message || error}`);
        removeCachedAuth(account);
      }
    }
  }

  const result = await loginByWcs(account, index);
  return { ...result, fromCache: false };
}

/**
 * 南航签到客户端
 * @class
 * @example
 * const client = new CsairSignClient();
 */
class CsairSignClient {
  /**
   * 创建签到客户端
   * @param {string} cookie - Cookie字符串
   * @example
   * const client = new CsairSignClient('TOKEN=xxx; channel=csair; ...');
   */
  constructor(cookie) {
    /**
     * Cookie字符串
     * @type {string}
     */
    this.cookie = cookie;
  }

  async h5Post(apiPath, data = {}) {
    const { body } = await httpRequest(buildH5Url(apiPath), {
      method: 'POST',
      headers: h5Headers(this.cookie),
      json: data,
      timeout: 15000,
    });
    return parseJsonBody(body);
  }

  async h5Get(apiPath, params = {}) {
    const url = new URL(buildH5Url(apiPath));
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
    const { body } = await httpRequest(url, {
      method: 'GET',
      headers: h5Headers(this.cookie),
      timeout: 15000,
    });
    return parseJsonBody(body);
  }

  /**
   * 执行签到请求
   * @param {string} signDate - 签到日期 YYYY-MM-DD
   * @returns {Promise<Object>} 返回签到结果
   * @throws {Error} 请求失败时抛出错误
   * @example
   * const result = await client.sign('2025-01-01');
   */
  async sign(signDate) {
    return this.h5Post('/marketing-tools/activity/join', {
      activityType: 'sign',
      channel: 'mini',
      entrance: 1,
      signDate,
    });
  }

  async getAwardContent() {
    return this.h5Get('/marketing-tools/sign/getUserAwardContent');
  }

  async getAwardList(awardStatus = 'waitReceive', pageNum = 1) {
    return this.h5Post('/marketing-tools/award/awardList', {
      activityType: 'sign',
      awardStatus,
      pageNum,
    });
  }

  async getAward(signUserRewardId) {
    return this.h5Post('/marketing-tools/award/getAward', {
      activityType: 'sign',
      signUserRewardId,
    });
  }
}

class CsairMiniSignClient {
  constructor(auth, member) {
    this.auth = auth;
    this.member = member || {};
  }

  miniSession() {
    return { sessionId: this.auth.sessionId, openId: this.auth.openId };
  }

  memberNo() {
    return cookieValue(this.member.cardNo || '');
  }

  async getSignInfo() {
    const memberNo = this.memberNo();
    return getMiniApi(
      '/mini/foundZone/signInPageView',
      { memberNo, signinChannel: 'foundTheZone' },
      this.miniSession(),
      { 'memberNo-encrypt': memberNo },
    );
  }

  async sign() {
    const cert = Array.isArray(this.member.certs)
      ? this.member.certs.find((item) => item && item.certType === 'NI')
      : null;
    return postMiniApiWithParams(
      '/mini/foundZone/signIn',
      { signinChannel: 'foundTheZone' },
      {
        certNo: cert && cert.certNo ? cert.certNo : '',
        memberNo: this.memberNo(),
        phone: this.member.mobile || '',
        userName: this.member.cnFullName || '',
        email: this.member.email || '',
      },
      this.miniSession(),
    );
  }

  canSign() {
    const pear = this.member.pearMemberInfoDto || {};
    return this.member.loginType === 'EM_Y' || pear.identifyStatus === 'Y';
  }

  async getMilesEarnActivity(lotteryParams) {
    const randomId = lotteryParams.randomId || '';
    return postWxopenApi(
      '/activity/api/mileagegift/getActivityInfo',
      {
        randomId,
        memberNo: this.memberNo(),
        helpHandgroupId: lotteryParams.helperId || '',
        pageName: '首页',
        page: `/page/jump?action=milesEarn&MEID=${randomId}`,
        flightInfo: lotteryParams.flightInfo || '',
      },
      this.miniSession(),
    );
  }

  async drawMilesEarn(lotteryParams, signInFlag) {
    return postWxopenApi(
      '/activity/api/mileagegift/draw',
      {
        randomId: lotteryParams.randomId,
        memberNo: this.memberNo(),
        signInGiftId: lotteryParams.signInGiftId,
        signInActivityId: lotteryParams.signInActivityId,
        rewardId: lotteryParams.rewardId,
        signInFlag,
      },
      this.miniSession(),
    );
  }
}

function responseMessage(data) {
  if (!data || typeof data !== 'object') return '';
  return String(data.msg || data.message || data.respMsg || data.resultMessage || data.errorMsg || '');
}

function isH5Success(data) {
  if (!data || typeof data !== 'object') return false;
  const code = data.respCode ?? data.code ?? data.errorCode ?? data.resultCode;
  return (
    code === 0 ||
    code === '0' ||
    code === '0000' ||
    data.success === true ||
    data.status === true ||
    /成功|已签到|已经签到|已领取|已参与|已发放/.test(responseMessage(data))
  );
}

function isH5SignPending(data) {
  return /签到中|请稍等/.test(responseMessage(data));
}

async function signH5WithRetry(h5Client, signDate, index) {
  let result;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await h5Client.sign(signDate);
    if (!isH5SignPending(result) || attempt === 3) return result;
    console.log(`↻ 账号 ${index} 签到处理中，等待5秒后复查...`);
    await sleep(5000);
  }
  return result;
}

function isAwardLike(item) {
  return !!(
    item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    (item.awardStatus || item.signUserRewardId || item.awardName || item.awardNameNum || item.rewardType || item.awardType || item.awardDesc)
  );
}

function collectAwardItems(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectAwardItems(item, depth + 1));
  if (typeof value !== 'object') return [];

  const items = isAwardLike(value) ? [value] : [];
  Object.values(value).forEach((item) => {
    items.push(...collectAwardItems(item, depth + 1));
  });
  return items;
}

function extractAwardItems(data) {
  const root = data && data.data !== undefined ? data.data : data;
  const seen = new Set();
  return collectAwardItems(root).filter((item) => {
    const key = getAwardId(item) || `${getAwardStatus(item)}:${getAwardName(item)}:${item.signDay || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getAwardStatus(item) {
  return String((item && (item.awardStatus || item.status || item.receiveStatus)) || '');
}

function getAwardId(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.signUserRewardId || item.userRewardId || item.rewardId || item.id || item.awardId || '');
}

function getAwardName(item) {
  if (!item || typeof item !== 'object') return '未知奖励';
  return String(item.awardNameNum || item.awardName || item.rewardName || item.name || item.title || '未知奖励');
}

function isLotteryAward(item) {
  return item && String(item.awardType || '').toLowerCase() === 'lotteryaward';
}

function isReceivableAward(item) {
  const status = getAwardStatus(item);
  return (
    RECEIVABLE_AWARD_STATUSES.has(status) ||
    (isLotteryAward(item) && (status === 'received' || !FINISHED_AWARD_STATUSES.has(status)))
  );
}

function parseAwardDesc(item) {
  if (!item || !item.awardDesc) return {};
  if (typeof item.awardDesc === 'object') return item.awardDesc;
  try {
    return JSON.parse(item.awardDesc);
  } catch (error) {
    return {};
  }
}

function getLotteryUrlFromAward(item) {
  const desc = parseAwardDesc(item);
  return String(desc.lotteryUrl || desc.url || item.lotteryUrl || '');
}

function getResultData(data) {
  if (!data || typeof data !== 'object') return {};
  const root = data.data && typeof data.data === 'object' ? data.data : data;
  return root.result && typeof root.result === 'object' ? root.result : root;
}

function parseLotteryParams(item, result = {}) {
  const lotteryUrl = getLotteryUrlFromAward(item) || String(result.lotteryUrl || '');
  if (!lotteryUrl) return null;
  try {
    const url = new URL(lotteryUrl, CSAIR_MINI_BASE);
    const rewardId = String(item.id || item.signUserRewardId || item.userRewardId || item.rewardId || '');
    if (item.awardId && !url.searchParams.get('signInGiftId')) url.searchParams.set('signInGiftId', item.awardId);
    if (item.activityId && !url.searchParams.get('signInActivityId')) url.searchParams.set('signInActivityId', item.activityId);
    if (rewardId && !url.searchParams.get('rewardId')) url.searchParams.set('rewardId', rewardId);
    return {
      randomId: url.searchParams.get('MEID') || url.searchParams.get('randomId') || String(result.lotteryId || ''),
      signInGiftId: url.searchParams.get('signInGiftId') || '',
      signInActivityId: url.searchParams.get('signInActivityId') || '',
      rewardId: url.searchParams.get('rewardId') || '',
      jumpUrl: lotteryUrl.startsWith('/') ? `${url.pathname}${url.search}` : url.toString(),
    };
  } catch (error) {
    return null;
  }
}

function buildLotteryJumpUrl(item, result) {
  const params = parseLotteryParams(item, result);
  return params ? params.jumpUrl : '';
}

function isMilesDrawSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  return data.code === 'W200' || data.respCode === '0000' || data.success === true || data.status === true;
}

function milesDrawMessage(data) {
  if (!data || typeof data !== 'object') return '未知结果';
  return String(data.message || data.msg || data.respMsg || data.resultMessage || data.giftName || data.giftType || '未知结果');
}

function summarizeAwardItems(items) {
  return items
    .slice(0, 5)
    .map((item) => `${getAwardName(item)}[${getAwardStatus(item) || '-'},${item.awardType || '-'},id=${getAwardId(item) || '-'}]`)
    .join('；');
}

async function getAwardTargets(h5Client, index, awardStatus) {
  const awardList = await h5Client.getAwardList(awardStatus, 1);
  if (!isH5Success(awardList)) {
    console.log(`⚠️ 账号 ${index} ${awardStatus}奖励列表异常: ${responseMessage(awardList) || '未知结果'}`);
    return [];
  }
  const items = extractAwardItems(awardList);
  const totalCount = awardList && awardList.data && awardList.data.totalCount !== undefined ? awardList.data.totalCount : items.length;
  console.log(`🎁 账号 ${index} ${awardStatus}奖励列表: total=${totalCount}, parsed=${items.length}${items.length ? `，${summarizeAwardItems(items)}` : ''}`);
  return items.filter(isReceivableAward);
}

async function handleLotteryAward(miniClient, item, result, index, awardName) {
  const lotteryParams = parseLotteryParams(item, result);
  if (!lotteryParams || !lotteryParams.randomId) {
    console.log(`⚠️ 账号 ${index} 奖励 ${awardName}: 缺少大转盘 MEID，无法抽奖`);
    return;
  }

  console.log(`🎯 账号 ${index} 奖励 ${awardName}: 抽奖入口=${lotteryParams.jumpUrl}`);
  if (!miniClient) {
    console.log(`⚠️ 账号 ${index} 缺少小程序登录态，无法自动点击戳我抽奖`);
    return;
  }
  if (!lotteryParams.signInGiftId || !lotteryParams.signInActivityId || !lotteryParams.rewardId) {
    console.log(`⚠️ 账号 ${index} 奖励 ${awardName}: 缺少签到抽奖参数，无法抽奖`);
    return;
  }

  try {
    const activity = await miniClient.getMilesEarnActivity(lotteryParams);
    const activityData = activity && activity.data && typeof activity.data === 'object' ? activity.data : activity || {};
    const signInFlag = activityData.signInFlag;
    const remain = activityData.freeDrawRemainQuantity;
    console.log(`🎯 账号 ${index} 大转盘状态: 剩余免费抽奖次数=${remain === undefined ? '未知' : remain}`);
    const drawResult = await miniClient.drawMilesEarn(lotteryParams, signInFlag);
    const success = isMilesDrawSuccess(drawResult);
    const prizeName = drawResult && (drawResult.giftName || (drawResult.mileageGiftInfo && drawResult.mileageGiftInfo.name));
    const message = prizeName || milesDrawMessage(drawResult);
    const noChance = /暂无抽奖机会|没有抽奖机会|抽奖次数已用完|已抽奖|已参与/.test(message);
    console.log(`${success ? '✅' : noChance ? '🎯' : '❌'} 账号 ${index} 戳我抽奖: ${message}`);
  } catch (error) {
    console.log(`⚠️ 账号 ${index} 戳我抽奖失败: ${error.message || error}`);
  }
}

async function checkAndClaimAwards(h5Client, index, miniClient = null) {
  if (!h5Client || !h5Client.cookie) return;
  console.log(`🎁 账号 ${index} 开始检查签到奖励`);

  let detailTargets = [];
  try {
    detailTargets = await getAwardTargets(h5Client, index, 'waitReceive');
    if (detailTargets.length === 0) detailTargets = await getAwardTargets(h5Client, index, 'all');
  } catch (error) {
    console.log(`⚠️ 账号 ${index} 待领取奖励列表查询失败: ${error.message || error}`);
  }

  let content;
  try {
    content = await h5Client.getAwardContent();
  } catch (error) {
    console.log(`⚠️ 账号 ${index} 奖励状态查询失败: ${error.message || error}`);
    content = null;
  }

  if (content && !isH5Success(content)) {
    console.log(`⚠️ 账号 ${index} 奖励状态异常: ${responseMessage(content) || '未知结果'}`);
  }

  const contentTargets = content && isH5Success(content) ? extractAwardItems(content).filter(isReceivableAward) : [];
  const targets = detailTargets.length > 0 ? detailTargets : contentTargets;
  if (targets.length === 0) {
    console.log(`🎁 账号 ${index} 暂无待领取/待参与签到奖励`);
    return;
  }

  console.log(`🎁 账号 ${index} 发现 ${targets.length} 个可处理奖励`);
  for (const item of targets) {
    const awardName = getAwardName(item);
    const awardId = getAwardId(item);
    const awardStatus = getAwardStatus(item);
    if (isLotteryAward(item) && awardStatus === 'received') {
      await handleLotteryAward(miniClient, item, {}, index, awardName);
      continue;
    }
    if (!awardId) {
      console.log(`⚠️ 账号 ${index} 奖励 ${awardName} 缺少 signUserRewardId，跳过`);
      continue;
    }

    try {
      const result = await h5Client.getAward(awardId);
      const success = isH5Success(result);
      const data = getResultData(result);
      const lotteryJumpUrl = buildLotteryJumpUrl(item, data);
      const lotteryInfo = [data.lotteryId ? `lotteryId=${data.lotteryId}` : '', lotteryJumpUrl ? `lotteryUrl=${lotteryJumpUrl}` : '']
        .filter(Boolean)
        .join('，');
      console.log(`${success ? '✅' : '❌'} 账号 ${index} 奖励 ${awardName}: ${responseMessage(result) || (success ? '处理成功' : '处理失败')}`);
      if (lotteryInfo) console.log(`🎯 账号 ${index} 抽奖信息: ${lotteryInfo}`);
      if (success && isLotteryAward(item) && lotteryJumpUrl) await handleLotteryAward(miniClient, item, data, index, awardName);
    } catch (error) {
      console.log(`⚠️ 账号 ${index} 奖励 ${awardName} 处理失败: ${error.message || error}`);
    }
  }
}

/**
 * 主流程函数
 * @returns {Promise<void>} 无返回值
 * @throws {Error} 当环境变量未设置或请求失败时抛出错误
 * @example
 * await main();
 */

const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '南航签到';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", streak: "", tasks: [], lottery: "", taskEarned: "" };
  return _rpRows[idx];
}
function _setName(idx, name) { if (name != null && name !== "") _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null && sign !== "") r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
function _setStreak(idx, streak) { if (streak != null && streak !== "") _rpGet(idx).streak = String(streak); }
function _setTaskEarned(idx, text) { if (text != null && text !== "") _rpGet(idx).taskEarned = String(text); }
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
async function doPush() { /* 由 flushLogPoints 统一经 std_report 推送 */ }
let _rpFlushed = false;
async function flushLogPoints(app) {
  if (_rpFlushed) return;
  _rpApp = app || _rpApp;
  const rows = _rpRows.filter(Boolean);
  if (!rows.length) return;
  _rpFlushed = true;
  await _stdReport(_rpApp, rows);
}
{
  const _oe = process.exit.bind(process);
  process.exit = function (code) {
    const p = flushLogPoints(_rpApp);
    if (p && typeof p.then === 'function') p.then(() => _oe(code)).catch(() => _oe(code));
    else _oe(code);
  };
}
process.on('beforeExit', () => { flushLogPoints(_rpApp); });


async function main() {
  if (ACCOUNT_LIST.length === 0) {
    console.log(`❌ 请先设置环境变量 ${ENV_NAME}`);
    return;
  }

  console.log(`✅ 共找到 ${ACCOUNT_LIST.length} 个账号配置`);

  for (let i = 0; i < ACCOUNT_LIST.length; i += 1) {
    await handleAccount(ACCOUNT_LIST[i], i + 1);
  }
}

/**
 * 处理单个账号签到
 * @param {string} cookie - Cookie字符串
 * @param {number} index - 账号索引
 * @returns {Promise<void>} 无返回值
 * @throws {Error} 请求失败时抛出错误
 * @example
 * await handleAccount('TOKEN=xxx; channel=csair; ...', 1);
 */
async function handleAccount(cookie, index) {
  console.log(`\n======= 账号 ${index} 开始处理 =======`);
  const errcodes = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];
  const today = new Date().toISOString().split('T')[0];

  for (let retry = 1; retry <= 3; retry++) {
    try {
      if (isCookieAccount(cookie)) {
        const client = new CsairSignClient(cookie);
        const signResult = await signH5WithRetry(client, today, index);
        const signSuccess = showResult(signResult, index);
        if (signSuccess || isH5SignPending(signResult)) await checkAndClaimAwards(client, index);
        return;
      }

      const { auth, member } = await getMiniAuthForAccount(cookie, index);
      const client = new CsairMiniSignClient(auth, member);
      const h5Client = new CsairSignClient(buildH5Cookie(member.token || auth.token));
      if (!client.canSign()) {
        console.log(`❌ 账号 ${index} 会员未实名或会员信息不完整，跳过签到`);
        return;
      }
      const signResult = await signH5WithRetry(h5Client, today, index);
      const signSuccess = showResult(signResult, index);
      if (signSuccess || isH5SignPending(signResult)) {
        await checkAndClaimAwards(h5Client, index, client);
      } else {
        console.log(`❌ 账号 ${index} 未确认签到成功，跳过奖励检查`);
      }
      return;
    } catch (error) {
      if (errcodes.includes(error.code) && retry < 3) {
        console.log(`↻ 第${retry}次重试中...`);
        await sleep(2000);
        continue;
      }
      console.log(`⚠️ 账号 ${index} 请求失败: ${error.message}`);
      return;
    }
  }
}

function isMiniAlreadySigned(data) {
  const info = data && data.data && typeof data.data === 'object' ? data.data : data || {};
  return String(info.signInFlag || '').toLowerCase() === 'true';
}

function isMiniSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  const code = data.code ?? data.resultCode ?? data.respCode ?? data.errorCode;
  const message = data.msg || data.message || data.resultMessage || data.respMsg || '';
  return (
    code === 0 ||
    code === '0' ||
    code === '0000' ||
    data.success === true ||
    data.status === true ||
    /成功|已签到/.test(String(message))
  );
}

function showMiniResult(data, index, action) {
  const info = data && data.data && typeof data.data === 'object' ? data.data : {};
  const already = isMiniAlreadySigned(data);
  const success = already || isMiniSuccess(data);
  const message = already
    ? '今日已签到'
    : data && (data.msg || data.message || data.resultMessage)
      ? data.msg || data.message || data.resultMessage
      : success
        ? `${action}成功`
        : '未知结果';
  const extraInfo = [];
  if (info.signInNum !== undefined) extraInfo.push(`连续签到天数: ${info.signInNum}`);
  if (info.signInFlag !== undefined) extraInfo.push(`今日签到标记: ${info.signInFlag}`);
  console.log(
    [
      `${success ? '✅' : '❌'} 账号 ${index}`,
      `操作结果: ${message}`,
      `签到状态: ${success ? '成功' : '失败'}`,
      ...(extraInfo.length ? ['--- 小程序签到详情 ---', ...extraInfo] : []),
      '',
    ].join('\n'),
  );
  return success;
}

/**
 * 显示签到结果
 * @param {Object} data - 返回的数据
 * @param {number} index - 账号索引
 * @returns {void} 无返回值
 * @example
 * showResult({ code: 0, msg: 'ok', success: true }, 1);
 */
function showResult(data, index) {
  if (!data) {
    console.log(`❌ 账号 ${index} 无效响应`);
    return false;
  }

  const success =
    data.code === 0 ||
    data.code === '0000' ||
    data.success === true ||
    data.status === true ||
    data.respCode === '0000' ||
    /签到成功|已签到|已经签到/.test(String(data.msg || data.message || data.respMsg || ''));
  const message = data.msg || data.message || data.respMsg || '未知结果';

  const baseInfo = [
    `${success ? '✅' : '❌'} 账号 ${index}`,
    `操作结果: ${message}`,
    `签到状态: ${success ? '成功' : '失败'}`,
  ];

  const extraInfo = [];
  if (data.data && typeof data.data === 'object') {
    if (data.data.result !== undefined) {
      extraInfo.push(`奖励提示: ${data.data.result}`);
    }
    if (data.data.award_num !== undefined) {
      extraInfo.push(`获得奖励数量: ${data.data.award_num}`);
    }
    if (data.data.score !== undefined) {
      extraInfo.push(`当前积分: ${data.data.score}`);
    }
  }

  console.log(
    [
      ...baseInfo,
      ...(extraInfo.length ? ['--- 奖励详情 ---', ...extraInfo] : []),
      '',
    ].join('\n'),
  );
  // 上报 std_report 双引擎（钉钉 markdown）
  const _info = (data && data.data) || {};
  const _already = isMiniAlreadySigned(data);
  _setName(index, "账号" + index);
  _setSign(index, _already ? "今日已签到" : (success ? "签到成功" : "签到失败"));
  if (_info.signInNum != null && _info.signInNum !== "") _setStreak(index, String(_info.signInNum));
  if (_info.score != null && _info.score !== "") _rpGet(index).total = String(_info.score);
  const _award = [];
  if (_info.result != null && _info.result !== "") _award.push(String(_info.result));
  if (_info.award_num != null && _info.award_num !== "") _award.push("奖励x" + _info.award_num);
  if (_award.length) _rpGet(index).earned = _award.join(" ");
  return success;
}

/**
 * 环境类
 * @description 提供青龙面板所需的环境支持
 * @param {string} name - 脚本名称
 * @returns {Object} 环境对象实例
 * @example
 * const $ = new Env('南航签到');
 */
function Env(name) {
  return new (class {
    /**
     * 构造函数
     * @param {string} name - 环境名称
     */
    constructor(name) {
      this.name = name;
      this.notifyMsgs = [];
    }

    /**
     * 日志输出方法
     * @param {string} msg - 日志消息
     * @param {Object} options - 选项配置
     * @param {boolean} options.notify - 是否发送通知
     * @returns {void} 无返回值
     */
    log(msg, options = {}) {
      console.log(msg);
      if (options.notify) this.notifyMsgs.push(msg);
    }

    /**
     * 发送通知方法
     * @returns {Promise<void>} 无返回值
     * @throws {Error} 当通知发送失败时抛出错误
     */
    async sendNotify() {
      if (this.notifyMsgs.length > 0) {
        await flushLogPoints(_rpApp);
      }
    }
  })(name);
}

main().catch(console.error);
