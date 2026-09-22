
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
let _rpApp = '纳爱斯';
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
@Description: 纳爱斯品质生活签到
cron: 31 8 * * *
------------------------------------------
变量名：nice
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("纳爱斯品质生活签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx231879a144b5879e";
const PAGE_VERSION = "290";
const API_BASE = "https://m.pailifan.com/xcx";
const BRAND_ID = 2655;
const TOKEN_CACHE_FILE = path.join(__dirname, "nice_token_cache.json");
const ENCRYPT_SALT = "tMFw=RXrEF7y^=7QXy2h2C_g_^";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "nice";

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

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex");
}

function formatDateTime(timestamp) {
    const d = new Date(timestamp * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function zeroPad(buffer) {
    const rest = buffer.length % 16;
    if (rest === 0) return buffer;
    return Buffer.concat([buffer, Buffer.alloc(16 - rest)]);
}

function encryptPayload(data) {
    const t = Math.floor(Date.now() / 1000);
    const date = formatDateTime(t);
    const key = Buffer.from(md5(ENCRYPT_SALT + date + t).substring(8, 24));
    const iv = Buffer.from(md5(date + t + ENCRYPT_SALT).substring(8, 24));
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    cipher.setAutoPadding(false);
    const input = zeroPad(Buffer.from(JSON.stringify(data), "utf8"));
    const encode = Buffer.concat([cipher.update(input), cipher.final()]).toString("base64");
    return { encode, t, bd: BRAND_ID };
}

function isTokenError(message) {
    return /40313|40317|unlogin|token|登录|授权|invalid/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        const _p = String(openid || "").trim().split("#");
        this.openid = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = "";
        this.memberId = "";
        this.phone = "";
        this.todaySigned = false;
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
        await this.getSignLog();
        await this.doSign();
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
            memberId: this.memberId,
            phone: this.phone,
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
        this.memberId = "";
        this.phone = "";
    }

    applyToken(data = {}) {
        this.token = data.token || data.accessToken || "";
        this.memberId = data.memberId || data.member_id || "";
        this.phone = data.phone || data.mobile || "";
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "VERSION": "2022072802",
            "brand": "devtools",
            "model": "Windows",
            "platform": "windows",
            "system": "Windows 10",
            "deviceOrientation": "portrait",
            "version": "8.0.5",
            "size": "414,896",
            ...extra,
        };
    }

    buildPayload(data = {}) {
        return {
            ...data,
            b: BRAND_ID,
            lat: data.lat || "",
            lng: data.lng || "",
        };
    }

    async request(apiPath, data = {}, options = {}) {
        const payload = this.buildPayload(options.skipToken ? data : { token: this.token, ...data });
        const res = await axios.post(`${API_BASE}${apiPath}`, encryptPayload(payload), {
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const result = res.data;
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(result)}`);
        if (!result || result.flag !== 0) {
            const message = result?.msg || result?.data?.message || result?.data?.reason || JSON.stringify(result);
            const err = new Error(message);
            err.flag = result?.flag;
            throw err;
        }
        if (result?.data?.reason === "unlogin") {
            const err = new Error("unlogin");
            err.flag = result.flag;
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
            const data = await this.request("/v2/user_login", { code }, { skipToken: true });
            this.applyToken({
                token: data?.token,
                memberId: data?.member_id || data?.u,
                phone: data?.p,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.memberId || "未知"} ${maskPhone(this.phone) || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignLog(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        try {
            const data = await this.request("/m/user");
            const user = data?.user || {};
            this.memberId = user.member_id || user.memberId || this.memberId;
            this.phone = user.phone || user.mobile || this.phone;
            this.saveCachedToken();
            $.log(`账号[${this.index}] 用户: memberId=${this.memberId || "未知"} ${maskPhone(this.phone) || ""}`);
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 查询用户失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async getSignLog(silent = false) {
        const data = await this.request("/u/signinlog");
        const info = data?.member_sign_info || {};
        const showDay = Number(info.show_day || 0);
        const totalCoins = info.zongCoin ?? data?.zongCoin ?? 0;
        this.todaySigned = Number(info.sign_today || 0) === 1;
        if (!silent) {
            $.log(`账号[${this.index}] 签到状态: ${this.todaySigned ? "今日已签" : "今日未签"} 连续${showDay}天 积分${totalCoins}`);
            const _rp = _rpGet(this.index);
            if (showDay != null && showDay !== "" && !isNaN(Number(showDay))) _rp.streak = String(showDay);
            if (totalCoins != null && totalCoins !== "" && !isNaN(Number(totalCoins))) _rp.total = String(totalCoins);
            if (this.todaySigned) _setSign(this.index, "今日已签到");
        }
        return data;
    }

    async doSign() {
        if (this.todaySigned) { _setSign(this.index, "今日已签到"); return; }
        try {
            const data = await this.request("/u/signin", { data: "2019-09-23" });
            const signData = data?.data || {};
            $.log(`账号[${this.index}] 签到成功: +${signData.coin ?? "未知"} 当前积分${signData.total_coins ?? "未知"}`);
            const _rp = _rpGet(this.index);
            const ep = extractPoints(data);
            _setSign(this.index, "签到成功");
            if (signData.coin != null && signData.coin !== "" && !isNaN(Number(signData.coin))) _rp.earned = "今日+" + signData.coin + "积分";
            else if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "积分";
            if (signData.total_coins != null && signData.total_coins !== "" && !isNaN(Number(signData.total_coins))) _rp.total = String(signData.total_coins);
            else if (ep.total != null) _rp.total = String(ep.total);
            _setLottery(this.index, _digLottery(data));
            await this.getSignLog(true);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|already/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                this.todaySigned = true;
                _setSign(this.index, "今日已签到");
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败: " + message.slice(0, 40));
            if (isTokenError(message)) this.removeCachedToken();
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
