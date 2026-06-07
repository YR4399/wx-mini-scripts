/*
@Description:  花王 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("花王");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxcaa47f040261f278";
const API_BASE = "https://kaoshop.kao.com.cn";
const TOKEN_CACHE_FILE = path.join(__dirname, "hw_token_cache.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try { return fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {} : {}; }
    catch { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); }
    catch (e) { $.log(`缓存写入失败: ${e.message}`); }
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = openid;
        this.token = "";
        this.userId = 0;
    }

    get headers() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/482/page-frame.html`,
            "xweb_xhr": "1",
            "Content-Type": "application/json",
        };
    }

    get authHeaders() {
        return { ...this.headers, token: this.token };
    }

    getCached() {
        const c = readCache();
        return c[this.openid] || null;
    }
    saveCache() {
        const c = readCache();
        c[this.openid] = { token: this.token, userId: this.userId, ts: Date.now() };
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
        const resp = await axios.post(`${API_BASE}/kaoshop/user/app/user/login`, {
            code,
            qyCode: "",
            authAppId: MINI_APP_ID,
            channel: "1",
            scene: 1007,
            storeId: "2",
            latitude: "31.20561",
            longitude: "121.51361",
        }, {
            headers: this.headers,
            timeout: 15000,
            validateStatus: () => true,
        });
        if (resp.data?.status !== 200 || !resp.data?.data?.token) {
            throw new Error(`登录失败: ${JSON.stringify(resp.data)}`);
        }
        this.token = resp.data.data.token;
        this.userId = resp.data.data.id || 0;
        if (!this.token) throw new Error(`登录未返回token`);
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功 uid=${this.userId}`);
    }

    async get(path, params = {}) {
        const resp = await axios.get(`${API_BASE}${path}`, {
            params,
            headers: this.authHeaders,
            timeout: 15000,
            validateStatus: () => true,
        });
        return resp.data;
    }

    async post(path, data = {}) {
        const resp = await axios.post(`${API_BASE}${path}`, data, {
            headers: this.authHeaders,
            timeout: 15000,
            validateStatus: () => true,
        });
        return resp.data;
    }

    async run() {
        const cached = this.getCached();
        if (cached?.token) {
            this.token = cached.token;
            this.userId = cached.userId;
            $.log(`账号[${this.index}] 使用缓存 uid=${this.userId}`);
            try {
                const check = await this.get("/kaoshop/user/app/sign/getSignContiDays");
                if (check.status !== 200) throw new Error("token无效");
            } catch {
                $.log(`账号[${this.index}] 缓存失效，重新登录`);
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 签到
        try {
            const resp = await this.post("/kaoshop/user/app/sign/signIn", {});
            if (resp?.status === 200 && resp?.code === "SUCCESS") {
                const contiResp = await this.get("/kaoshop/user/app/sign/getSignContiDays");
                const conti = contiResp?.data || 1;
                $.log(`账号[${this.index}] 签到成功: +${resp.data}积分 (连续${conti}天)`);
            } else if (/已签|已经|already|signed/i.test(resp?.message || "")) {
                const contiResp = await this.get("/kaoshop/user/app/sign/getSignContiDays");
                $.log(`账号[${this.index}] 今日已签到 (连续${contiResp?.data || "?"}天)`);
            } else {
                $.log(`账号[${this.index}] 签到失败: ${resp?.message || JSON.stringify(resp)}`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 签到异常: ${e.message}`);
        }

        // 积分查询
        try {
            const userResp = await this.get(`/kaoshop/user/app/user/getuser`, { id: this.userId, channel: "1", scene: 1007 });
            const user = userResp?.data || {};
            const integral = user.integral ?? user.availIntegral ?? "?";
            $.log(`账号[${this.index}] 积分:${integral} | ${user.storeName || "花王"}`);
        } catch {}
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).finally(() => $.done());
