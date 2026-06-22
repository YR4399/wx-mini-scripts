/*
@Description: 燕印象燕窝签到
cron: 15 8 * * *
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const $ = new Env("燕印象燕窝签到");
const axios = require("axios");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx875202908b8a99cd";
const API_BASE = "https://xls.chengmenghudong.net.cn";
const SHOP_ID = "1636";

const wx_server_url = process.env.wx_server_url || "";
const wx_auth = process.env.wx_auth || "";
const wcs = new WeChatServer({ url: wx_server_url, appid: MINI_APP_ID, auth: wx_auth });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class YanyinxiangClient {
    constructor(openid, index) {
        this.openid = openid;
        this.index = index;
        this.session_id = "";
        this.visit_cookie = "";
    }

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "session-id": this.session_id,
            "visit-cookie": this.visit_cookie,
            "shop-id": SHOP_ID,
            "api-version": "1",
            "client-type": "wxapp",
            "version": "6.18.0",
            "versionCode": "785",
            "x-requested-with": "XMLHttpRequest",
            "xweb_xhr": "1",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.51 NetType/WIFI",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/13/page-frame.html",
        };
    }

    async login() {
        // 1. Get guest session
        let resp = await axios.get(API_BASE + "/shop/client/member/get-sessionid", {
            headers: { ...this.getHeaders(), "session-id": "", "visit-cookie": "" },
            timeout: 15000,
        });
        this.session_id = resp.data.session_id || "";
        this.visit_cookie = resp.data.cookie || "";

        // 2. Get wx code
        const { data } = await wcs.getCode(this.openid);
        const code = data && data.data ? data.data.code : data && data.code;
        if (!code) throw new Error("获取 code 失败");

        // 3. Login
        resp = await axios.post(API_BASE + "/shop/client/wx-app/login", {
            code: code,
            info: { nickName: "微信用户", gender: 0, avatarUrl: "", language: "", city: "", province: "", country: "" },
            rawData: "",
            signature: "",
            encryptedData: "",
            iv: "",
        }, {
            headers: this.getHeaders(),
            timeout: 15000,
        });

        const d = resp.data;
        if (d.error !== 0) throw new Error("登录失败: " + (d.message || JSON.stringify(d)));

        $.log(`账号[${this.index}] 登录成功: ${d.nickname || "会员"}, ID:${d.member_id}`);
        return d;
    }

    async signIn() {
        // Check status
        let resp = await axios.get(API_BASE + "/shop/apps/creditsign/client/index/index", {
            headers: this.getHeaders(), timeout: 15000,
        });
        const idx = resp.data;
        if (idx.today_sign === 1) {
            const reward = (idx.reward && idx.reward.sign_reward) || 0;
            $.log(`账号[${this.index}] 今日已签到 +${reward}积分`);
            return reward;
        }

        // Do sign
        const activity_id = idx.activity_id || "3316";
        resp = await axios.post(API_BASE + "/shop/apps/creditsign/client/index/sign",
            { activity_id },
            { headers: this.getHeaders(), timeout: 15000 }
        );
        const d = resp.data;
        if (d.error === 0) {
            const msg = d.message || "";
            const m = msg.match(/\d+/);
            const reward = m ? parseInt(m[0]) : 10;
            $.log(`账号[${this.index}] 签到成功 +${reward}积分`);
            return reward;
        }
        if (d.message && d.message.includes("已签")) {
            $.log(`账号[${this.index}] 今日已签到`);
            return 0;
        }
        $.log(`账号[${this.index}] 签到: ` + (d.message || JSON.stringify(d)));
        return 0;
    }

    async run() {
        await this.login();
        await sleep(1000);
        await this.signIn();
    }
}

async function main() {
    const openids = (process.env.wx_opinion || "").split("&").filter(Boolean);
    if (!openids.length) throw new Error("未配置 wx_opinion");

    $.log(`共找到${openids.length}个账号`);

    for (let i = 0; i < openids.length; i++) {
        const client = new YanyinxiangClient(openids[i], i + 1);
        try {
            await client.run();
        } catch (e) {
            $.log(`账号[${i + 1}] 异常: ${e.message}`);
        }
        if (i < openids.length - 1) await sleep(3000);
    }
}

main().catch(e => $.log("ERR: " + e.message)).finally(async () => {
    try {
      const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN;
      if (token) {
        const axios = require("axios");
        const log = ($.notifyStr || []).slice(-10).join(String.fromCharCode(10));
        await axios.post("http://www.pushplus.plus/send", {
          token, title: "yanyinxiang", content: log || "yanyinxiang执行完成", template: "txt"
        }, { timeout: 10000 });
      }
    } catch(e) {}
    $.sendMsg = async () => {}; $.done();
  });;
