/*
君品荟 - 登录、签到、查询、酒谷之旅农场、滑块验证、std_report双引擎推送
cron: 45 8 * * *
每4小时推送一次数据汇总，新增定时 0 0,4,8,12,16,20 * * *

变量名：junpinhui
变量值：wx_server 中保存的 openid/账号标识，多账号用 & 或换行分隔
      也支持 openid#token 或仅 token
依赖变量：wx_server_url、wx_auth、地块
依赖模块: axios, crypto-js
新增控制变量：FORCE_SLIDE_VERIFY 设为true每次账号强制重新滑块
推送：经 std_report 双引擎（钉钉 markdown）统一推送，无需额外配置
*/

// ====================== 替换掉缺失的 env.js 依赖 ======================
const $ = {
  name: "君品荟",
  userIdx: 1,
  userList: [],
  userCount: 0,
  log: (msg) => console.log(msg),
  wait: (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min))),
  checkEnv: (ckName) => {
    let envVal = process.env[ckName];
    if (!envVal) {
      console.log(`❌ 未找到环境变量: ${ckName}，请先在青龙中添加变量。`);
      return;
    }
    // 支持按换行符、& 或 @ 分割多账号
    let splitted = envVal.split(/&|\n|@/).map(v => v.trim()).filter(v => v);
    $.userList = splitted;
    $.userCount = splitted.length;
    console.log(`✅ 共找到 ${$.userCount} 个账号配置`);
  },
  done: () => console.log("\n🎉 所有任务执行结束")
};
// =======================================================================

const axios = require("axios");
// __NET_RETRY__
axios.interceptors.response.use(
  (r) => r,
  async (e) => {
    const cfg = e.config || {};
    cfg.__rc = (cfg.__rc || 0) + 1;
    const m = String((e && (e.message || e.code)) || "");
    const net = !e.response && /timeout|ECONNABORTED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang|network|connection/i.test(m);
    if (net && cfg.__rc <= 3) {
      await new Promise((s) => setTimeout(s, 2000 * cfg.__rc));
      const { __rc, ...rest } = cfg;
      return axios.request(rest);
    }
    throw e;
  }
);
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ckName = "junpinhui";
const MINI_APP_ID = "wx8d41cdc44c8aeaab";
const APP_VERSION = "1.0.12";
const FM_BASE = "https://fm.exijiu.com";
const GARDEN_BASE = "https://apimallwm.exijiu.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "junpinhui_token_cache.json");
// 强制每次执行滑块开关，青龙环境变量 FORCE_SLIDE_VERIFY=true 开启
const FORCE_SLIDE = process.env.FORCE_SLIDE_VERIFY === "true";

// === [本地账号服务配置] 根据抓包数据更新 ===
const WX_SERVER_URL = process.env.wx_server_url || "http://100.122.1.00:18788";
const WX_AUTH = process.env.wx_auth || "b47ad1";

// ================= 新增滑块验证依赖全局配置 =================
const OCR_SERVER = process.env.OCR_SERVER || 'https://ddddocr.xzxxn7.live';

// 随机生成虚拟IP
const generateRandomIP = () => {
    const part1 = Math.floor(Math.random() * 255) + 1;
    const part2 = Math.floor(Math.random() * 255);
    const part3 = Math.floor(Math.random() * 255);
    const part4 = Math.floor(Math.random() * 255);
    return `${part1}.${part2}.${part3}.${part4}`;
};

// AES 加密函数
function aesEncrypt(e, n) {
    const cryptoJS = require('crypto-js');
    var t = cryptoJS.enc.Utf8.parse(n),
        i = cryptoJS.enc.Utf8.parse(JSON.stringify(e)),
        r = cryptoJS.AES.encrypt(i, t, {
            mode: cryptoJS.mode.ECB,
            padding: cryptoJS.pad.Pkcs7
        });
    return cryptoJS.enc.Base64.stringify(r.ciphertext);
}

// 滑块OCR请求封装
const slidePost = async (body, randomIP) => {
    try {
        const response = await axios.post(`${OCR_SERVER}/capcode`, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': randomIP,
                'X-Real-IP': randomIP
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        $.log(`滑块OCR识别请求失败: ${error.message}`);
        throw error;
    }
};
// =========================================================

// ===================== std_report 双引擎推送（钉钉 markdown） =====================
const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '君品荟';
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
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
function _setTaskEarned(idx, text) { if (text != null && text !== "") _rpGet(idx).taskEarned = String(text); }
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
// =========================================================================

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    $.log(`token缓存写入失败: ${e.message || e}`);
  }
}

function md5(text) {
  return crypto.createHash("md5").update(String(text)).digest("hex");
}

function mask(value = "") {
  value = String(value);
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function parseAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return { openid: "", token: "" };

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        token: data.token || data.accessToken || "",
      };
    } catch {}
  }

  for (const sep of ["#", "|"]) {
    if (text.includes(sep)) {
      const [openid, ...rest] = text.split(sep);
      return { openid: openid.trim(), token: rest.join(sep).trim() };
    }
  }

  if (text.length > 40 && !text.startsWith("o")) return { openid: "", token: text };
  return { openid: text, token: "" };
}

function headers(token = "") {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
    Referer: `https://servicewechat.com/${MINI_APP_ID}/215/page-frame.html`,
    AppID: MINI_APP_ID,
    "App-Version": APP_VERSION,
    Authorization: `Basic ${Buffer.from("wechat:wechat_secret").toString("base64")}`,
    ...(token ? { "X-Access-Token": token } : {}),
  };
}

function shortJson(value, limit = 180) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function okCode(res) {
  return String(res?.code) === "10000" || res?.success === true || Number(res?.err) === 0;
}

function assertOk(res, action) {
  if (!res || !okCode(res)) {
    throw new Error(`${action}失败: ${res?.message || res?.msg || res?.errMsg || shortJson(res, 500)}`);
  }
  return res.data;
}

async function request(method, base, urlPath, { token = "", data = null, params = null } = {}) {
  const res = await axios({
    method,
    url: `${base}${urlPath}`,
    data,
    params,
    timeout: 20000,
    validateStatus: () => true,
    headers: headers(token),
  });
  return res.data;
}

function aesCbcPkcs7Hex(text, key, iv) {
  const keyBuf = Buffer.from(String(key), "utf8");
  const ivBuf = Buffer.from(String(iv), "utf8");
  const algo = { 16: "aes-128-cbc", 24: "aes-192-cbc", 32: "aes-256-cbc" }[keyBuf.length];
  if (!algo) throw new Error(`encrypt_key长度异常: ${keyBuf.length}`);
  if (ivBuf.length !== 16) throw new Error(`iv长度异常: ${ivBuf.length}`);
  const cipher = crypto.createCipheriv(algo, keyBuf, ivBuf);
  return cipher.update(text, "utf8", "hex") + cipher.final("hex");
}

function listify(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["list", "data", "records", "items", "rows"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function pickId(item = {}) {
  for (const key of ["id", "sorghum_id", "sorghumId", "member_sorghum_id", "memberSorghumId", "land_id", "landId"]) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return "";
}

function landNo(item = {}) {
  return item.serial_number ?? item.serialNumber ?? pickId(item) ?? "?";
}

function landStatus(item = {}) {
  const value = Number(item.status ?? -1);
  return Number.isFinite(value) ? value : -1;
}

function isPlantable(item = {}) {
  return pickId(item) && landStatus(item) === 0;
}

function isGrowing(item = {}) {
  const status = landStatus(item);
  return pickId(item) && status > 0 && ![10, 11].includes(status);
}

function isHarvestable(item = {}) {
  return pickId(item) && [10, 11].includes(landStatus(item));
}

function isCompleted(task = {}) {
  return Number(task.is_complete ?? task.isComplete ?? task.complete ?? task.status_complete ?? 0) === 1;
}

class Task {
  constructor(raw) {
    this.index = $.userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid;
    this.token = account.token || "";
    this.member = {};
    this.cacheKey = this.openid || (this.token ? md5(this.token).slice(0, 16) : `account_${this.index}`);
    this.encryptKeyCache = null;
    // 推送用的数据收集
    this.pushData = {
      nickName: "",
      integration: 0,
      water: 0,
      wheat: 0,
      sorghum: 0,
      wine: 0,
      manure: 0,
      wineStatus: "",
      farmLogs: []
    };
  }

  addFarmLog(log) {
    this.pushData.farmLogs.push(log);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      openid: this.openid || this.getCached().openid || "",
      ...(this.token ? { token: this.token } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeToken() {
    const cache = readCache();
    if (cache[this.cacheKey]) {
      delete cache[this.cacheKey].token;
      writeCache(cache);
    }
    this.token = ""; 
  }

  async getWxCode() {
    if (!this.openid) throw new Error("缺少 openid，无法自动登录");
    
    try {
      const codeRes = await axios.post(`${WX_SERVER_URL}/wx/code`, {
        openid: this.openid,
        appid: MINI_APP_ID 
      }, {
        headers: { 
          'auth': WX_AUTH, 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
        }
      });

      if (codeRes.data && codeRes.data.status === true && codeRes.data.data && codeRes.data.data.code) {
        return codeRes.data.data.code;
      } else {
        throw new Error(`wx_server 未返回 code: ${JSON.stringify(codeRes.data)}`);
      }
    } catch (error) {
      throw new Error(`wx_server 获取 code 失败: ${error.message}`);
    }
  }

  async syncSessionKey() {
    try {
      $.log(`⏳ 账号[${this.index}] 正在等待 5 秒，以获取全新的 code...`);
      await $.wait(5000, 5000); 
      
      const newCode = await this.getWxCode(); 
      $.log(`🔄 账号[${this.index}] 成功获取第二段 code，正在向官方服务器同步最新 SessionKey...`);
      
      const res = await this.gardenGet("/garden/wechat/saveSessionKey", { code: newCode });
      $.log(`✅ 账号[${this.index}] SessionKey 同步完成: ${shortJson(res || "ok")}`);
    } catch (e) {
      $.log(`⚠️ 账号[${this.index}] SessionKey 同步失败: ${e.message}`);
    }
  }

  async login() {
    $.log(`🔔 账号[${this.index}] 正在获取新 code 换取全新 Token...`);
    const code = await this.getWxCode();
    const data = assertOk(
      await request("post", FM_BASE, "/api/v2/login/wxMiniSilentLogin", {
        data: { code },
      }),
      "静默登录"
    );
    if (!data?.token) throw new Error(`静默登录未返回 token: ${JSON.stringify(data)}`);
    this.token = data.token;
    this.saveCache({
      unionId: data.unionId || "",
      phone: data.phone || "",
      mainOpenId: data.openId || "",
    });
    $.log(`✅ 账号[${this.index}] 登录成功: ${mask(data.phone || data.openId || this.token)}`);

    await this.syncSessionKey();
  }

  async ensureLogin() {
    if (!this.token) this.token = this.getCached().token || "";
    if (this.token) return;
    await this.login();
  }

  async withRelogin(fn) {
    await this.ensureLogin();
    let res = await fn();
    const msg = `${res?.message || ""}${res?.msg || ""}`;
    if (!okCode(res) && this.openid && /登录|授权|token|Token|未认证|失效/.test(msg)) {
      $.log(`账号[${this.index}] token疑似失效，重新登录`);
      this.removeToken();
      await this.login();
      res = await fn();
    }
    return res;
  }

  async gardenGet(urlPath, params = {}) {
    const res = await this.withRelogin(() =>
      request("get", GARDEN_BASE, urlPath, { token: this.token, params })
    );
    return assertOk(res, urlPath);
  }

  async gardenPost(urlPath, data = {}) {
    const res = await this.withRelogin(() =>
      request("post", GARDEN_BASE, urlPath, { token: this.token, data })
    );
    return assertOk(res, urlPath);
  }

  async getEncryptKey() {
    if (this.encryptKeyCache) {
      return this.encryptKeyCache;
    }

    if (!this.openid) throw new Error("缺少 openid，无法生成微信 encryptData");
    const { data } = await axios.post(
      `${WX_SERVER_URL}/wx/encryptkey`,
      { appid: MINI_APP_ID, openid: this.openid },
      {
        headers: { 
          'auth': WX_AUTH,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    if (!data?.status) throw new Error(data?.message || "wx_server 获取 encryptkey 失败");
    const info = data.data || {};
    const encryptKey = info.encryptKey || info.encrypt_key;
    const iv = info.iv;
    const version = info.version;
    if (!encryptKey || !iv || version === undefined) {
      throw new Error(`wx_server encryptkey 缺少必要字段: ${JSON.stringify(data)}`);
    }
    
    $.log(`🔐 账号[${this.index}] 提取加密参数成功 -> Key: ${encryptKey} | iv: ${iv} | version: ${version}`);
    
    this.encryptKeyCache = { encryptKey, iv, version };
    return this.encryptKeyCache;
  }

  async encryptData(data = {}) {
    const payload = data && typeof data === "object" ? { ...data } : {};
    const key = await this.getEncryptKey();
    payload.ts = Date.now();
    payload.encryptData = aesCbcPkcs7Hex(JSON.stringify(payload), key.encryptKey, key.iv);
    payload.version = key.version;
    return payload;
  }

  async encryptedPost(urlPath, data = {}) {
    return this.gardenPost(urlPath, await this.encryptData(data));
  }

  async encryptedGet(urlPath, data = {}) {
    return this.gardenGet(urlPath, await this.encryptData(data));
  }

  async queryMember() {
    const info = await this.gardenGet("/garden/Gardenmemberinfo/getMemberInfo");
    this.member = info || {};
    this.saveCache({
      memberId: info?.member_id || "",
      nickName: info?.nick_name || "",
      integration: info?.integration || "",
    });
    // 更新推送数据
    this.pushData.nickName = info?.nick_name || mask(info?.member_id || "");
    this.pushData.integration = info?.integration || 0;
    this.pushData.water = info?.water || 0;
    this.pushData.wheat = info?.wheat || 0;
    this.pushData.sorghum = info?.sorghum || 0;
    this.pushData.wine = info?.wine || 0;
    this.pushData.manure = info?.manure || 0;
    
    $.log(
      `账号[${this.index}] 会员: ${info?.nick_name || mask(info?.member_id || "")}，积分${info?.integration ?? "未知"}，水滴${info?.water ?? 0}，有机肥${info?.manure ?? 0}，种子${info?.sorghum ?? 0}`
    );
    return info || {};
  }

  // ========== 重构滑块验证：独立强制重跑滑块方法 ==========
  async reVerifyCaptcha() {
    let retryTimes = 2; // 失败重试2次
    for (let r = 1; r <= retryTimes; r++) {
      try {
          const randomIP = generateRandomIP();
          $.log(`账号[${this.index}] 【强制重新滑块】第${r}/${retryTimes}次，虚拟IP: ${randomIP}`);
          
          const captchaRes = await axios.post(`${FM_BASE}/api/captcha/get`, { captchaType: "blockPuzzle" }, {
              headers: {
                  ...headers(this.token),
                  "X-Forwarded-For": randomIP,
                  "X-Real-IP": randomIP
              },
              timeout:12000
          });
          
          const captcha = captchaRes.data;
          if (!captcha.success) {
              throw new Error(`获取滑块底图失败: ${captcha.message}`);
          }

          $.log(`账号[${this.index}] 滑块底图获取完成，调用OCR识别缺口坐标`);
          
          const slideResponse = await slidePost({
              slidingImage: captcha.data.repData.jigsawImageBase64,
              backImage: captcha.data.repData.originalImageBase64
          }, randomIP);

          const point = aesEncrypt({ x: slideResponse.result, y: 5 }, captcha.data.repData.secretKey);

          $.log(`账号[${this.index}] OCR识别x坐标:${slideResponse.result}，提交校验`);
          
          const checkRes = await axios.post(`${FM_BASE}/api/captcha/check`, {
              captchaType: "blockPuzzle",
              pointJson: point,
              token: captcha.data.repData.token
          }, {
              headers: {
                  ...headers(this.token),
                  "X-Forwarded-For": randomIP,
                  "X-Real-IP": randomIP
              },
              timeout:12000
          });

          if (checkRes.data.success) {
              $.log(`✅ 账号[${this.index}] 滑块验证校验通过！`);
              return true;
          } else {
              throw new Error(`服务器校验失败: ${checkRes.data.message}`);
          }
      } catch (error) {
          $.log(`⚠️ 账号[${this.index}] 滑块第${r}次失败: ${error.message}`);
          if(r < retryTimes) await $.wait(3000,5000);
      }
    }
    $.log(`❌ 账号[${this.index}] 滑块重试${retryTimes}次全部失败，跳过滑块流程`);
    return false;
  }

  // 原有普通滑块入口（兼容旧逻辑）
  async verifyCaptcha() {
    return await this.reVerifyCaptcha();
  }

  async dailySign() {
    const fn = async () => {
      const code = await this.getWxCode();
      const res = await axios({
        method: "post",
        url: `${FM_BASE}/api/customer/daily/fillSignIn`,
        data: { code: code, channelCode: "xj_mall_wx_applet" },
        timeout: 20000,
        validateStatus: () => true,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; 2106118C Build/UKQ1.231003.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 Mobile Safari/537.36 XWEB/1460217 MMWEBSDK/20250904 MMWEBID/1162 MicroMessenger/8.0.64.2940(0x28004033) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
          "Referer": `https://servicewechat.com/${MINI_APP_ID}/218/page-frame.html`,
          "AppID": MINI_APP_ID,
          "App-Version": "1.7",
          "Authorization": "Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ=",
          "X-Access-Token": this.token,
          "Accept-Encoding": "gzip, deflate, br"
        }
      });
      return assertOk(res.data, "每日签到");
    };

    try {
      const data = await this.withRelogin(fn);
      $.log(`账号[${this.index}] 签到成功: ${shortJson(data || "ok")}`);
      _setName(this.index, this.pushData.nickName || this.openid);
      // 推送补充总积分（会员 integration 字段）
      const _int = this.pushData && this.pushData.integration != null ? Number(this.pushData.integration) : null;
      _setSign(this.index, "签到成功", null, _int != null && _int > 0 ? String(_int) : null);
    } catch (e) {
      $.log(`账号[${this.index}] 签到失败: ${e.message || e}`);
    }
  }

  async getActiveWineRecord() {
    try {
      const data = await this.gardenGet("/garden/gardenmemberwine/index");
      const records = listify(data);
      const activeRecord = records.find(r => r.status === 3 || r.status === 2 || r.status === 1 || r.crop_time);
      if (activeRecord) {
        return activeRecord;
      }
    } catch (e) {}
    return null;
  }

  async makeYeast() {
    try {

      const res = await this.withRelogin(async () => {
        const response = await axios({
          method: "post",
          url: `${GARDEN_BASE}/garden/wheat/makeWineYeast`,
          data: "volumn=100",
          headers: {
            ...headers(this.token),
            "Content-Type": "application/x-www-form-urlencoded"
          }
        });
        return response.data;
      });
      const data = assertOk(res, "制曲");
      $.log(`账号[${this.index}] 制曲成功: 消耗小麦 ${Math.abs(data?.consume_wheat || 0)}, 获得酒曲 ${data?.get_wine_yeast || 0}`);
    } catch (e) {
      $.log(`账号[${this.index}] 制曲失败: ${e.message || e}`);
    }
  }

  async makeWine() {
    try {
      const res = await this.withRelogin(async () => {
        const response = await axios({
          method: "post",
          url: `${GARDEN_BASE}/garden/gardenmemberwine/makeWine`,
          data: "volumn=200",
          headers: {
            ...headers(this.token),
            "Content-Type": "application/x-www-form-urlencoded"
          }
        });
        return response.data;
      });
      const data = assertOk(res, "制酒(酿酒)");
      
      if (data && data.make_wine_record) {
        const record = data.make_wine_record;
        $.log(`账号[${this.index}] 制酒开始，单号: ${record.id}，预计收取时间: ${record.crop_time}`);
        this.pushData.wineStatus = `酿酒进行中：预计${record.crop_time}收取`;
        this.saveCache({
          current_wine_id: record.id,
          wine_crop_time: record.crop_time
        });
        return true;
      }
    } catch (e) {
      $.log(`账号[${this.index}] 制酒(酿酒)失败: ${e.message || e}`);
      if (String(e.message || e).includes("正在制酒中")) {
        $.log(`⚠️ 警告: 账号[${this.index}] 本地丢失了酿造流水号。为了恢复自动收取，请前往小程序【手动收一次酒】，重置脚本循环！`);
      }
      return false;
    }
  }

  async harvestWine(id) {
    try {
      const data = await this.gardenGet("/garden/gardenmemberwine/harvestWine", { id: id });
      $.log(`账号[${this.index}] 收酒成功: 获得酒滴 ${data?.wine || 0}`);
      this.pushData.wineStatus = `收酒成功：获得酒滴 ${data?.wine || 0}`;
      return true;
    } catch (e) {
      $.log(`账号[${this.index}] 收酒失败(ID:${id}): ${e.message || e}`);
      return false;
    }
  }

  async runWineAutomation() {
    // 只有当种子数量大于200时，才执行后续的酒坊逻辑
    const currentSorghum = Number(this.member.sorghum || 0);
    if (currentSorghum <= 200) {
      $.log(`\n账号[${this.index}] 种子数量不足 (${currentSorghum} <= 200)，暂不执行酒坊制曲/酿酒/收酒操作。`);
      return;
    }

    $.log(`\n账号[${this.index}] 开始酒坊酿造逻辑 (制酒/收酒/制曲循环)...`);
    let cache = this.getCached();
    let wineId = cache.current_wine_id;
    let cropTime = cache.wine_crop_time;

    if (!wineId) {
      const activeRecord = await this.getActiveWineRecord();
      if (activeRecord && activeRecord.id) {
        wineId = activeRecord.id;
        cropTime = activeRecord.crop_time;
        $.log(`账号[${this.index}] 🔄 成功从服务器同步到进行中的酿造: ID ${wineId}, 预计收取 ${cropTime}`);
        this.pushData.wineStatus = `酿酒进行中：预计${cropTime}收取`;
        this.saveCache({ current_wine_id: wineId, wine_crop_time: cropTime });
      }
    }

    if (wineId && cropTime) {
      const now = new Date().getTime();
      const targetTime = new Date(cropTime.replace(/-/g, "/")).getTime(); 

      if (now >= targetTime) {
        $.log(`账号[${this.index}] 酒已酿熟，开始收酒 (ID: ${wineId})`);
        const success = await this.harvestWine(wineId);
        
        if (success) {
          this.saveCache({ current_wine_id: null, wine_crop_time: null });
          let count = (cache.harvestWineCount || 0) + 1;
          $.log(`账号[${this.index}] 当前已累计收酒次数: ${count}/9`);
          
          if (count >= 9) {
            $.log(`账号[${this.index}] 收酒次数已达 9 次，触发【制曲】操作!`);
            await this.makeYeast();
            count = 0; 
          }
          this.saveCache({ harvestWineCount: count });
          
          await $.wait(3000, 5000);
          await this.makeWine();
        }
      } else {
        $.log(`账号[${this.index}] 酿酒进行中，未到收取时间: ${cropTime}`);
        this.pushData.wineStatus = `酿酒进行中：预计${cropTime}收取`;
      }
    } else {
      $.log(`账号[${this.index}] 当前酒坊空闲，开始新的制酒`);
      await this.makeWine();
    }
  }

  async queryFarm() {
    const data = await this.gardenGet("/garden/sorghum/index");
    const lands = listify(data);
    const summary = lands
      .map((v) => `#${v.serial_number ?? v.id ?? "?"}:${v.status ?? "?"}`)
      .join(" ");
    $.log(`账号[${this.index}] 地块: ${lands.length || 0}块 ${summary}`.trim());
    this.pushData.landSummary = `地块${lands.length || 0}块 ${summary}`.trim();
    return lands;
  }

  landPayload(land) {
    const id = pickId(land);
    return { id, sorghum_id: id, member_sorghum_id: id, land_id: id };
  }

  async harvestFarm(lands) {
    const candidates = lands.filter(isHarvestable);
    if (!candidates.length) return false;

    let acted = false;
    try {
      const data = await this.encryptedGet("/garden/Sorghum/harvestAll");
      $.log(`账号[${this.index}] 一键收获成功: ${shortJson(data || "ok")}`);
      return true;
    } catch (e) {
      $.log(`账号[${this.index}] 一键收获失败，尝试单块收获: ${e.message || e}`);
    }

    for (const land of candidates) {
      try {
        const data = await this.encryptedPost("/garden/sorghum/harvest", this.landPayload(land));
        $.log(`账号[${this.index}] 收获成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 收获失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(20000, 25000);
    }
    return acted;
  }

  async seedFarm(lands) {
    const seedCount = Number(this.member.sorghum || 0);
    if (seedCount <= 0) {
      $.log(`账号[${this.index}] 无可用种子，跳过种植`);
      return false;
    }
    const candidates = lands.filter(isPlantable);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可种植地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(seedCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/seed", this.landPayload(land));
        $.log(`账号[${this.index}] 种植成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 种植失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(20000, 25000);
    }
    return acted;
  }

  async waterFarm(lands) {
    const waterCount = Number(this.member.water || 0);
    if (waterCount <= 0) {
      $.log(`账号[${this.index}] 无可用水滴，跳过浇水`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可浇水地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(waterCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/watering", this.landPayload(land));
        $.log(`账号[${this.index}] 浇水成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 浇水失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(20000, 25000);
    }
    return acted;
  }

  async manureFarm(lands) {
    const manureCount = Number(this.member.manure || 0);
    if (manureCount <= 0) {
      $.log(`账号[${this.index}] 无可用有机肥，跳过施肥/养护`);
      return false;
    }
    const candidates = lands.filter(isGrowing);
    if (!candidates.length) {
      $.log(`账号[${this.index}] 未识别到可施肥/养护地块`);
      return false;
    }
    let acted = false;
    const limit = Math.min(manureCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const land = candidates[i];
      try {
        const data = await this.encryptedPost("/garden/sorghum/manuring", this.landPayload(land));
        $.log(`账号[${this.index}] 施肥/养护成功: 地块${landNo(land)} ${shortJson(data || "ok")}`);
        acted = true;
      } catch (e) {
        $.log(`账号[${this.index}] 施肥/养护失败[${landNo(land)}]: ${e.message || e}`);
      }
      await $.wait(20000, 25000);
    }
    return acted;
  }

  async runFarmAutomation() {
    let cropType = [{"1":"高粱"},{"2":"小麦"}];
    
    // 读取青龙环境变量控制地块数量
    let landLimitStr = process.env['地块'];
    let landLimit = parseInt(landLimitStr);
    if (isNaN(landLimit) || landLimit <= 0) {
      landLimit = 4; // 默认只操作前4块地
    }

    $.log(`\n账号[${this.index}] 开始农场植物状态逻辑 (计划操作前 ${landLimit} 块地)`);
    await this.queryMember();
    let lands = await this.queryFarm();
    
    if (!lands || lands.length === 0) {
      $.log(`账号[${this.index}] 未查询到任何土地`);
      return true;
    }

    // 根据环境变量截取需要操作的地块
    let targetLands = lands.slice(0, landLimit);

    for (let i = 0; i < targetLands.length; i++) {
      let land = targetLands[i];
      let landId = pickId(land);

      $.log(`\n--- 开始处理第 ${i + 1} 块地 (ID: ${landId}) ---`);

      if (land.status == -1) {
        $.log(`账号[${this.index}] 第${i + 1}块地(${landId})：未解锁`);
        $.log(`账号[${this.index}] 开始解锁第${i + 1}块土地`);
        try {
          await this.encryptedPost(`/garden/sorghum/extend`, { serial_number: land.serial_number ?? land.id });
          $.log(`账号[${this.index}] 解锁成功`);
          lands = await this.queryFarm();
          land = lands.find(l => pickId(l) == landId) || lands[i];
        } catch (e) {
          $.log(`账号[${this.index}] 解锁失败: ${e.message || e}`);
          continue; 
        }
      }

      if (land.status != -1) {
        $.log(`账号[${this.index}] 第${i + 1}块地(${landId})：已解锁`);
        let typeStr = land.type !== undefined ? String(land.type) : "1";
        let nameObj = cropType.find(item => typeStr in item);
        let name = nameObj ? nameObj[typeStr] : "未知作物";

        $.log(`账号[${this.index}] 种植状态：${name}*${land.volumn || 0} 收获时间：${land.crop_time || '未知'}`);

        const plantCropWithRotation = async () => {
          let cache = this.getCached();
          let sorghumCount = cache.sorghumPlantCount || 0;
          
          let nextType = sorghumCount < 20 ? 1 : 2; 
          let nextName = nextType === 1 ? "高粱" : "小麦";

          $.log(`账号[${this.index}] 准备种植: ${nextName} (当前记录已连种高粱 ${sorghumCount} 次)`);

          try {
            await this.encryptedPost(`/garden/sorghum/seed`, { id: landId, type: nextType });
            $.log(`账号[${this.index}] 种植 ${nextName} 成功`);
            this.addFarmLog(`🌱 种植成功：地块${i + 1} ${nextName}`);
            
            if (nextType === 1) {
              this.saveCache({ sorghumPlantCount: sorghumCount + 1 });
            } else {
              this.saveCache({ sorghumPlantCount: 0 });
            }
          } catch (e) { 
            $.log(`账号[${this.index}] 种植失败: ${e.message || e}`); 
          }
        };

        const harvestAndPlant = async () => {
          $.log(`账号[${this.index}] ${name}已成熟，开始收获`);
          try {
            await this.encryptedPost(`/garden/sorghum/harvest`, { id: landId, sorghum_id: landId, member_sorghum_id: landId, land_id: landId });
            $.log(`账号[${this.index}] 收获成功`);
            this.addFarmLog(`🌾 收获成功：地块${i + 1} ${name}`);
            $.log(`账号[${this.index}] 开始种植新一轮作物`);
            await this.queryMember();
            await plantCropWithRotation();
          } catch (e) { 
            $.log(`账号[${this.index}] 收获/种植失败: ${e.message || e}`); 
          }
        };

        if (land.status == 0) {
          $.log(`账号[${this.index}] 第${i + 1}块地已清空，开始播种`);
          await plantCropWithRotation();
        } else if (land.status == 2) {
          await harvestAndPlant();
        } else {
          let code = 0, retry = 0;
          let isMature = false; 

          while (code == 0 && retry < 3) {
            await this.queryMember(); 
            if (Number(this.member.water || 0) <= 0) {
              $.log(`账号[${this.index}] 水滴不足，跳过浇水`);
              break;
            }
            try {
              await this.encryptedPost(`/garden/sorghum/watering`, { id: landId, sorghum_id: landId, member_sorghum_id: landId, land_id: landId });
              $.log(`账号[${this.index}] 浇水成功`);
              retry++;
              await $.wait(2000, 3000);
            } catch (e) {
              let errorMsg = String(e.message || e);
              $.log(`账号[${this.index}] 浇水结束: ${errorMsg}`);
              code = 1;
              if (errorMsg.includes("仅允许为成长中的高粱浇水") || errorMsg.includes("成熟")) {
                isMature = true;
              }
            }
          }

          if (isMature) {
             $.log(`账号[${this.index}] 识别到植物已成熟，立刻进行收获与种植操作！`);
             await harvestAndPlant();
             continue; 
          }

          code = 0; retry = 0;
          while (code == 0 && retry < 3) {
            await this.queryMember(); 
            if (Number(this.member.manure || 0) <= 0) {
              $.log(`账号[${this.index}] 有机肥不足，跳过施肥`);
              break;
            }
            try {
              await this.encryptedPost(`/garden/sorghum/manuring`, { id: landId, sorghum_id: landId, member_sorghum_id: landId, land_id: landId });
              $.log(`账号[${this.index}] 施肥成功`);
              retry++;
              await $.wait(2000, 3000);
            } catch (e) {
              let errorMsg = String(e.message || e);
              $.log(`账号[${this.index}] 施肥结束: ${errorMsg}`);
              code = 1;
              if (errorMsg.includes("成熟")) {
                isMature = true;
              }
            }
          }
          
          if (isMature) {
             $.log(`账号[${this.index}] 识别到植物已成熟，立刻进行收获与种植操作！`);
             await harvestAndPlant();
          }
        }
      }
    }
    return true;
  }

  async queryTasks() {
    const data = await this.gardenGet("/garden/tasks/index");
    const tasks = listify(data);
    if (!tasks.length) {
      $.log(`账号[${this.index}] 未查询到任务列表`);
      return [];
    }
    $.log(
      `账号[${this.index}] 任务: ${tasks
        .map((t) => `${t.name || t.code || t.id}:${isCompleted(t) ? "已完成" : "未完成"}`)
        .join("，")}`
    );
    return tasks;
  }

  async doShareTask() {
    for (let i = 1; i <= 3; i++) {
      try {
        const data = await this.encryptedPost("/garden/gardenmemberinfo/dailyShare");
        $.log(`账号[${this.index}] 分享任务 第 ${i}/3 次完成: ${shortJson(data || "ok")}`);
      } catch (e) {
        $.log(`账号[${this.index}] 分享任务 第 ${i}/3 次失败: ${e.message || e}`);
      }
      
      if (i < 3) {
        const delayMs = Math.floor(Math.random() * (15000 - 5000 + 1) + 5000);
        $.log(`账号[${this.index}] 分享任务间隔，随机等待 ${delayMs / 1000} 秒...`);
        await $.wait(delayMs, delayMs);
      }
    }
  }

  async doQuestionTask() {
    try {
      const questions = listify(await this.gardenGet("/garden/Gardenquestiontask/index"));
      if (!questions.length) {
        $.log(`账号[${this.index}] 每日一答无题目`);
        return;
      }
      for (const q of questions) {
        const id = q.id;
        const answer = q.answer;
        if (!id || !answer) continue;
        const data = await this.encryptedGet("/garden/Gardenquestiontask/answerResultsJph", {
          itemid: id,       
          selected: answer, 
        });
        $.log(`账号[${this.index}] 每日一答完成: ${q.title ? shortJson(q.title, 45) : id} => ${shortJson(data || "ok")}`);
        await $.wait(20000, 25000);
      }
    } catch (e) {
      $.log(`账号[${this.index}] 每日一答失败: ${e.message || e}`);
    }
  }

  async doRealityTask() {
    try {
      const data = await this.gardenGet("/garden/realscene/reward");
      $.log(`账号[${this.index}] 实景相册任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 实景相册任务失败: ${e.message || e}`);
    }
  }

  async doCompleteInfoTask() {
    try {
      const data = await this.gardenGet("/garden/tasks/checkCompleteMemberInfo");
      $.log(`账号[${this.index}] 完善信息任务: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 完善信息任务失败: ${e.message || e}`);
    }
  }

  async doSubscribePrize() {
    try {
      const data = await this.gardenGet("/garden/tasks/getSubscribePrize");
      $.log(`账号[${this.index}] 订阅奖励: ${shortJson(data || "ok")}`);
    } catch (e) {
      $.log(`账号[${this.index}] 订阅奖励失败: ${e.message || e}`);
    }
  }

  async doTasks(tasks) {
    const pending = tasks.filter((task) => !isCompleted(task));
    if (!pending.length) {
      $.log(`账号[${this.index}] 暂无未完成任务`);
      return; 
    }
    for (const task of pending) {
      const code = task.code || "";
      if (code === "answer_survey") await this.doQuestionTask();
      else if (code === "garden_share") await this.doShareTask();
      else if (code === "view_organic_sorghum") await this.doRealityTask();
      else if (code === "complete_member_info") await this.doCompleteInfoTask();
      else if (/subscribe/i.test(code)) await this.doSubscribePrize();
      else $.log(`账号[${this.index}] 未适配任务: ${task.name || code || task.id}`);
      await $.wait(20000, 25000);
    }
  }

  async run() {
    $.log(`\n账号[${this.index}] ${mask(this.openid || this.cacheKey)}`);
    
    this.removeToken();

    await this.ensureLogin(); 
    await this.queryMember();
    _setName(this.index, this.pushData.nickName || this.openid);
    // 注意：会员积分(总积分)改由签到脚本(君品荟签到/jph_runner.py)推送，本花园脚本只展示种植/收获等花园流程

    const todayDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
    const cacheData = this.getCached();

    // 签到(含滑块)已由 jph_runner.py(君品荟签到)负责，本脚本专注花园/农场，默认关闭签到
    // 如需恢复本脚本签到，设置环境变量 JPH_ENABLE_SIGN=true
    const enableSign = process.env.JPH_ENABLE_SIGN === "true";
    if (!enableSign) {
      $.log(`账号[${this.index}] 签到功能已关闭（签到由君品荟签到脚本负责），跳过滑块与签到`);
    } else if (FORCE_SLIDE || cacheData.lastSignDate !== todayDate) {
      const randomDelay = Math.floor(Math.random() * 5000) + 10000;
      $.log(`账号[${this.index}] 登录校验完成，等待 ${randomDelay / 1000}s 后执行滑块验证`);
      await $.wait(randomDelay, randomDelay);

      // 调用重构后的强制滑块方法，重新完整跑一次滑块任务
      await this.reVerifyCaptcha();
      await $.wait(2000, 5000);

      await this.dailySign();
      this.saveCache({ lastSignDate: todayDate });

      await $.wait(20000, 25000);
    } else {
      $.log(`账号[${this.index}] 今日已完成滑块签到，跳过滑块流程（设置 FORCE_SLIDE_VERIFY=true 可强制重跑滑块）`);
    }

    const tasks = await this.queryTasks();
    await this.doTasks(tasks);

    await this.runWineAutomation();

    await this.runFarmAutomation();

    await this.queryMember();
    await this.queryFarm();
    this.flushGardenPush();
  }

  // 将种植/收获日志与酒谷状态整理进推送的「任务」列表，替代原本的积分展示
  flushGardenPush() {
    const r = _rpGet(this.index);
    // 种植/收获流程（farmLogs 已是完整中文描述，直接作为任务项，避免 "名称: 状态" 冗余）
    for (const log of (this.pushData.farmLogs || [])) {
      if (log) r.tasks.push(String(log));
    }
    // 酒谷(酿酒/收酒)状态
    if (this.pushData.wineStatus) {
      r.tasks.push("🍷 " + String(this.pushData.wineStatus));
    }
    // 花园状态(水滴/种子/酒滴): 每轮都展示, 不再只在「本轮无动作」时才补
    // 用户要求：像以前没收获时的那版推送一样，固定把种子等全局数据带上
    // 2026-09-15 用户要求去掉「地块N块 #1:10 #2:-1 …」，故不再拼 landSummary
    {
      const p = this.pushData;
      const parts = [];
      if (p.water != null && p.water !== "") parts.push(`水滴${p.water}`);
      if (p.sorghum != null && p.sorghum !== "") parts.push(`种子${p.sorghum}`);
      if (p.wine != null && p.wine !== "") parts.push(`酒滴${p.wine}`);
      r.tasks.push("🌿 花园状态：" + (parts.length ? parts.join(" ｜ ") : "暂无更新"));
    }
  }
}

!(async () => {
  $.checkEnv(ckName);
  if (!$.userCount) return;
  for (const account of $.userList) {
    try {
      await new Task(account).run();
    } catch (e) {
      $.log(`账号执行失败: ${e.message || e}`);
    }
  }
  // 全部账号跑完后，由 beforeExit 钩子经 std_report 双引擎统一推送
  await flushLogPoints(_rpApp);
})()
  .catch((e) => $.log(`脚本异常: ${e.message || e}`))
  .finally(() => $.done && $.done());