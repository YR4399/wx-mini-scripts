// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

/*
@Description: 茶百道签到
cron: 30 9 * * *
*/

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
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
const BUSINESS_ID = "QhIwqqaafPIo";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";

class WeChatServer {
    constructor(options) {
        this.serverUrl = (options.url || "http://127.0.0.1:8787").replace(/\/$/, "");
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
    }

    getHeaders(host) {
        return {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "CSESSION": this.csession || "",
            "versionCode": "34613",
            "versionName": "3.4.613",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/1154/page-frame.html`,
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
            pureSign: true
        }, {
            headers: this.getHeaders(API_BASE),
            timeout: 30000,
            validateStatus: () => true
        });

        if (resp1.data?.code !== "000" || !resp1.data?.data?.token) {
            throw new Error(`首次登录失败: ${JSON.stringify(resp1.data)}`);
        }

        this.csession = resp1.data.data.token;
        $.log(`账号[${this.index}] 首次登录成功`);

        // Step 2: 获取新code并刷新登录 (pureSign=false, token=旧CSESSION)
        await $.wait(800 + Math.random() * 500);
        const { data: codeData2 } = await wechat.getCode(openid);
        const code2 = codeData2?.data?.code || codeData2?.code;
        if (!code2) {
            $.log(`账号[${this.index}] 获取刷新code失败，使用首次登录`);
            return resp1.data.data;
        }

        const resp2 = await axios.post(`${API_BASE}/hll-auth-client/oauth2/login/get/info`, {
            token: this.csession,
            groupId: GROUP_ID,
            memberSystemId: MEMBER_SYSTEM_ID,
            code: code2,
            appId: MINI_APP_ID,
            pureSign: false
        }, {
            headers: this.getHeaders(API_BASE),
            timeout: 30000,
            validateStatus: () => true
        });

        if (resp2.data?.code === "000" && resp2.data?.data?.token) {
            this.csession = resp2.data.data.token;
            $.log(`账号[${this.index}] 刷新登录成功, encryptedUserPhone: ${resp2.data.data.encryptedUserPhone ? "有" : "无"}`);
            return resp2.data.data;
        } else {
            $.log(`账号[${this.index}] 刷新登录失败: ${JSON.stringify(resp2.data).substring(0, 100)}`);
            return resp1.data.data;
        }
    }

    async signIn() {
        const resp = await axios.post(`${MARKETING_BASE}/marketing/minip/activity/join/signIn`, {
            id: "",
            businessId: BUSINESS_ID,
            activityJoinSource: 0,
            shopId: -1
        }, {
            headers: this.getHeaders("md-h5-gateway.shuxinyc.com"),
            timeout: 30000,
            validateStatus: () => true
        });
        return resp.data;
    }

    async run() {
        const wechat = new WeChatServer({
            url: process.env.wx_server_url || "http://127.0.0.1:8787",
            appid: MINI_APP_ID,
            auth: process.env.wx_auth || ""
        });

        await this.login(wechat, this.user);

        // 签到
        await $.wait(1000 + Math.random() * 1500);
        const signResult = await this.signIn();

        if (signResult.code === "000") {
            const gifts = signResult.data?.marketingGiftConfCOList || [];
            const giftNames = gifts.map(g => {
                const items = g.giftList || [];
                return items.map(i => {
                    if (i.giftType === 3) return `${i.point}熊猫币`;
                    return g.giftName || "奖励";
                }).join("+");
            }).join(", ");
            $.log(`账号[${this.index}] 签到成功! 获得: ${giftNames || "奖励"}`);
        } else {
            const msg = signResult.msg || JSON.stringify(signResult);
            if (msg.includes("已签") || msg.includes("已参与")) {
                $.log(`账号[${this.index}] 今日已签到`);
            } else {
                $.log(`账号[${this.index}] 签到失败: ${msg}`);
            }
        }

        $.log(`账号[${this.index}] 任务完成`);
    }
}

!(async () => {
    
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
    // ========== push result ==========
    try {
        const _logs = $.notifyStr || [];
        if (_logs.length > 0) {
            await sendPushNotify("茶百道签到", _logs.join("\n"));
        }
    } catch(_e) {}
    // ========== push end ==========
    $.sendMsg = async () => {}; $.log = async () => {};
    process.exit(0);
});
