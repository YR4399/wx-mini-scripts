// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

/*
@Description:  植白说小程序
cron: 30 8 * * *
*/

const { Env } = require("../tools/env.js");
const $ = new Env("植白说小程序");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");
// ========== SSL和代理修复 ==========
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
// ========== SSL和代理修复结束 ==========



const ckName = "wx_opinion";
const MINI_APP_ID = "wx6b6c5243359fe265";
const API_BASE = "https://www.kozbs.com/demo/wx/";
const TOKEN_CACHE_FILE = path.join(__dirname, "zbs_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027";
const defaultUserAgent = USER_AGENT;

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

function shortToken(token = "") {
    const value = String(token);
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function isTokenError(message) {
    return /(^|[^0-9])501([^0-9]|$)|token|登录|授权|未登录|失效|过期/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.token = "";
        this.userInfo = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached?.token) {
            this.token = cached.token;
            this.userInfo = cached.userInfo || {};
            $.log(`账号[${this.index}] 使用缓存token: ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getPoints("当前");
        await this.signIn();
        await this.getPoints("签到后");
    }

    get userId() {
        return this.userInfo?.userId || this.userInfo?.id || 1;
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
            userInfo: this.userInfo,
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
        this.userInfo = {};
    }

    headers(extra = {}) {
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": "https://servicewechat.com/wx6b6c5243359fe265/171/page-frame.html",
            "xweb_xhr": "1",
            ...extra,
        };
        if (this.token) headers["X-Dts-Token"] = this.token;
        return headers;
    }

    async request(apiPath, { method = "GET", data = {}, auth = true } = {}) {
        const options = {
            method,
            url: new URL(apiPath, API_BASE).toString(),
            headers: this.headers(),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (!auth) delete options.headers["X-Dts-Token"];
        if (method.toUpperCase() === "GET") options.params = data;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (Number(result?.errno) !== 0) throw new Error(`${result?.errno ?? ""} ${result?.errmsg || result?.message || JSON.stringify(result)}`.trim());
        return result;
    }

    async getLoginCode() {
        if (!process.env.wx_auth) throw new Error("缺少 wx_auth，无法从 wx_server 获取 code");
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const result = await this.request("auth/login_by_weixin", {
                method: "POST",
                auth: false,
                data: {
                    code,
                    userInfo: {},
                    shareUserId: 1,
                },
            });
            const token = result?.data?.token || "";
            if (!token) throw new Error(`登录响应未返回token: ${JSON.stringify(result)}`);
            this.token = token;
            this.userInfo = result?.data?.userInfo || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: ${this.userInfo.nickname || maskPhone(this.userInfo.mobile) || this.userId}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.request("user/getUserIntegral", {
                data: { userId: this.userId },
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    async getPoints(prefix = "当前") {
        try {
            const result = await this.request("user/getUserIntegral", {
                data: { userId: this.userId },
            });
            const integer = result?.data?.integer ?? result?.data?.integral ?? result?.data?.point ?? "未知";
            $.log(`🌸账号[${this.index}] ${prefix}积分: ${integer}🎉`);
        } catch (e) {
            const message = String(e.message || e);
            $.log(`🌸账号[${this.index}] 获取积分失败: ${message}❌`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    async signIn() {
        try {
            const status = await this.request("home/signDay", {
                data: { userId: this.userId },
            });
            if (status?.data?.isSign) {
                $.log(`🌸账号[${this.index}] 今日已签到`);
                return;
            }

            await this.request("home/sign", {
                data: { userId: this.userId },
            });
            $.log(`🌸账号[${this.index}] 签到成功🎉`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已签|重复/.test(message)) {
                $.log(`🌸账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`🌸账号[${this.index}] 签到失败: ${message}❌`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    
    $.checkEnv(ckName);

    for (const user of $.userList) {
        await new Task(user).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(async () => {
    // ========== push result ==========
    try {
        const _logs = $.notifyStr || [];
        if (_logs.length > 0) {
            await sendPushNotify("植白说小程序", _logs.join("\n"));
        }
    } catch(_e) {}
    // ========== push end ==========
    $.sendMsg = async () => {}; $.log = async () => {};
    process.exit(0);
});

// getNotice removed - no external ad content
