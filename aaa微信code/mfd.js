// ========== 环境配置 ==========
process.env.http_proxy = "";
process.env.https_proxy = "";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.all_proxy = "";
process.env.ALL_PROXY = "";
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 麦富迪会员小程序签到
cron: 35 8 * * *
------------------------------------------
变量名：mfd
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行

依赖变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("麦富迪会员签到");
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
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx278a2ed79c5182f8";
const API_BASE = "https://cdp.myfoodiepet.com";
const APP_ID = "6259662812989361028";
const TENANT_ID = "00ae459e842642f78b9ab0d8e7c027b4";
const SIGN_SALT = "XpL9q#dK2zRf$tMn";
const TOKEN_CACHE_FILE = path.join(__dirname, "mfd_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "mfd";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function shortValue(value = "") {
    const text = String(value || "");
    return text ? `${text.slice(0, 4)}***${text.slice(-4)}` : "";
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex");
}

function memberSignature(memberId) {
    const timestamp = Date.now();
    return {
        memberId,
        timestamp,
        signature: md5(`${memberId}${timestamp}${SIGN_SALT}`),
    };
}

function isTokenError(error) {
    return /登录|授权|memberId|401|openid|code|token/i.test(String(error && (error.message || error)));
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        const _p = String(account || "").trim().split("#");
        this.account = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.openId = "";
        this.unionId = "";
        this.memberId = "";
        this.phone = "";
        this.groupId = "";
        this.agentId = "";
        this.memberInfo = {};
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存登录态: memberId=${shortValue(this.memberId)}`);
            if (!(await this.checkLogin())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存登录态失效，重新登录`);
            }
        }

        if (!this.memberId) {
            await this.loginByWxCode();
            if (!this.memberId) return;
        }

        await this.getMemberInfo();
        await this.getContinuousDays();
        await this.signIn();
        await this.getContinuousDays();
    }

    getCachedToken() {
        const cache = readTokenCache();
        const item = cache[this.account];
        if (!item || !item.memberId) return null;
        return item;
    }

    saveCachedToken() {
        if (!this.memberId) return;
        const cache = readTokenCache();
        cache[this.account] = {
            openId: this.openId,
            unionId: this.unionId,
            memberId: this.memberId,
            phone: this.phone,
            groupId: this.groupId,
            agentId: this.agentId,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeTokenCache(cache);
        }
        this.openId = "";
        this.unionId = "";
        this.memberId = "";
        this.phone = "";
        this.groupId = "";
        this.agentId = "";
    }

    applyToken(data = {}) {
        this.openId = data.openId || "";
        this.unionId = data.unionId || "";
        this.memberId = data.memberId || "";
        this.phone = data.phone || "";
        this.groupId = data.groupId || "";
        this.agentId = data.agentId || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/402/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            appId: APP_ID,
            tenantId: TENANT_ID,
            wxAppid: MINI_APP_ID,
            groupId: this.groupId || "",
            ...extra,
        };
        if (this.memberId) headers.userId = this.memberId;
        return headers;
    }

    async request({ method = "GET", apiPath, params = {}, data = {} }) {
        const upperMethod = method.toUpperCase();
        const options = {
            method: upperMethod,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (upperMethod === "GET") options.params = { ...params, _: Date.now() };
        else {
            options.params = { _: Date.now() };
            options.data = data;
        }

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || (String(result.code) !== "0" && Number(result.code) !== 2)) {
            throw new Error(result?.msg || result?.message || JSON.stringify(result));
        }
        return result;
    }

    async getLoginCode() {
        if (!process.env.wx_auth) throw new Error("缺少 wx_auth，无法从 wx_server 获取 code");
        const { data } = await wechat.getCode(this.account);
        const code = data && (data.code || (data.data && data.data.code));
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async getIdentityInfo() {
        try {
            const result = await this.request({
                apiPath: `/tnew/myfoodiepet-member/v1/member/identity/info/${MINI_APP_ID}`,
            });
            const data = result.data || {};
            this.groupId = data.groupId || this.groupId;
            this.agentId = data.agentId || this.agentId;
            this.saveCachedToken();
            return data;
        } catch (e) {
            $.log(`账号[${this.index}] 获取身份配置失败: ${e.message || e}`);
            return {};
        }
    }

    async loginByWxCode() {
        try {
            await this.getIdentityInfo();
            const code = await this.getLoginCode();
            const result = await this.request({
                apiPath: "/tnew/myfoodiepet-member/v1/wechat/applet/authorizeV2",
                params: { code },
            });
            const data = result.data || {};
            this.openId = data.openId || "";
            this.unionId = data.unionId || "";
            this.memberId = String(data.memberId || "");
            this.phone = data.phone || "";
            if (!this.memberId) throw new Error(`登录响应未返回 memberId: ${JSON.stringify(result)}`);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: memberId=${shortValue(this.memberId)} ${maskPhone(this.phone)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkLogin() {
        try {
            if (!this.groupId) await this.getIdentityInfo();
            await this.queryMemberById();
            return true;
        } catch (e) {
            return false;
        }
    }

    async queryMemberById() {
        const result = await this.request({
            method: "POST",
            apiPath: "/tnew/myfoodiepet-member/v1/member/queryByMemberId",
            data: memberSignature(this.memberId),
        });
        return result.data || {};
    }

    async getMemberInfo() {
        try {
            const data = await this.queryMemberById();
            this.memberInfo = data;
            const name = data.nickName || data.nickname || data.memberName || data.name || "未知";
            const phone = data.phone || data.mobile || this.phone;
            const point = data.totalPoint ?? data.availablePoint ?? data.point ?? data.points ?? data.integral ?? "未知";
            $.log(`账号[${this.index}] 会员: ${name} ${maskPhone(phone)} 积分=${point}`);
            const _rp = _rpGet(this.index);
            const _pt = data.totalPoint ?? data.availablePoint ?? data.point ?? data.points ?? data.integral;
            if (_pt != null && _pt !== "" && !isNaN(Number(_pt))) _rp.total = String(_pt);
        } catch (e) {
            $.log(`账号[${this.index}] 查询会员信息失败: ${e.message || e}`);
            if (isTokenError(e)) this.removeCachedToken();
        }
    }

    async getContinuousDays() {
        try {
            const result = await this.request({
                apiPath: `/tnew/myfoodiepet-member/v1/member/continuous-days/${this.memberId}`,
            });
            const data = result.data || {};
            this.signedToday = data.signedToday;
            $.log(`账号[${this.index}] 签到状态: 连续${data.continuousDays ?? 0}天 今日=${data.signedToday ? "已签" : "未签"}`);
            const _rp = _rpGet(this.index);
            if (data.continuousDays != null && data.continuousDays !== "" && !isNaN(Number(data.continuousDays))) _rp.streak = String(data.continuousDays);
            if (data.signedToday) _setSign(this.index, "今日已签到");
            return data;
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到状态失败: ${e.message || e}`);
            return {};
        }
    }

    async signIn() {
        try {
            if (this.signedToday) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }
            const result = await this.request({
                method: "POST",
                apiPath: "/tnew/myfoodiepet-member/v1/member/sign",
                data: { memberId: this.memberId },
            });
            $.log(`账号[${this.index}] 签到成功: ${result.msg || result.message || "ok"}`);
            const _rp = _rpGet(this.index);
            const ep = extractPoints(result);
            _setSign(this.index, "签到成功");
            if (ep.total != null) _rp.total = String(ep.total);
            if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "积分";
            _setLottery(this.index, _digLottery(result));
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复签到/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败: " + message.slice(0, 60));
            if (isTokenError(e)) this.removeCachedToken();
        }
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
function _digLottery(obj) {
  if (obj == null) return "";
  const flat = (function _f(o, pre, acc) {
    acc = acc || {};
    if (Array.isArray(o)) { o.forEach((v, i) => _f(v, pre ? pre + "." + i : "" + i, acc)); return acc; }
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const nv = o[k]; const nk = pre ? pre + "." + k : k;
        if (nv && typeof nv === "object") _f(nv, nk, acc); else acc[nk.toLowerCase()] = nv;
      }
      return acc;
    }
    if (pre) acc[pre] = obj; return acc;
  })(obj, "", {});
  const keys = Object.keys(flat);
  const hit = (re) => keys.filter(k => re.test(k));
  const lotteryKeys = hit(/lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift/);
  const out = [];
  for (const k of lotteryKeys) {
    let v = flat[k]; if (v == null) continue;
    if (typeof v === "object") v = JSON.stringify(v);
    const s = String(v); if (s && s !== "{}" && s !== "[]") out.push(s);
  }
  return out.join("｜");
}
let _rpRows = [];
let _rpApp = '麦富迪';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", tasks: [], lottery: "" };
  return _rpRows[idx];
}
function logPoints(todayPoints, totalPoints, app, idx, status) {
  _rpApp = app || _rpApp;
  const r = _rpGet(idx);
  if (status != null && status !== "") r.sign = String(status);
  if (totalPoints != null && totalPoints !== "" && !isNaN(Number(totalPoints))) r.total = String(totalPoints);
  if (todayPoints != null && todayPoints !== "" && !isNaN(Number(todayPoints)) && Number(todayPoints) !== 0) r.earned = "今日+" + todayPoints + "积分";
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null) r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
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


!(async () => {
    $.checkEnv(ckName);
    for (const account of $.userList) {
        await new Task(account).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
