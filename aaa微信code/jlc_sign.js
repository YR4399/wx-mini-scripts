// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

/*
@Description: 嘉立创金豆商城签到
cron: 30 8 * * *
*/

const { Env } = require("../tools/env.js");
const $ = new Env("嘉立创金豆商城签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ====== 配置 ======
const MINI_APP_ID = "wx6c7b851c877dba42";
const PASSPORT_BASE = "https://passport.jlc.com";
const API_BASE = "https://m.jlc.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "jlc_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "wx_opinion";

// ====== WCS 初始化 ======
const WeChatServer = require("./wcs.js");
const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

// ====== 缓存 ======
function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) { return {}; }
}
function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) { $.log("写入缓存失败: " + (e.message || e)); }
}

// ====== 任务类 ======
class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.accessToken = "";
        this.secretKey = "";
    }

    async run() {
        // 1. 尝试缓存 token
        const cached = this.getCachedToken();
        if (cached) {
            this.accessToken = cached;
            $.log("账号[" + this.index + "] 使用缓存token");
            if (await this.checkToken()) {
                await this.getSecretKey();
                await this.doTasks();
                return;
            }
            $.log("账号[" + this.index + "] 缓存token失效，重新登录");
            this.removeCachedToken();
        }

        // 2. 登录
        if (!await this.loginByWxCode()) return;

        // 3. 获取动态 secretkey
        await this.getSecretKey();

        // 4. 执行任务
        await this.doTasks();
    }

    async doTasks() {
        await this.getSignInStatus();
        await this.signIn();
        await this.getIntegral();
    }

    async loginByWxCode() {
        try {
            // Step 1: 获取 wx.login code
            const { data } = await wechat.getCode(this.openid);
            const code = data?.code || data?.data?.code;
            if (!code) {
                $.log("账号[" + this.index + "] 获取code失败");
                return false;
            }

            // Step 2: check-applet-login 获取 appletLoginToken
            const { data: checkResult } = await axios.post(
                PASSPORT_BASE + "/api/cas/sso/login/check-applet-login",
                { appId: "JLC_MOBILE_APP", appletAuthCode: code },
                { headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT }, timeout: 15000 }
            );

            if (!checkResult.success || !checkResult.data || !checkResult.data.token) {
                $.log("账号[" + this.index + "] check-applet-login失败: " + JSON.stringify(checkResult));
                return false;
            }

            const appletLoginToken = checkResult.data.token;

            // Step 3: applet-silent-login 获取 CAS 授权码
            const { data: silentResult } = await axios.post(
                PASSPORT_BASE + "/api/cas/sso/login/applet-silent-login",
                { token: appletLoginToken, appId: "JLC_MOBILE_APP" },
                { headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT }, timeout: 15000 }
            );

            if (!silentResult.success || !silentResult.data || !silentResult.data.code) {
                $.log("账号[" + this.index + "] applet-silent-login失败: " + JSON.stringify(silentResult));
                return false;
            }

            const casCode = silentResult.data.code;

            // Step 4: login-by-code 获取 AccessToken
            const formData = "code=" + casCode;
            const { data: loginResult } = await axios.post(
                API_BASE + "/api/login/login-by-code",
                formData,
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": USER_AGENT,
                        "X-JLC-MP-AppId": MINI_APP_ID,
                        "X-JLC-ClientType": "MP-WEIXIN",
                        "X-JLC-MP-Env": "release",
                        "X-JLC-MP-Version": "1.111.0",
                        "X-JLC-AccessToken": "NONE",
                    },
                    timeout: 15000
                }
            );

            if (loginResult.success && loginResult.data && loginResult.data.accessToken) {
                this.accessToken = loginResult.data.accessToken;
                this.saveCachedToken();
                $.log("账号[" + this.index + "] 登录成功, 用户: " + (loginResult.data.customerCode || ""));
                return true;
            }

            $.log("账号[" + this.index + "] login-by-code失败: " + JSON.stringify(loginResult));
            return false;
        } catch (e) {
            $.log("账号[" + this.index + "] 登录异常: " + (e.message || e));
            return false;
        }
    }

    async getSecretKey() {
        try {
            const { data: result } = await axios.post(API_BASE + "/api/integrated/secret/update", {}, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (result.success && result.data && result.data.keyId) {
                this.secretKey = result.data.keyId;
            }
        } catch (e) {
            // 忽略失败，使用默认值
        }
    }

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-JLC-AccessToken": this.accessToken,
            "X-JLC-MP-AppId": MINI_APP_ID,
            "X-JLC-ClientType": "MP-WEIXIN",
            "X-JLC-MP-Env": "release",
            "X-JLC-MP-Version": "1.111.0",
            "secretkey": this.secretKey || "61306231663964312d613530382d343163382d393065322d353439663864376462623030",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/139/page-frame.html",
        };
    }

    async checkToken() {
        try {
            const { data: result } = await axios.post(API_BASE + "/api/appPlatform/cas-auth/get-current-user", {}, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (result.success && result.data) {
                $.log("账号[" + this.index + "] Token有效, 用户: " + (result.data.customerCode || "未知"));
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    async getSignInStatus() {
        try {
            const { data: result } = await axios.get(API_BASE + "/api/activity/sign/getCurrentUserSignInConfig", {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (result.success && result.data) {
                const { haveSignIn, day } = result.data;
                $.log("账号[" + this.index + "] 签到状态: " + (haveSignIn ? "已签到" : "未签到") + ", 连续" + day + "天");
            }
        } catch (e) {
            $.log("账号[" + this.index + "] 查询签到状态失败: " + (e.message || e));
        }
    }

    async signIn() {
        try {
            const { data: signResult } = await axios.get(API_BASE + "/api/activity/sign/signIn?platformType=MP-WEIXIN&source=2", {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (signResult.success) {
                $.log("账号[" + this.index + "] 签到成功!");
            } else {
                const msg = signResult.message || signResult.errorCode || JSON.stringify(signResult);
                if (msg.indexOf("已签到") !== -1 || msg.indexOf("already") !== -1) {
                    $.log("账号[" + this.index + "] 今日已签到");
                } else {
                    $.log("账号[" + this.index + "] 签到失败: " + msg);
                }
            }
        } catch (e) {
            const status = e.response ? e.response.status : 0;
            if (status === 401) {
                $.log("账号[" + this.index + "] 今日已签到(401)");
            } else {
                $.log("账号[" + this.index + "] 签到异常: " + (e.message || e));
            }
        }
    }

    async getIntegral() {
        try {
            const { data: result } = await axios.get(API_BASE + "/api/activity/front/getCustomerIntegral", {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (result.success) {
                let points = result.data;
                if (typeof points === "object" && points !== null) {
                    points = points.integral || points.points || points.value || JSON.stringify(points);
                }
                $.log("账号[" + this.index + "] 当前积分: " + points);
            }
        } catch (e) {}
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] ? cache[this.openid].token : "";
    }
    saveCachedToken() {
        const cache = readTokenCache();
        cache[this.openid] = { token: this.accessToken, ts: Date.now() };
        writeTokenCache(cache);
    }
    removeCachedToken() {
        const cache = readTokenCache();
        delete cache[this.openid];
        writeTokenCache(cache);
        this.accessToken = "";
    }
}

// ====== 主入口 ======
async function main() {
    const envStr = process.env[ckName] || "";
    if (!envStr) {
        $.log("未配置 " + ckName + " 环境变量");
        return;
    }
    const openids = envStr.split(/[&\n]/).filter(s => s.trim());
    $.log("共 " + openids.length + " 个账号");
    for (const openid of openids) {
        try {
            await new Task(openid.trim()).run();
        } catch (e) {
            $.log("账号异常: " + (e.message || e));
        }
        await $.wait(3000 + Math.random() * 5000);
    }
}
main().catch(console.error);



// ========== 自动推送 ==========
process.on("beforeExit", async () => {
    try {
        const logs = global._pushLogs || [];
        if (logs.length > 0) {
            await sendPushNotify("jlc_sign 签到结果", logs.join("\n"));
        }
    } catch(e) {}
});
// ========== 自动推送结束 ==========
