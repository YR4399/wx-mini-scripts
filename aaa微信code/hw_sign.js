/*
@Description:  花王 签到
cron: 30 8 * * *
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const $ = new Env("花王");
const axios = require("axios");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx6c7b851c877dba42";
const KDT_ID = "145921631";

let wxServer;
try { wxServer = new WeChatServer({ url: process.env.wx_server_url, appid: MINI_APP_ID, auth: process.env.wx_auth }); } catch {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class Task {
    constructor(user, idx) { this.user = user; this.index = idx; this.token = null; this.tokenFile = "./hw_token.json"; }

    _readToken() { try { return JSON.parse(require("fs").readFileSync(this.tokenFile, "utf8"))[this.user] || null; } catch { return null; } }
    _writeToken(tk) {
        let c = {}; try { c = JSON.parse(require("fs").readFileSync(this.tokenFile, "utf8")); } catch {}
        c[this.user] = tk; require("fs").writeFileSync(this.tokenFile, JSON.stringify(c, null, 2));
    }

    async login() {
        let tk = this._readToken();
        if (tk) {
            try {
                const r = await axios.post("https://h5.youzan.com/wscshop/weapp/authorize.json", { access_token: tk }, { params: { kdt_id: KDT_ID, app_id: MINI_APP_ID }, headers: this._h(), timeout: 15000 });
                if (r.data && r.data.code === 0) { this.token = tk; return; }
            } catch {}
        }
        const code = (await wxServer.getCode(this.user)).data.data.code || (await wxServer.getCode(this.user)).data.code;
        const r = await axios.post("https://uic.youzan.com/passport/general/auth.json",
            { appId: MINI_APP_ID, code, platformName: "weapp", signature: "windows", clientBiz: "weapp_wsc", inWsc: true, kdtId: Number(KDT_ID) },
            { params: { kdt_id: KDT_ID, app_id: MINI_APP_ID }, headers: this._h(), timeout: 15000 }
        );
        this.token = r.data && r.data.data && r.data.data.access_token;
        if (!this.token) throw new Error("login fail");
        this._writeToken(this.token);
    }

    _h() { return { "Content-Type": "application/json", "Extra-Data": JSON.stringify({ sid: "", version: "2.240.6", clientType: "weapp-miniprogram", client: "weapp", bizEnv: "", uuid: Math.random().toString(36).slice(2), ftime: Date.now() }), "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/66/page-frame.html" }; }

    _q() { return { kdt_id: KDT_ID, app_id: MINI_APP_ID, access_token: this.token }; }

    async signIn() {
        const p = await axios.get("https://h5.youzan.com/wscump/checkin/show_checkin_page_v2.json", { params: this._q(), headers: this._h(), timeout: 15000 });
        const id = p.data && p.data.data && (p.data.data.checkinId || p.data.data.check_in_id);
        if (!id) return;
        const r = await axios.get("https://h5.youzan.com/wscump/checkin/checkinV2.json", { params: { ...this._q(), checkinId: id }, headers: this._h(), timeout: 15000 });
        const d = r.data;
        const pts = d && d.data && d.data.point;
        $.log(`账号[${this.index}] ${d && d.code === 0 ? "签到成功" : d.msg || ""} ` + (pts != null ? "+" + pts + "积分" : ""));
    }

    async run() { await this.login(); await sleep(1000); await this.signIn(); }
}

!(async () => {
    $.checkEnv("HUAWANG_ACCOUNT");
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
        if (i < $.userList.length - 1) await sleep(3000);
    }
})().catch(e => console.log(e)).finally(() => $.done());
