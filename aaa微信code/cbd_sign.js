// ========== 推送通知 ==========
// 已禁用
// ========== 推送通知结束 ==========

/*
@Description: 茶百道签到
cron: 30 9 * * *
*/

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require("axios");
// ========== SSL和代理修复 ==========
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
// ========== SSL和代理修复结束 ==========


axios.defaults.proxy = false;

const $ = new Env("茶百道签到");
const ckName = "wx_opinion";

const MINI_APP_ID = "wx2804355dbf8d15c3";
const API_BASE = "https://chabaidao-gateway2.shuxinyc.com";
const MARKETING_BASE = "https://md-h5-gateway.shuxinyc.com";
const GROUP_ID = "317964";
const MEMBER_SYSTEM_ID = "21";
// 兜底用当前真实 businessId（每周活动轮换，自动发现优先；此值仅当发现接口全部失败时使用）
const BUSINESS_ID = process.env.cbd_business_id || "72WpoD2wdefp";

// 抓包对齐: 2026-07-29 线上版本
const VERSION_CODE = "34710";
const VERSION_NAME = "3.4.710";
const REFERRER_VER = "1242";

const UA = "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 XWEB/1500047 MMWEBSDK/20260502 MM";

class WeChatServer {
    constructor(options) {
        this.serverUrl = (options.url || "http://host.docker.internal:18788").replace(/\/$/, "");
        this.appid = options.appid;
        this.auth = options.auth || "";
    }

    getCode(openid) {
        return axios.post(`${this.serverUrl}/wx/code`, { appid: this.appid, openid }, {
            headers: { auth: this.auth }, timeout: 60000
        });
    }
}

class Task {
    constructor(user, index) {
        this.user = user;
        this.index = index;
        this.csession = null;
        this.cookiesByHost = {};   // 维护阿里云WAF的 acw_tc cookie
    }

    genTraceId() {
        return crypto.randomUUID();
    }

    // 从响应头提取 acw_tc (阿里云WAF风控cookie) 并按 host 缓存
    saveCookies(host, resp) {
        try {
            let sc = resp && resp.headers && resp.headers['set-cookie'];
            if (!sc) return;
            const arr = Array.isArray(sc) ? sc : [sc];
            const acw = arr.map(c => String(c).split(';')[0]).filter(c => c.startsWith('acw_tc='));
            if (acw.length) this.cookiesByHost[host] = acw.join('; ');
        } catch (_) {}
    }

    getHeaders(host) {
        const h = {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "CSESSION": this.csession || "",
            "versionCode": VERSION_CODE,
            "versionName": VERSION_NAME,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${REFERRER_VER}/page-frame.html`,
            "Host": host.replace("https://", "").replace("http://", ""),
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Dest": "empty",
            "xweb_xhr": "1",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive"
        };
        const ck = this.cookiesByHost[host];
        if (ck) h["Cookie"] = ck;
        return h;
    }

    async login(wechat, openid) {
        // Step 1: 获取code并首次登录 (pureSign=true, token="")
        const { data: codeData1 } = await wechat.getCode(openid);
        const code1 = codeData1?.data?.code || codeData1?.code;
        if (!code1) throw new Error(`获取code失败`);

        const resp1 = await axios.post(`${API_BASE}/hll-auth-client/oauth2/login/get/info`, {
            token: "",
            groupId: GROUP_ID,
            memberSystemId: MEMBER_SYSTEM_ID,
            code: code1,
            appId: MINI_APP_ID,
            pureSign: true,
            traceId: this.genTraceId()
        }, {
            headers: this.getHeaders(API_BASE),
            timeout: 30000,
            validateStatus: () => true
        });
        this.saveCookies(API_BASE, resp1);

        if (resp1.data?.code !== "000" || !resp1.data?.data?.token) {
            throw new Error(`首次登录失败: ${JSON.stringify(resp1.data)}`);
        }

        this.csession = resp1.data.data.token;
        L.ok("账号[" + this.index + "] 首次登录成功");

        // Step 2: 获取新code并刷新登录 (pureSign=false, token=旧CSESSION)
        await $.wait(800 + Math.random() * 500);
        const { data: codeData2 } = await wechat.getCode(openid);
        const code2 = codeData2?.data?.code || codeData2?.code;
        if (!code2) {
            L.fail("账号[" + this.index + "] 获取刷新code失败，使用首次登录");
            return resp1.data.data;
        }

        const resp2 = await axios.post(`${API_BASE}/hll-auth-client/oauth2/login/get/info`, {
            token: this.csession,
            groupId: GROUP_ID,
            memberSystemId: MEMBER_SYSTEM_ID,
            code: code2,
            appId: MINI_APP_ID,
            pureSign: false,
            traceId: this.genTraceId()
        }, {
            headers: this.getHeaders(API_BASE),
            timeout: 30000,
            validateStatus: () => true
        });
        this.saveCookies(API_BASE, resp2);

        if (resp2.data?.code === "000" && resp2.data?.data?.token) {
            this.csession = resp2.data.data.token;
            L.ok("账号[" + this.index + "] 刷新登录成功");
            return resp2.data.data;
        } else {
            L.fail("账号[" + this.index + "] 刷新登录失败: " + JSON.stringify(resp2.data).substring(0, 100) + "");
            return resp1.data.data;
        }
    }

    async fetchBusinessId(openId) {
        // 如果手动指定了 businessId，优先使用
        if (process.env.cbd_business_id) return process.env.cbd_business_id;

        // 从缓存文件读取（每周有效）
        const cacheFile = path.join(__dirname, ".cbd_business_id");
        try {
            if (fs.existsSync(cacheFile)) {
                const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
                const age = Date.now() - (cache.time || 0);
                // 缓存6天有效
                if (age < 6 * 86400 * 1000 && cache.bId) {
                    L.info("使用缓存 businessId: " + cache.bId + "");
                    return cache.bId;
                }
            }
        } catch (_) {}

        // 从广告配置自动发现 (CBD_093_member_weeksop 周签到的 bId)
        try {
            const host = "chabaidao-gateway2.shuxinyc.com";
            const headers = this.getHeaders(host);
            headers["Accept"] = "application/json";
            const resp = await axios.post(`${API_BASE}/cbd-advert-service/resBit/front/getAdContent`, {
                appId: MINI_APP_ID,
                appUserId: openId || "",
                resBitCodeList: ["CBD_093_member_weeksop"],
                dropEnd: 1,
                appVersion: parseInt(VERSION_CODE, 10),
                orderType: 1,
                diningMode: 1,
                traceId: this.genTraceId()
            }, { headers, timeout: 15000, validateStatus: () => true });
            this.saveCookies(host, resp);

            const body = JSON.stringify(resp.data);
            // 匹配 bId=xxxx (多种格式)
            let m = body.match(/type=3[^"'\s]*bId=([A-Za-z0-9]+)/);
            if (!m) m = body.match(/"businessId":"([A-Za-z0-9]+)"/);
            if (!m) m = body.match(/"bId":"([A-Za-z0-9]+)"/);
            if (m) {
                L.info("自动发现签到 businessId: " + m[1] + "");
                // 缓存
                try { fs.writeFileSync(cacheFile, JSON.stringify({ bId: m[1], time: Date.now() })); } catch (_) {}
                return m[1];
            }
        } catch (e) {
            L.fail("获取 businessId 失败: " + e.message + "");
        }
        L.info("使用默认 businessId (兜底): " + BUSINESS_ID);
        return BUSINESS_ID;
    }

    async signIn(businessId) {
        const host = "md-h5-gateway.shuxinyc.com";
        const resp = await axios.post(`${MARKETING_BASE}/marketing/minip/activity/join/signIn`, {
            businessId: businessId || BUSINESS_ID,
            activityJoinSource: 0,
            traceId: this.genTraceId()
        }, {
            headers: this.getHeaders(host),
            timeout: 30000,
            validateStatus: () => true
        });
        this.saveCookies(host, resp);
        return resp.data;
    }

    async run() {
        const wechat = new WeChatServer({
            url: process.env.wx_server_url || "http://host.docker.internal:18788",
            appid: MINI_APP_ID,
            auth: process.env.wx_auth || ""
        });

        const loginData = await this.login(wechat, this.user);
        const openId = loginData?.openId || "";

        // 自动发现当前周的 businessId (带重试)
        let businessId = await this.fetchBusinessId(openId) || BUSINESS_ID;

        // 签到
        await $.wait(1000 + Math.random() * 1500);
        let signResult = await this.signIn(businessId);

        // 如果 businessId 过期，清除缓存并重新获取
        if (signResult.code !== "000" && !(signResult.msg || "").includes("已签")) {
            L.fail("businessId 可能已失效，重新获取...");
            const cacheFile = path.join(__dirname, ".cbd_business_id");
            try { fs.unlinkSync(cacheFile); } catch (_) {}
            const newBid = await this.fetchBusinessId(openId) || BUSINESS_ID;
            if (newBid !== businessId) {
                await $.wait(1000);
                signResult = await this.signIn(newBid);
            }
        }

        if (signResult.code === "000") {
            const gifts = signResult.data?.marketingGiftConfCOList || [];
            const giftNames = gifts.map(g => {
                const items = g.giftList || [];
                return items.map(i => {
                    if (i.giftType === 3) return `${i.point}熊猫币`;
                    return g.giftName || "奖励";
                }).join("+");
            }).join(", ");
            L.ok("账号[" + this.index + "] 签到成功! 获得: " + (giftNames || "奖励") + "");
        } else {
            const msg = signResult.msg || JSON.stringify(signResult);
            if (msg.includes("已签") || msg.includes("已参与")) {
                L.info("账号[" + this.index + "] 今日已签到");
            } else {
                L.fail("账号[" + this.index + "] 签到失败: " + msg + "");
            }
        }

        L.info("账号[" + this.index + "] 任务完成");
    }
}

!(async () => {
  sectionLine("茶白道", "");

$.userIdx = 0;
    $.checkEnv(ckName);

    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
        if (i < $.userList.length - 1) {
            await $.wait(3000 + Math.random() * 5000);
        }
    }
})()
    .catch((e) => console.log(e))
    .finally(async () => {
    // PushPlus 推送
    try {
        const logs = $.notifyStr || [];
        const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN || "";
        if (logs.length > 0 && token) {
            await axios.post("http://www.pushplus.plus/send", {
                token, title: "茶百道签到", content: logs.join("\n"), template: "txt"
            }, { timeout: 10000 });
        }
    } catch (_) {}
    $.sendMsg = async () => {}; $.log = async () => {};
    process.exit(0);
});
