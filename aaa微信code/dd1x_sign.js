/*
@Description: 铛铛一下 签到+抽奖
cron: 30 8 * * *
*/

const { Env } = require("../tools/env.js");
const $ = new Env("铛铛一下");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxe378d2d7636c180e";
const API_BASE = "https://vues.dd1x.cn";
const CHANNEL_ID = "154";
const TOKEN_CACHE_FILE = path.join(__dirname, "dd1x_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

axios.defaults.proxy = false;

class Task {
    constructor(openid, index) {
        this.index = index;
        this.openid = openid;
        this.token = null;
        this.mid = null;
        this.nickname = null;
    }

    getHeaders() {
        const headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "xweb_xhr": "1",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/832/page-frame.html`,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        };
        if (this.token) {
            headers["token"] = this.token;
        }
        return headers;
    }

    async request(url, options = {}) {
        const { method = "GET", params, data, headers: extraHeaders } = options;
        const config = {
            method,
            url: url.startsWith("http") ? url : `${API_BASE}${url}`,
            headers: { ...this.getHeaders(), ...extraHeaders },
            timeout: 30000,
            validateStatus: () => true,
        };
        if (params) config.params = params;
        if (data) config.data = data;
        const resp = await axios(config);
        return resp.data;
    }

    loadTokenCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
                if (cache[this.openid] && cache[this.openid].token) {
                    return cache[this.openid];
                }
            }
        } catch (e) {}
        return null;
    }

    saveTokenCache(token, mid, nickname) {
        try {
            let cache = {};
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
            }
            cache[this.openid] = { token, mid, nickname, savedAt: Date.now() };
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2));
        } catch (e) {}
    }

    clearTokenCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
                delete cache[this.openid];
                fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2));
            }
        } catch (e) {}
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.data?.code || data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        $.log(`账号[${this.index}] 获取code登录...`);
        const code = await this.getLoginCode();
        const result = await this.request(`/wechat/login`, {
            params: { code, channelId: CHANNEL_ID },
        });
        if (result.code !== 0 || !result.data?.token) {
            throw new Error(`登录失败: ${JSON.stringify(result)}`);
        }
        this.token = result.data.token;
        this.mid = result.data.mid;
        this.nickname = result.data.nickname || "";
        this.saveTokenCache(this.token, this.mid, this.nickname);
        $.log(`账号[${this.index}] ${this.nickname} 登录成功 mid=${this.mid}`);
    }

    async verifyToken() {
        const result = await this.request(`/api/v2/get_sign_list`);
        if (result.code !== 0) {
            $.log(`账号[${this.index}] token失效，重新登录`);
            this.clearTokenCache();
            await this.loginByWxCode();
        } else {
            $.log(`账号[${this.index}] ${this.nickname} token有效`);
        }
    }

    async getSignList() {
        const result = await this.request(`/api/v2/get_sign_list`);
        if (result.code !== 0) {
            throw new Error(`获取签到列表失败: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async signJoin() {
        const result = await this.request(`/api/v2/sign_join`);
        if (result.code !== 0) {
            throw new Error(`签到失败: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async getLotteryInfo() {
        const result = await this.request(`/front/activity/get_lottery_info`, {
            params: { id: 13, channelId: CHANNEL_ID },
        });
        if (result.code !== 0) {
            throw new Error(`获取抽奖信息失败: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async doLottery() {
        // 第1步：抽奖，获取 record_id
        const result = await this.request(`/front/activity/get_lottery_result`, {
            params: { id: 13 },
        });
        if (result.code !== 0) {
            throw new Error(`抽奖失败: ${JSON.stringify(result)}`);
        }
        const { record_id, prizeName } = result.data;

        // 第2步：确认领取奖品
        if (record_id) {
            const updateResult = await this.request(`/front/activity/update_lottery_result`, {
                params: { id: record_id },
            });
            $.log(`账号[${this.index}] 确认领取: ${JSON.stringify(updateResult)}`);
        }

        return { record_id, prizeName };
    }

    async getMemberInfo() {
        const result = await this.request(`/api/v2/get_member_info`);
        if (result.code !== 0) {
            throw new Error(`获取会员信息失败: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async getAccountDetailed() {
        const result = await this.request(`/api/h/get_account_detailed`);
        if (result.code !== 0) {
            throw new Error(`获取账户详情失败: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async run() {
        // 1. 尝试加载缓存 token
        const cached = this.loadTokenCache();
        if (cached) {
            this.token = cached.token;
            this.mid = cached.mid;
            this.nickname = cached.nickname || "";
            $.log(`账号[${this.index}] ${this.nickname} 使用缓存token`);
            await this.verifyToken();
        } else {
            await this.loginByWxCode();
        }

        // 2. 获取初始余额
        let initialMoney = 0;
        try {
            const memberInfo = await this.getMemberInfo();
            initialMoney = memberInfo.money || 0;
            $.log(`账号[${this.index}] 初始余额: ${initialMoney}元`);
        } catch (e) {
            $.log(`账号[${this.index}] 获取初始余额失败: ${e.message}`);
        }

        // 2. 签到
        try {
            const signList = await this.getSignList();
            const signDayNum = signList.signDayNum || 0;
            $.log(`账号[${this.index}] 已连续签到 ${signDayNum} 天`);

            if (signList.signDayInfos?.[0]?.dayStatus === 0) {
                const signResult = await this.signJoin();
                $.log(`账号[${this.index}] 签到成功! 奖品: ${signResult.name || "现金红包"}`);
            } else {
                $.log(`账号[${this.index}] 今日已签到`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 签到异常: ${e.message}`);
        }

        // 3. 抽奖（每天5次免费机会）
        try {
            const lotteryInfo = await this.getLotteryInfo();
            const goodsCount = lotteryInfo.lottery?.lotteryGoods?.length || 0;
            const memberCount = lotteryInfo.member_count || "0";
            $.log(`账号[${this.index}] 抽奖信息: ${goodsCount}个奖品, ${memberCount}人参与`);

            const maxLottery = 5;
            for (let j = 0; j < maxLottery; j++) {
                try {
                    await $.wait(1500 + Math.random() * 2000);
                    const lotteryResult = await this.doLottery();
                    $.log(`账号[${this.index}] 第${j + 1}次抽奖: ${lotteryResult.prizeName || "谢谢参与"}`);
                } catch (e) {
                    $.log(`账号[${this.index}] 第${j + 1}次抽奖异常: ${e.message}`);
                    break;
                }
            }
        } catch (e) {
            $.log(`账号[${this.index}] 抽奖异常: ${e.message}`);
        }

        // 4. 获取最终余额
        try {
            const memberInfo = await this.getMemberInfo();
            const finalMoney = memberInfo.money || 0;
            const moneyDiff = (finalMoney - initialMoney).toFixed(2);
            $.log(`账号[${this.index}] 最终余额: ${finalMoney}元 (变化: ${moneyDiff >= 0 ? '+' : ''}${moneyDiff}元)`);
        } catch (e) {
            $.log(`账号[${this.index}] 获取最终余额失败: ${e.message}`);
        }

        $.log(`账号[${this.index}] 任务完成`);
    }
}

!(async () => {
    $.checkEnv(ckName);
    const accounts = process.env[ckName].split("&").filter(Boolean);
    $.log(`共找到${accounts.length}个账号`);

    for (let i = 0; i < accounts.length; i++) {
        const openid = accounts[i].trim();
        if (!openid) continue;
        try {
            const task = new Task(openid, i + 1);
            await task.run();
        } catch (e) {
            $.log(`账号[${i + 1}] 运行异常: ${e.message}`);
        }
        if (i < accounts.length - 1) {
            const wait = 3000 + Math.random() * 5000;
            $.log(`等待 ${(wait / 1000).toFixed(1)} 秒...`);
            await $.wait(wait);
        }
    }
})()
    .catch((e) => $.log(`运行异常: ${e.message}`))
    .finally(() => $.done());
