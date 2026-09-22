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
@Description: 影视飓风小程序签到
cron: 28 8 * * *
------------------------------------------
变量名：yingshijufeng
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("影视飓风小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx92782ef90ebc836d";
const CLIENT_ID = "4d65249d377b2c3ed8";
const CLIENT_SECRET = "1cdc05151d64f3a4a6ebd0e9de64422a";
const GRANT_TYPE = "yz_union";
const CLIENT_BIZ = "weapp_wsc";
const KDT_ID = "149536603";
const USER_VERSION = "2.226.7.101";
const PAGE_VERSION = "17";
const API_BASE = "https://h5.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "yingshijufeng_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "yingshijufeng";

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

function pickToken(data = {}) {
    return data.accessToken || data.access_token || "";
}

function isTokenError(message) {
    return /access_token|token|登录|授权|invalid session|session/i.test(String(message || ""));
}

class Task {
    constructor(openid, index) {
        this.index = index || $.userIdx++;
        const _p = String(openid || "").split("#");
        this.openid = _p[0].trim();
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = "";
        this.sessionId = "";
        this.cookie = "";
        this.kdtId = KDT_ID;
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

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.showCheckinPage();
        await this.doCheckin();
        await this.getPoints();
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
            sessionId: this.sessionId,
            kdtId: this.kdtId,
            cookie: this.cookie,
            mobile: this.userInfo.mobile || "",
            nickName: this.userInfo.nick_name || this.userInfo.nickName || "",
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
        this.sessionId = "";
        this.cookie = "";
    }

    applyToken(data = {}) {
        this.token = pickToken(data);
        this.sessionId = data.sessionId || data.session_id || "";
        this.kdtId = String(data.kdtId || data.kdt_id || KDT_ID);
        this.cookie = data.cookie || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "*/*",
            "Extra-Data": JSON.stringify({
                sid: this.sessionId || "",
                version: USER_VERSION,
                clientType: "weapp-miniprogram",
                client: "weapp",
                bizEnv: "wsc",
            }),
            ...extra,
        };
        if (this.cookie) headers.Cookie = this.cookie;
        return headers;
    }

    getBaseParams(params = {}) {
        return {
            app_id: MINI_APP_ID,
            kdt_id: this.kdtId,
            access_token: this.token,
            ...params,
        };
    }

    async request({ method = "GET", path: apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        options.params = skipToken ? params : this.getBaseParams(params);
        if (method !== "GET") options.data = data;

        const { data: result, status, headers } = await axios.request(options);
        if (headers["set-cookie"]) {
            this.cookie = headers["set-cookie"].map((item) => item.split(";")[0]).join("; ");
        }
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || result.code !== 0) throw new Error(result?.msg || JSON.stringify(result));
        return result.data;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async authorize(code, data) {
        return this.request({
            method: "POST",
            path: "/wscshop/weapp/authorize.json",
            skipToken: true,
            data: { ...data, code },
        });
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            let data;
            try {
                data = await this.authorize(code, {
                    appId: MINI_APP_ID,
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    grantType: GRANT_TYPE,
                });
            } catch (e) {
                data = await this.authorize(code, {
                    appId: MINI_APP_ID,
                    clientBiz: CLIENT_BIZ,
                });
            }
            this.applyToken(data);
            this.userInfo = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${data.nick_name || data.nickName || ""} ${maskPhone(data.mobile) || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.request({ path: "/wscump/checkin/show_checkin_page_v2.json" });
            return true;
        } catch (e) {
            return false;
        }
    }

    async showCheckinPage() {
        try {
            const data = await this.request({ path: "/wscump/checkin/show_checkin_page_v2.json" });
            this.checkinId = data?.checkinId;
            this.isShow = !!data?.isShow;
            $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${this.isShow}`);
            // 连签天数（防御性提取，字段缺失则诚实留空）
            const _ep = extractPoints(data);
            const _st = _ep.streak != null ? _ep.streak : _pickNum(data, ['series_days', 'seriesdays', 'sign_day', 'signday', 'continuous_days', 'continuousday', 'continue_days', 'sign_count', 'signcount', 'total_sign', 'totalsign', 'signseries']);
            if (_st != null) _setStreak(this.index, _st);
        } catch (e) {
            $.log(`账号[${this.index}] 获取签到活动失败: ${e.message || e}`);
            if (isTokenError(e.message || e)) this.removeCachedToken();
        }
    }

    async doCheckin() {
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 未获取到 checkinId，跳过签到`);
            return;
        }
        try {
            const data = await this.request({
                path: "/wscump/checkin/checkinV2.json",
                params: { checkinId: this.checkinId },
            });
            const awards = (data?.list || []).map((item) => item?.infos?.title).filter(Boolean).join(", ");
            _setSign(this.index, "签到成功", awards ? awards : "");
            _setLottery(this.index, _digLottery(data));
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${awards ? ` ${awards}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已达最大参与次数|已签到|重复签到/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败");
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async getPoints() {
        try {
            const data = await this.request({ path: "/wscump/integral/user_points.json" });
            const _pts = data?.current_points ?? data?.real_points;
            if (_pts != null && !isNaN(Number(_pts))) _rpGet(this.index).total = String(_pts);
            $.log(`账号[${this.index}] 当前积分: ${_pts ?? "未知"}`);
        } catch (e) {
            $.log(`账号[${this.index}] 查询积分失败: ${e.message || e}`);
        }
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '影视飓风';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", streak: "", tasks: [], taskEarned: "", lottery: "" };
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
function _setStreak(idx, n) { if (n != null && n !== "" && !isNaN(Number(n))) _rpGet(idx).streak = String(n); }
function _setTaskEarned(idx, text) { if (text != null && text !== "") _rpGet(idx).taskEarned = String(text); }
function _pickNum(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    const flat = {};
    for (const [k, v] of Object.entries(obj)) {
        flat[String(k).toLowerCase()] = v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) flat[String(k2).toLowerCase()] = v2;
        }
    }
    for (const key of keys) {
        const v = flat[key];
        if (v != null && v !== '' && !isNaN(Number(v))) return Math.trunc(Number(v));
    }
    return null;
}
function _digLottery(obj) {
    if (obj == null) return "";
    const keys = ['lottery', 'draw', 'prize', '转盘', 'turntable', 'raffle', 'lucky', '福袋', 'reward', 'rewards', 'gift'];
    const hits = [];
    const scan = (o, depth) => {
        if (o == null || depth > 4) return;
        if (Array.isArray(o)) { o.forEach(v => scan(v, depth + 1)); return; }
        if (typeof o === 'object') {
            for (const k of Object.keys(o)) {
                if (keys.some(kk => String(k).toLowerCase().includes(kk.toLowerCase()))) {
                    const v = o[k];
                    if (v != null && v !== '') hits.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
                }
                scan(o[k], depth + 1);
            }
        }
    };
    scan(obj, 0);
    return hits.length ? hits.join("｜") : "";
}
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
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
