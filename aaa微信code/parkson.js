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
@Description: parkson 呼啦圈小程序签到
cron: 35 8 * * *
------------------------------------------
变量名：parkson
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("呼啦圈小程序签到");
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
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx89a714fb03b61b99";
const APP_VERSION = "2.30.3";
const ENV_VERSION = "release";
const API_BASE = "https://smp-api.iyouke.com/dtapi";
const TOKEN_CACHE_FILE = path.join(__dirname, "parkson_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "parkson";

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

function formatDate(date = new Date(), separator = "-") {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return [y, m, d].join(separator);
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        const _p = String(raw || "").trim().split("#");
        this.openid = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.accessToken = "";
        this.authorization = "";
        this.userInfo = {};
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) return;
        }

        await this.getPointsInfo();
        await this.getSignList();
        await this.doSign();
        await this.getPointsInfo();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            accessToken: this.accessToken,
            authorization: this.authorization,
            userId: this.userInfo.userId || "",
            nickName: this.userInfo.nickName || "",
            userMobile: this.userInfo.userMobile || "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.openid]) {
            delete cache[this.openid];
            writeTokenCache(cache);
        }
        this.accessToken = "";
        this.authorization = "";
    }

    applyToken(data = {}) {
        this.accessToken = data.accessToken || data.access_token || "";
        this.authorization = data.authorization || (this.accessToken ? `bearer${this.accessToken}` : "");
        this.userInfo = data;
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/42/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            appId: MINI_APP_ID,
            version: APP_VERSION,
            envVersion: ENV_VERSION,
            "xy-extra-data": `appid=${MINI_APP_ID};version=${APP_VERSION};envVersion=${ENV_VERSION};`,
            ...extra,
        };
        if (this.authorization) headers.Authorization = this.authorization;
        return headers;
    }

    async request({ method = "POST", apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (result && typeof result === "object" && result.error !== undefined && result.error !== 0) {
            const err = new Error(result.errorMsg || result.msg || JSON.stringify(result));
            err.code = result.error;
            throw err;
        }
        return result?.data ?? result;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request({
                apiPath: "/appLogin",
                skipToken: true,
                data: {
                    appType: 1,
                    principal: code,
                },
            });
            this.applyToken(data);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: userId=${data.userId || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getUserInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUserInfo(log = true) {
        const data = await this.request({
            method: "GET",
            apiPath: "/p/user/userInfo",
        });
        this.userInfo = {
            ...this.userInfo,
            ...data,
        };
        this.saveCachedToken();
        if (log) $.log(`账号[${this.index}] 用户: ${data.nickName || ""} ${data.memberName || ""}`);
        return data;
    }

    async getPointsInfo() {
        try {
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/pointsInfo/query",
            });
            $.log(`账号[${this.index}] 积分: ${data?.pointsNums ?? "未知"} 连签=${data?.seriesDays ?? 0} 今日=${data?.signTodayResult ? "已签" : "未签"}`);
            if (data?.pointsNums != null && data.pointsNums !== "") _setSign(this.index, "", "", String(data.pointsNums));
            if (data?.seriesDays != null && data.seriesDays !== "") _rpGet(this.index).streak = String(data.seriesDays);
            return data;
        } catch (e) {
            $.log(`账号[${this.index}] 查询积分失败: ${e.message || e}`);
            if (/token|登录|授权|401/i.test(String(e.message || e))) this.removeCachedToken();
        }
    }

    async getSignList() {
        try {
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/sign/list",
                params: { v4Flag: true },
            });
            const today = formatDate();
            const todayItem = Array.isArray(data) ? data.find((item) => item?.isToday || item?.dateStr === today) : null;
            this.todayDate = todayItem?.dateStr || today;
            this.isTodaySign = Number(todayItem?.daySignStatus) === 2;
            $.log(`账号[${this.index}] 签到状态: ${this.todayDate} ${this.isTodaySign ? "已签" : "未签"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到状态失败: ${e.message || e}`);
            if (/token|登录|授权|401/i.test(String(e.message || e))) this.removeCachedToken();
        }
    }

    async doSign() {
        if (this.isTodaySign) {
            $.log(`账号[${this.index}] 今日已签到`);
            _setSign(this.index, "今日已签到", "", "");
            return;
        }
        try {
            const date = (this.todayDate || formatDate()).replace(/-/g, "/");
            const data = await this.request({
                method: "GET",
                apiPath: "/pointsSign/user/sign",
                params: { date },
            });
            const reward = data?.signReward;
            const earned = (reward !== undefined && reward !== null) ? `今日+${reward}积分` : "";
            $.log(`账号[${this.index}] 签到成功: +${reward ?? "未知"}积分`);
            _setSign(this.index, "签到成功", earned, "");
            _setLottery(this.index, _digLottery(data));
        } catch (e) {
            const message = String(e.message || e);
            if (/已签|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到", "", "");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败");
            if (/token|登录|授权|401/i.test(message)) this.removeCachedToken();
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
let _rpApp = '呼啦圈';
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
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
