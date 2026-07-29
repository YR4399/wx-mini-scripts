/*
@Description:  花王 签到
cron: 30 8 * * *
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const $ = new Env("花王");
const axios = require("axios");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxcaa47f040261f278";
const BASE = "https://kaoshop.kao.com.cn";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

let wxServer;
try { wxServer = new WeChatServer({ url: process.env.wx_server_url, appid: MINI_APP_ID, auth: process.env.wx_auth }); } catch {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Task {
    constructor(user, idx) {
        this.user = user;
        this.index = idx;
        this.token = null;
        this.tokenFile = "./hw_token.json";
    }

    _readToken() {
        try { return JSON.parse(require("fs").readFileSync(this.tokenFile, "utf8"))[this.user] || null; } catch { return null; }
    }
    _writeToken(tk) {
        let c = {}; try { c = JSON.parse(require("fs").readFileSync(this.tokenFile, "utf8")); } catch {}
        c[this.user] = tk; require("fs").writeFileSync(this.tokenFile, JSON.stringify(c, null, 2));
    }

    _h(extra) {
        return Object.assign({
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/483/page-frame.html"
        }, extra || {});
    }

    async login() {
        // 优先尝试缓存 token
        let tk = this._readToken();
        if (tk) {
            try {
                const r = await axios.get(BASE + "/kaoshop/user/app/sign/getLatestSign", { headers: this._h({ token: tk }), timeout: 15000 });
                if (r.data && r.data.code === "SUCCESS") { this.token = tk; return; }
            } catch {}
        }
        const codeResp = await wxServer.getCode(this.user);
        const code = codeResp.data && codeResp.data.data && codeResp.data.data.code || (codeResp.data && codeResp.data.code);
        if (!code) throw new Error("获取code失败");
        const r = await axios.post(BASE + "/kaoshop/user/app/user/login",
            { code, qyCode: "", authAppId: MINI_APP_ID, channel: 6, scene: 1145, latitude: "31.20561", longitude: "121.51361" },
            { headers: this._h(), timeout: 15000 }
        );
        const d = r.data;
        this.token = d && d.data && d.data.token;
        if (!this.token) throw new Error("login fail: " + JSON.stringify(d));
        this._writeToken(this.token);
    }

    async signIn() {
        const r = await axios.get(BASE + "/kaoshop/user/app/sign/getLatestSign", { headers: this._h({ token: this.token }), timeout: 15000 });
        const d = r.data;
        const signData = d && d.data;
        if (d && d.code === "SUCCESS" && signData) {
            const days = signData.contiDays || 0;
            $.log(`账号[${this.index}] 今日已签到 (连续${days}天)`);
            return;
        }
        const r2 = await axios.post(BASE + "/kaoshop/user/app/sign/sign", {}, { headers: this._h({ token: this.token }), timeout: 15000 });
        const d2 = r2.data;
        if (d2 && d2.code === "SUCCESS") {
            $.log(`账号[${this.index}] ✅ 签到成功`);
        } else {
            $.log(`账号[${this.index}] 签到失败: ` + (d2 && (d2.message || JSON.stringify(d2)) || "未知"));
        }
    }

    async run() { await this.login(); await sleep(1000); await this.signIn(); }
}

!(async () => {
    $.userIdx = 0;
    $.checkEnv("HUAWANG_ACCOUNT");
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
        if (i < $.userList.length - 1) await sleep(3000);
    }
})().catch(e => console.log(e)).finally(() => $.done());
