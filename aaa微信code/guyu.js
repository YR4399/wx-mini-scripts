/*
@Description: 谷雨 小程序签到
cron: 10 9 * * *

逆向来源: wxapkg wxda948f3be0afc375 (v75) app-service.js
  签名: 除 /noValid/log 外所有接口都要签
    secretKey = R6WbJ830wNsEdjH9GumwKYiYxHz0K9QD
    POST: payload = {body: JSON.stringify(data), secretKey, ts}
    GET : payload = {...params, secretKey, ts}
    sign = sha1( 把每个 (key+value) 推入数组 -> sort() -> 顺序拼接 )
    data/params 为空时 sign 置空串
  ts   = Date.now() + offset, offset 由 GET /activity/common/time 校正
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const { sendPushNotify } = require("./_push_helper");
const $ = new Env("谷雨签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxda948f3be0afc375";
const PKG_VER = "75";
const API_BASE = "https://mall-mobile-v6.vecrp.com/mobile";
const TOKEN_CACHE_FILE = path.join(__dirname, "guyu_token_cache.json");
const SECRET_KEY = "R6WbJ830wNsEdjH9GumwKYiYxHz0K9QD";
const SHOP_ID = "100186753";
const ACTIVITY_ID = "cdd30467-abb8-4944-8941-2879aa950a86";
let ckName = "wx_opinion";

// 服务端时间偏移(ms) = 服务器时间 - 本地时间
let TIME_OFFSET = 0;

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

const uuid = () => crypto.randomUUID();
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const nowTs = () => Date.now() + TIME_OFFSET;

/** 照包内实现: 每个 key+value 入数组 -> sort() -> 顺序拼接 */
function joinSorted(obj) {
    const arr = [];
    for (const k in obj) arr.push(k + obj[k]);
    arr.sort();
    let out = "";
    arr.forEach((e) => { out = out === "" ? e : out + e; });
    return out;
}

function makeSign(method, data, params) {
    const ts = nowTs();
    const isPost = String(method).toUpperCase() === "POST";
    const payload = isPost
        ? { body: JSON.stringify(data), secretKey: SECRET_KEY, ts }
        : Object.assign({}, params || {}, { secretKey: SECRET_KEY, ts });
    const n = isPost ? data : params;
    let sign = sha1(joinSorted(payload));
    // 包内: n 为空/undefined/"undefined" 时 sign 置空
    if (!(n && n !== undefined && n !== "undefined")) sign = "";
    return { sign, ts };
}

function baseHeaders(sign, ts, token) {
    return {
        "Content-Type": "application/json;charset=UTF-8",
        token: token || "",
        sign,
        ts: String(ts),
        startTime: String(Date.now()),
        appid: MINI_APP_ID,
        "X-TracedId": uuid(),
        "xweb_xhr": "1",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
        Referer: `https://servicewechat.com/${MINI_APP_ID}/${PKG_VER}/page-frame.html`,
    };
}

/** 同步服务端时间(仅需一次); 该接口无参数 -> sign 为空串 */
async function syncServerTime() {
    try {
        const t0 = Date.now();
        const r = await axios.get(`${API_BASE}/activity/common/time`, {
            headers: baseHeaders("", t0, ""),
            timeout: 15000,
        });
        if (r.data?.success && r.data?.result) {
            TIME_OFFSET = Number(r.data.result) - Date.now();
            L.info(`服务端时间已同步 (偏移 ${TIME_OFFSET}ms)`);
            return true;
        }
    } catch (e) {
        L.info(`服务端时间同步失败(${e.message})，使用本地时间`);
    }
    return false;
}

/** 服务器当日日期, 格式 yyyy-M-d (不补零, 与小程序一致) */
function serverToday() {
    const d = new Date(nowTs());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

class Task {
    constructor(openid, idx, nick) {
        this.openid = openid;
        this.idx = idx;
        this.nick = nick || `账号${idx}`;
        this.token = null;
    }

    tag(msg) { return `[${this.idx}] ${this.nick} ${msg}`; }

    readCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
                return cache[this.openid] || null;
            }
        } catch (e) {}
        return null;
    }

    saveCache(token) {
        try {
            let cache = {};
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
            }
            cache[this.openid] = { token, ts: Date.now() };
            fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
        } catch (e) {}
    }

    clearCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE_FILE)) {
                const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8"));
                delete cache[this.openid];
                fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
            }
        } catch (e) {}
    }

    async request(method, urlPath, data, params) {
        const { sign, ts } = makeSign(method, data, params);
        const config = {
            method,
            url: API_BASE + urlPath,
            headers: baseHeaders(sign, ts, this.token),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (String(method).toUpperCase() === "POST") config.data = data;
        else config.params = params;
        const r = await axios.request(config);
        return r.data;
    }

    /** WCS 取 code: 只接受 string, 瞬时故障退避重试 */
    async getCode() {
        for (let i = 0; i < 3; i++) {
            try {
                const { data: res } = await wechat.getCode(this.openid);
                const code = res?.data?.code || res?.code;
                if (typeof code === "string" && code.length > 10) return code;
                const msg = JSON.stringify(res || {}).slice(0, 120);
                if (/account not found|not found/i.test(msg)) {
                    L.fail(this.tag(`WCS账号不存在，跳过: ${msg}`));
                    return null;
                }
                L.info(this.tag(`取code异常(${msg})，重试...`));
            } catch (e) {
                L.info(this.tag(`取code异常(${e.message})，重试...`));
            }
            await $.wait(2000 * (i + 1));
        }
        return null;
    }

    async login() {
        const code = await this.getCode();
        if (!code) return false;
        // shopId 必须传实际门店号: 传 null 会导致后续签到报「用户id不能为空」
        const body = {
            code: String(code),
            appid: MINI_APP_ID,
            shopId: SHOP_ID,
            envVersion: "release",
            isEnterpriseWx: false,
            scene: 1168,
            referrerInfo: { appId: MINI_APP_ID },
        };
        const res = await this.request("POST", "/wxAppLogin", body, null);
        if (res?.success && res?.result?.mobileToken) {
            this.token = res.result.mobileToken;
            this.saveCache(this.token);
            return true;
        }
        L.fail(this.tag(`登录失败: ${res?.msg || JSON.stringify(res).slice(0, 150)}`));
        return false;
    }

    async checkToken() {
        try {
            const d = await this.request("GET", "/customer/getMyAllPoint", null, { shopId: SHOP_ID });
            return !!d?.success;
        } catch (e) {
            return false;
        }
    }

    async loadInfo() {
        return await this.request("GET", "/activity/sign/loadActivityInfo", null, {
            activityId: ACTIVITY_ID,
            source: "undefined",
            shopId: SHOP_ID,
        });
    }

    async doSign() {
        return await this.request("POST", "/activity/sign/sign", {
            shopId: SHOP_ID,
            activityId: ACTIVITY_ID,
            signDate: serverToday(),
        }, null);
    }

    async run() {
        // 1. 复用缓存 token
        const cached = this.readCache();
        if (cached?.token) {
            this.token = cached.token;
            if (!(await this.checkToken())) {
                this.token = null;
                this.clearCache();
            }
        }

        // 2. 登录(带重试)
        if (!this.token) {
            let ok = false;
            for (let i = 0; i < 3; i++) {
                ok = await this.login();
                if (ok) break;
                if (i < 2) await $.wait(2000 + i * 1500);
            }
            if (!ok) return;
            await $.wait(1500);
        }

        // 3. 查询活动状态
        let already = false;
        try {
            const info = await this.loadInfo();
            if (info?.success) {
                const r = info.result || {};
                L.info(this.tag(`积分=${r.customerIntegral ?? "?"} 连签=${r.signDays ?? 0}天 日签奖励=${r.integral ?? "?"}`));
                if (r.canJoin === false) already = true;
            } else {
                L.info(this.tag(`查询活动信息: ${info?.msg || "无返回"}`));
            }
        } catch (e) {
            L.info(this.tag(`查询活动信息异常: ${e.message}`));
        }

        if (already) {
            L.info(this.tag("今日已签到"));
            return;
        }

        // 4. 签到
        const retryable = (m) => /服务正忙|1099|996|当前请求异常|超时|timeout|ECONNRESET|socket|网络/i.test(m || "");
        for (let retry = 0; retry < 3; retry++) {
            try {
                const res = await this.doSign();
                if (res?.success) {
                    const r = res.result || {};
                    const parts = [`+${r.integral ?? 2}积分`];
                    if (r.memberDayIntegral) parts.push(`会员日+${r.memberDayIntegral}`);
                    if (r.couponTitle) parts.push(`券:${r.couponTitle}`);
                    L.ok(this.tag(`签到成功 ${parts.join(" ")}`));
                    return;
                }
                const msg = res?.msg || "未知错误";
                // 已签
                if (/已达到最大参与次数|已签到|重复/.test(msg)) {
                    L.info(this.tag("今日已签到"));
                    return;
                }
                // token 失效 -> 重登一次
                if (retry === 0 && /用户id|授权失败|登录|token/i.test(msg)) {
                    L.info(this.tag(`token疑似失效(${msg})，重新登录...`));
                    this.clearCache();
                    this.token = null;
                    if (await this.login()) { await $.wait(1500); continue; }
                    L.fail(this.tag("重新登录失败"));
                    return;
                }
                if (retryable(msg) && retry < 2) {
                    L.info(this.tag(`签到失败(${msg})，第${retry + 1}次重试...`));
                    await $.wait(2000 + retry * 1500);
                    continue;
                }
                L.fail(this.tag(`签到失败: ${msg}`));
                return;
            } catch (e) {
                const m = e.message || String(e);
                if (retryable(m) && retry < 2) {
                    L.info(this.tag(`签到异常(${m})，第${retry + 1}次重试...`));
                    await $.wait(2000 + retry * 1500);
                    continue;
                }
                L.fail(this.tag(`签到异常: ${m}`));
                return;
            }
        }
    }
}

/** NICK_MAP 兼容 JSON 与 `openid:昵称&openid:昵称` 两种格式 */
function parseNickMap() {
    const raw = process.env.NICK_MAP || "";
    const map = {};
    if (!raw) return map;
    if (raw.trim().startsWith("{")) {
        try { return JSON.parse(raw); } catch (e) { return map; }
    }
    raw.split("&").forEach((seg) => {
        const i = seg.indexOf(":");
        if (i > 0) map[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    });
    return map;
}

!(async () => {
    sectionLine("谷雨", "");
    $.userIdx = 0;
    $.checkEnv(ckName);
    if (!process.env.wx_server_url || !process.env.wx_auth) {
        L.info("未配置WCS服务");
        return;
    }

    const openids = $.userList;
    const nickMap = parseNickMap();
    L.info(`共${openids.length}个账号`);

    await syncServerTime();

    for (let i = 0; i < openids.length; i++) {
        const task = new Task(openids[i], i + 1, nickMap[openids[i]]);
        await task.run();
        if (i < openids.length - 1) await $.wait(3000 + Math.random() * 5000);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(async () => {
        try {
            const logs = $.notifyStr || [];
            if (logs.length > 0) await sendPushNotify("谷雨", logs.join("\n"));
        } catch (_e) {}
        process.exit(0);
    });
