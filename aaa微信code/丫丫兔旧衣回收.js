/*
@Description: 丫丫兔旧衣回收 签到
cron: 10 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("丫丫兔旧衣回收");
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

const APPID = "wx3d40b636a2efc0f5";
const API_BASE = "https://yayatu-cloud.iguo.tech";
const CACHE_FILE = path.join(__dirname, "yyt_token_cache.json");
let ckName = "wx_opinion";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: APPID,
    auth: process.env.wx_auth || "",
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function random(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function getHeaders(token = "") {
    return {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "plateForm": "WX",
        "tenantAppId": APPID,
        "Authorization": token,
        "channelNo": "",
        "Referer": "https://servicewechat.com/" + APPID + "/26/page-frame.html",
        "xweb_xhr": "1",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    };
}

function loadCache() { try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch(e) {} return {}; }
function saveCache(data) { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); }

class YaYaTu {
    constructor(openid, index) {
        this.index = index;
        this.openid = openid;
        this.token = "";
    }

    async login() {
        $.log("账号[" + this.index + "] 尝试WCS登录...");
        try {
            const codeRes = await wechat.getCode(this.openid);
            const code = codeRes?.data?.data?.code || codeRes?.data?.code;
            if (!code) { $.log("账号[" + this.index + "] WCS未返回code"); return false; }

            const body = {
                data: { viteIds: "", scence: "", authCode: code, userName: "微信用户", advatar: "" },
                m: Date.now()
            };
            const r = await axios.post(API_BASE + "/recy/api/user/registerAuthCode",
                body,
                { headers: getHeaders(), timeout: 15000 }
            );
            if (r.data?.status === 200 && r.data.data?.token) {
                this.token = r.data.data.token;
                $.log("账号[" + this.index + "] 登录成功");
                return true;
            }
            $.log("账号[" + this.index + "] 登录失败: " + (r.data?.msg || JSON.stringify(r.data)));
        } catch(e) { $.log("账号[" + this.index + "] 登录异常: " + e.message); }
        return false;
    }

    async checkAndSign() {
        $.log("========== 丫丫兔 账号[" + this.index + "] ==========");
        const cache = loadCache();
        if (cache[this.openid]?.token) {
            this.token = cache[this.openid].token;
        }

        // Test cached token
        if (this.token) {
            try {
                const r = await axios.get(API_BASE + "/fuli/api/fuli/signedInfo",
                    { headers: getHeaders(this.token), timeout: 15000 }
                );
                if (r.data?.status === 200) {
                    $.log("账号[" + this.index + "] 缓存token有效");
                } else {
                    $.log("账号[" + this.index + "] 缓存token失效");
                    this.token = "";
                }
            } catch(e) {
                $.log("账号[" + this.index + "] token验证异常: " + e.message);
                this.token = "";
            }
        }

        if (!this.token) {
            const ok = await this.login();
            if (!ok) return { ok: false, reason: "登录失败(需签名)" };
            cache[this.openid] = { token: this.token };
            saveCache(cache);
        }

        // Get sign info
        const si = await axios.get(API_BASE + "/fuli/api/fuli/signedInfo",
            { headers: getHeaders(this.token), timeout: 15000 }
        );
        if (si.data?.status !== 200) return { ok: false, reason: "查询失败" };
        const isSign = si.data.data?.isSign;
        const signDays = si.data.data?.signDays || 0;
        $.log("账号[" + this.index + "] 已签: " + isSign + " | 连续: " + signDays + "天");

        if (isSign) {
            $.log("账号[" + this.index + "] 今日已签到");
            return { ok: true, status: "已签", signDays };
        }

        // Do sign
        const sr = await axios.get(API_BASE + "/fuli/api/fuli/signed",
            { headers: getHeaders(this.token), timeout: 15000 }
        );
        if (sr.data?.status === 200) {
            $.log("账号[" + this.index + "] 签到成功");
            return { ok: true, status: "签到成功", signDays };
        }
        if (sr.data?.msg?.includes("已签到")) {
            $.log("账号[" + this.index + "] " + sr.data.msg);
            return { ok: true, status: "已签", signDays };
        }
        $.log("账号[" + this.index + "] 签到失败: " + (sr.data?.msg || JSON.stringify(sr.data)));
        return { ok: false, reason: sr.data?.msg || "未知", signDays };
    }
}

async function main() {
    $.log("=== 丫丫兔旧衣回收 开始 ===");
    $.checkEnv(ckName);
    const accounts = $.userList || [];
    if (accounts.length === 0) { $.log("未配置 wx_opinion"); return; }
    $.log("共 " + accounts.length + " 个账号");

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
        if (i > 0) { const d = random(3000, 8000); await sleep(d); }
        const b = new YaYaTu(accounts[i], i + 1);
        try { results.push(Object.assign({ openid: accounts[i] }, await b.checkAndSign())); }
        catch(e) { $.log("账号[" + (i+1) + "] 异常: " + e.message); results.push({ openid: accounts[i], index: i+1, ok: false, reason: e.message }); }
    }

    const ok = results.filter(r => r.ok);
    $.log("=== 汇总: " + ok.length + "/" + results.length + " ===");
    let msg = "丫丫兔 " + ok.length + "/" + results.length;
    for (const r of results) msg += "\n账号[" + r.index + "] " + (r.ok ? "OK" : r.reason || "FAIL") + " | 连续" + (r.signDays || 0) + "天";
    sendPushNotify("丫丫兔旧衣回收", msg);
    $.log("=== 丫丫兔旧衣回收 结束 ===");
}

main().catch(e => { $.log("异常: " + e.message); sendPushNotify("丫丫兔旧衣回收", "异常: " + e.message); });
