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
@Description: 飞鹤微信小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：feihe
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("飞鹤微信小程序签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wx4205ec55b793245e";
const API_BASE = "https://www.feihevip.com";
const APP_ID = "xmyx";
const APP_KEY = "TwUQ01lKS1Km5zlV2f7amsZc5EQYkTbv";
const SIGN_TASK_TYPE = "DJSYQD";
const TOKEN_CACHE_FILE = path.join(__dirname, "feihe_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "feihe";

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskToken(token = "") {
    if (!token) return "";
    return token.length > 16 ? `${token.slice(0, 8)}***${token.slice(-8)}` : `${token.slice(0, 4)}***`;
}

function randomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function md5Upper(text) {
    return crypto.createHash("md5").update(text).digest("hex").toUpperCase();
}

function buildSignedHeaders({ data = null, token = "" } = {}) {
    const headers = {
        fhAppid: APP_ID,
        fhNonceStr: randomString(16),
        fhTimestamp: Math.floor(Date.now() / 1000),
        token,
        source: 1,
        "Content-Type": "application/json",
        OrderUpdate: 1,
        visit: "",
    };
    const dataSignValue = data && typeof data === "object" ? JSON.stringify(data) : data ? String(data) : "";
    const signKeys = ["fhAppid", "fhNonceStr", "fhTimestamp", dataSignValue].sort();
    const signText = signKeys.reduce((text, key) => {
        if (Object.prototype.hasOwnProperty.call(headers, key)) {
            return text + key + headers[key];
        }
        return text + key;
    }, "");

    return {
        ...headers,
        fhSign: md5Upper(signText + APP_KEY),
        Referer: `https://servicewechat.com/${MINI_APP_ID}/420/page-frame.html`,
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
    };
}

function buildUrl(apiPath, query = {}) {
    const params = new URLSearchParams();
    Object.entries(query || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) params.append(key, String(value));
    });
    return `${API_BASE}${apiPath}${params.toString() ? `?${params.toString()}` : ""}`;
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        const _a = String(account || "").trim().split("#");
        this.account = _a[0].trim();
        this.remark = (_a[1] || "").trim();
        this.token = "";
        this.userInfo = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached.token || "";
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.token)}`);
            if (!(await this.checkToken())) {
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
                this.removeCachedToken();
                this.token = "";
            }
        }

        if (!this.token) {
            await this.loginByCode();
        }
        if (!this.token) return;

        if (this.remark) _setName(this.index, this.remark);
        await this.getIndexInfo();
        await this.signIn();
    }

    getCachedToken() {
        const cache = readCache();
        return cache[this.account] || null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readCache();
        cache[this.account] = {
            token: this.token,
            userInfo: this.userInfo,
            updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }

    removeCachedToken() {
        const cache = readCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeCache(cache);
        }
    }

    async request({ method = "GET", apiPath, query = {}, data = null, token = this.token, allowFail = false }) {
        const options = {
            method,
            url: buildUrl(apiPath, query),
            headers: buildSignedHeaders({ data: method === "GET" ? null : data, token }),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method !== "GET") options.data = data || {};

        const { status, data: result } = await axios.request(options);
        const ok = status === 200 && String(result?.code) === "200";
        if (!ok && !allowFail) {
            throw new Error(`HTTP ${status} ${JSON.stringify(result)}`);
        }
        return result;
    }

    async getWxCode() {
        const wxServerUrl = process.env.wx_server_url;
        const wxAuth = process.env.wx_auth;
        if (!wxServerUrl || !wxAuth) throw new Error("未配置 wx_server_url 或 wx_auth");

        const { status, data } = await axios.post(
            `${wxServerUrl.replace(/\/$/, "")}/wx/getuserinfo`,
            { appid: MINI_APP_ID, openid: this.account },
            {
                headers: {
                    auth: wxAuth,
                    "content-type": "application/json",
                },
                timeout: 15000,
                validateStatus: () => true,
            }
        );
        const code = data?.code || data?.data?.code || data?.phoneCode || data?.data?.phoneCode;
        if (status !== 200 || !code) throw new Error(`wx_server 获取code失败: HTTP ${status} ${JSON.stringify(data)}`);
        return code;
    }

    async loginByCode() {
        const code = await this.getWxCode();
        const result = await this.request({
            apiPath: "/api/starMember/getUserToken",
            query: { code },
            token: "",
        });
        const data = result.data || {};
        this.token = result.token || data.token || "";
        this.userInfo = {
            crmId: data.crmId,
            openId: data.openId,
            unionId: data.unionId,
            loginStatus: data.loginStatus,
            expireTime: data.expireTime,
        };
        if (!this.token) throw new Error(`登录成功但未返回token: ${JSON.stringify(result)}`);
        this.saveCachedToken();
        $.log(`账号[${this.index}] code登录成功: ${data.crmId || data.openId || ""} token=${maskToken(this.token)}`);
    }

    async checkToken() {
        try {
            const result = await this.request({
                method: "POST",
                apiPath: "/api/structures/index",
                data: { id: "" },
                allowFail: true,
            });
            return String(result?.code) === "200";
        } catch (e) {
            return false;
        }
    }

    async getIndexInfo() {
        const result = await this.request({
            method: "POST",
            apiPath: "/api/structures/index",
            data: { id: "" },
            allowFail: true,
        });
        if (String(result?.code) === "200") {
            const signModule = (result.data?.modules || []).find((item) => String(item.moduleType) === "17");
            $.log(`账号[${this.index}] 首页签到入口: ${signModule ? "已发现" : "未发现"}`);
        } else {
            $.log(`账号[${this.index}] 首页信息查询失败: ${result?.msg || JSON.stringify(result)}`);
        }
    }

    async signIn() {
        const finish = await this.request({
            apiPath: "/api/member/signin/tofinish",
            query: { taskType: SIGN_TASK_TYPE },
            allowFail: true,
        });
        if (String(finish?.code) === "200" && finish.data === true) {
            $.log(`账号[${this.index}] 签到任务已上报`);
        } else if (String(finish?.code) === "200") {
            $.log(`账号[${this.index}] 签到接口返回: ${JSON.stringify(finish.data)}`);
        } else {
            throw new Error(`签到失败: ${finish?.msg || JSON.stringify(finish)}`);
        }

        const complete = await this.request({
            apiPath: "/api/member/signin/completeTask",
            query: { taskType: SIGN_TASK_TYPE },
            allowFail: true,
        });
        if (String(complete?.code) === "200") {
            const points = complete.data?.awardSendPoints || complete.data?.awardPoint || 0;
            $.log(`账号[${this.index}] 签到完成${points ? `，获得${points}积分` : ""}`);
            const done = String(finish?.code) === "200" && finish.data === true;
            const _ep = Object.assign({}, extractPoints(finish) || {}, extractPoints(complete) || {});
            if (_ep.total != null) _rpGet(this.index).total = String(_ep.total);
            if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
            const _lot = _digLottery(finish) || _digLottery(complete);
            if (_lot) _setLottery(this.index, _lot);
            _setSign(this.index, done ? "签到成功" : "今日已签到", points ? `今日+${points}积分` : null, _ep.total != null ? String(_ep.total) : null);
        } else if (complete?.msg) {
            $.log(`账号[${this.index}] 完成确认返回: ${complete.msg}`);
            _setSign(this.index, "签到失败", null, null);
        }
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = "飞鹤微信小程序签到";
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
function _digLottery(obj) {
  if (obj == null) return "";
  const flat = (function _f(o, pre, acc) {
    acc = acc || {};
    if (Array.isArray(o)) { o.forEach((v, i) => _f(v, pre ? pre + "." + i : "" + i, acc)); return acc; }
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const nv = o[k];
        const nk = pre ? pre + "." + k : k;
        if (nv && typeof nv === "object") _f(nv, nk, acc);
        else acc[nk.toLowerCase()] = nv;
      }
      return acc;
    }
    if (pre) acc[pre] = obj;
    return acc;
  })(obj, "", {});
  const keys = Object.keys(flat);
  const hit = (re) => keys.filter(k => re.test(k));
  const lotteryKeys = hit(/lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift/);
  const out = [];
  for (const k of lotteryKeys) {
    let v = flat[k];
    if (v == null) continue;
    if (typeof v === "object") v = JSON.stringify(v);
    const s = String(v);
    if (s && s !== "{}" && s !== "[]") out.push(s);
  }
  return out.join("｜");
}
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
    if (!$.userCount) return;

    for (const account of $.userList) {
        const task = new Task(account);
        try {
            await task.run();
        } catch (e) {
            $.log(`账号[${task.index}] 运行失败: ${e.message || e}`);
        }
    }
})()
    .catch((e) => $.log(`运行异常: ${e.message || e}`))
    .finally(() => $.done && $.done());
