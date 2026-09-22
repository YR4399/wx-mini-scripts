/*
@Description: 梦百合 签到
cron: 30 8 * * *
*/
require("https").globalAgent.options.rejectUnauthorized = false;
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("梦百合");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxac481dbea7d77e73";
const API_BASE = "https://mfapi.mlily.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "mlh_token_cache.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() { try { return fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {} : {}; } catch { return {}; } }
function writeCache(c) { try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log("缓存写入失败: " + e.message); } }

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        const _p = String(openid || "").split("#");
        this.openid = _p[0];
        this.remark = _p[1] ? _p[1].trim() : "";
        this.token = "";
        this.guestToken = "c4ba89ff4292291b9ac65471c7527d9";
    }

    get headers() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/22/page-frame.html",
            "xweb_xhr": "1",
        };
    }

    getCached() { const c = readCache(); return c[this.openid] || null; }
    saveCache() { const c = readCache(); c[this.openid] = { token: this.token, guestToken: this.guestToken, ts: Date.now() }; writeCache(c); }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error("WCS未返回code");
        return code;
    }

    async login() {
        const code = await this.getLoginCode();
        let resp = await axios({
            method: "POST",
            url: API_BASE + "/v1/wechat/oauth/mini/login",
            params: { ajax: true, platform: "weapp", guestToken: this.guestToken },
            data: { code },
            headers: { ...this.headers, "Content-Type": "application/json" },
            timeout: 15000,
            validateStatus: () => true,
        });
        if (resp.data?.code !== 1 && resp.data?.code !== 2) {
            throw new Error("登录失败: " + (resp.data?.msg || JSON.stringify(resp.data)));
        }
        this.token = resp.data?.data?.access_token || resp.data?.data?.token || resp.data?.data || "";
        if (!this.token) throw new Error("登录未返回token");
        this.saveCache();
        L.ok("账号[" + this.index + "] 登录成功");
    }

    async get(path, extra = {}) {
        const params = { ajax: true, platform: "weapp", guestToken: this.guestToken, ...extra };
        if (this.token) params.token = this.token;
        Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);
        const resp = await axios.get(API_BASE + path, { params, headers: this.headers, timeout: 15000 });
        if (resp.data?.code !== 1 && resp.data?.code !== 2) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data;
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        const cached = this.getCached();
        if (cached?.token) {
            this.token = cached.token;
            this.guestToken = cached.guestToken || this.guestToken;
            try {
                await this.get("/v1/account/info");
                L.info("账号[" + this.index + "] 使用缓存token");
            } catch (e) {
                $.log("账号[" + this.index + "] 缓存失效: " + e.message);
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 签到
        try {
            const resp = await axios({
                method: "POST",
                url: API_BASE + "/v1/marketing/checkin",
                params: { ajax: true, platform: "weapp", guestToken: this.guestToken, token: this.token },
                headers: this.headers,
                timeout: 15000,
                validateStatus: () => true,
            });
            const _rp = _rpGet(this.index);
            if (resp.data?.code === 1) {
                L.ok("账号[" + this.index + "] 签到成功: +" + (resp.data?.data || "积分"));
                const ep = extractPoints(resp.data);
                _setSign(this.index, "签到成功");
                if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "积分";
                else if (resp.data?.data != null && resp.data.data !== "" && !isNaN(Number(resp.data.data))) _rp.earned = "今日+" + resp.data.data + "积分";
                if (ep.total != null) _rp.total = String(ep.total);
                _setLottery(this.index, _digLottery(resp.data));
            } else if (/已签到|已签|already/i.test(resp.data?.msg || "")) {
                L.info("账号[" + this.index + "] 今日已签到");
                _setSign(this.index, "今日已签到");
            } else {
                $.log("账号[" + this.index + "] 签到失败: " + (resp.data?.msg || JSON.stringify(resp.data)));
                _setSign(this.index, "签到失败: " + String(resp.data?.msg || "").slice(0, 60));
            }
        } catch (e) {
            $.log("账号[" + this.index + "] 签到异常: " + e.message);
        }

        // 积分查询
        try {
            const info = await this.get("/v1/account/info");
            const authInfo = info?.authInfo || {};
            L.info("账号[" + this.index + "] 积分:" + (authInfo.integral || 0) + " | " + (authInfo.levelName || "会员"));
            const _pt = authInfo.integral;
            if (_pt != null && _pt !== "" && !isNaN(Number(_pt))) _rpGet(this.index).total = String(_pt);
        } catch {}
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
let _rpApp = '梦百合';
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

async function main() {
$.userIdx = 0;
    $.checkEnv(ckName);
    const users = $.userList || [];
    if (!users.length) { L.info("未配置wx_opinion"); return; }
    L.info("共" + users.length + "个账号");
    for (const user of users) {
        try {
            const t = new Task(user);
            await t.run();
        } catch (e) {
            $.log("账号失败: " + e.message);
        }
    }
    // 推送统一由 beforeExit / process.exit 钩子经 std_report 完成
}

main().catch(e => { $.log("异常: " + e.message); });
