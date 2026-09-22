/*
@Description: 小王姐妹福利社 签到 (星云有客/iyouke 平台)
cron: 20 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("小王姐妹福利社");
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

const MINI_APP_ID = "wx42ed09ac1b1d3566";
const API_BASE = "https://smp-api.iyouke.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "xwjmfls_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36 XWEB/1160117";
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || process.env.wx_auth || "",
});

// ---------- token 缓存 ----------
function loadCache() {
    try { return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")); } catch (_) { return {}; }
}
function saveCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2)); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
function log(msg) { $.log(msg); logLines.push(msg); }
function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

class Task {
    constructor(openid, index) {
        this.openid = openid;
        this.index = index;
        this.token = "";
        this.nick = "";
    }

    headers() {
        const h = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "appid": MINI_APP_ID,
            "xweb_xhr": "1",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/page-frame.html`,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        };
        if (this.token) h["authorization"] = "bearer" + this.token; // 注意: bearer 与 token 无空格
        return h;
    }

    async req(method, url, data) {
        const resp = await axios({
            method, url: API_BASE + url, data,
            headers: this.headers(), timeout: 20000, validateStatus: () => true,
        });
        return resp;
    }

    // 从 WCS 拿 wx.login code
    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.data?.code || data?.code;
        if (!code) throw new Error(`WCS 未返回 code: ${JSON.stringify(data).slice(0, 120)}`);
        return code;
    }

    // code 换业务 token
    async loginByWxCode() {
        const code = await this.getLoginCode();
        const resp = await this.req("POST", "/dtapi/appLogin", { principal: code, appType: 1 });
        const d = resp.data || {};
        if (!d.access_token) throw new Error(`登录失败: ${JSON.stringify(d).slice(0, 150)}`);
        this.token = d.access_token;
        // 缓存
        const c = loadCache();
        c[this.openid] = { token: this.token, ts: Date.now() };
        saveCache(c);
        return true;
    }

    // 校验 token 是否有效
    async checkToken() {
        const resp = await this.req("GET", "/dtapi/p/user/userInfo");
        if (resp.status === 200 && resp.data && resp.data.userId) {
            this.nick = resp.data.nickName || "";
            return true;
        }
        return false;
    }

    async ensureLogin() {
        const c = loadCache();
        if (c[this.openid]?.token) {
            this.token = c[this.openid].token;
            if (await this.checkToken()) { log(`账号[${this.index}] 复用缓存 token${this.nick ? " (" + this.nick + ")" : ""}`); return; }
            log(`账号[${this.index}] 缓存 token 失效，重新登录`);
            this.token = "";
        }
        await this.loginByWxCode();
        await this.checkToken();
        log(`账号[${this.index}] 登录成功${this.nick ? " (" + this.nick + ")" : ""}`);
    }

    async getPoints() {
        const resp = await this.req("GET", "/dtapi/points/user/centerInfo");
        return resp.data?.data?.pointsBalance;
    }

    async sign() {
        // 先查签到状态
        let signed = false;
        try {
            const st = await this.req("GET", "/dtapi/pointsSign/user/sign/list?v4Flag=true");
            const list = st.data?.data || [];
            const today = list.find((x) => x.isToday);
            if (today && today.daySignStatus === 1) signed = true;
        } catch (_) {}

        if (signed) { log(`账号[${this.index}] 今日已签到`); _setSign(this.index, "今日已签到"); return; }

        const resp = await this.req("GET", `/dtapi/pointsSign/user/sign?date=${encodeURIComponent(todayStr())}`);
        const d = resp.data || {};
        if (d.error === 0 && d.data) {
            const r = d.data.signReward ?? 0;
            const ex = d.data.extraSignReward ?? 0;
            const got = Number(r) + Number(ex);
            log(`账号[${this.index}] 签到成功: +${r}积分${ex ? " (额外+" + ex + ")" : ""}`);
            _setSign(this.index, "签到成功", got > 0 ? "今日+" + got + "积分" : "", "");
        } else if (/已签|已经签到|repeat|signed/i.test(JSON.stringify(d))) {
            log(`账号[${this.index}] 今日已签到`);
            _setSign(this.index, "今日已签到");
        } else {
            log(`账号[${this.index}] 签到返回: ${JSON.stringify(d).slice(0, 150)}`);
            _setSign(this.index, "签到失败");
        }
    }

    async run() {
        try {
            _setName(this.index, this.nick || ("账号" + this.index));
            await this.ensureLogin();
            if (this.nick) _setName(this.index, this.nick);
            await this.sign();
            const p = await this.getPoints();
            if (p !== undefined) {
                log(`账号[${this.index}] 当前积分: ${p}`);
                _rpGet(this.index).total = String(p);
            }
        } catch (e) {
            log(`账号[${this.index}] 执行失败: ${e.message}`);
            _setSign(this.index, "执行失败");
        }
    }
}

// ========== 推送：经 std_report 双引擎（钉钉 markdown）统一推送，无需额外配置 ==========

const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '小王姐妹福利社';
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

(async () => {
    const raw = process.env[ckName] || "";
    const openids = raw.split(/[&\n]/).map((s) => s.trim()).filter(Boolean);
    if (!openids.length) { $.log(`未配置 ${ckName} 环境变量`); return; }
    $.log(`共 ${openids.length} 个账号`);
    for (let i = 0; i < openids.length; i++) {
        await new Task(openids[i], i + 1).run();
        if (i < openids.length - 1) await sleep(3000 + Math.random() * 5000);
    }
    await flushLogPoints(_rpApp);
})();
