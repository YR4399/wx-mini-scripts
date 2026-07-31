/*
@Description: 尔木淘官方商城 签到
cron: 20 8 * * *
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const $ = new Env("尔木淘签到(旧店)");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx49edfe9a54fe0fa5";
const KDT_ID = "145921631";
const APP_VERSION = "2.240.6";
const API_BASE = "https://h5.youzan.com";
const UIC_BASE = "https://uic.youzan.com";
const TOKEN_CACHE = path.join(__dirname, "ermutao_token.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";

axios.defaults.proxy = false;

function uuid() {
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ========== Task 类 ==========
class Task {
    constructor(openid, index) {
        this.openid = openid;
        this.index = index;
        this.token = null;
        this.sessionId = null;
        this.cache = {};
    }

    loadCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE)) {
                const data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
                const entry = data[this.openid];
                if (entry) {
                    this.cache = entry;
                    this.token = entry.accessToken;
                    this.sessionId = entry.sessionId;
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    saveCache() {
        try {
            let data = {};
            if (fs.existsSync(TOKEN_CACHE)) data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
            data[this.openid] = { accessToken: this.token, sessionId: this.sessionId, time: Date.now() };
            fs.writeFileSync(TOKEN_CACHE, JSON.stringify(data), "utf8");
        } catch (_) {}
    }

    getExtraData() {
        return JSON.stringify({
            sid: this.sessionId || "",
            version: APP_VERSION,
            clientType: "weapp-miniprogram",
            client: "weapp",
            bizEnv: "",
            uuid: uuid(),
            ftime: Date.now(),
        });
    }

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/66/page-frame.html`,
            "Extra-Data": this.getExtraData(),
            "xweb_xhr": "1",
            "app-mode": "default",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        };
    }

    buildQuery() {
        return { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token || "" };
    }

    // ========== WCS code ==========
    async getWxCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.data?.code || data?.code;
        if (!code) throw new Error(`WCS 获取 code 失败: ${JSON.stringify(data)}`);
        return code;
    }

    // ========== UIC 登录 ==========
    async login() {
        if (this.loadCache()) {
            $.log(`账号[${this.index}] 使用缓存 token`);
            const valid = await this.validateToken();
            if (valid) return true;
            $.log(`账号[${this.index}] 缓存失效，重新登录`);
            this.token = null;
        }

        const code = await this.getWxCode();
        $.log(`账号[${this.index}] 获取 code 成功`);

        const resp = await axios.post(`${UIC_BASE}/passport/general/auth.json`, {
            appId: MINI_APP_ID,
            code,
            platformName: "weapp",
            signature: "windows",
            clientBiz: "weapp_wsc",
            inWsc: true,
            kdtId: KDT_ID,
            extraBizData: {
                enterOptions: {
                    extKdtId: parseInt(KDT_ID),
                    path: "pages/home/dashboard/index",
                    query: {},
                    scene: 1007,
                    referrerInfo: {},
                    apiCategory: "default",
                },
                guideBizDataMap: { from_params: "" },
                sceneData: {},
            },
        }, {
            params: { kdt_id: KDT_ID, app_id: MINI_APP_ID },
            headers: this.getHeaders(),
            timeout: 30000,
        });

        const d = resp.data;
        if (d.code !== 0 || !d.data?.accessToken) {
            throw new Error(`登录失败: ${JSON.stringify(d)}`);
        }
        this.token = d.data.accessToken;
        this.sessionId = d.data.sessionId;
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功: ${d.data.nickname || d.data.mobile}`);
        return true;
    }

    async validateToken() {
        try {
            const resp = await axios.post(`${API_BASE}/wscuser/membercenter/present.json`, null, {
                params: this.buildQuery(),
                headers: this.getHeaders(),
                timeout: 15000,
                validateStatus: () => true,
            });
            return resp.data?.code === 0;
        } catch (_) { return false; }
    }

    // ========== 签到 ==========
    async sign() {
        // Step 1: 获取签到页面，拿到 checkinId
        const pageResp = await axios.get(`${API_BASE}/wscump/checkin/show_checkin_page_v2.json`, {
            params: this.buildQuery(),
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const pageData = pageResp.data;
        if (pageData.code !== 0) {
            $.log(`账号[${this.index}] 获取签到页面失败: ${JSON.stringify(pageData).slice(0, 100)}`);
            return false;
        }
        const checkinId = pageData.data?.checkinId || pageData.data?.checkin_id;
        if (!checkinId) {
            $.log(`账号[${this.index}] 未找到 checkinId`);
            return false;
        }

        // Step 2: 执行签到
        const signResp = await axios.get(`${API_BASE}/wscump/checkin/checkinV2.json`, {
            params: { ...this.buildQuery(), checkinId },
            headers: this.getHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const signData = signResp.data;
        if (signData.code === 0 && signData.data?.success) {
            const award = signData.data.list || signData.data.awardList || [];
            const desc = award.map(a => a.infos?.title || a.title || "").join(", ") || "奖励";
            $.log(`账号[${this.index}] 签到成功 获得: ${desc}`);
            return true;
        }
        const msg = signData.msg || signData.message || JSON.stringify(signData);
        if (msg.includes("已签") || msg.includes("重复") || msg.includes("最大")) {
            $.log(`账号[${this.index}] 今日已签到`);
            return true;
        }
        $.log(`账号[${this.index}] 签到失败: ${msg.slice(0, 100)}`);
        return false;
    }

    // ========== 主流程 ==========
    async run() {
        $.log(`\n========== 尔木淘 账号[${this.index}] ${this.openid.slice(0, 8)}*** ==========`);
        await this.login();
        await $.wait(500 + Math.random() * 1000);
        await this.sign();
        $.log(`账号[${this.index}] 任务完成`);
    }
}

// ========== 主入口 ==========
!(async () => {
$.userIdx = 0;
    $.checkEnv(ckName);
    const accounts = $.userList;
    $.log(`共找到${accounts.length}个账号`);

    for (let i = 0; i < accounts.length; i++) {
        try {
            await new Task(accounts[i], i + 1).run();
        } catch (e) {
            $.log(`账号[${i + 1}] 异常: ${e.response?.status || e.message || e}`);
        }
        if (i < accounts.length - 1) await $.wait(2000 + Math.random() * 3000);
    }
})().catch((e) => $.log(e.message || e))
    .finally(async () => {
        try {
            const _logs = $.notifyStr || [];
            if (_logs.length > 0) await sendPushNotify("尔木淘签到(旧店)", _logs.join("\n"));
        } catch (_) {}
        $.done && $.done();
    });
