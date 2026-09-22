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
@Date: 2026.06.01
@Description:  植白说小程序
cron: 30 8 * * *
------------------------------------------
#Notice:
变量名称：zbs
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
需要配置：wx_server_url、wx_auth

⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

const { Env } = require("../tools/env.js");
const $ = new Env("植白说小程序");
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

const ckName = "zbs";
const MINI_APP_ID = "wx6b6c5243359fe265";
const API_BASE = "https://www.kozbs.com/demo/wx/";
const TOKEN_CACHE_FILE = path.join(__dirname, "zbs_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027";
const defaultUserAgent = USER_AGENT;

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

function shortToken(token = "") {
    const value = String(token);
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function isTokenError(message) {
    return /(^|[^0-9])501([^0-9]|$)|token|登录|授权|未登录|失效|过期/i.test(String(message || ""));
}

class Task {
    constructor(openid, index) {
        this.index = index || $.userIdx++;
        const _p = String(openid || "").split("#");
        this.openid = _p[0].trim();
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = "";
        this.userInfo = {};
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCachedToken();
        if (cached?.token) {
            this.token = cached.token;
            this.userInfo = cached.userInfo || {};
            $.log(`账号[${this.index}] 使用缓存token: ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getPoints("当前");
        const _before = this._pts;
        await this.signIn();
        await this.getPoints("签到后");
        const _after = this._pts;
        // 今日获得：以签到前后积分增量兜底（honest）
        if (_before != null && _after != null && (_after - _before) > 0) {
            const _r = _rpGet(this.index);
            if (!_r.earned || _r.earned === "") _r.earned = "今日+" + (_after - _before) + "积分";
        }
    }

    get userId() {
        return this.userInfo?.userId || this.userInfo?.id || 1;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            token: this.token,
            userInfo: this.userInfo,
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
        this.userInfo = {};
    }

    headers(extra = {}) {
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": "https://servicewechat.com/wx6b6c5243359fe265/171/page-frame.html",
            "xweb_xhr": "1",
            ...extra,
        };
        if (this.token) headers["X-Dts-Token"] = this.token;
        return headers;
    }

    async request(apiPath, { method = "GET", data = {}, auth = true } = {}) {
        const options = {
            method,
            url: new URL(apiPath, API_BASE).toString(),
            headers: this.headers(),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (!auth) delete options.headers["X-Dts-Token"];
        if (method.toUpperCase() === "GET") options.params = data;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (Number(result?.errno) !== 0) throw new Error(`${result?.errno ?? ""} ${result?.errmsg || result?.message || JSON.stringify(result)}`.trim());
        return result;
    }

    async getLoginCode() {
        if (!process.env.wx_auth) throw new Error("缺少 wx_auth，无法从 wx_server 获取 code");
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const result = await this.request("auth/login_by_weixin", {
                method: "POST",
                auth: false,
                data: {
                    code,
                    userInfo: {},
                    shareUserId: 1,
                },
            });
            const token = result?.data?.token || "";
            if (!token) throw new Error(`登录响应未返回token: ${JSON.stringify(result)}`);
            this.token = token;
            this.userInfo = result?.data?.userInfo || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.userInfo.nickname || maskPhone(this.userInfo.mobile) || this.userId}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.request("user/getUserIntegral", {
                data: { userId: this.userId },
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(prefix = "当前") {
        try {
            const result = await this.request("user/getUserIntegral", {
                data: { userId: this.userId },
            });
            const integer = result?.data?.integer ?? result?.data?.integral ?? result?.data?.point ?? "未知";
            this._pts = (integer === "未知" || integer == null) ? null : Number(integer);
            if (this._pts != null) _rpGet(this.index).total = String(this._pts);
            $.log(`🌸账号[${this.index}] ${prefix}积分: ${integer}🎉`);
        } catch (e) {
            const message = String(e.message || e);
            $.log(`🌸账号[${this.index}] 获取积分失败: ${message}❌`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async signIn() {
        try {
            const status = await this.request("home/signDay", {
                data: { userId: this.userId },
            });
            const sd = status?.data || {};
            // 连签天数（防御性提取，字段缺失则诚实留空）
            const _ep = extractPoints(sd);
            const _st = _ep.streak != null ? _ep.streak : _pickNum(sd, ['signDay', 'signday', 'continueSignDay', 'continue_days', 'continuousDay', 'seriesDay', 'seriesday', 'signCount', 'signcount', 'totalSign', 'totalsign']);
            if (_st != null) _setStreak(this.index, _st);
            if (sd.isSign) {
                $.log(`🌸账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }

            await this.request("home/sign", {
                data: { userId: this.userId },
            });
            $.log(`🌸账号[${this.index}] 签到成功🎉`);
            _setSign(this.index, "签到成功");
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已签|重复/.test(message)) {
                $.log(`🌸账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到");
                return;
            }
            $.log(`🌸账号[${this.index}] 签到失败: ${message}❌`);
            _setSign(this.index, "签到失败");
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '植白说';
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
    await getNotice();
    $.checkEnv(ckName);

    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

async function getNotice() {
    try {
        const options = {
            url: "https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json",
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000,
        };
        const { data: res } = await axios.request(options);
        $.log(res);
        return res;
    } catch (e) {}
}
