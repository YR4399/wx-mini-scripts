const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = "尔木淘签到";
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
        if (hit && val != null && val !== "" && typeof val !== "object") hits.push(`${k}=${val}`);
        if (typeof val === "object") walk(val, depth + 1);
      }
      return;
    }
  };
  walk(obj, 0);
  return hits.length ? hits.join("｜") : "";
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
/*
@Description: 尔木淘官方商城 签到
cron: 20 8 * * *
*/
require("https").globalAgent.options.rejectUnauthorized = false;
const { Env } = require("../tools/env.js");
const $ = new Env("尔木淘签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxbaa2eb7c41d78388";
const KDT_ID = "91322384";
const APP_VERSION = "2.240.6";
const API_BASE = "https://h5.youzan.com";
const UIC_BASE = "https://uic.youzan.com";
const TOKEN_CACHE = path.join(__dirname, "ermutao_token.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";

axios.defaults.proxy = false;

function uuid() {
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ========== Task 类 ==========

// ---------- 本地累计积分缓存（接口无总积分字段，本机向前累计签到获得）----------
const _PCF = path.join(__dirname, "ermutao_points_cache.json");
function _pcRead() { try { if (!fs.existsSync(_PCF)) return {}; return JSON.parse(fs.readFileSync(_PCF, "utf8")) || {}; } catch (e) { return {}; } }
function _pcWrite(c) { try { fs.writeFileSync(_PCF, JSON.stringify(c, null, 2), "utf8"); } catch (e) {} }
function _pcToday() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function _pcRoll(k, c) {
  const rec = c[k] || (c[k] = { hist: 0, gain: 0, date: _pcToday() });
  if (rec.date !== _pcToday()) { rec.hist = (Number(rec.hist) || 0) + (Number(rec.gain) || 0); rec.gain = 0; rec.date = _pcToday(); }
  return rec;
}
function _pcAdd(k, n, c) { const rec = _pcRoll(k, c); rec.gain = (Number(rec.gain) || 0) + (Number(n) || 0); rec.date = _pcToday(); }
function _pcTotal(k, c) { const rec = c[k] || { hist: 0, gain: 0 }; return (Number(rec.hist) || 0) + (Number(rec.gain) || 0); }

class Task {
    constructor(openid, index) {
        const _parts = String(openid || "").split("#");
        this.openid = _parts[0].trim();
        this.remark = (_parts[1] || "").trim();
        this.index = index;
        this.token = null;
        this.sessionId = null;
        this.cache = {};
    }

    loadCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE)) {
                const data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
                const entry = data[this.openid];
                if (entry) {
                    this.cache = entry;
                    this.token = entry.accessToken;
                    this.sessionId = entry.sessionId;
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    saveCache() {
        try {
            let data = {};
            if (fs.existsSync(TOKEN_CACHE)) data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
            data[this.openid] = { accessToken: this.token, sessionId: this.sessionId, time: Date.now() };
            fs.writeFileSync(TOKEN_CACHE, JSON.stringify(data), "utf8");
        } catch (_) {}
    }

    getExtraData() {
        return JSON.stringify({
            sid: this.sessionId || "",
            version: APP_VERSION,
            clientType: "weapp-miniprogram",
            client: "weapp",
            bizEnv: "",
            uuid: uuid(),
            ftime: Date.now(),
        });
    }

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/66/page-frame.html`,
            "Extra-Data": this.getExtraData(),
            "xweb_xhr": "1",
            "app-mode": "default",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        };
    }

    buildQuery() {
        return { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token || "" };
    }

    // ========== WCS code ==========
    async getWxCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.data?.code || data?.code;
        if (!code) throw new Error(`WCS 获取 code 失败: ${JSON.stringify(data)}`);
        return code;
    }

    // ========== UIC 登录 ==========
    async login() {
        if (this.loadCache()) {
            $.log(`账号[${this.index}] 使用缓存 token`);
            const valid = await this.validateToken();
            if (valid) return true;
            $.log(`账号[${this.index}] 缓存失效，重新登录`);
            this.token = null;
        }

        const code = await this.getWxCode();
        $.log(`账号[${this.index}] 获取 code 成功`);

        const resp = await axios.post(`${UIC_BASE}/passport/general/auth.json`, {
            appId: MINI_APP_ID,
            code,
            platformName: "weapp",
            signature: "windows",
            clientBiz: "weapp_wsc",
            inWsc: true,
            kdtId: KDT_ID,
            extraBizData: {
                enterOptions: {
                    extKdtId: parseInt(KDT_ID),
                    path: "pages/home/dashboard/index",
                    query: {},
                    scene: 1007,
                    referrerInfo: {},
                    apiCategory: "default",
                },
                guideBizDataMap: { from_params: "" },
                sceneData: {},
            },
        }, {
            params: { kdt_id: KDT_ID, app_id: MINI_APP_ID },
            headers: this.getHeaders(),
            timeout: 30000,
        });

        const d = resp.data;
        if (d.code !== 0 || !d.data?.accessToken) {
            throw new Error(`登录失败: ${JSON.stringify(d)}`);
        }
        this.token = d.data.accessToken;
        this.sessionId = d.data.sessionId;
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功: ${d.data.nickname || d.data.mobile}`);
        return true;
    }

    async validateToken() {
        try {
            const resp = await axios.post(`${API_BASE}/wscuser/membercenter/present.json`, null, {
                params: this.buildQuery(),
                headers: this.getHeaders(),
                timeout: 15000,
                validateStatus: () => true,
            });
            return resp.data?.code === 0;
        } catch (_) { return false; }
    }

    // ========== 签到 ==========
    async sign() {
        // Step 1: 获取签到页面，拿到 checkinId
        const pageResp = await axios.get(`${API_BASE}/wscump/checkin/show_checkin_page_v2.json`, {
            params: this.buildQuery(),
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const pageData = pageResp.data;
        if (pageData.code !== 0) {
            $.log(`账号[${this.index}] 获取签到页面失败: ${JSON.stringify(pageData).slice(0, 100)}`);
            if (typeof _setSign === 'function') _setSign(this.index, "签到失败", null, null);
            return false;
        }
        const checkinId = pageData.data?.checkinId || pageData.data?.checkin_id;
        if (!checkinId) {
            $.log(`账号[${this.index}] 未找到 checkinId`);
            return false;
        }
        // 从签到页响应提取 总积分/连签/抽奖（通用扫描，缺字段则空）
        const _ep = extractPoints(pageData.data) || {};
        if (_ep.total != null) _setSign(this.index, null, null, String(_ep.total));
        if (_ep.streak != null) _rpGet(this.index).streak = _ep.streak;
        const _lotP = _digLottery(pageData.data);
        if (_lotP) _setLottery(this.index, _lotP);

        // Step 2: 执行签到
        const signResp = await axios.get(`${API_BASE}/wscump/checkin/checkinV2.json`, {
            params: { ...this.buildQuery(), checkinId },
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const signData = signResp.data;
        if (signData.code === 0 && signData.data?.success) {
            const award = signData.data.list || signData.data.awardList || [];
            const desc = award.map(a => a.infos?.title || a.title || "").join(", ") || "奖励";
            $.log(`账号[${this.index}] 签到成功 获得: ${desc}`);
            let _emGain = null;
            try { const _mm = /(\d+)\s*积分/.exec(desc); if (_mm) _emGain = parseInt(_mm[1], 10); } catch (e) {}
            this._pc = this._pc || _pcRead();
            _pcRoll(this.openid, this._pc);
            if (_emGain) _pcAdd(this.openid, _emGain, this._pc);
            _pcWrite(this._pc);
            const _emTotal = _pcTotal(this.openid, this._pc);
            if (typeof _setSign === 'function') _setSign(this.index, "签到成功", desc || null, String(_emTotal));
            const _emRow = _rpGet(this.index); if (_emRow) _emRow.totalLabel = "累计积分";
            return true;
        }
        const msg = signData.msg || signData.message || JSON.stringify(signData);
        if (msg.includes("已签") || msg.includes("重复") || msg.includes("最大")) {
            $.log(`账号[${this.index}] 今日已签到`);
            this._pc = this._pc || _pcRead();
            _pcRoll(this.openid, this._pc);
            _pcWrite(this._pc);
            const _emT2 = _pcTotal(this.openid, this._pc);
            if (typeof _setSign === 'function') _setSign(this.index, "今日已签到", null, String(_emT2));
            const _emRow2 = _rpGet(this.index); if (_emRow2) _emRow2.totalLabel = "累计积分";
            return true;
        }
        $.log(`账号[${this.index}] 签到失败: ${msg.slice(0, 100)}`);
        return false;
    }





    // ========== 主流程 ==========
    async run() {
        $.log(`\n========== 尔木淘 账号[${this.index}] ${this.openid.slice(0, 8)}*** ==========`);
        if (this.remark) _setName(this.index, this.remark);
        await this.login();
        await $.wait(500 + Math.random() * 1000);
        await this.sign();
        $.log(`账号[${this.index}] 任务完成`);
    }
}

// ========== 主入口 ==========
!(async () => {
$.userIdx = 0;
    $.checkEnv(ckName);
    const accounts = $.userList;
    $.log(`共找到${accounts.length}个账号`);

    for (let i = 0; i < accounts.length; i++) {
        try {
            await new Task(accounts[i], i + 1).run();
        } catch (e) {
            $.log(`账号[${i + 1}] 异常: ${e.response?.status || e.message || e}`);
        }
        if (i < accounts.length - 1) await $.wait(2000 + Math.random() * 3000);
    }
})().catch((e) => $.log(e.message || e))
    .finally(async () => {
        $.done && $.done();
    });
