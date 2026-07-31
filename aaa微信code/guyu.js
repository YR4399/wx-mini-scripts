/*
@Description: 谷雨 小程序签到
cron: 36 8 * * *
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const { sendPushNotify } = require("./_push_helper");
const $ = new Env("谷雨签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxda948f3be0afc375";
const API_BASE = "https://mall-mobile-v6.vecrp.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "guyu_token_cache.json");
const SECRET_KEY = "R6WbJ830wNsEdjH9GumwKYiYxHz0K9QD";
const SHOP_ID = "100186753";
const ACTIVITY_ID = "cdd30467-abb8-4944-8941-2879aa950a86";
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function uuid() {
    return crypto.randomUUID();
}

class Task {
    constructor(openid, idx) {
        this.openid = openid;
        this.idx = idx;
        this.token = null;
    }

    readCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const raw = fs.readFileSync(TOKEN_CACHE_FILE, "utf-8");
                const cache = JSON.parse(raw);
                return cache[this.openid] || null;
            }
        } catch (e) {}
        return null;
    }

    saveCache(token) {
        try {
            let cache = {};
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
            }
            cache[this.openid] = { token, ts: Date.now() };
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
        } catch (e) {}
    }

    clearCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
                delete cache[this.openid];
                fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
            }
        } catch (e) {}
    }

    sha1(str) {
        return crypto.createHash("sha1").update(str).digest("hex");
    }

    makeSign(method, data, params) {
        const ts = Date.now();
        let payload;
        if (method === "POST") {
            payload = { body: JSON.stringify(data), secretKey: SECRET_KEY, ts };
        } else {
            payload = Object.assign({}, params || {}, { secretKey: SECRET_KEY, ts });
        }
        const keys = Object.keys(payload).sort();
        const raw = keys.map((k) => k + payload[k]).join("");
        return { sign: this.sha1(raw), ts };
    }

    request(method, url, data, params) {
        const { sign, ts } = this.makeSign(method, data, params);
        const headers = {
            "Content-Type": "application/json;charset=UTF-8",
            token: this.token || "",
            sign: sign,
            ts: String(ts),
            startTime: String(ts),
            "X-TracedId": uuid(),
            appid: MINI_APP_ID,
            "xweb_xhr": "1",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
            Referer: `https://servicewechat.com/${MINI_APP_ID}/68/page-frame.html`,
        };

        let config = { method, url, headers, timeout: 15000 };
        if (method === "POST") {
            config.data = data;
        } else {
            config.params = params;
        }
        return axios.request(config);
    }

    async login(code) {
        const { data: result } = await axios.post(`${API_BASE}/mobile/wxAppLogin`, {
            code: String(code),
            appid: MINI_APP_ID,
            shopId: null,
            envVersion: "release",
            isEnterpriseWx: false,
            scene: 1168,
            referrerInfo: { appId: MINI_APP_ID },
        }, {
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
                appid: MINI_APP_ID,
                "xweb_xhr": "1",
                Referer: `https://servicewechat.com/${MINI_APP_ID}/68/page-frame.html`,
            },
            timeout: 15000,
        });

        if (result?.success && result?.result?.mobileToken) {
            this.token = result.result.mobileToken;
            this.saveCache(this.token);
            return true;
        }
        L.fail("[" + this.idx + "] 登录失败: " + result?.message || JSON.stringify(result) + "");
        return false;
    }

    async run() {
        // 1. 尝试缓存 token
        const cached = this.readCache();
        if (cached && cached.token) {
            this.token = cached.token;
            const alive = await this.checkToken();
            if (!alive) {
                this.token = null;
                this.clearCache();
            }
        }

        // 2. 无 token则登录（谷雨 996「请刷新重试」偶发，重试登录）
        if (!this.token) {
            let ok = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                const { data: codeRes } = await wechat.getCode(this.openid);
                if (!codeRes?.data?.code && !codeRes?.code) {
                    L.fail("[" + this.idx + "] WCS获取code失败");
                    return;
                }
                const code = codeRes.data?.code || codeRes.code;
                ok = await this.login(code);
                if (ok) break;
                if (attempt < 2) {
                    L.fail("[" + this.idx + "] 登录失败，第" + attempt + 1 + "次重试...");
                    await $.wait(2000 + attempt * 1500);
                }
            }
            if (!ok) return;
            await $.wait(2000);
        }

        // 3. 查询签到状态
        try {
            const { data: info } = await this.request("GET", `${API_BASE}/mobile/activity/sign/loadActivityInfo`, null, {
                activityId: ACTIVITY_ID,
                source: "undefined",
                shopId: SHOP_ID,
            });

            if (info?.success) {
                const points = info.result?.customerIntegral || "0";
                const signDays = info.result?.signDays ?? 0;
                L.info("[" + this.idx + "] 积分=" + points + " 连签=" + signDays + "天");

                if (!info.result?.canJoin) {
                    L.info("[" + this.idx + "] 今日已签到");
                    return;
                }
            }
        } catch (e) {
            L.fail("[" + this.idx + "] 查询签到状态异常: " + e.message + "");
            return;
        }

        // 4. 执行签到（token过期时自动重登，偶发 996/超时 自动重试）
        const isRetryable = (m) => /用户id|授权失败|996|当前请求异常|超时|timeout|ECONNRESET|socket|网络/.test(m || "");
        for (let retry = 0; retry < 3; retry++) {
            try {
                const today = $.time("yyyy-M-dd");
                const { data: signResult } = await this.request("POST", `${API_BASE}/mobile/activity/sign/sign`, {
                    shopId: SHOP_ID,
                    activityId: ACTIVITY_ID,
                    signDate: today,
                });

                if (signResult?.success) {
                    const reward = signResult.result?.integral || 2;
                    L.ok("[" + this.idx + "] 签到成功: +" + reward + "积分");
                    break;
                } else {
                    const msg = signResult?.msg || "未知错误";
                    // token过期：用户id不能为空 或 授权失败 → 清缓存重登
                    if (retry === 0 && (msg.includes("用户id") || msg.includes("授权失败"))) {
                        L.info("[" + this.idx + "] token疑似过期(" + msg + ")，清除缓存重新登录...");
                        this.clearCache();
                        this.token = null;
                        const { data: codeRes } = await wechat.getCode(this.openid);
                        const code = codeRes?.data?.code || codeRes?.code;
                        if (code) {
                            const ok = await this.login(code);
                            if (ok) { await $.wait(2000); continue; }
                        }
                        L.fail("[" + this.idx + "] 重新登录失败");
                        break;
                    }
                    if (isRetryable(msg) && retry < 2) {
                        L.fail("[" + this.idx + "] 签到失败(" + msg + ")，第" + retry + 1 + "次重试...");
                        await $.wait(2000 + retry * 1500);
                        continue;
                    }
                    L.fail("[" + this.idx + "] 签到失败: " + msg + "");
                    break;
                }
            } catch (e) {
                const m = e.message || String(e);
                if (isRetryable(m) && retry < 2) {
                    L.fail("[" + this.idx + "] 签到异常(" + m + ")，第" + retry + 1 + "次重试...");
                    await $.wait(2000 + retry * 1500);
                    continue;
                }
                L.fail("[" + this.idx + "] 签到异常: " + m + "");
                break;
            }
        }
    }

    async checkToken() {
        try {
            const { data } = await this.request("GET", `${API_BASE}/mobile/customer/getMyAllPoint`, null, {
                shopId: SHOP_ID,
            });
            return data?.success;
        } catch (e) {
            return false;
        }
    }
}

!(async () => {
  sectionLine("谷雨", "");
$.userIdx = 0;
    $.checkEnv(ckName);
    if (!process.env.wx_server_url || !process.env.wx_auth) {
        L.info("未配置WCS服务");
        return;
    }

    const openids = $.userList;
    L.info("共" + openids.length + "个账号");

    for (let i = 0; i < openids.length; i++) {
        const task = new Task(openids[i], i + 1);
        await task.run();
        if (i < openids.length - 1) {
            await $.wait(3000 + Math.random() * 5000);
        }
    }

})().catch((e) => $.log(e.message || e))
    .finally(async () => {
        try {
            const logs = $.notifyStr || [];
            if (logs.length > 0) {
                await sendPushNotify("谷雨签到结果", logs.join("\n"));
            }
        } catch (_e) {}
        process.exit(0);
    });
