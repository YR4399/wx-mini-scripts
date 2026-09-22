/*
------------------------------------------
@Description: 茶百道 - 微信小程序签到（自动发现签到活动）
cron: 30 9 * * *
数据来源：SunnyNet 抓包逆向（2026-09-04）
------------------------------------------
修复点：
1. 签到接口 Body 字段修正：抓包实际为 {businessId, activityJoinSource, traceId}，旧脚本传的是 {id, shopId}
2. 请求头补齐 versionCode / versionName
3. 自动发现：queryDetail 校验候选 businessId，动态读取活动名称（"X月会员签到 第N期"）
4. 加入 std_report 统一推送格式
5. 总积分查询：qryPointsAppletAccount
------------------------------------------
*/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

const { Env } = require("../tools/env.js");
const $ = new Env("茶百道签到");
const axios = require("axios");
axios.defaults.proxy = false;

// __NET_RETRY__
axios.interceptors.response.use(
    (r) => r,
    async (e) => {
        const cfg = e.config || {};
        cfg.__rc = (cfg.__rc || 0) + 1;
        const m = String((e && (e.message || e.code)) || "");
        const net = !e.response && /timeout|ECONNABORTED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang|network|connection/i.test(m);
        if (net && cfg.__rc <= 3) {
            await new Promise((s) => setTimeout(s, 2000 * cfg.__rc));
            const { __rc, ...rest } = cfg;
            return axios.request(rest);
        }
        throw e;
    }
);

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WeChatServer = require("./wcs.js");

const ckName = "wx_opinion";  // 与原脚本一致，复用面板通用账号变量
const APP_NAME = "茶百道签到";
const TOKEN_CACHE_FILE = path.join(__dirname, "cbd_sign_token_cache.json");

const MINI_APP_ID = "wx2804355dbf8d15c3";
const API_BASE = "https://chabaidao-gateway2.shuxinyc.com";
const MARKETING_BASE = "https://md-h5-gateway.shuxinyc.com";
const POINTS_BASE = "https://marketing.shuxinyc.com";

const GROUP_ID = "317964";
const MEMBER_SYSTEM_ID = "21";

// 版本信息（抓包固定值）
const VERSION_CODE = "34792";
const VERSION_NAME = "3.4.792";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.6 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364";

// 接口
const EP_LOGIN = "/hll-auth-client/oauth2/login/get/info";
const EP_SIGNIN = "/marketing/minip/activity/join/signIn";
const EP_QUERYDETAIL = "/marketing/minip/activity/queryDetail";
const EP_PRIZE_RECORD = "/marketing/minip/activity/member/prize/record";
const EP_QRYPOINTS = "/memberActivity2c/applet/points/qryPoints";
const EP_QRYPOINTS_ACC = "/memberPoints2C/applet/qryPointsAppletAccount";
const EP_ADVERT = "/cbd-advert-service/resBit/front/getAdContent";

// 签到活动候选 businessId（每周更换期数，businessId 可能变化；脚本自动轮询校验）
//   来源：SunnyNet 抓包 2026-09-04（第 5 期 44FQcqlKRSf2）
const BUSINESS_ID_CANDIDATES = [
    process.env.cbd_business_id || "44FQcqlKRSf2",
    "nLeSJVfnWF5Q",  // 旧版本备份（第 3/4 期用过）
];

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try { if (!fs.existsSync(TOKEN_CACHE_FILE)) return {}; return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) {}
}
function genUUID() {
    return crypto.randomUUID();
}
function short(v, n = 120) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return (s.length > n) ? s.slice(0, n) + "…" : s;
}
// 解析活动时间 "20260831000000" → Date（用于判断活动是否已结束）
function parseActTime(v) {
    const t = String(v || "").replace(/[^0-9]/g, "");
    if (t.length < 8) return null;
    const d = new Date(
        Number(t.slice(0, 4)),
        Number(t.slice(4, 6)) - 1,
        Number(t.slice(6, 8)),
        Number(t.slice(8, 10) || 0),
        Number(t.slice(10, 12) || 0),
        Number(t.slice(12, 14) || 0)
    );
    return isNaN(d.getTime()) ? null : d;
}

class Task {
    constructor(raw, index) {
        this.account = { openid: raw, remark: "" };
        this.index = index;
        this.csession = null;
        this.openId = "";
        this.businessId = "";
        this.activityName = "";
        this.activityStart = "";
        this.activityEnd = "";
        this.activityExpired = false;
        if (this.account.remark) _setName(this.index, this.account.remark);
    }

    getHeaders(host) {
        return {
            "Host": host,
            "Connection": "keep-alive",
            "Content-Type": "application/json",
            "CSESSION": this.csession || "",
            "versionCode": VERSION_CODE,
            "versionName": VERSION_NAME,
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/1307/page-frame.html",
            "User-Agent": UA,
            "xweb_xhr": "1",
        };
    }

    async request(base, apiPath, { json = {}, extraHeaders = {} } = {}) {
        const url = base + apiPath;
        const res = await axios.request({
            method: "POST",
            url,
            headers: { ...this.getHeaders(new URL(base).hostname), ...extraHeaders },
            data: { ...json, traceId: genUUID() },
            timeout: 30000,
            validateStatus: () => true,
        });
        return res.data;
    }

    async login() {
        const cache = readCache();
        // 尝试用缓存 token
        if (cache[this.account.openid]?.csession) {
            this.csession = cache[this.account.openid].csession;
            const chk = await this.request(API_BASE, EP_QRYPOINTS_ACC, { json: {} });
            if (chk?.code === "000" && chk?.data) {
                this.log("使用缓存 token");
                return cache[this.account.openid];
            }
        }

        // Step 1: 首次登录 pureSign=true
        const { data: codeData1 } = await wechat.getCode(this.account.openid);
        const code1 = codeData1?.data?.code || codeData1?.code;
        if (!code1) throw new Error("获取 code 失败");

        const resp1 = await this.request(API_BASE, EP_LOGIN, { json: {
            token: "", groupId: GROUP_ID, memberSystemId: MEMBER_SYSTEM_ID,
            code: code1, appId: MINI_APP_ID, pureSign: true,
        }});
        if (resp1?.code !== "000" || !resp1?.data?.token) {
            throw new Error("首次登录失败: " + short(resp1));
        }
        this.csession = resp1.data.token;
        this.openId = resp1.data.openId || this.account.openid;
        this.log("首次登录成功");

        // Step 2: 刷新登录 pureSign=false
        await $.wait(800 + Math.random() * 500);
        const { data: codeData2 } = await wechat.getCode(this.account.openid);
        const code2 = codeData2?.data?.code || codeData2?.code;
        if (!code2) { this._saveToken(); return resp1.data; }

        const resp2 = await this.request(API_BASE, EP_LOGIN, { json: {
            token: this.csession, groupId: GROUP_ID, memberSystemId: MEMBER_SYSTEM_ID,
            code: code2, appId: MINI_APP_ID, pureSign: false,
        }});
        if (resp2?.code === "000" && resp2?.data?.token) {
            this.csession = resp2.data.token;
            this.openId = resp2.data.openId || this.openId;
            this.log("刷新登录成功");
            this._saveToken();
            return resp2.data;
        }
        this.log("刷新登录失败，使用首次登录");
        this._saveToken();
        return resp1.data;
    }

    _saveToken() {
        const cache = readCache();
        cache[this.account.openid] = { csession: this.csession, openId: this.openId, ts: Date.now() };
        writeCache(cache);
    }

    log(msg) { $.log(`账号[${this.index}] ${msg}`); }

    isAuthError(r) {
        const s = short(r, 200);
        return /登录|登录已过期|not.*login|unauthori|token.*invalid|CSESSION|session.*expire|CSRF/i.test(s);
    }

    // 自动发现：优先选**未结束**的活动；全部结束则标记 activityExpired（跳过签到而不是报失败）
    // 【2026-09-17 修】旧版只校验 signInDetail 存在就选，会选中已经结束的上一期
    // （实测 09-17 三账号全部 "❌ 签到失败: 活动已结束"，属旧活动未过期剔除导致）。
    async discoverBusinessId() {
        // 手动指定优先
        if (process.env.cbd_business_id) {
            this.businessId = process.env.cbd_business_id;
            this.log(`手动指定 businessId: ${this.businessId}`);
            return this.businessId;
        }
        let fallback = null;
        for (const bid of BUSINESS_ID_CANDIDATES) {
            try {
                const r = await this.request(MARKETING_BASE, EP_QUERYDETAIL, {
                    json: { businessId: bid, activityType: 3, month: "", year: "" },
                });
                if (r?.code === "000" && r?.data?.signInDetail) {
                    const d = r.data.signInDetail;
                    const end = parseActTime(d.endTime);
                    const expired = end ? end.getTime() < Date.now() : false;
                    this.log(`发现签到活动: "${d.name}" (${bid}, ${d.startTime}-${d.endTime})${expired ? " [已结束]" : ""}`);
                    if (!expired) {
                        this.businessId = bid;
                        this.activityName = d.name || "";
                        this.activityStart = d.startTime || "";
                        this.activityEnd = d.endTime || "";
                        this.activityExpired = false;
                        return bid;
                    }
                    if (!fallback) fallback = { bid, d };
                } else {
                    this.log(`businessId ${bid} 无有效活动（${short(r, 80)}）`);
                }
            } catch (e) {
                this.log(`businessId ${bid} 探测异常: ${e.message || e}`);
            }
        }
        if (fallback) {
            // 没有进行中的活动：不再硬签旧活动，标记跳过
            this.businessId = fallback.bid;
            this.activityName = fallback.d.name || "";
            this.activityStart = fallback.d.startTime || "";
            this.activityEnd = fallback.d.endTime || "";
            this.activityExpired = true;
            this.log(`⚠️ 候选活动均已结束（最近一期: "${this.activityName}" 截止 ${this.activityEnd}）→ 本次跳过签到，等新一期上线`);
            return this.businessId;
        }
        // 兜底用第一个候选
        this.businessId = BUSINESS_ID_CANDIDATES[0];
        this.log(`兜底使用 businessId: ${this.businessId}`);
        return this.businessId;
    }

    async getPoints() {
        try {
            const r = await this.request(API_BASE, EP_QRYPOINTS_ACC, { json: {} });
            if (r?.code === "000" && r?.data) {
                const pts = Number(r.data.total || r.data.enable || 0);
                this.log(`总积分: ${pts}`);
                return pts;
            }
        } catch (e) { /* 忽略 */ }
        try {
            const r = await this.request(POINTS_BASE, EP_QRYPOINTS, { json: {} });
            if (r?.code === "000" && r?.data) return Number(r.data.points || 0);
        } catch (e) {}
        return 0;
    }

    async getPrizeRecord() {
        try {
            const r = await this.request(MARKETING_BASE, EP_PRIZE_RECORD, {
                json: { businessId: this.businessId, queryCurrentNew: true, activityId: "", type: 3 },
            });
            if (r?.code === "000" && r?.data) return r.data;
        } catch (e) {}
        return null;
    }

    async signIn() {
        if (!this.businessId) await this.discoverBusinessId();
        const resp = await this.request(MARKETING_BASE, EP_SIGNIN, {
            json: { businessId: this.businessId, activityJoinSource: 0 },
        });
        return resp;
    }

    async run() {
        try {
            const loginData = await this.login();
            // 自动发现签到活动
            await this.discoverBusinessId();
            // 签到前刷一次总积分
            const ptsBefore = await this.getPoints();
            if (this.activityExpired) {
                // 没有进行中的活动：跳过而不是报失败（等品牌方上新一期）
                this.log(`➖ 跳过签到：活动已结束（${this.activityName || this.businessId}），非脚本故障`);
                _setSign(this.index, "跳过:活动已结束", "", 0);
                if (this.index != null) _rpGet(this.index).total = String(ptsBefore);
                this.log("任务完成");
                return;
            }
            // 执行签到
            await $.wait(1000 + Math.random() * 1500);
            const r = await this.signIn();

            if (r?.code === "000") {
                const gifts = r.data?.marketingGiftConfCOList || [];
                const giftText = gifts.map(g => {
                    const items = g.giftList || [];
                    return items.map(i => {
                        if (i.giftType === 3 && i.point > 0) return `${i.point}熊猫币`;
                        return g.giftName || "奖励";
                    }).join("+");
                }).join(", ");
                const signDate = r.data?.signDate || "";
                const dateStr = signDate ? `${signDate.slice(4,6)}/${signDate.slice(6,8)}` : "";
                this.log(`✅ 签到成功! ${giftText || "奖励"}${dateStr ? "（" + dateStr + "）" : ""}`);
                _setSign(this.index, `签到成功${giftText ? " +" + giftText : ""}${dateStr ? " " + dateStr : ""}`, "", 0);
                // 刷积分
                const ptsAfter = await this.getPoints();
                const earned = ptsAfter > ptsBefore ? (ptsAfter - ptsBefore) : 0;
                if (this.index != null) _rpGet(this.index).total = String(ptsAfter);
                if (earned > 0) _rpGet(this.index).earned = "今日+" + earned + "熊猫币";
            } else {
                const msg = r?.msg || short(r, 200);
                if (/已签|已参与|已参加|重复/.test(String(msg))) {
                    this.log(`📌 今日已签到`);
                    _setSign(this.index, "今日已签到", "", 0);
                    const pts = await this.getPoints();
                    if (this.index != null) _rpGet(this.index).total = String(pts);
                } else if (this.isAuthError(r)) {
                    this.log(`⚠️ 登录失效: ${msg}`);
                    _setSign(this.index, "登录失效", "", 0);
                } else {
                    this.log(`❌ 签到失败: ${msg}`);
                    _setSign(this.index, "失败:" + msg.slice(0, 40), "", 0);
                }
            }
            // 中奖记录（补充信息）
            const record = await this.getPrizeRecord();
            if (record) {
                const list = record.list || record.records || [];
                if (Array.isArray(list) && list.length) {
                    _addTask(this.index, "签到奖励", `${list.length}条`);
                }
            }
            this.log("任务完成");
        } catch (e) {
            this.log(`异常: ${e.message || e}`);
            _setSign(this.index, "异常:" + String(e.message || e).slice(0, 40), "", 0);
        }
    }
}

// ========== std_report 集成 ==========
async function getNotice() {
    // 通知入口（保留兼容）
}
const { report: _stdReport } = require("./std_report");
let _rpApp = APP_NAME;
let _rpRows = [];
function _rpGet(idx) {
    if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", tasks: [], lottery: "" };
    return _rpRows[idx];
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
    const r = _rpGet(idx);
    if (sign != null) r.sign = String(sign);
    if (earned != null && earned !== "") r.earned = String(earned);
    if (total != null && total !== "") r.total = String(total);
}
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
async function flushLogPoints(app) {
    _rpApp = app || _rpApp;
    const rows = _rpRows.filter(Boolean);
    if (!rows.length) return;
    await _stdReport(_rpApp, rows);
}
{
    const _oe = process.exit.bind(process);
    process.exit = function (code) {
        const p = flushLogPoints(_rpApp);
        if (p && typeof p.then === "function") p.then(() => _oe(code)).catch(() => _oe(code));
        else _oe(code);
    };
}
process.on("beforeExit", () => { flushLogPoints(_rpApp); });

!(async () => {
    await getNotice();
    $.checkEnv(ckName);
    if (!$.userCount) { $.log(`未找到变量 ${ckName}`); return; }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})().catch((e) => $.log(e.message || e)).finally(() => $.done());
