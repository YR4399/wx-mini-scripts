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
const API_BASE = "https://m.jlc.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "jlc_token_cache.json");
const SECRET_KEY = "61306231663964312d613530382d343163382d393065322d353439663864376462623030";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";

let ckName = "wx_opinion";

// 支持两种模式：
// 1. 手动传入 AccessToken: jlc=备注#openid#accessToken
// 2. WCS 自动获取（需要 WCS 支持嘉立创小程序登录）

// ====== WCS 初始化 ======
const WeChatServer = require("./wcs.js");
const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

// 解析手动传入的 token
function parseManualTokens() {
    const envStr = process.env.jlc || "";
    if (!envStr) return [];
    return envStr.split(/[&\n]/).filter(s => s.trim()).map(item => {
        const parts = item.split("#");
        return {
            remark: parts[0] || "",
            openid: parts[1] || "",
            accessToken: parts[2] || "",
        };
    });
}

// ====== Token 缓存 ======
function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) { return {}; }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) { $.log(`写入token缓存失败: ${e.message || e}`); }
}

// ====== 任务类 ======
class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.accessToken = "";
        this.user = {};
    }

    async run() {
        // 1. 尝试缓存 token
        const cached = this.getCachedToken();
        if (cached) {
            this.accessToken = cached;
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        // 2. 登录
        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) return;
        }

        // 3. 查询签到状态
        await this.getSignInStatus();

        // 4. 执行签到
        await this.signIn();

        // 5. 查询积分
        await this.getIntegral();
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
            
            // 嘉立创使用 CAS 认证，通过 code 获取 AccessToken
            const { data: result } = await axios.get(`${API_BASE}/api/appPlatform/cas-auth/get-current-user`, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            if (result.success && result.data) {
                this.accessToken = result.data.accessToken || result.data.token || "";
                if (this.accessToken) {
                    this.saveCachedToken();
                    $.log(`账号[${this.index}] 登录成功`);
                } else {
                    $.log(`账号[${this.index}] 登录失败: 未获取到token`);
                }
            } else {
                $.log(`账号[${this.index}] 登录失败: ${result.message || JSON.stringify(result)}`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 登录异常: ${e.message || e}`);
        }
    }

    async getSignInStatus() {
        try {
            const { data: result } = await axios.get(`${API_BASE}/api/activity/sign/getCurrentUserSignInConfig`, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            if (result.success && result.data) {
                const { haveSignIn, day, haveReceive } = result.data;
                $.log(`账号[${this.index}] 签到状态: ${haveSignIn ? "已签到" : "未签到"}, 连续${day}天, 奖励${haveReceive ? "已领取" : "未领取"}`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到状态失败: ${e.message || e}`);
        }
    }

    async signIn() {
        try {
            // 获取签到配置
            const { data: configResult } = await axios.get(`${API_BASE}/api/activity/sign/getSignInConfig`, {
                params: { platformType: "MP-WEIXIN", configCode: "sign002" },
                headers: this.getHeaders(),
                timeout: 15000
            });

            if (!configResult.success || !configResult.data) {
                $.log(`账号[${this.index}] 获取签到配置失败`);
                return;
            }

            // 执行签到
            const { data: signResult } = await axios.post(`${API_BASE}/api/activity/sign/signIn`, {
                signModeCode: "sign002"
            }, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            if (signResult.success) {
                $.log(`账号[${this.index}] 签到成功!`);
            } else {
                const msg = signResult.message || signResult.errorCode || "";
                if (msg.includes("已签到") || msg.includes("already")) {
                    $.log(`账号[${this.index}] 今日已签到`);
                } else {
                    $.log(`账号[${this.index}] 签到失败: ${msg}`);
                }
            }
        } catch (e) {
            $.log(`账号[${this.index}] 签到异常: ${e.message || e}`);
        }
    }

    async getIntegral() {
        try {
            const { data: result } = await axios.get(`${API_BASE}/api/activity/front/getCustomerIntegral`, {
                headers: this.getHeaders(),
                timeout: 15000
            });

            if (result.success && result.data) {
                $.log(`账号[${this.index}] 当前积分: ${result.data}`);
            }
        } catch (e) {
            // 忽略积分查询失败
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
            "secretkey": SECRET_KEY,
            "xweb_xhr": "1",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/139/page-frame.html`,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        };
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid]?.token;
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

    async checkToken() {
        try {
            const { data: result } = await axios.get(`${API_BASE}/api/appPlatform/cas-auth/get-current-user`, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            return result.success;
        } catch (e) { return false; }
    }
}

// ====== 主入口 ======
async function main() {
    // 检查手动 token
    const manualTokens = parseManualTokens();

    if (manualTokens.length > 0) {
        // 手动 token 模式
        $.log(`使用手动 token 模式，共 ${manualTokens.length} 个账号`);

        for (const account of manualTokens) {
            try {
                const task = new Task(account.openid);
                task.accessToken = account.accessToken;
                if (account.remark) {
                    $.log(`[${account.remark}] 开始执行`);
                }
                await task.run();
            } catch (e) {
                $.log(`账号异常: ${e.message || e}`);
            }
            await $.wait(3000 + Math.random() * 5000);
        }
    } else {
        // WCS 自动模式
        const envStr = process.env[ckName] || "";
        if (!envStr) {
            $.log(`未配置 ${ckName} 环境变量 或 jlc 环境变量`);
            $.log(``);
            $.log(`使用方式：`);
            $.log(`  方式1 (手动token): set jlc=备注#openid#accessToken`);
            $.log(`  方式2 (WCS自动):  set wx_opinion=openid`);
            return;
        }

        const openids = envStr.split(/[&\n]/).filter(s => s.trim());
        $.log(`使用 WCS 自动模式，共 ${openids.length} 个账号`);

        for (const openid of openids) {
            try {
                await new Task(openid.trim()).run();
            } catch (e) {
                $.log(`账号异常: ${e.message || e}`);
            }
            await $.wait(3000 + Math.random() * 5000);
        }
    }
}

main().catch(console.error);