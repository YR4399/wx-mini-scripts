/*
@Description:  快乐会 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("快乐会");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx2ffe954c1d2e5369";
const KDT_ID = 182494514;
const CHECKIN_ID = 5543694;
const API_BASE = "https://retail-h5.youzan.com";
const UIC_URL = "https://uic.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "klh_token_cache.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try { return fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE,"utf8")) || {} : {}; }
    catch { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c,null,2),"utf8"); }
    catch(e) { $.log(`缓存写入失败: ${e.message}`); }
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = openid;
        this.token = "";
        this.yzUid = "";
    }

    get headers() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/171/page-frame.html`,
            "xweb_xhr": "1",
            "Accept": "application/json",
        };
    }

    getCached() {
        const c = readCache();
        return c[this.openid] || null;
    }
    saveCache() {
        const c = readCache();
        c[this.openid] = { token: this.token, yzUid: this.yzUid, ts: Date.now() };
        writeCache(c);
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`WCS 未返回 code`);
        return code;
    }

    async login() {
        const code = await this.getLoginCode();
        const body = { app_id: MINI_APP_ID, code, platformName: "weapp" };
        const resp = await axios.post(`${UIC_URL}/passport/general/auth.json`, body, {
            headers: { ...this.headers, "Content-Type": "application/json" },
            timeout: 15000,
        });
        const d = resp.data?.data || resp.data;
        this.token = d.access_token || d.accessToken || "";
        this.yzUid = String(d.yz_uid || d.yzUid || "");
        if (!this.token) throw new Error(`登录失败: ${JSON.stringify(resp.data)}`);
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功`);
    }

    async get(path, params = {}) {
        const q = { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token, ...params };
        const resp = await axios.get(`${API_BASE}${path}`, { params: q, headers: this.headers, timeout: 15000 });
        if (resp.data?.code !== 0) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data;
    }

    async run() {
        const cached = this.getCached();
        if (cached?.token) {
            this.token = cached.token;
            this.yzUid = cached.yzUid;
            try {
                await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "3.192.7.202" });
            } catch {
                $.log(`账号[${this.index}] 缓存失效，重新登录`);
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 签到
        try {
            const status = await this.get("/wscump/checkin/get_activity_by_yzuid_v2.json", { checkinId: CHECKIN_ID });
            if (status.isCheckin) {
                $.log(`账号[${this.index}] 今日已签到 (连续${status.continuesDay}天)`);
            } else {
                const result = await this.get("/wscump/checkin/checkinV2.json", { checkinId: CHECKIN_ID });
                if (result.success) {
                    const award = result.list?.[0]?.infos?.title || "+奖励";
                    $.log(`账号[${this.index}] 签到成功: ${award}`);
                } else {
                    $.log(`账号[${this.index}] 签到失败`);
                }
            }
        } catch (e) {
            $.log(`账号[${this.index}] 签到异常: ${e.message}`);
        }

        // 积分
        try {
            const stats = await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "3.192.7.202" });
            $.log(`账号[${this.index}] 当前快乐币: ${stats.stats?.points ?? "?"}`);
        } catch {}
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).finally(() => $.done());
