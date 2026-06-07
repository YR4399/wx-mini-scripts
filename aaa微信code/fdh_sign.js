/*
@Description:  福东海 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("福东海");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx6c440c5e4d7f02e3";
const KDT_ID = 155212604;
const CHECKIN_ID = 7284594;
const API_BASE = "https://h5.youzan.com";
const UIC_URL = "https://uic.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "fdh_token_cache.json");
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
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
        if (!code) throw new Error(`WCS 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async login() {
        const code = await this.getLoginCode();
        const body = {
            app_id: MINI_APP_ID,
            code,
            platformName: "weapp",
        };
        const resp = await axios.post(`${UIC_URL}/passport/general/auth.json`, body, {
            headers: { ...this.headers, "Content-Type": "application/json" },
            timeout: 15000,
        });
        const d = resp.data?.data || resp.data;
        this.token = d.access_token || d.accessToken || "";
        this.yzUid = String(d.yz_uid || d.yzUid || "");
        if (!this.token) throw new Error(`登录未返回 token: ${JSON.stringify(resp.data)}`);
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功 yzUid=${this.yzUid}`);
    }

    async get(path, params = {}) {
        const q = { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token, ...params };
        const resp = await axios.get(`${API_BASE}${path}`, { params: q, headers: this.headers, timeout: 15000 });
        if (resp.data?.code !== 0) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data;
    }

    async run() {
        // 读取缓存
        const cached = this.getCached();
        if (cached?.token && cached?.yzUid) {
            this.token = cached.token;
            this.yzUid = cached.yzUid;
            $.log(`账号[${this.index}] 使用缓存 token`);
            try {
                // 验证 token 有效性
                await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "2.233.4.101" });
            } catch {
                $.log(`账号[${this.index}] 缓存失效，重新登录`);
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 查询签到状态
        try {
            const status = await this.get("/wscump/checkin/get_activity_by_yzuid_v2.json", { checkinId: CHECKIN_ID });
            if (status.isCheckin) {
                $.log(`账号[${this.index}] 今日已签到 (连续${status.continuesDay}天)`);
                if (status.rewards?.length) {
                    const prize = status.rewards.find(r => !r.fetched);
                    if (prize) $.log(`  连续签到奖励待领取: ${prize.duration}天`);
                }
            } else {
                // 执行签到
                const result = await this.get("/wscump/checkin/checkinV2.json", { checkinId: CHECKIN_ID });
                if (result.success) {
                    const award = result.list?.[0]?.infos?.title || "+奖励";
                    $.log(`账号[${this.index}] 签到成功: ${award}`);
                } else {
                    $.log(`账号[${this.index}] 签到失败: ${JSON.stringify(result)}`);
                }
            }
        } catch (e) {
            $.log(`账号[${this.index}] 签到异常: ${e.message}`);
        }

        // 查询积分
        try {
            const stats = await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "2.233.4.101" });
            $.log(`账号[${this.index}] 当前积分: ${stats.stats?.points ?? "?"}`);
        } catch {}
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).finally(() => $.done());
