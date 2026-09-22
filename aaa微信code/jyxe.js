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
@Description: 旧衣小二签到
cron: 33 8 * * *
------------------------------------------
变量名：jyxe
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("旧衣小二签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

// ---------- 本地累计环保币（接口无总环保币字段，本机向前累计每日签到获得值）----------
const POINTS_CACHE_FILE = path.join(__dirname, "jyxe_points_cache.json");
function readPoints() {
    try { if (!fs.existsSync(POINTS_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(POINTS_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writePoints(c) {
    try { fs.writeFileSync(POINTS_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入积分缓存失败: ${e.message || e}`); }
}
function jyxeToday() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function rollDay(openid, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: jyxeToday() });
    if (rec.date !== jyxeToday()) { rec.hist = (Number(rec.hist) || 0) + (Number(rec.gain) || 0); rec.gain = 0; rec.date = jyxeToday(); }
    return rec;
}
function addGain(openid, point, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: jyxeToday() });
    rec.gain = (Number(rec.gain) || 0) + (Number(point) || 0);
    rec.date = jyxeToday();
}
function curTotal(openid, cache) { const rec = cache[openid] || { hist: 0, gain: 0 }; return (Number(rec.hist) || 0) + (Number(rec.gain) || 0); }

const MINI_APP_ID = "wx426d52c8130b8559";
const PAGE_VERSION = "5";
const API_BASE = "https://jiuyixiaoer.fzjingzhou.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "jyxe_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";
const GUEST_TOKEN = "wek2020123456788wek";

let ckName = "jyxe";

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

function formBody(data = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) params.append(key, String(value));
    }
    return params;
}

function isTokenError(message) {
    return /token|登录|验证失败|9999|401|403|expire|过期|失效/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        // 变量值格式支持 "openid#备注"，必须剥离备注：带后缀的字符串拿去 wx_server 取 code 会找不到账号
        const raw = String(openid || "").trim();
        const parts = raw.split("#");
        this.openid = (parts[0] || raw).trim();
        this.remark = (parts[1] || "").trim();
        this.session = {};
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCachedToken();
        if (cached) {
            this.session = cached;
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.session.token) {
            await this.loginByWxCode();
            if (!this.session.token) return;
        }

        await this.doSign();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.session.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            token: this.session.token,
            userInfo: this.session.userInfo || {},
            newOrder: this.session.newOrder || null,
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
        this.session = {};
    }

    headers() {
        return {
            "content-type": "application/x-www-form-urlencoded",
            "platform": "MP-WEIXIN",
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
        };
    }

    async request(apiPath, data = {}, options = {}) {
        const token = options.noauth ? GUEST_TOKEN : (this.session.token || GUEST_TOKEN);
        const res = await axios.post(`${API_BASE}${apiPath}`, formBody({
            ...(data || {}),
            token,
        }), {
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (Number(res.data?.code) !== 1000) {
            const error = new Error(res.data?.msg || `接口错误: ${res.data?.code || "unknown"}`);
            error.data = res.data;
            throw error;
        }
        return res.data;
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
            const res = await this.request("/api/login/getWxMiniProgramSessionKey", {
                code,
                gdtVid: "",
            }, { noauth: true });
            const data = res.data || {};
            this.session = {
                token: data.token || res.token || "",
                userInfo: data.personInfo || {},
                newOrder: data.newOrder || null,
            };
            if (!this.session.token) throw new Error("登录未返回token");
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            const res = await this.request("/api/Person/index");
            if (res.data) {
                this.session.userInfo = res.data;
                const _ep = extractPoints(res) || {};
                if (_ep.total != null) _setSign(this.index, null, null, String(_ep.total));
                if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async doSign() {
        try {
            const res = await this.request("/api/Person/sign");
            const beans = res.data;
            $.log(`账号[${this.index}] 签到成功${beans !== undefined ? `，获得${beans}环保币` : ""}`);
            // 本地累计：只有真正签到成功才累加今日环保币
            const _pc = readPoints(); rollDay(this.openid, _pc);
            if (beans !== undefined && beans !== null && !isNaN(Number(beans))) addGain(this.openid, beans, _pc);
            writePoints(_pc);
            const _ep = extractPoints(res) || {};
            const _earned = (beans !== undefined && beans !== null && String(beans) !== "") ? `获得${beans}环保币` : null;
            const _total = String(curTotal(this.openid, _pc));
            const _streak = _ep.streak != null ? _ep.streak : null;
            _setSign(this.index, "签到成功", _earned, _total);
            _rpGet(this.index).totalLabel = "累计环保币";
            if (_streak != null) _rpGet(this.index).streak = String(_streak);
            _setLottery(this.index, _digLottery(res));
        } catch (e) {
            const message = e.message || e;
            if (/已签到|今日已|重复|已经签到/.test(String(message))) {
                $.log(`账号[${this.index}] 今日已签到`);
                const _pc2 = readPoints(); rollDay(this.openid, _pc2); writePoints(_pc2);
                _setSign(this.index, "今日已签", null, String(curTotal(this.openid, _pc2)));
                _rpGet(this.index).totalLabel = "累计环保币";
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
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
let _rpApp = '旧衣小二';
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
