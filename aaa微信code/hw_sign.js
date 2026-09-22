/*
@Description: 花王官方商城 - 签到+积分查询
cron: 4 14 * * *
解包来源: wxcaa47f040261f278 (2026-09-03)
API: https://kaoshop.kao.com.cn/kaoshop
登录: POST /user/app/user/login  body {code, qyCode, authAppId, channel, scene, latitude, longitude}
签到检查: GET /user/app/sign/getLatestSign  (返 integral/contiDays)
签到执行: POST /user/app/sign/signIn
积分查询: GET /integral/app/integral/getUserIntegral
*/
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// Fix: container has unreachable HTTPS_PROXY injected by FlClash
for (const k of ["HTTP_PROXY","http_proxy","HTTPS_PROXY","https_proxy"]) delete process.env[k];
axios.defaults.proxy = false;

const { Env } = require("./tools/env.js");
const $ = new Env("花王");
const stdReport = require("./std_report");

const MINI_APP_ID = "wxcaa47f040261f278";
const BASE = "https://kaoshop.kao.com.cn/kaoshop";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

let wxServer;
try {
    wxServer = new (require("./wcs.js"))({
        url: process.env.wx_server_url || "http://host.docker.internal:18788",
        appid: MINI_APP_ID,
        auth: process.env.wx_auth || "",
    });
} catch(e) { console.log("[花王] WCS init failed:", e.message); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Token cache ----------
const TOKEN_CACHE = path.join(__dirname, "hw_token.json");
function readTokenCache() { try { return JSON.parse(fs.readFileSync(TOKEN_CACHE,"utf8")); } catch { return {}; } }
function writeTokenCache(c) { try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(c,null,2)); } catch{} }

// ---------- Points cache (total integral accumulation) ----------
const POINTS_CACHE = path.join(__dirname, "hw_sign_points_cache.json");
function readPointsCache() { try { return JSON.parse(fs.readFileSync(POINTS_CACHE,"utf8")); } catch { return {}; } }
function writePointsCache(c) { try { fs.writeFileSync(POINTS_CACHE, JSON.stringify(c,null,2)); } catch{} }

class Task {
    constructor(openid, remark, idx) {
        this.openid = String(openid||"").trim();
        this.remark = String(remark||"").trim();
        this.idx = idx;
        this.token = null;
    }

    _headers(extra) {
        return Object.assign({
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/483/page-frame.html"
        }, extra || {});
    }

    async login() {
        // Try cached token first
        let tk = readTokenCache()[this.openid];
        if (tk) {
            try {
                const r = await axios.get(BASE + "/user/app/sign/getLatestSign", {
                    headers: this._headers({ token: tk }), timeout: 15000
                });
                if (r.data && r.data.code === "SUCCESS") { this.token = tk; return; }
            } catch(e) {}
        }
        // Get fresh code from WCS
        const codeResp = await wxServer.getCode(this.openid);
        const code = codeResp.data && codeResp.data.data && codeResp.data.data.code
                  || (codeResp.data && codeResp.data.code);
        if (!code) throw new Error("获取code失败");
        const r = await axios.post(BASE + "/user/app/user/login",
            { code, qyCode:"", authAppId: MINI_APP_ID, channel: 6, scene: 1145,
              latitude: "31.20561", longitude: "121.51361" },
            { headers: this._headers(), timeout: 15000 }
        );
        const d = r.data;
        this.token = d && d.data && d.data.token;
        if (!this.token) throw new Error("登录失败: " + JSON.stringify(d));
        const cache = readTokenCache();
        cache[this.openid] = this.token;
        writeTokenCache(cache);
    }

    async checkSign() {
        const r = await axios.get(BASE + "/user/app/sign/getLatestSign", {
            headers: this._headers({ token: this.token }), timeout: 15000
        });
        const d = r.data;
        if (d && d.code === "SUCCESS" && d.data) return d.data;
        return null;
    }

    async signIn() {
        const r = await axios.post(BASE + "/user/app/sign/signIn", {}, {
            headers: this._headers({ token: this.token }), timeout: 15000
        });
        const d = r.data;
        if (d && d.code === "SUCCESS") return d.data;
        return null;
    }

    async getPoints() {
        const r = await axios.get(BASE + "/integral/app/integral/getUserIntegral", {
            headers: this._headers({ token: this.token }), timeout: 15000
        });
        const d = r.data;
        if (d && d.code === "SUCCESS") return d.data;
        return null;
    }

    async run() {
        const key = this.remark || this.openid.slice(0,6) || String(this.idx);
        // Phase 1: Login
        try { await this.login(); } catch(e) {
            $.log("账号[" + this.idx + "] 登录失败: " + e.message);
            _rpRows[this.idx-1] = { idx:this.idx, name:key, sign:"登录失败("+e.message+")", earned:"", total:"", streak:"", tasks:[], lottery:"" };
            return;
        }
        // Phase 2: Check sign status
        const signData = await this.checkSign();
        if (signData) {
            const days = signData.contiDays || 0;
            $.log("账号[" + this.idx + "] 今日已签到 (连续" + days + "天)");
            _rpRows[this.idx-1] = { idx:this.idx, name:key, sign:"今日已签到", earned:"", total:"", streak:String(days), tasks:[], lottery:"" };
            // Phase 3: Get total points from /integral/app/integral/getUserIntegral
            const pts = await this.getPoints();
            if (pts) {
                const total = Number(pts.integral) || 0;
                _rpRows[this.idx-1].total = String(total);
                const pc = readPointsCache();
                pc[key] = { hist: total, date: Date.now() };
                writePointsCache(pc);
                $.log("账号[" + this.idx + "] 积分: " + total);
            }
        } else {
            // Phase 2b: Sign in via POST /user/app/sign/signIn
            const signResult = await this.signIn();
            if (signResult) {
                const earned = signResult.integral || signResult.points || 0;
                $.log("账号[" + this.idx + "] 签到成功 +" + earned + "积分");
                _rpRows[this.idx-1] = { idx:this.idx, name:key, sign:"签到成功", earned:"+"+earned, total:"", streak:"", tasks:[], lottery:"" };
                // Get total points
                const pts = await this.getPoints();
                if (pts) {
                    const total = Number(pts.integral) || 0;
                    _rpRows[this.idx-1].total = String(total);
                    const pc = readPointsCache();
                    pc[key] = { hist: total, date: Date.now() };
                    writePointsCache(pc);
                }
            } else {
                $.log("账号[" + this.idx + "] 签到失败");
                _rpRows[this.idx-1] = { idx:this.idx, name:key, sign:"签到失败", earned:"", total:"", streak:"", tasks:[], lottery:"" };
            }
        }
    }
}

// ---------- Report rows (for std_report) ----------
let _rpRows = [];

// ---------- Main ----------
!(async () => {
    $.checkEnv("wx_opinion");
    const accounts = (process.env.wx_opinion || "").split("&").map(s=>s.trim()).filter(Boolean);
    const nicks = process.env.NICK_MAP ? (() => {
        const m = {};
        (process.env.NICK_MAP || "").split("&").forEach(p => {
            const [k, v] = p.split(":");
            if (k && v) m[k.trim()] = v.trim();
        });
        return m;
    })() : {};
    for (let i = 0; i < accounts.length; i++) {
        const openid = accounts[i];
        const remark = nicks[openid] || openid.slice(0, 4);
        const task = new Task(openid, remark, i+1);
        _rpRows[i] = { idx:i+1, name: remark, sign:"-", earned:"", total:"", streak:"", tasks:[], lottery:"" };
        await task.run();
        if (i < accounts.length - 1) await sleep(2000);
    }
    // Push via std_report
    const rows = _rpRows.filter(Boolean);
    if (rows.length) {
        await stdReport.report("花王官方商城", rows);
    }
})().catch(e => console.log(e)).finally(() => $.done());
