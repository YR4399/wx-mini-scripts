/*
@Description: 嘉立创金豆商城签到
cron: 30 8 * * *
变量名：jlc
变量值：备注#accessToken，多账号&分隔
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

let ckName = "jlc";

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
    constructor(remark, accessToken) {
        this.index = $.userIdx++;
        this.remark = remark || "";
        this.accessToken = accessToken || "";
    }

    async run() {
        if (!this.accessToken) {
            $.log("账号[" + this.index + "] 未提供AccessToken");
            return;
        }

        $.log("账号[" + this.index + "] " + (this.remark || "开始"));

        // 1. 检查 token 是否有效
        if (!(await this.checkToken())) {
            $.log("账号[" + this.index + "] AccessToken无效或已过期");
            return;
        }

        // 2. 查询签到状态
        await this.getSignInStatus();

        // 3. 执行签到
        await this.signIn();

        // 4. 查询积分
        await this.getIntegral();
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
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/139/page-frame.html",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
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
            $.log("账号[" + this.index + "] Token验证失败: " + (e.message || e));
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
                const { haveSignIn, day, haveReceive } = result.data;
                $.log("账号[" + this.index + "] 签到状态: " + (haveSignIn ? "已签到" : "未签到") + ", 连续" + day + "天, 奖励" + (haveReceive ? "已领取" : "未领取"));
                return result.data;
            }
        } catch (e) {
            $.log("账号[" + this.index + "] 查询签到状态失败: " + (e.message || e));
        }
        return null;
    }

    async signIn() {
        try {
            const { data: signResult } = await axios.get(API_BASE + "/api/activity/sign/signIn", {
                headers: this.getHeaders(),
                timeout: 15000
            });
            if (signResult.success) {
                $.log("账号[" + this.index + "] 签到成功!");
                return true;
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
        return false;
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
}

// ====== 主入口 ======
async function main() {
    const envStr = process.env[ckName] || "";
    if (!envStr) {
        $.log("未配置 " + ckName + " 环境变量");
        $.log("");
        $.log("配置方式：");
        $.log("  变量名: jlc");
        $.log("  变量值: 备注#accessToken，多账号用&分隔");
        $.log("  示例: 我的账号#a9e5962f-b38b-4b7a-bdf0-051215e521b4");
        $.log("");
        $.log("AccessToken获取方式：");
        $.log("  打开嘉立创小程序 → 抓包 → 找到 X-JLC-AccessToken 请求头");
        return;
    }

    const accounts = envStr.split(/[&\n]/).filter(s => s.trim());
    $.log("共 " + accounts.length + " 个账号");

    for (const account of accounts) {
        try {
            const parts = account.trim().split("#");
            const remark = parts[0] || "";
            const accessToken = parts[1] || parts[0] || "";
            await new Task(remark, accessToken).run();
        } catch (e) {
            $.log("账号异常: " + (e.message || e));
        }
        await $.wait(3000 + Math.random() * 5000);
    }
}
main().catch(console.error);
