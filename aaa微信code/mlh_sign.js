/*
@Description: 梦百合 签到
cron: 30 8 * * *
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("梦百合");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");
// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

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
        this.openid = openid;
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
            if (resp.data?.code === 1) {
                L.ok("账号[" + this.index + "] 签到成功: +" + (resp.data?.data || "积分"));
            } else if (/已签到|已签|already/i.test(resp.data?.msg || "")) {
                L.info("账号[" + this.index + "] 今日已签到");
            } else {
                $.log("账号[" + this.index + "] 签到失败: " + (resp.data?.msg || JSON.stringify(resp.data)));
            }
        } catch (e) {
            $.log("账号[" + this.index + "] 签到异常: " + e.message);
        }

        // 积分查询
        try {
            const info = await this.get("/v1/account/info");
            const authInfo = info?.authInfo || {};
            L.info("账号[" + this.index + "] 积分:" + (authInfo.integral || 0) + " | " + (authInfo.levelName || "会员"));
        } catch {}
    }
}

async function main() {
$.userIdx = 0;
    $.checkEnv(ckName);
    const users = $.userList || [];
    if (!users.length) { L.info("未配置wx_opinion"); return; }
    L.info("共" + users.length + "个账号");
    const results = [];
    for (const user of users) {
        try {
            const t = new Task(user);
            await t.run();
            results.push("账号[" + t.index + "] OK");
        } catch (e) {
            results.push("账号失败: " + e.message);
        }
    }
    sendPushNotify("梦百合", results.join("\n") || "梦百合执行完成");
}

main().catch(e => { $.log("异常: " + e.message); sendPushNotify("梦百合", "异常: " + e.message); });
