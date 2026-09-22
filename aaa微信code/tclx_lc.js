/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 同程旅行里程签到+任务/高温出逃计划/旅行真相 登录/查询/签到/任务
cron: 21 8 * * *
------------------------------------------
变量名：tclx_lc
变量值：wx_server里的openid/账号标识，多账号用 & 或换行
依赖变量：wx_server_url、wx_auth
开关变量：TCLX_LC_GUAFEN  false=跳过瓜分任务
           TCLX_LC_HEAT_ESCAPE  false=跳过高温出逃计划
           TCLX_LC_TRAVEL_FACT  false=跳过旅行真相
           TCLX_LC_CASH_SCRATCH false=跳过钞级省每日刮卡
           TCLX_LC_FLOWER_GOD  false=跳过花神抽签
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("同程旅行里程签到");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { report } = require("./std_report");

const CK_NAME = "tclx_lc";
const APP = { name: "同程旅行里程签到", appid: "wx336dcaf6a1ecf632" };

// ====== sectoken 缓存 ======
// sectoken 有效期约 7-15 天，缓存到本地 JSON 减少每次调用 WCS 登录
const TOKEN_CACHE_FILE = path.join(__dirname, "tclx_lc_token_cache.json");
const TOKEN_TTL = parseInt(process.env.TCLX_LC_TOKEN_TTL || "86400000") || 86400000; // 24h 默认

function loadTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8"));
    } catch { return {}; }
}

function saveTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch {}
}

function cachedLoginInfo(openid) {
    const cache = loadTokenCache();
    const entry = cache[openid];
    if (!entry || !entry.sectoken) return null;
    if (Date.now() - entry.cachedAt > TOKEN_TTL) {
        delete cache[openid]; saveTokenCache(cache); return null;
    }
    return {
        openId: entry.openId,
        encryOpenId: entry.encryOpenId,
        aesOpenId: entry.aesOpenId,
        unionId: entry.unionId,
        aesUnionId: entry.aesUnionId,
        memberId: entry.memberId,
        sectoken: entry.sectoken,
    };
}

function saveLoginInfo(openid, info) {
    const cache = loadTokenCache();
    cache[openid] = { ...info, cachedAt: Date.now() };
    saveTokenCache(cache);
}

// 轻量校验：用缓存的 sectoken 查询会员信息，成功则 token 有效
async function validateCachedToken(sectoken, openId) {
    const r = await request({
        method: "GET",
        url: "https://wx.17u.cn/wechatmypubapi/myInfo/memberInfo",
        headers: {
            apmat: `${openId}|${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "")}|${Math.floor(Math.random() * 1000000)}`,
            TCSecTk: sectoken,
            secToken: sectoken,
            "TC-USER-TOKEN": sectoken,
        },
    });
    return r.status === 200 && r.data?.code === 0;
}

// ====== 推送 / 日志装饰工具 ======
const TC_SUMMARY = []; // 收集每个账号里程，用于结尾汇总
const TC_ROWS = [];    // 收集每个账号结构化推送数据（接入 std_report）
function maskOpenid(o) {
    if (!o) return "?";
    return o.length > 12 ? o.slice(0, 8) + "…" + o.slice(-4) : o;
}
function padCn(s, n) {
    let w = 0;
    for (const ch of String(s)) w += /[一-鿿＀-￯]/.test(ch) ? 2 : 1;
    return String(s) + " ".repeat(Math.max(0, n - w));
}
// 任务图标：日志与推送共用（$.log 同时进控制台与推送）
const TC_ICON = {
    login: "🔑", query: "🔍", sign: "📅", share: "🎁", task: "📋",
    drama: "📜", watch: "📺", game: "🎮", heat: "🌡️", fact: "🧭",
    scratch: "💰", train: "🚄", flower: "🌸", fail: "❌", skip: "⏭️",
};
// 四风判词（结尾装饰语，可随意替换）
const TC_JUDGE = "他对错你我看也不透，百样苦自有百样人受。";
// 账号全部来自环境变量 wx_opinion (见下方 DEFAULT_OPENID)，不再写死 openid
const TC_NICK = {};
function nickOf(openid) { return openid ? openid.slice(-6) : ""; }
const wx_server_url = (process.env.wx_server_url || "http://host.docker.internal:18788").replace(/\/$/, "");
const wx_auth = process.env.wx_auth || "";
// WCS 会话鉴权缓存：面板 wx_auth 通常是 smallcat-client 的会话 token；
// 若失效(401)，自动用控制台账号密码(/api/client/login)刷新一次。
let _wcsAuth = null;
function getWcsAuth() { return _wcsAuth || wx_auth || ""; }
async function refreshWcsAuth() {
    try {
        const user = process.env.WCS_CONSOLE_USER || "yr1314";
        const pwd = process.env.WCS_CONSOLE_PWD || "yr123123";
        const r = await request({ method: "POST", url: `${wx_server_url}/api/client/login`, headers: { "content-type": "application/json" }, data: { username: user, password: pwd } });
        const auth = r.data?.data?.auth;
        if (auth) { _wcsAuth = auth; return auth; }
    } catch (e) {}
    return wx_auth || "";
}
const DEFAULT_OPENID = process.env.wx_opinion || "";
const ENABLE_GUAFEN = (process.env.TCLX_LC_GUAFEN || "true") === "true";
const ENABLE_HEAT_ESCAPE = (process.env.TCLX_LC_HEAT_ESCAPE ?? "true") === "true";
const ENABLE_TRAVEL_FACT = (process.env.TCLX_LC_TRAVEL_FACT ?? "true") === "true";
const ENABLE_CASH_SCRATCH = (process.env.TCLX_LC_CASH_SCRATCH ?? "true") === "true";
const ENABLE_FLOWER_GOD = (process.env.TCLX_LC_FLOWER_GOD ?? "true") === "true";
const ENABLE_TRAIN_LOTTERY = (process.env.TCLX_LC_TRAIN_LOTTERY ?? "true") === "true";
const ENABLE_DAILY_CHECK = (process.env.TCLX_LC_DAILY_CHECK ?? "true") === "true";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const DEEPTrip = {
    base: "https://dtgw.ly.com/deeptrip",
    apiAppId: "wx1b9209e76e943ce6",
    business: "100072",
    platId: "10888",
};

function short(value, max = 220) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getFiveDays() {
    const days = [];
    for (let i = -2; i <= 2; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        days.push(formatDate(d));
    }
    return days;
}

async function request(options, _attempt = 1) {
    try {
        const res = await axios.request({ proxy: false,
            timeout: 20000,
            validateStatus: () => true,
            ...options,
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "application/json, text/plain, */*",
                ...(options.headers || {}),
            },
        });
        return { status: res.status, headers: res.headers || {}, data: res.data };
    } catch (e) {
        // 容器出网偶发抖动(超时/连接重置/socket hang up)时自动重试，避免单账号偶发失败
        const retryable = /ECONNABORTED|ECONNRESET|socket hang up|ETIMEDOUT|ENOTFOUND|timeout/i.test(e.code || e.message || "");
        if (retryable && _attempt < 3) {
            $.log && L.info("[retry] 网络抖动(" + e.code || e.message + ")，第" + _attempt + "次重试...");
            await new Promise(r => setTimeout(r, 3000 * _attempt));
            return request(options, _attempt + 1);
        }
        throw e;
    }
}

async function getWxCode(appid, openid) {
    if (!wx_auth) throw new Error("未配置 wx_auth");
    const { status, data } = await request({
        method: "POST",
        url: `${wx_server_url}/wx/code`,
        headers: { auth: wx_auth, "content-type": "application/json" },
        data: { appid, openid },
    });
    const code = data?.code || data?.data?.code || data?.phoneCode || data?.data?.phoneCode;
    if (status !== 200 || !code) throw new Error(`获取code失败 HTTP ${status}: ${short(data)}`);
    return code;
}

// ====== DeepTrip HTTP helper ======
async function dtPost(path, body, opts = {}) {
    const headers = {
        "content-type": "application/json;charset=UTF-8",
        token: opts.token || "",
        unionid: opts.unionid || "",
        appid: DEEPTrip.apiAppId,
        business: DEEPTrip.business,
        "dt-channel": opts.dtChannel || "H5",
        dtSource: opts.dtSource || "h5_wechat",
        language: "zh-cn",
        platId: DEEPTrip.platId,
    };
    const res = await axios.post(`${DEEPTrip.base}${path}`, body, {
        timeout: 20000, validateStatus: () => true, headers,
    });
    return res.data;
}

// ====== DeepTrip SSE chat ======
async function dtChat(sectoken, unionId, subChannel, query) {
    return new Promise((resolve, reject) => {
        const req = https.request(`${DEEPTrip.base}/chat/hotel_chat`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MiniProgramEnv/Windows WindowsWechat/WMPF",
                "dt-channel": "MAIN_MINI",
                "dtSource": "tc_wx_miniapp",
                "language": "zh-cn",
                "platId": "501",
                "os": "Android",
                "version": "20260625",
                "wechatSecToken": sectoken,
                "sub_channel": subChannel,
                "refid": "2001002851",
            },
        }, (res) => {
            let finished = false;
            res.on("data", (chunk) => {
                const lines = chunk.toString().split("\n");
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        try {
                            const d = JSON.parse(line.substring(5));
                            if (d.type === "finsh") finished = true;
                        } catch(e) {}
                    }
                }
            });
            res.on("end", () => resolve({ finished }));
        });
        req.on("error", reject);
        req.setTimeout(30000, () => {
            req.destroy();
            resolve({ finished: false, timedOut: true });
        });
        req.write(JSON.stringify({
            loc: { coordinates: { type: "gcj02", lat: 31.851200103759766, lng: 117.26061248779297 }, address: "安徽省合肥市蜀山区三里庵街道梅山路107号" },
            sid: "sess-" + Math.random().toString(36).substring(2, 8),
            q: query,
            selected_travel: "", feedNoteId: "",
            selected_route_scenic_name: [], selected_option_ids: [],
            travel_commend: null,
            flight_create_front_param: {
                id: "fp-" + Math.random().toString(36).substring(2, 8),
                type: subChannel === "HEAT_ESCAPE" ? "heatEscape" : "travelFact",
                subChannel, question: "", refid: "2001002851", krowxwysct: "deliver",
            },
        }));
        req.end();
    });
}

// ====== 周周打卡瓜分现金 H5 活动（signInCash）请求封装 ======
// 活动页: https://wx.17u.cn/cvgzt/20260819dailyCheckIn/index
// 接口域: https://cvg.17usoft.com/activity/signInCash{path}  成功码: code===1000（注意非 0/200）
// 接口: getIndexInfo / signIn / makeup / getTaskInfo / completeTask / claimTaskReward / draw / help
//
// 【身份机制·逆向结论 2026-08-28】该活动用的是「微信网页 OAuth 一次性 code」：
//   app.js 的 getAuth(module 2872) 在无缓存时会 location.replace 跳微信授权，
//   回跳 URL 带 ?code=xxx；q.openId = userInfo.code(即该 OAuth code)，q.unionId = unionid。
//   后端用 code 换真实用户，静态/过期 code 一律返回 2018「客户信息不存在」。
//   这与飞儿萌(tclx_fly_sign.js 用稳定 memberId)是两套不同身份体系，openid 不可互用。
//   => 此任务【无法用 WCS / 静态抓包做定时自动化】。只能「每次现抓新鲜 code 当天跑一次」。
// 【如何现抓】真机/模拟器微信打开活动 -> 开发者工具 Network 找 cvg.17usoft.com/activity/signInCash/getIndexInfo
//   请求 body 里的 idenId(=回跳URL的?code=) 与 unionId 复制出来，立刻(几分钟内)填下面两个变量运行。
//   多账号需各自现抓（code 一次性）。
const DAILY_ACT_ID = "c60c3ca52ec79260203998db4578c913";
const DAILY_IDENID = process.env.TCLX_LC_DAILY_IDENID || "";
const DAILY_UNIONID = process.env.TCLX_LC_DAILY_UNIONID || "";
const DAILY_COOKIE = process.env.TCLX_LC_DAILY_COOKIE || "";
const DAILY_REFID = process.env.TCLX_LC_DAILY_REFID || "";
async function dailyApi(path, body = {}) {
    const r = await request({
        method: "POST",
        url: `https://cvg.17usoft.com/activity/signInCash${path}`,
        headers: {
            "Content-Type": "application/json",
            Referer: "https://wx.17u.cn/cvgzt/20260819dailyCheckIn/index",
            ...(DAILY_COOKIE ? { cookie: DAILY_COOKIE } : {}),
        },
        data: { actId: DAILY_ACT_ID, unionId: DAILY_UNIONID, idenId: DAILY_IDENID, ...body },
        proxy: false,
        validateStatus: () => true,
        timeout: 20000,
    });
    return r.data || {};
}

class Tongcheng {

    // ====== 钞级省每日刮卡 ======
    async cashScratch() {
        try {
            if (!this.loginInfo.sectoken) throw new Error('未登录');
            const h = this.cashScratchHeaders();
            const schGuid = 'fission-sch-2025-dxneldyh';

            // 领奖：rec 返回码语义（真机抓包实测）
            //   0=领取成功  3027=已经领取过了  3003=不满足领取条件(券类需分享助力)  其它=失败
            const doRec = async (shareId) => {
                const recR = await request({
                    method: 'POST',
                    url: 'https://wx.17u.cn/qiushiinnerapi/fission/lottery/rec',
                    headers: h,
                    data: { shareGuid: shareId },
                });
                return recR.data?.code;
            };
            const recLabel = (code) => {
                if (code === 0) return '(已领)';
                if (code === 3027) return '(已领过)';
                if (code === 3003) return '(需分享)';
                return '(领失败:' + code + ')';
            };

            const list = await request({
                method: 'POST',
                url: 'https://wx.17u.cn/qiushiinnerapi/fission/lottery/list',
                headers: h,
                data: { schGuid },
            });
            const ld = list.data?.data || {};
            if (!ld.blockList) return '钞级省-获取活动列表失败: ' + short(list.data, 100);
            if (ld.qsChannelGuid) h.qsChannelGuid = ld.qsChannelGuid;
            const lotteryCount = ld.lotteryCount ?? 0;
            const maxLotteryCount = ld.maxLotteryCount ?? 6;

            let prizes = [];

            // ① 先补领“已刮开但未领取”的占用格子（修复旧bug遗留 + 崩溃恢复；即使今日刮卡次数已用完也能补领）
            const occupied = (ld.blockList || []).filter(b => b.isOccupy === 1 && b.lotteryDto?.currentShareId);
            for (const b of occupied) {
                const code = await doRec(b.lotteryDto.currentShareId);
                if (code === 0) prizes.push((b.lotteryDto.resTitle || '奖品') + '(补领)');
                // 3027 已领过 / 3003 需分享 静默跳过，避免推送刷屏
                await new Promise(r => setTimeout(r, 1000));
            }

            // ② 刮开剩余空格并即时领取
            const remain = maxLotteryCount - lotteryCount;
            const occupiedIndices = new Set((ld.blockList || []).filter(b => b.isOccupy === 1).map(b => b.index));
            const unused = [0,1,2,3,4,5,6,7].filter(i => !occupiedIndices.has(i));
            const toLottery = remain > 0 ? unused.slice(0, remain) : [];
            for (const idx of toLottery) {
                const lr = await request({
                    method: 'POST',
                    url: 'https://wx.17u.cn/qiushiinnerapi/fission/lottery/lottery',
                    headers: h,
                    data: { schGuid, blockIndex: idx },
                });
                const lrd = lr.data?.data || {};
                if (lrd.resTitle) {
                    // 刮出奖品且返回 currentShareId 即时领取
                    // 修复：旧判断 resState===0 与真实刮卡结果(resState=1)不符，导致走入“(自动)”分支跳过领奖
                    const shareId = lrd.currentShareId || (ld.blockList?.find(b => b.index === idx)?.lotteryDto?.currentShareId);
                    prizes.push(lrd.resTitle + (shareId ? recLabel(await doRec(shareId)) : '(无需领)'));
                    await new Promise(r => setTimeout(r, 1500));
                } else {
                    const msg = lr.data?.msg || short(lr.data, 60);
                    // 次数耗尽：记录一次即停，避免对剩余空格重复刷屏
                    if (/没有开奖次数|次数已用完|次数不足/.test(msg)) { prizes.push('[今日次数已用完]'); break; }
                    prizes.push('[失败] ' + msg);
                }
            }

            if (!occupied.length && !toLottery.length) return '钞级省: 无可领/可刮卡位置(' + lotteryCount + '/' + maxLotteryCount + ')';

            const newList = await request({
                method: 'POST',
                url: 'https://wx.17u.cn/qiushiinnerapi/fission/lottery/list',
                headers: h,
                data: { schGuid },
            });
            const nld = newList.data?.data || {};
            return '钞级省: ' + nld.lotteryCount + '/' + maxLotteryCount + ' | 奖品: ' + (prizes.join(', ') || '无');
        } catch (e) {
            return '钞级省异常: ' + (e.message || e);
        }
    }



    flowerGodHeaders(extra = {}) {
        return {
            'accountSystem': '1',
            'osType': '1',
            'platform': 'WX_MP',
            'secToken': this.loginInfo.sectoken,
            'userToken': '',
            "TC-USER-TOKEN": this.loginInfo.sectoken,
            "TC-PLATFORM-CODE": "WX_MP",
            "TC-OS-TYPE": "1",
            'Origin': 'https://wx.17u.cn',
            'Referer': 'https://wx.17u.cn/wxweb/',
            ...extra,
        };
    }


    // ====== 花神抽签 ======
    async flowerGod() {
        try {
            if (!this.loginInfo.sectoken) return '花神抽签: 无sectoken';
            const h = this.flowerGodHeaders();

            // 1. 获取首页信息
            const homeRes = await request({
                method: 'GET',
                url: 'https://wx.17u.cn/platformflowpool/flowerGod/home',
                headers: h,
            });
            const homeData = homeRes.data?.data || {};
            const remainDrawCount = homeData.remainDrawCount || 0;
            if (remainDrawCount <= 0) return '花神抽签: 剩余次数=0，今日无抽奖机会';

            const results = [];
            for (let k = 0; k < remainDrawCount; k++) {
                try {
                    // 2. 抽签
                    const drawRes = await request({
                        method: 'POST',
                        url: 'https://wx.17u.cn/platformflowpool/flowerGod/drawCard',
                        headers: h,
                        data: { usage: 'common' },
                    });
                    const drawCard = drawRes.data?.data || {};
                    if (!drawCard.cardId) {
                        results.push('第' + (k + 1) + '次: 无cardId');
                        continue;
                    }
                    // 3. 翻签
                    await $.wait(1500);
                    const flipRes = await request({
                        method: 'POST',
                        url: 'https://wx.17u.cn/platformflowpool/flowerGod/flipCard',
                        headers: h,
                        data: { cardId: drawCard.cardId },
                    });
                    const flipCard = flipRes.data?.data || {};
                    const reward = flipCard.rewardAmt ? flipCard.rewardAmt + '里程' : '无奖励';
                    results.push(flipCard.cardName + '('+reward+')');
                } catch (e) {
                    results.push('第' + (k + 1) + '次异常: ' + (e.message || e));
                }
                if (k < remainDrawCount - 1) await $.wait(1500);
            }
            return '花神抽签: ' + results.join(' | ');
        } catch (e) {
            return '花神抽签异常: ' + (e.message || e);
        }
    }
    cashScratchHeaders(extra = {}) {
        return {
            'accountSystem': '1',
            'openId': '',
            'osType': '0',
            'platform': 'WX_H5',
            'secToken': this.loginInfo.sectoken,
            'userToken': this.loginInfo.sectoken,
            'userTokenMode': '1',
            'versionType': '0',
            'qsChannelGuid': '',
            'Origin': 'https://wx.17u.cn',
            'Referer': 'https://wx.17u.cn/memberft/student/studentcard/moneySave',
            ...extra,
        };
    }

    constructor(openid) {
        this.openid = openid;
        this.loginInfo = {};
    }

    headers(extra = {}) {
        const sectoken = this.loginInfo.sectoken || "";
        return {
            apmat: `${this.loginInfo.openId || this.openid}|${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "")}|${Math.floor(Math.random() * 1000000)}`,
            TCSecTk: sectoken,
            TCxcxVersion: "10.8.7",
            platform: "WX_MP",
            osType: "2",
            secToken: sectoken,
            "TC-MALL-PLATFORM-CODE": "WX_MP",
            "TC-MALL-USER-TOKEN": sectoken,
            "TC-OS-TYPE": "2",
            "TC-PLATFORM-CODE": "WX_MP",
            "TC-USER-TOKEN": sectoken,
            ...extra,
        };
    }

    async login() {
        // 1. 尝试从缓存读取 sectoken
        const cached = cachedLoginInfo(this.openid);
        if (cached) {
            L.info("缓存sectoken有效，跳过WCS登录");
            this.loginInfo = cached;
            // 轻量校验缓存 token 是否仍然有效
            const valid = await validateCachedToken(cached.sectoken, cached.openId || this.openid);
            if (!valid) {
                L.warn("缓存token失效，重新登录");
                return this._doLogin();
            }
            return `openId=${cached.openId} memberId=${cached.memberId || ""} (缓存)`;
        }
        // 2. 无缓存，执行完整登录
        return this._doLogin();
    }

    async _doLogin() {
        const code = await getWxCode(APP.appid, this.openid);
        const res = await request({
            method: "POST",
            url: "https://wx.17u.cn/wechatappapi/wxUser/login",
            headers: { "content-type": "application/json" },
            data: { code, scene: 1001 },
        });
        const content = res.data?.content || res.data?.data || {};
        if (res.status !== 200 || !content.openId) throw new Error(`登录失败 HTTP ${res.status}: ${short(res.data)}`);
        this.loginInfo = {
            openId: content.openId,
            encryOpenId: content.encryOpenId,
            aesOpenId: content.aesOpenId,
            unionId: content.unionId,
            aesUnionId: content.aesUnionId,
            memberId: content.memberId,
            sectoken: content.sectoken,
        };
        // 缓存登录态
        saveLoginInfo(this.openid, this.loginInfo);
        return `openId=${content.openId} memberId=${content.memberId || ""}`;
    }

    async query() {
        const member = await request({
            method: "GET",
            url: "https://wx.17u.cn/wechatmypubapi/myInfo/memberInfo",
            headers: this.headers(),
        });
        const mileage = await request({
            method: "POST",
            url: "https://tcmobileapi.17usoft.com/mallgatewayapi/userApi/mileages/remain",
            headers: this.headers({
                "content-type": "application/json",
                "TC-MALL-DEPT-CODE": "iH3PGf9ZucSMMEYi4keylA==",
                "TC-MALL-CLIENT": "API_CLIENT",
                "TC-MALL-OS-TYPE": "Android",
            }),
            data: { osType: 2 },
        });
        const remain = mileage.data?.data?.remainBalance ?? mileage.data?.data?.balance ?? mileage.data?.remainBalance;
        const content = member.data?.content || member.data?.data?.content || {};
        return `会员=${short(content.memberBanner || content.memberRights || content, 100)} 里程=${remain ?? short(mileage.data, 100)}`;
    }

    async sign() {
        const days = getFiveDays();
        const calendar = await request({
            method: "POST",
            url: "https://wx.17u.cn/wxmpsign/sign/signCalendar",
            headers: this.headers({ "content-type": "application/json" }),
            data: { beginDate: days[0], endDate: days[4] },
        });
        const signInfo = await request({
            method: "POST",
            url: "https://wx.17u.cn/wxmpsign/sign/getSignInfo",
            headers: this.headers({ "content-type": "application/json" }),
            data: {},
        });
        const info = signInfo.data?.data || {};
        const cal = calendar.data?.data || {};
        if (info.todaySigned || cal.todaySigned) return `今日已签到，连续=${info.periodContinuedSignDays ?? cal.periodContinuedSignDays ?? "未知"}天`;
        const sign = await request({
            method: "POST",
            url: "https://wx.17u.cn/wxmpsign/sign/saveSignInfo",
            headers: this.headers({ "content-type": "application/json" }),
            data: {},
        });
        return `签到接口返回: ${short(sign.data)}`;
    }

    // ====== 看短句领里程 ======
    async dramaVisitReward() {
        try {
            const base = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getBaseData",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            if (base.data?.code !== 0) return "看短句-获取配置失败: " + short(base.data);
            const dayLimit = base.data.data?.userDayLimit ?? 20;

            const rec = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getRecommendTop",
                headers: this.headers({ "content-type": "application/json" }),
                data: { pageIndex: 1, pageSize: 10 },
            });
            if (rec.data?.code !== 0) return "看短句-获取推荐失败: " + short(rec.data);

            await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getVisitNotice",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });

            const reward = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/recVisitReward",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            const visitReward = reward.data?.data?.visitMileageReward ?? 0;

            const history = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getHistoryWatch",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            const watchList = history.data?.data?.list || [];
            const totalWatch = watchList.reduce((s, w) => s + (w.incomeMileage || 0), 0);

            const income = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getMileageIncome",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            const balance = income.data?.data?.mileageBalance ?? 0;
            const today = income.data?.data?.todayMileageIncome ?? 0;

            let result = "访问+" + visitReward + "里程";
            if (watchList.length > 0) {
                result += " | 已看" + watchList.length + "部(" + watchList.map(w => w.dramaName || w.dramaId).join(", ") + ") 累计" + totalWatch + "里程";
            }
            result += " | 余额" + balance + " 今日" + today + " | 日限额" + dayLimit;
            return result;
        } catch (e) {
            return "看短句异常: " + (e.message || e);
        }
    }

    // ====== 观看任务 ======
    async dramaWatch() {
        try {
            const rec = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getRecommendTop",
                headers: this.headers({ "content-type": "application/json" }),
                data: { pageIndex: 1, pageSize: 10 },
            });
            if (rec.data?.code !== 0) return "观看任务-获取推荐失败: " + short(rec.data);

            const dramas = rec.data?.data?.list || rec.data?.data || [];
            if (!dramas.length) return "观看任务-暂无推荐短剧";

            const history = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getHistoryWatch",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            const watchedIds = new Set((history.data?.data?.list || []).map(w => w.dramaId));
            const unwatched = dramas.filter(d => !watchedIds.has(d.dramaId));

            if (!unwatched.length) {
                const income = await request({
                    method: "POST",
                    url: "https://wx.17u.cn/platformflowpool/drama/getMileageIncome",
                    headers: this.headers({ "content-type": "application/json" }),
                    data: {},
                });
                const balance = income.data?.data?.mileageBalance ?? 0;
                const today = income.data?.data?.todayMileageIncome ?? 0;
                const base = await request({
                    method: "POST",
                    url: "https://wx.17u.cn/platformflowpool/drama/getBaseData",
                    headers: this.headers({ "content-type": "application/json" }),
                    data: {},
                });
                const limit = base.data.data?.userDayLimit ?? 20;
                return "观看任务-已全部观看 | 余额" + balance + " 今日" + today + "/" + limit;
            }

            let totalGot = 0;
            let names = [];
            for (const drama of unwatched) {
                await request({
                    method: "POST",
                    url: "https://wx.17u.cn/platformflowpool/drama/getVisitNotice",
                    headers: this.headers({ "content-type": "application/json" }),
                    data: { dramaId: drama.dramaId },
                });
                await new Promise(r => setTimeout(r, 3500));
                const reward = await request({
                    method: "POST",
                    url: "https://wx.17u.cn/platformflowpool/drama/recVisitReward",
                    headers: this.headers({ "content-type": "application/json" }),
                    data: { dramaId: drama.dramaId, srcAppId: drama.srcAppId || drama.src_app_id || "" },
                });
                const got = reward.data?.data?.visitMileageReward ?? 0;
                totalGot += got;
                names.push(drama.dramaName + " +" + got);
            }

            const income = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/drama/getMileageIncome",
                headers: this.headers({ "content-type": "application/json" }),
                data: {},
            });
            const balance = income.data?.data?.mileageBalance ?? 0;
            const today = income.data?.data?.todayMileageIncome ?? 0;
            return "观看任务-" + unwatched.length + "部(" + names.join(", ") + ") +" + totalGot + " | 余额" + balance + " 今日" + today;
        } catch (e) {
            return "观看任务异常: " + (e.message || e);
        }
    }

    // ====== 里程分享 ======
    async mileageSign() {
        const res = await request({
            method: "POST",
            url: "https://wx.17u.cn/wxmpsign/share/mileage/participateInShareMileage",
            headers: this.headers({ "content-type": "application/json" }),
            data: {},
        });
        const code = res.data?.code;
        if (code === 200) {
            const total = await request({
                method: "GET",
                url: "https://wx.17u.cn/wxmpsign/share/mileage/getTodayTotalShareMileage",
                headers: this.headers(),
            });
            const m = total.data?.data?.mileage ?? 0;
            return `里程分享完成，今日里程=${m}`;
        }
        if (code === 1001) return "里程分享今日已完成";
        return `里程分享: ${short(res.data)}`;
    }

    // ====== 任务中心 ======
    async doTasks() {
        const schemes = ["task-2025-nflygijg", "task-2026-nhamgnuq"];
        const msgs = [];
        for (const scheme of schemes) {
            const listRes = await request({
                method: "POST",
                url: "https://wx.17u.cn/qiushiinnerapi/task/detailList",
                headers: this.headers({ "content-type": "application/json" }),
                data: { detailGuid: "", pageNum: 1, pageSize: 999, schemeGuid: scheme },
            });
            if (!listRes.data?.isSucceed) continue;
            const tasks = listRes.data.data?.taskDetails || [];
            for (const t of tasks) {
                if (t.status !== 0) continue;
                if (t.taskType === 3 || t.taskType === 4) continue;
                const dg = t.detailGuid;
                if (!dg) continue;
                const title = t.title || "";
                let ok = true;
                for (const action of ["startTask", "finishTask", "sendTaskPrize"]) {
                    const ar = await request({
                        method: "POST",
                        url: `https://wx.17u.cn/qiushiinnerapi/task/${action}`,
                        headers: this.headers({ "content-type": "application/json" }),
                        data: { detailGuid: dg, pageNum: 1, pageSize: 999, schemeGuid: scheme },
                    });
                    if (!ar.data?.isSucceed) { msgs.push(`${title} ${action}失败`); ok = false; break; }
                }
                if (ok) msgs.push(`${title} ✅ +${t.prizeTitle || "?"}里程`);
            }
        }
        return msgs.length ? msgs.join("; ") : "无可完成任务";
    }

    // ====== LuckyCode 游戏（暑期抽免单） ======
    async luckyCode() {
        try {
            if (!this.loginInfo.sectoken) throw new Error("未登录");
            const h = this.luckyCodeHeaders();
            const actRes = await request({
                method: "POST",
                url: "https://wx.17u.cn/platformflowpool/luckyCode/getActDetail",
                headers: h,
                data: {},
            });
            const act = actRes.data?.data || {};
            const actGuid = act.actGuid;
            if (!actGuid) return "游戏-未获取到活动ID";
            const remainGameCount = act.remainGameCount ?? 0;
            if (remainGameCount <= 0) return `游戏: 无剩余次数（今日已用完） | 活动=${act.actName || "未知"}`;
            const targetScore = String(act.targetValue ?? 6.6);
            let uploaded = 0;
            let remaining = remainGameCount;
            for (let i = 0; i < Math.min(remainGameCount, 5) && remaining > 0; i++) {
                const upRes = await request({
                    method: "POST",
                    url: "https://wx.17u.cn/platformflowpool/luckyCode/uploadGameResult",
                    headers: h,
                    data: { isSuccess: true, gameScore: targetScore, actGuid },
                });
                const upData = upRes.data?.data || {};
                remaining = upData.remainGameCount ?? remaining;
                if (upRes.data?.code === 0) {
                    uploaded++;
                    if (remaining > 0) await $.wait(2000);
                }
            }
            return `游戏: ${uploaded}次（${act.actName || "未知"}）| 剩余=${remaining}`;
        } catch (e) {
            return `游戏异常: ${e.message || e}`;
        }
    }

    // ====== LuckyCode 请求头 ======
    luckyCodeHeaders(extra = {}) {
        return {
            "TC-PLATFORM-CODE": "WX_MP",
            "TC-OS-TYPE": "1",
            "TC-USER-TOKEN": this.loginInfo.sectoken,
            "accountSystem": "1",
            "platform": "WX_MP",
            "osType": "1",
            "secToken": this.loginInfo.sectoken,
            "userToken": "",
            ...extra,
        };
    }

    // ====== 高温出逃计划 ======
    async heatEscape() {
        try {
            if (!this.loginInfo.sectoken) throw new Error("未登录");
            const token = this.loginInfo.sectoken;
            const unionId = this.loginInfo.unionId;

            // 1. 提交 page_view 事件（每日浏览旅行真相）
            const pv = await dtPost("/marketing/activity/task/event", {
                activityType: "HEAT_ESCAPE", eventType: "page_view", targetPage: "travel_fact",
            }, { token, unionid: unionId });
            const pvOk = pv?.code === "0";
            const pvMsg = pvOk ? "成功" : (pv?.msg || "失败");

            // 2. 调用 hotel_chat 完成 travel_plan 任务
            const chat = await dtChat(token, unionId, "HEAT_ESCAPE", "[DeepTrip_逃离高温] 帮我查从合肥到大理的高铁票。");

            // 3. 查询活动详情，获取抽奖次数
            const detail = await dtPost("/marketing/activity/common/detail", { activityType: "HEAT_ESCAPE" }, { token, unionid: unionId });
            const data = detail?.data || {};
            const lotteryNum = data.lotteryNum || 0;

            // 4. 抽奖
            let prizes = [];
            const activityId = data.activityId;
            const phaseId = data.phases?.[0]?.phaseId;
            if (lotteryNum > 0 && activityId && phaseId) {
                for (let i = 0; i < lotteryNum; i++) {
                    const res = await dtPost("/marketing/activity/qiushi-lottery/lottery", {
                        bizActivityId: activityId, phaseId,
                    }, { token, unionid: unionId });
                    const prize = res?.data;
                    if (prize) {
                        prizes.push(prize.prizeTitle || prize.prizeName || "?");
                    } else if (res?.code && res?.code !== "0") {
                        prizes.push(`[${res.code}]${res.msg || ""}`);
                    }
                }
            }

            const msgs = [
                `page_view:${pvMsg}`,
                `chat:${JSON.stringify(chat)}`,
                `抽奖${lotteryNum}次:${prizes.join(",") || "无"}`,
            ];
            return msgs.join(" | ");
        } catch (e) {
            return `高温出逃异常: ${e.message || e}`;
        }
    }

    // ====== 每日旅行真相 ======
    async travelFact() {
        try {
            if (!this.loginInfo.sectoken) throw new Error("未登录");
            const token = this.loginInfo.sectoken;
            const unionId = this.loginInfo.unionId;

            // 1. 提交 page_view 事件
            const pv = await dtPost("/marketing/activity/task/event", {
                activityType: "TRAVEL_FACT", eventType: "page_view", targetPage: "travel_fact",
            }, { token, unionid: unionId });
            const pvMsg = pv?.code === "0" ? "成功" : (pv?.msg || "失败");

            // 2. 调用 hotel_chat 完成 travel_plan 任务
            const chat = await dtChat(token, unionId, "TRAVEL_FACT", "[DeepTrip_旅行真相] 帮我查从合肥到大理的高铁票。");

            // 3. 查询里程
            const detail = await dtPost("/marketing/activity/common/detail", { activityType: "TRAVEL_FACT" }, { token, unionid: unionId });
            const data = detail?.data || {};
            const mileage = data.mileage ?? "未知";
            const tasks = (data.taskList || []).filter(t => t.taskProgress === "1").map(t => t.taskName);

            return `page_view:${pvMsg} | chat:${JSON.stringify(chat)} | 积分:${mileage} | 已完成:${tasks.join(",") || "无"}`;
        } catch (e) {
            return `旅行真相异常: ${e.message || e}`;
        }
    }

    // ====== 火车票抽奖码 - 三个浏览任务得抽奖码 ======
    // 网页授权：通过 WCS 获取同程公众号(wx3827070276e49e30)的网页 OAuth code
    async getWebOauthCode(redirect) {
        const data = { openid: this.openid, appid: "wx3827070276e49e30", scope: "snsapi_userinfo", state: "99", redirect_uri: redirect };
        let auth = getWcsAuth();
        let r = await request({ method: "POST", url: `${wx_server_url}/wx/oauth`, headers: { auth, "content-type": "application/json" }, data });
        if (r.status === 401) { auth = await refreshWcsAuth(); r = await request({ method: "POST", url: `${wx_server_url}/wx/oauth`, headers: { auth, "content-type": "application/json" }, data }); }
        if (r.status !== 200 || !r.data?.data?.code) throw new Error(`网页授权失败 HTTP ${r.status}: ${short(r.data)}`);
        return r.data.data.code;
    }

    // 用 OAuth code + 小程序会员态 cookie 换取网页 WxUserToken（trainLottery 活动必需）
    async fetchWxUserToken(code, li) {
        const cookie = `WxXcxUser=openid=${li.openId}&unionid=${li.unionId}&sectoken=${li.sectoken}`;
        const back = encodeURIComponent("https://wx.17u.cn/tripactivities/lottery/index?refid=&actCode=020b2bae7e6111f1ac3735f46258597e&taskNo=TSMNLS38TS8LSG6FM7HG1SILEP2M5512&_miniAppVersion=8.1.4");
        const url = `https://wx.17u.cn/tripactivities/getWXUserInfo?url=${back}&env=product&code=${code}&state=snsapi_userinfo`;
        const r = await request({ method: "GET", url, headers: { Cookie: cookie, Referer: "https://open.weixin.qq.com/" }, maxRedirects: 0 });
        const sc = r.headers?.["set-cookie"] || [];
        for (const c of (Array.isArray(sc) ? sc : [sc])) {
            const m = String(c).match(/WxUserToken=([^;]+)/);
            if (m) return m[1];
        }
        return null;
    }

    async trainLotteryBrowse() {
        try {
            if (!this.loginInfo.sectoken) throw new Error("未登录");
            const li = this.loginInfo;
            const ACT = "020b2bae7e6111f1ac3735f46258597e";
            const CHANNEL = 852;
            const BASE = "https://wx.17u.cn/tripactivities/api/trainLottery";
            const REDIRECT = "https://wx.17u.cn/tripactivities/getWXUserInfo";
            // —— 火车票抽奖码是 H5 网页活动，只认网页登录态 WxUserToken ——
            // 自动链路: WCS /wx/oauth(网页授权) -> getWXUserInfo(带小程序会员cookie) -> WxUserToken
            // 也支持环境变量手动覆盖: TCLX_LC_TRAIN_TOKEN(单token) / TCLX_LC_TRAIN_TOKENS({openId:token})
            let TOKEN_MAP = {};
            try { if (process.env.TCLX_LC_TRAIN_TOKENS) TOKEN_MAP = JSON.parse(process.env.TCLX_LC_TRAIN_TOKENS); } catch (e) {}
            const oid = li.openId;
            let wut = process.env.TCLX_LC_TRAIN_TOKEN || TOKEN_MAP[oid] || "";
            let tokenSrc = wut ? "手动注入" : "";
            if (!wut) {
                const code = await this.getWebOauthCode(REDIRECT);
                wut = await this.fetchWxUserToken(code, li);
                tokenSrc = wut ? "WCS网页授权自动签发" : "";
            }
            if (!wut) return `火车票抽奖码: 无法获取网页WxUserToken(需WCS网页授权能力)。请确认面板 wx_server_url/wx_auth 正确且账号已授权`;
            const auth = () => ({
                channel: CHANNEL,
                memberId: li.memberId || "",
                unionId: li.unionId || "",
                openId: oid || "",
                nickName: "",
                headImg: "",
                token: wut,
                actCode: ACT,
                traceId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            });
            // 1. 查询活动任务列表
            const idxR = await request({ method: "POST", url: `${BASE}/index`, headers: { "content-type": "application/json" }, data: auth() });
            const obj = idxR.data?.obj || {};
            if (!obj.taskInfoList) {
                const msg = idxR.data?.message || short(idxR.data);
                return `火车票抽奖码(${tokenSrc}): 查询失败 ${msg}`;
            }
            const tasks = obj.taskInfoList || [];
            const browse = tasks.filter((t) => t.taskType === "BROWSE" && t.taskStatus === 0);
            let claimed = 0;
            for (const t of browse) {
                const r = await request({ method: "POST", url: `${BASE}/claim_task`, headers: { "content-type": "application/json" }, data: { ...auth(), taskId: t.taskId } });
                if (r.data?.success) claimed++;
                await $.wait(1500);
            }
            // 2. 重新查询拿抽奖码
            const idxR2 = await request({ method: "POST", url: `${BASE}/index`, headers: { "content-type": "application/json" }, data: auth() });
            const obj2 = idxR2.data?.obj || {};
            const myCodes = (obj2.myLotteryCodeInfo || []).map((c) => c.lotteryCode);
            const browseAll = (obj2.taskInfoList || []).filter((t) => t.taskType === "BROWSE");
            const done = browseAll.filter((t) => t.taskStatus === 2).length;
            return `火车票抽奖码(${tokenSrc}): 浏览任务${done}/${browseAll.length} 本次领${claimed} | 抽奖码: ${myCodes.join(",") || "无"}`;
        } catch (e) {
            return `火车票抽奖码异常: ${e.message || e}`;
        }
    }

    // ====== 周周打卡瓜分现金（H5 活动 signInCash）======
    // 注意：身份是一次性 OAuth code，仅当天现抓现跑有效。详见文件顶部 DAILY_* 注释。
    async dailyCheckIn() {
        if (!DAILY_IDENID || !DAILY_UNIONID) {
            return "周周打卡: 未配置身份(需现抓 OAuth code 填 TCLX_LC_DAILY_IDENID / TCLX_LC_DAILY_UNIONID，见文件顶部说明)";
        }
        const log = [];
        try {
            const idx = await dailyApi("/getIndexInfo", DAILY_REFID ? { refId: DAILY_REFID } : {});
            L.info("    周周打卡 getIndexInfo: code=" + idx.code + " " + short(idx, 400));
            if (Number(idx.code) !== 1000) return `周周打卡-首页失败 code=${idx.code} ${idx.message || ""}`;
            const info = idx.data || {};
            // 首跑以信息收集为主：直接尝试打卡（已打卡后端会返回非1000，安全记录）
            const sign = await dailyApi("/signIn");
            log.push(Number(sign.code) === 1000 ? "打卡✅" : `打卡(已打卡/失败 code=${sign.code})`);
            const ti = await dailyApi("/getTaskInfo");
            if (Number(ti.code) === 1000) {
                const tasks = ti.data?.taskList || ti.data?.list || ti.data?.tasks || [];
                L.info("    周周打卡 任务数=" + tasks.length);
                for (const t of tasks) {
                    if (t.status === 0 && t.taskRecordId) {
                        const ct = await dailyApi("/completeTask", { taskType: t.taskType });
                        if (Number(ct.code) === 1000) {
                            const cr = await dailyApi("/claimTaskReward", { taskRecordId: t.taskRecordId });
                            if (Number(cr.code) === 1000) log.push("任务✅" + (t.title || t.taskType || ""));
                        }
                    }
                }
            } else {
                log.push("任务查询(code=" + ti.code + ")");
            }
            const draw = await dailyApi("/draw");
            if (Number(draw.code) === 1000) log.push("瓜分抽奖✅");
            else if (draw.code) log.push("抽奖(code=" + draw.code + ")");
            return "周周打卡: " + (log.join("; ") || "无操作");
        } catch (e) {
            return "周周打卡异常: " + (e.message || e);
        }
    }
}

async function runAccount(openid, index, total) {
    L.info("\n┏━━━━━━━━━━━ 👤 账号 " + index + "/" + total + "" + nickOf(openid) ? " · " + nickOf(openid) : "" + " ━━━━━━━━━━━┓");
    L.info("   openid: " + maskOpenid(openid) + "");
    L.info("┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫");
    const runner = new Tongcheng(openid);
    try {
        L.info("" + TC_ICON.login + " 登录：" + await runner.login() + "");
        const q = await runner.query();
        const mileage = (q.match(/remainMileageTitle":(\d+)/) || q.match(/里程=(\d+)/) || [])[1] || "?";
        TC_SUMMARY.push({ index, openid, mileage });
        L.info("" + TC_ICON.query + " 查询：" + q + "");
        const _signTxt = await runner.sign();
        L.info("" + TC_ICON.sign + " 签到：" + _signTxt + "");
        const _streak = (_signTxt.match(/连续=(\d+)天/) || [])[1] || null;
        TC_ROWS.push({ index, openid, mileage, sign: _signTxt, streak: _streak });
        if (ENABLE_GUAFEN) {
            L.info("" + TC_ICON.share + " 里程分享：" + await runner.mileageSign() + "");
            L.info("" + TC_ICON.task + " 任务：" + await runner.doTasks() + "");
        } else {
            L.info("" + TC_ICON.skip + " 瓜分任务：已跳过 (TCLX_LC_GUAFEN=false)");
        }
        L.info("" + TC_ICON.drama + " 看短句：" + await runner.dramaVisitReward() + "");
        L.info("" + TC_ICON.watch + " 观看：" + await runner.dramaWatch() + "");

        // LuckyCode 游戏
        L.info("" + TC_ICON.game + " 游戏：" + await runner.luckyCode() + "");

        // DeepTrip 活动
        if (ENABLE_HEAT_ESCAPE) {
            L.info("" + TC_ICON.heat + " 高温出逃：" + await runner.heatEscape() + "");
        } else {
            L.info("" + TC_ICON.skip + " 高温出逃：已跳过 (TCLX_LC_HEAT_ESCAPE=false)");
        }
        if (ENABLE_TRAVEL_FACT) {
            L.info("" + TC_ICON.fact + " 旅行真相：" + await runner.travelFact() + "");
        } else {
            L.info("" + TC_ICON.skip + " 旅行真相：已跳过 (TCLX_LC_TRAVEL_FACT=false)");
        }
        if (ENABLE_CASH_SCRATCH) {
            L.info("" + TC_ICON.scratch + " 钞级省刮卡：" + await runner.cashScratch() + "");
        } else {
            L.info("" + TC_ICON.skip + " 钞级省刮卡：已跳过 (TCLX_LC_CASH_SCRATCH=false)");
        }
        if (ENABLE_TRAIN_LOTTERY) {
            L.info("" + TC_ICON.train + " 火车票抽奖码：" + await runner.trainLotteryBrowse() + "");
        } else {
            L.info("" + TC_ICON.skip + " 火车票抽奖码：已跳过 (TCLX_LC_TRAIN_LOTTERY=false)");
        }
        if (ENABLE_FLOWER_GOD) {
            L.info("" + TC_ICON.flower + " 花神抽签：" + await runner.flowerGod() + "");
        } else {
            L.info("" + TC_ICON.skip + " 花神抽签：已跳过 (TCLX_LC_FLOWER_GOD=false)");
        }
        if (ENABLE_DAILY_CHECK) {
            L.info("" + TC_ICON.sign + " 周周打卡：" + await runner.dailyCheckIn() + "");
        } else {
            L.info("" + TC_ICON.skip + " 周周打卡：已跳过 (TCLX_LC_DAILY_CHECK=false)");
        }
    } catch (e) {
        L.fail("执行失败：" + e.message || e + "");
    }
}

(async () => {
    const accounts = (process.env[CK_NAME] || DEFAULT_OPENID || process.env.wx_opinion || "")
        .split((process.env[CK_NAME] || "").includes("\n") ? "\n" : "&")
        .map((x) => x.trim())
        .filter(Boolean);
    if (!accounts.length) {
        L.info("未配置 " + CK_NAME + "");
        await $.done();
        return;
    }
    const total = accounts.length;
    L.info("🌟════════════════════════════════════🌟");
    L.info("   同程旅行 · 里程签到每日任务");
    L.info("   " + $.time("yyyy-MM-dd HH:mm:ss") + "");
    L.info("🌟════════════════════════════════════🌟");
    L.info("共找到 " + total + " 个账号");
    for (let i = 0; i < total; i++) {
        await runAccount(accounts[i], i + 1, total);
        await $.wait(800);
    }
    // ===== 结尾汇总 + 判词装饰 =====
    if (TC_SUMMARY.length) {
        L.info("\n┏━━━━━━━━━━ 📊 里程汇总 ━━━━━━━━━━┓");
        for (const s of TC_SUMMARY) {
            const nick = nickOf(s.openid);
            L.info("  " + padCn("账号" + s.index + (nick ? "·" + nick : ""), 12) + " " + maskOpenid(s.openid) + "  里程 " + s.mileage + "");
        }
        L.info("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛");
    }
    L.info("\n🌸 判词｜" + TC_JUDGE + "");
    try {
        if (report && TC_ROWS.length) {
            const _rows = TC_ROWS.map(function (s) {
                return {
                    idx: s.index,
                    name: nickOf(s.openid) || null,
                    sign: s.sign || null,
                    earned: null,
                    total: (s.mileage != null && s.mileage !== "?" ? String(s.mileage) : null),
                    streak: s.streak || null,
                    tasks: null,
                    lottery: null,
                    taskEarned: null
                };
            });
            await report('同程旅行里程签到', _rows);
        }
    } catch (e) {}
    await $.done();
})().catch(async (e) => {
    L.fail("脚本异常：" + e.stack || e.message || e + "");
    await $.done();
});