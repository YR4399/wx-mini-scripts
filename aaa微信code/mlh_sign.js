/*
@Description:  梦百合 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("梦百合");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxd21d381ded23b9be";
const API_BASE = "https://mfapi.mlily.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "mlh_token_cache.json");
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
        this.guestToken = "cd562a8038eeaa4d3d372c8fc4f65c2";
        this.userInfo = {};
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
        c[this.openid] = { token: this.token, guestToken: this.guestToken, ts: Date.now() };
        writeCache(c);
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error("WCS 未返回 code");
        return code;
    }

    async login() {
        const code = await this.getLoginCode();
        // Step 1: 微信OAuth登录 - 尝试多种方式
        let resp = await axios({
            method: "POST",
            url: `${API_BASE}/v1/wechat/oauth/mini/login`,
            params: { ajax: true, platform: "weapp", guestToken: this.guestToken },
            data: { code },
            headers: { ...this.headers },
            timeout: 15000,
            validateStatus: () => true,
        });
        $.log(`  DEBUG step1: status=${resp.status} data=${JSON.stringify(resp.data).slice(0,300)}`);
        if (resp.status !== 200) throw new Error(`登录失败 HTTP ${resp.status}`);
        
        const d = resp.data;
        // code: 0=失败, 1=成功已绑定, 2=待绑定
        if (d.code !== 1 && d.code !== 2) {
            // 尝试获取新的 guestToken 然后重试
            const gtResp = await axios.get(`${API_BASE}/v1/guest/token`, {
                params: { ajax: true, platform: "weapp" },
                headers: this.headers,
                timeout: 15000,
                validateStatus: () => true,
            });
            $.log(`  DEBUG guestToken resp: ${JSON.stringify(gtResp.data).slice(0,200)}`);
            if (gtResp.data?.data?.guestToken) {
                this.guestToken = gtResp.data.data.guestToken;
                // 重试登录
                resp = await axios({
                    method: "POST",
                    url: `${API_BASE}/v1/wechat/oauth/mini/login`,
                    params: { ajax: true, platform: "weapp", guestToken: this.guestToken },
                    data: { code },
                    headers: { ...this.headers },
                    timeout: 15000,
                    validateStatus: () => true,
                });
                $.log(`  DEBUG step1 retry: ${JSON.stringify(resp.data).slice(0,300)}`);
            }
        }
        
        if (resp.data?.code !== 1 && resp.data?.code !== 2) {
            throw new Error(`登录失败: ${resp.data?.msg || JSON.stringify(resp.data)}`);
        }

        // Step 2: 获取手机号
        const phoneResp = await axios.get(`${API_BASE}/v1/wechat/oauth/mini/phone/new`, {
            params: { ajax: true, platform: "weapp", guestToken: this.guestToken },
            headers: this.headers,
            timeout: 15000,
            validateStatus: () => true,
        });
        const phoneData = phoneResp.data?.data || phoneResp.data;
        $.log(`  DEBUG phone: ${JSON.stringify(phoneData).slice(0,200)}`);

        // Step 3: 绑定获取token
        const bindResp = await axios.get(`${API_BASE}/v1/wechat/oauth/mini/bind`, {
            params: { ajax: true, platform: "weapp", guestToken: this.guestToken },
            headers: this.headers,
            timeout: 15000,
            validateStatus: () => true,
        });
        const bindData = bindResp.data?.data || bindResp.data;
        $.log(`  DEBUG bind: ${JSON.stringify(bindData).slice(0,200)}`);
        
        this.token = bindData?.access_token || bindData?.token || bindData?.accessToken || "";
        if (!this.token) throw new Error(`绑定未返回token: ${JSON.stringify(bindData)}`);
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功`);
    }

    async get(path, extra = {}) {
        const params = {
            ajax: true,
            platform: "weapp",
            guestToken: this.guestToken,
            ...extra,
        };
        if (this.token) params.token = this.token;
        // Remove undefined values
        Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);
        const resp = await axios.get(`${API_BASE}${path}`, { params, headers: this.headers, timeout: 15000 });
        // code: 1=成功, 2=待绑定(非错误)
        if (resp.data?.code !== 1 && resp.data?.code !== 2) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data;
    }

    async run() {
        const cached = this.getCached();
        if (cached?.token) {
            this.token = cached.token;
            this.guestToken = cached.guestToken || this.guestToken;
            try {
                await this.get("/v1/account/info");
                $.log(`账号[${this.index}] 使用缓存 token`);
            } catch (e) {
                $.log(`账号[${this.index}] 缓存失效: ${e.message}`);
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 签到
        try {
            const result = await this.get("/v1/marketing/checkin");
            $.log(`账号[${this.index}] 签到成功: +${result}积分`);
        } catch (e) {
            if (e.message?.includes?.("已签到") || e.message?.includes?.("已签")) {
                $.log(`账号[${this.index}] 今日已签到`);
            } else {
                $.log(`账号[${this.index}] 签到失败: ${e.message}`);
            }
        }

        // 积分
        try {
            const info = await this.get("/v1/account/info");
            const authInfo = info?.authInfo || {};
            $.log(`账号[${this.index}] 积分:${authInfo.integral} | ${authInfo.levelName || "会员"}`);
        } catch {}
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).finally(() => $.done());
