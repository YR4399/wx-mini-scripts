/*
@Description:  快乐会 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
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
    catch(e) { L.fail("缓存写入失败: " + e.message + ""); }
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.openid = openid;
        this.token = "";
        this.userId = 0;
        this.mobile = "";
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
        c[this.openid] = { token: this.token, userId: this.userId, mobile: this.mobile, ts: Date.now() };
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
        const body = { appId: MINI_APP_ID, code, platformName: "weapp", signature: "Windows" };
        const resp = await axios.post(`${UIC_URL}/passport/general/auth.json`, body, {
            headers: {
                ...this.headers,
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout: 15000,
            validateStatus: () => true,
        });
        if (resp.status !== 200 || resp.data?.code !== 0 || !resp.data?.data?.sessionId) {
            throw new Error(`登录失败: ${JSON.stringify(resp.data)}`);
        }
        const d = resp.data.data;
        this.token = d.sessionId || "";
        this.userId = d.userId || 0;
        this.mobile = d.mobile || "";
        if (!this.token) throw new Error(`登录失败: ${JSON.stringify(resp.data)}`);
        this.saveCache();
        L.ok("账号[" + this.index + "] 登录成功 uid=" + this.userId + " " + this.mobile + "");
    }

    async get(path, params = {}) {
        const q = { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token, ...params };
        const extraData = JSON.stringify({ is_weapp: 1, sid: this.token, userId: this.userId, version: "3.192.7.202", client: "weapp" });
        const hdrs = {
            ...this.headers,
            "Cookie": `KDTSESSIONID=${this.token}`,
            "Extra-Data": extraData,
        };
        const resp = await axios.get(`${API_BASE}${path}`, { params: q, headers: hdrs, timeout: 15000, validateStatus: () => true });
        if (resp.data?.code !== 0 && resp.data?.code !== 200) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data || resp.data;
    }

    async run() {
        const cached = this.getCached();
        if (cached?.token) {
            this.token = cached.token;
            this.userId = cached.userId;
            this.mobile = cached.mobile;
            L.info("账号[" + this.index + "] 使用缓存 uid=" + this.userId + "");
            try {
                await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "3.192.7.202" });
            } catch {
                L.fail("账号[" + this.index + "] 缓存失效，重新登录");
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;

        // 签到
        try {
            const status = await this.get("/wscump/checkin/get_activity_by_yzuid_v2.json", { checkinId: CHECKIN_ID });
            if (status?.isCheckin) {
                L.info("账号[" + this.index + "] 今日已签到 (连续" + status.continuesDay + "天)");
            } else {
                const extraData = JSON.stringify({ is_weapp: 1, sid: this.token, userId: this.userId, version: "3.192.7.202", client: "weapp" });
                const url = `${API_BASE}/wscump/checkin/checkinV2.json?app_id=${MINI_APP_ID}&kdt_id=${KDT_ID}&access_token=${this.token}&checkinId=${CHECKIN_ID}&userId=${this.userId}`;
                const resp2 = await axios.get(url, {
                    headers: {
                        ...this.headers,
                        "Cookie": `KDTSESSIONID=${this.token}`,
                        "Extra-Data": extraData,
                    },
                    timeout: 15000,
                    validateStatus: () => true,
                });
                const result = resp2.data;
                if (result?.code === 0 || result?.success) {
                    const award = result?.data?.list?.[0]?.infos?.title || "+10快乐币";
                    L.ok("账号[" + this.index + "] 签到成功: " + award + "");
                } else if (/已达最大参与|已签到|已签|already|limit/i.test(result?.msg || "")) {
                    L.info("账号[" + this.index + "] 今日已签到");
                } else {
                    L.fail("账号[" + this.index + "] 签到失败: " + result?.msg || JSON.stringify(result) + "");
                }
            }
        } catch (e) {
            L.fail("账号[" + this.index + "] 签到异常: " + e.message + "");
        }

        // 积分
        try {
            const stats = await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "3.192.7.202" });
            L.info("账号[" + this.index + "] 当前快乐币: " + stats?.stats?.points ?? "?" + "");
        } catch {}
    }
}

!(async () => {
  sectionLine("快乐会", "");
$.userIdx = 0;
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).then(async () => {
    const _logs = $.notifyStr || [];
    if (_logs.length > 0) await sendPushNotify("快乐会签到", _logs.join("\n"));
  }).finally(() => $.done());
