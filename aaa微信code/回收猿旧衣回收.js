/*
@Description: 回收猿旧衣回收 签到
cron: 15 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("回收猿旧衣回收");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");
// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

// ========== SSL和代理修复 ==========
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
// ========== SSL和代理修复结束 ==========

const APPID = "wxadd84841bd31a665";
const API_BASE = "https://www.52bjy.com/api/app";
const APP_KEY = "1079fb245839e765";
const CACHE_FILE = path.join(__dirname, "hsy_token_cache.json");
let ckName = "wx_opinion";

const UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841",
    "Mozilla/5.0 (Linux; Android 14; 2407FPN8EG Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.153 Mobile Safari/537.36 XWEB/1460043 MMWEBSDK/20251006 MiniProgramEnv/android",
    "Mozilla/5.0 (Linux; Android 13; Redmi K60 Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Mobile Safari/537.36 XWEB/1300003 MMWEBSDK/20250901 MiniProgramEnv/android",
];

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: APPID,
    auth: process.env.wx_auth || "",
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function random(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function getUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }
function getHeaders() {
    return {
        "User-Agent": getUA(),
        "xweb_xhr": "1",
        "Referer": "https://servicewechat.com/" + APPID + "/133/page-frame.html",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    };
}

function loadCache() { try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch(e) {} return {}; }
function saveCache(data) { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); }

class HuiShouYuan {
    constructor(openid, index) {
        this.index = index;
        this.openid = openid;
        this.auth = "";
        this.username = "";
    }

    async apiGet(action, extra = {}) {
        const q = new URLSearchParams({ action, appkey: APP_KEY, auth: this.auth, username: this.username });
        for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) q.append(k, v);
        try {
            const res = await axios.get(API_BASE + "/user.php?" + q.toString(), { headers: getHeaders(), timeout: 15000 });
            return res.data;
        } catch(e) { $.log("账号[" + this.index + "] API失败: " + e.message); return null; }
    }

    async login() {
        $.log("账号[" + this.index + "] 尝试WCS登录...");
        try {
            const codeRes = await wechat.getCode(this.openid);
            const code = codeRes?.data?.data?.code || codeRes?.data?.code;
            if (!code) { $.log("账号[" + this.index + "] WCS未返回code"); return false; }

            const bindRes = await axios.post(
                "https://www.52bjy.com/api/app/hsy.php",
                "action=auth&method=weixin_bind&code=" + encodeURIComponent(code) + "&appkey=" + APP_KEY + "&merchant_id=2&version=2&inviter=",
                { headers: { ...getHeaders(), "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
            );
            const data = bindRes.data;
            if (data?.is_success && data.data?.jiufy_auth) {
                this.auth = data.data.jiufy_auth;
                this.username = data.data.username;
                $.log("账号[" + this.index + "] 登录成功: " + (data.data.passport || "?"));
                return true;
            }
            $.log("账号[" + this.index + "] 登录失败: " + (data?.message || JSON.stringify(data)));
        } catch(e) { $.log("账号[" + this.index + "] 登录异常: " + e.message); }
        return false;
    }

    async checkAndSign() {
        $.log("========== 回收猿 账号[" + this.index + "] ==========");
        const cache = loadCache();
        if (cache[this.openid]?.jiufy_auth) {
            this.auth = cache[this.openid].jiufy_auth;
            this.username = cache[this.openid].username;
        }

        if (this.auth) {
            const info = await this.apiGet("userinfo");
            if (info?.is_success) {
                $.log("账号[" + this.index + "] 缓存auth有效");
            } else {
                $.log("账号[" + this.index + "] 缓存auth失效");
                this.auth = ""; this.username = "";
            }
        }

        if (!this.auth) {
            const ok = await this.login();
            if (!ok) return { ok: false, reason: "登录失败" };
            cache[this.openid] = { jiufy_auth: this.auth, username: this.username };
            saveCache(cache);
        }

        const info = await this.apiGet("userinfo");
        if (!info?.is_success) return { ok: false, reason: "auth无效" };
        const passport = info.data?.passport || "?";
        const credit = info.data?.credit || 0;
        $.log("账号[" + this.index + "] 用户: " + passport + " | 积分: " + credit);

        const si = await this.apiGet("getsigninfo", { app: "hsywx" });
        if (si?.is_success && si.data?.hassign === 1) {
            $.log("账号[" + this.index + "] 今日已签到");
            return { ok: true, status: "已签", passport, credit };
        }

        const sr = await this.apiGet("qiandao", { app: "hsywx" });
        if (!sr) return { ok: false, reason: "请求失败", passport, credit };
        if (sr.is_success) {
            $.log("账号[" + this.index + "] 签到成功: " + (sr.message || "OK"));
            await sleep(2000);
            const ni = await this.apiGet("userinfo");
            const nc = ni?.data?.credit || credit;
            $.log("账号[" + this.index + "] 签到后积分: " + nc + " (+" + (nc - credit) + ")");
            return { ok: true, status: "签到成功", passport, credit: nc, gained: nc - credit };
        }
        if (sr.code === 100) { $.log("账号[" + this.index + "] " + (sr.message || "已签")); return { ok: true, status: "已签", passport, credit }; }
        $.log("账号[" + this.index + "] 签到失败: " + (sr.message || JSON.stringify(sr)));
        return { ok: false, reason: sr.message || "未知", passport, credit };
    }
}

async function main() {
    $.log("=== 回收猿旧衣回收 开始 ===");
    $.checkEnv(ckName);
    const accounts = $.userList || [];
    if (accounts.length === 0) { $.log("未配置 wx_opinion"); return; }
    $.log("共 " + accounts.length + " 个账号");

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
        if (i > 0) { const d = random(3000, 8000); await sleep(d); }
        const b = new HuiShouYuan(accounts[i], i + 1);
        try { results.push(Object.assign({ openid: accounts[i] }, await b.checkAndSign())); }
        catch(e) { $.log("账号[" + (i+1) + "] 异常: " + e.message); results.push({ openid: accounts[i], index: i+1, ok: false, reason: e.message }); }
    }

    const ok = results.filter(r => r.ok);
    $.log("=== 汇总: " + ok.length + "/" + results.length + " ===");
    let msg = "回收猿 " + ok.length + "/" + results.length;
    for (const r of results) msg += "\n账号[" + r.index + "] " + (r.passport || "?") + " | " + (r.ok ? "OK" : r.reason || "FAIL");
    sendPushNotify("回收猿旧衣回收", msg);
    $.log("=== 回收猿旧衣回收 结束 ===");
}

main().catch(e => { $.log("异常: " + e.message); sendPushNotify("回收猿旧衣回收", "异常: " + e.message); });
