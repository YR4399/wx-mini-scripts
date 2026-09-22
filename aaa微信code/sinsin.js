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
@Description: sinsin微信小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：sinsin
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("sinsin微信小程序签到");
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
const querystring = require("querystring");

const MINI_APP_ID = "wxdc40acf03fc92e6f";
const KDT_ID = "126240508";
const USER_VERSION = "2.235.5.101";
const API_BASE = "https://h5.youzan.com";
const UIC_BASE = "https://uic.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "sinsin_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "sinsin";

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

function maskToken(token = "") {
    if (!token) return "";
    return token.length > 12 ? `${token.slice(0, 6)}***${token.slice(-6)}` : `${token.slice(0, 3)}***`;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        const _p = String(raw || "").trim().split("#");
        this.openid = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = {};
        this.checkinId = "";
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            $.log(`账号[${this.index}] 使用缓存session: ${maskToken(this.sessionId)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存session失效，重新code登录`);
            }
        }

        if (!this.sessionId) await this.loginByWxCode();
        if (!this.sessionId) return;

        await this.getPoints("签到前");
        await this.getCheckinInfo();
        await this.doCheckin();
        await this.getPoints("签到后");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.sessionId) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            ...this.token,
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
        this.token = {};
    }

    get accessToken() {
        return this.token.accessToken || this.token.access_token || "";
    }

    get sessionId() {
        return this.token.sessionId || this.token.session_id || "";
    }

    buildExtraData() {
        return JSON.stringify({
            is_weapp: 1,
            sid: this.sessionId,
            version: USER_VERSION,
            client: "weapp",
            bizEnv: "wsc",
        });
    }

    buildUrl(apiPath, query = {}) {
        const pathname = apiPath.replace(/^\/+/, "");
        const params = querystring.stringify({
            store_id: "",
            app_id: MINI_APP_ID,
            kdt_id: KDT_ID,
            access_token: this.accessToken,
            ...query,
        });
        return `${API_BASE}/${pathname}?${params}`;
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/54/page-frame.html`,
            "Extra-Data": this.buildExtraData(),
            "Cookie": this.sessionId ? `KDTSESSIONID=${this.sessionId}; yz_log_seqb=1` : "",
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
    }

    async request({ method = "GET", apiPath, query = {}, data = {} }) {
        const options = {
            method,
            url: this.buildUrl(apiPath, query),
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method !== "GET") options.data = data;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    async getWxCode() {
        const wxServerUrl = process.env.wx_server_url;
        const wxAuth = process.env.wx_auth;
        if (!wxServerUrl || !wxAuth) throw new Error("未配置 wx_server_url 或 wx_auth");

        const { status, data } = await axios.post(
            `${wxServerUrl.replace(/\/$/, "")}/wx/getuserinfo`,
            { appid: MINI_APP_ID, openid: this.openid },
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

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const { status, data } = await axios.post(
                `${UIC_BASE}/passport/general/auth.json`,
                {
                    appId: MINI_APP_ID,
                    code,
                    platformName: "weapp",
                    signature: "Windows",
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                        "Referer": `https://servicewechat.com/${MINI_APP_ID}/54/page-frame.html`,
                        "X-Requested-With": "XMLHttpRequest",
                    },
                    timeout: 15000,
                    validateStatus: () => true,
                }
            );
            if (status !== 200 || data?.code !== 0 || !data?.data?.sessionId) {
                throw new Error(`UIC登录失败: HTTP ${status} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data)}`);
            }
            this.token = data.data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${data.data?.nickName || data.data?.nickname || ""} ${maskPhone(data.data?.mobile)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPoints("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(label = "积分") {
        const data = await this.request({ apiPath: "wscump/integral/user_points.json" });
        const points = data?.current_points ?? data?.real_points ?? data?.total_points ?? "未知";
        $.log(`账号[${this.index}] ${label}: ${points}积分`);
        if (points !== "未知" && !isNaN(Number(points))) _setSign(this.index, "", "", String(points));
        return data;
    }

    async getCheckinInfo() {
        const data = await this.request({ apiPath: "wscump/checkin/show_checkin_page_v2.json" });
        this.checkinId = data?.checkinId || data?.checkin_id || "";
        $.log(`账号[${this.index}] 签到活动: checkinId=${this.checkinId || "未获取"} isShow=${data?.isShow} showPage=${data?.showPage}`);
        const ep = extractPoints(data);
        if (ep.streak != null) _rpGet(this.index).streak = String(ep.streak);
        return data;
    }

    async doCheckin() {
        if (!this.checkinId) {
            $.log(`账号[${this.index}] 未获取到签到活动，跳过`);
            return;
        }
        try {
            const data = await this.request({
                apiPath: "wscump/checkin/checkinV2.json",
                query: { checkinId: this.checkinId },
            });
            const award = (data?.list || [])
                .map((item) => item?.infos?.title || item?.infos?.desc || "")
                .filter(Boolean)
                .join(", ");
            $.log(`账号[${this.index}] 签到成功: ${data?.desc || ""}${award ? ` ${award}` : ""}`);
            _setSign(this.index, "签到成功", award || "", "");
            _setLottery(this.index, _digLottery(data));
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|参与次数|最大参与次数/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到", "", "");
                return;
            }
            if (/手机号未授权|mobile.*authorized/i.test(message)) {
                $.log(`账号[${this.index}] 签到失败: 用户手机号未授权，请先在小程序内完成手机号授权`);
                _setSign(this.index, "签到失败");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败");
            if (e.code === -1 || e.code === 40010 || e.code === 40009 || /登录|token|session|access/i.test(message)) this.removeCachedToken();
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
let _rpApp = '森森';
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
