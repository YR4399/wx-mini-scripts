
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
let _rpApp = '日清';
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
@Description: 日清食品小程序签到
cron: 28 8 * * *
------------------------------------------
变量名：nissin
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("日清食品签到");
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

const MINI_APP_ID = "wx21b71db59d93bd6d";
const API_BASE = "https://foodhall-prod-api.nissinfoodium.com.cn/miniapp";

// ---------- 本地累计积分（接口无总积分字段，本机向前累计每日签到获得积分）----------
const POINTS_CACHE_FILE = path.join(__dirname, "nissin_points_cache.json");
function readPoints() {
    try { if (!fs.existsSync(POINTS_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(POINTS_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writePoints(c) {
    try { fs.writeFileSync(POINTS_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入积分缓存失败: ${e.message || e}`); }
}
function nissinToday() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function rollDay(openid, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: nissinToday() });
    if (rec.date !== nissinToday()) { rec.hist = (Number(rec.hist) || 0) + (Number(rec.gain) || 0); rec.gain = 0; rec.date = nissinToday(); }
    return rec;
}
function addGain(openid, point, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: nissinToday() });
    rec.gain = (Number(rec.gain) || 0) + (Number(point) || 0);
    rec.date = nissinToday();
}
function curTotal(openid, cache) { const rec = cache[openid] || { hist: 0, gain: 0 }; return (Number(rec.hist) || 0) + (Number(rec.gain) || 0); }
const PAGE_VERSION = "74";
const TOKEN_CACHE_FILE = path.join(__dirname, "nissin_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "nissin";

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

function isTokenError(e) {
    const message = String(e?.message || e || "");
    return e?.code === 401 || e?.code === 900001 || /401|900001|token|登录|授权|Auth-Status|invalid/i.test(message);
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        const _p = String(openid || "").trim().split("#");
        this.openid = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = "";
        this.redOpenId = "";
        this.userId = "";
        this.user = {};
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

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getUser();
        await this.getSignInInfo();
        await this.doSign();
        await this.enterGame();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            accessToken: this.token,
            redOpenId: this.redOpenId,
            userId: this.userId,
            mobile: this.user.mobile || "",
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
        this.token = "";
        this.redOpenId = "";
        this.userId = "";
    }

    applyToken(data = {}) {
        this.token = data.accessToken || data.access_token || "";
        this.redOpenId = data.redOpenId || data.openId || data.open_id || "";
        this.userId = data.userId || data.user_id || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        return headers;
    }

    async request({ method = "GET", apiPath, data, params, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (params) options.params = params;
        if (data !== undefined) options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result, headers } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (headers && headers["auth-status"] === "false") {
            const err = new Error("Auth-Status=false");
            err.code = 900001;
            throw err;
        }
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
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
            const openData = await this.request({
                method: "POST",
                apiPath: "/auth/getOpenId",
                skipToken: true,
                data: {
                    code,
                    invitorMemberId: 0,
                },
            });
            this.redOpenId = openData.openId || "";
            if (!this.redOpenId) throw new Error(`auth/getOpenId 未返回 openId: ${JSON.stringify(openData)}`);

            const loginData = await this.request({
                method: "POST",
                apiPath: "/auth/login",
                skipToken: true,
                data: {
                    openId: this.redOpenId,
                },
            });
            this.applyToken({
                ...loginData,
                redOpenId: this.redOpenId,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: userId=${this.userId || "未知"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignInInfo(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        try {
            const data = await this.request({ apiPath: "/auth/user/current" });
            this.user = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 用户: ${data?.nickname || data?.name || ""} ${maskPhone(data?.mobile) || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询用户失败: ${e.message || e}`);
            if (isTokenError(e)) this.removeCachedToken();
        }
    }

    async getSignInInfo(silent = false) {
        const data = await this.request({ apiPath: "/sign-in/statistics" });
        this.signInfo = data || {};
        if (!silent) {
            $.log(`账号[${this.index}] 签到状态: ${data?.hasSignedToday ? "已签" : "未签"} 连续${data?.continuousDays || 0}天 总${data?.totalDays || 0}天 今日${data?.todayPoints ?? "未知"}积分`);
        }
        // 该接口仅返回连续/累计天数与今日积分，无积分余额字段；连签取 continuousDays
        const _rp = _rpGet(this.index);
        if (data?.continuousDays != null && data.continuousDays !== "" && !isNaN(Number(data.continuousDays))) _rp.streak = String(data.continuousDays);
        return data;
    }

    async doSign() {
        if (this.signInfo?.hasSignedToday) {
            $.log(`账号[${this.index}] 今日已签到`);
            _setSign(this.index, "今日已签到");
            const _pc0 = readPoints(); rollDay(this.openid, _pc0);
            const _r0 = _rpGet(this.index); _r0.total = String(curTotal(this.openid, _pc0)); _r0.totalLabel = "累计积分";
            writePoints(_pc0);
            return;
        }
        try {
            const data = await this.request({
                method: "POST",
                apiPath: "/sign-in",
                data: {},
            });
            $.log(`账号[${this.index}] 签到成功: +${data ?? "未知"}积分`);
            const _pc = readPoints(); rollDay(this.openid, _pc);
            if (data != null && data !== "" && !isNaN(Number(data))) addGain(this.openid, data, _pc);
            writePoints(_pc);
            const _rp = _rpGet(this.index);
            _setSign(this.index, "签到成功");
            _rp.total = String(curTotal(this.openid, _pc)); _rp.totalLabel = "累计积分";
            if (data != null && data !== "" && !isNaN(Number(data))) _rp.earned = "今日+" + data + "积分";
            else { const ep = extractPoints(data); if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "积分"; }
            _setLottery(this.index, _digLottery(data));
            await this.getSignInInfo(true);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败: " + message.slice(0, 40));
            if (isTokenError(e)) this.removeCachedToken();
        }
    }

    async getTaskList() {
        try {
            const data = await this.request({ apiPath: "/taskCenter/getEffectiveTask" });
            return Array.isArray(data) ? data : [];
        } catch (e) {
            $.log(`账号[${this.index}] 查询任务列表失败: ${e.message || e}`);
            if (isTokenError(e)) this.removeCachedToken();
            return [];
        }
    }

    async enterGame() {
        try {
            const beforeTasks = await this.getTaskList();
            const gameTask = beforeTasks.find((item) => item?.ruleType === "PLAY_GAME");
            if (gameTask) {
                $.log(`账号[${this.index}] 玩游戏任务: ${gameTask.complete ? "已完成" : "未完成"}`);
            }

            const gameConfig = await this.request({ apiPath: "/game/config" });
            await this.request({
                method: "POST",
                apiPath: "/game/login",
                data: {
                    loginIp: "",
                    loginLocation: "",
                },
            });
            const playCount = await this.request({ apiPath: "/game/count" });
            const gameUrl = `https://foodhall-prod.nissinfoodium.com.cn/game/index.html?version=${Date.now()}&token=${encodeURIComponent(this.token)}&user_id=${encodeURIComponent(this.userId || this.user.id || "")}&webViewHeight=800`;
            const page = await axios.get(gameUrl, {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
                },
                timeout: 15000,
                validateStatus: () => true,
            });
            if (page.status >= 200 && page.status < 400) {
                $.log(`账号[${this.index}] 已进入游戏: ${gameConfig?.shareTitle || "日清消消乐"} 剩余次数=${playCount ?? "未知"}`);
            } else {
                $.log(`账号[${this.index}] 进入游戏页面异常: HTTP ${page.status}`);
            }

            const afterTasks = await this.getTaskList();
            const updatedGameTask = afterTasks.find((item) => item?.ruleType === "PLAY_GAME");
            if (updatedGameTask) {
                $.log(`账号[${this.index}] 玩游戏任务更新: ${updatedGameTask.complete ? "已完成" : "未完成"}`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 进入游戏失败: ${e.message || e}`);
            if (isTokenError(e)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
