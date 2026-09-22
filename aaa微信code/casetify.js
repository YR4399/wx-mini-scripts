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
@Description: CASETiFY 签到
cron: 46 8 * * *
------------------------------------------
变量名：casetify
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("CASETiFY 签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxd0c71d6bf928a416";
const PAGE_VERSION = "160";
const API_BASE = "https://mini-app-api.casetify.cn/api/v4";
const WECHAT_ID = 260;
const POINT_MALL_TYPE = 13;
const TOKEN_CACHE_FILE = path.join(__dirname, "casetify_token_cache.json");

// ---------- 本地累计积分（接口无总积分字段，本机向前累计每日签到获得积分）----------
function _cfReadPoints() {
    try { if (!fs.existsSync(path.join(__dirname, "casetify_points_cache.json"))) return {}; return JSON.parse(fs.readFileSync(path.join(__dirname, "casetify_points_cache.json"), "utf8")) || {}; } catch (e) { return {}; }
}
function _cfWritePoints(c) {
    try { fs.writeFileSync(path.join(__dirname, "casetify_points_cache.json"), JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log(`写入积分缓存失败: ${e.message || e}`); }
}
function _cfToday() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function _cfRollDay(openid, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: _cfToday() });
    if (rec.date !== _cfToday()) { rec.hist = (Number(rec.hist) || 0) + (Number(rec.gain) || 0); rec.gain = 0; rec.date = _cfToday(); }
    return rec;
}
function _cfAddGain(openid, point, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: _cfToday() });
    rec.gain = (Number(rec.gain) || 0) + (Number(point) || 0);
    rec.date = _cfToday();
}
function _cfCurTotal(openid, cache) { const rec = cache[openid] || { hist: 0, gain: 0 }; return (Number(rec.hist) || 0) + (Number(rec.gain) || 0); }
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "casetify";

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

function normalizeDate(value) {
    const parts = String(value || "").split("-");
    if (parts.length !== 3) return String(value || "");
    return `${parts[0]}-${String(Number(parts[1])).padStart(2, "0")}-${String(Number(parts[2])).padStart(2, "0")}`;
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isTokenError(message) {
    return /token|登录|授权|invalid|expire|过期|401|403/i.test(String(message || ""));
}

class Task {
    constructor(raw) {
        const _parts = String(raw || "").split("#");
        this.openid = _parts[0].trim();
        this.remark = (_parts[1] || "").trim();
        this.index = $.userIdx++;
        this.token = "";
        this.memberId = "";
        this.customerNo = "";
        this.phone = "";
        this.levels = "";
        this.campaignId = "";
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
        if (!this.remark) {
            const _n = this.phone || this.customerNo || this.levels || "";
            if (_n) _setName(this.index, _n);
        }

        await this.getCampaignId();
        await this.doSign();
        this.saveCachedToken();
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
            customerNo: this.customerNo,
            phone: this.phone,
            levels: this.levels,
            campaignId: this.campaignId,
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
        this.customerNo = "";
        this.campaignId = "";
    }

    applyToken(data = {}) {
        this.token = data.token || "";
        this.memberId = data.memberId || data.id || "";
        this.customerNo = data.customerNo || "";
        this.phone = data.phone || "";
        this.levels = data.levels || "";
        this.campaignId = data.campaignId || "";
    }

    getHeaders(auth = false) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        };
        if (!auth) headers.token = this.token || "";
        return headers;
    }

    async request(method, apiPath, data = {}, options = {}) {
        const requestOptions = {
            method,
            url: `${API_BASE}/${apiPath}`,
            headers: this.getHeaders(options.auth),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (method === "GET") requestOptions.params = data;
        else requestOptions.data = data;

        const { status, data: result } = await axios.request(requestOptions);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!options.allowAnyCode && result?.resultCode !== "1") {
            const err = new Error(result?.msg || JSON.stringify(result));
            err.resultCode = result?.resultCode;
            throw err;
        }
        return result;
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
            const result = await this.request("GET", `estore/member/onLogin/${code}/${WECHAT_ID}`, {}, { auth: true });
            const user = result.data || {};
            this.applyToken({
                token: user.token,
                memberId: user.id,
                customerNo: user.customerNo,
                phone: user.phone,
                levels: user.levels,
            });
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.levels || "会员"} ${this.customerNo || this.memberId || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getCampaignId(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getCampaignId(silent = false) {
        if (this.campaignId) return this.campaignId;
        const result = await this.request("GET", "estore-campaign/campaign/info/get", {
            campaignType: POINT_MALL_TYPE,
        });
        const campaignId = result.data?.detail?.campaignId || result.data?.campaignId || "";
        if (!campaignId) throw new Error("未找到积分商城活动");
        this.campaignId = campaignId;
        this.saveCachedToken();
        if (!silent) $.log(`账号[${this.index}] 积分商城活动: ${campaignId}`);
        return campaignId;
    }

    async getSignInfo() {
        if (!this.campaignId) await this.getCampaignId(true);
        const result = await this.request("GET", "estore-campaign/campaign/pointsMall/assignment/sign", {
            campaignId: this.campaignId,
        });
        return result.data || {};
    }

    async doSign() {
        try {
            const before = await this.getSignInfo();
            const signDays = Array.isArray(before.signDays) ? before.signDays : [];
            const todayStatus = signDays.find((item) => normalizeDate(item.signDay) === today());
            const dailyTask = Array.isArray(before.assignDetail)
                ? before.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            const alreadySigned = todayStatus?.signStatus === 1 || dailyTask?.completeStatus === 1;

            let after = before;
            if (!alreadySigned) {
                const sign = await this.request("POST", "estore-campaign/member/sign/do", {}, { allowAnyCode: true });
                if (sign.resultCode !== "1") {
                    const message = sign.msg || JSON.stringify(sign);
                    if (/已签|重复/.test(message)) {
                        $.log(`账号[${this.index}] 今日已签到`);
                    } else {
                        throw new Error(message);
                    }
                }
                after = await this.getSignInfo();
            }

            // 填充四项推送字段：签到奖励 / 总积分 / 连签 / 抽奖
            const task = Array.isArray(after.assignDetail)
                ? after.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            // 本地累计：只有当天真正签到成功才累加（alreadySigned 时不重复加）
            const _pc = _cfReadPoints();
            _cfRollDay(this.openid, _pc);
            if (!alreadySigned && task?.awardPrice != null) _cfAddGain(this.openid, task.awardPrice, _pc);
            const _localTotal = _cfCurTotal(this.openid, _pc);
            _cfWritePoints(_pc);
            if (task?.awardPrice != null && task.awardPrice !== "") {
                logPoints(task.awardPrice, String(_localTotal), "CASETiFY 签到", this.index, "签到成功");
            } else {
                logPoints(null, String(_localTotal), "CASETiFY 签到", this.index, "签到成功");
            }
            _rpGet(this.index).totalLabel = "累计积分";

            const _ep = extractPoints(after) || {};
            if (_ep.total != null) _setSign(this.index, null, null, _ep.total);
            let _streak = _ep.streak != null ? _ep.streak : computeStreak(after.signDays);
            if (_streak != null && _streak !== "" && _streak !== 0) _rpGet(this.index).streak = _streak;
            const _lot = _digLottery(after);
            if (_lot) _setLottery(this.index, _lot);

            $.log(`账号[${this.index}] 签到成功: +${task?.awardPrice || "未知"}积分`);
        } catch (e) {
            const message = e.message || e;
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = 'CASETiFY';
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
  if (obj == null || typeof obj !== "object") return "";
  const hits = [];
  const keys = ["lottery", "draw", "prize", "raffle", "turntable", "wheel", "转盘", "抽奖", "奖励"];
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        const lk = String(k).toLowerCase();
        const hit = keys.some((kk) => lk.includes(kk.toLowerCase()));
        const val = v[k];
        if (hit && val != null && val !== "" && typeof val !== "object") {
          hits.push(`${k}=${val}`);
        }
        if (typeof val === "object") walk(val, depth + 1);
      }
      return;
    }
  };
  walk(obj, 0);
  return hits.length ? hits.join("｜") : "";
}
function computeStreak(signDays) {
  const arr = (signDays || [])
    .filter((x) => x && x.signStatus === 1)
    .map((x) => normalizeDate(x.signDay))
    .filter((x) => x)
    .sort();
  if (!arr.length) return 0;
  let streak = 0;
  const d = new Date();
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (arr.includes(key)) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
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
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
