/*
OPPO商城小程序自动任务脚本（独立运行版）
功能：微信code自动登录 + 每日签到 + 浏览任务 + 积分收益统计
依赖：仅需 axios （npm install axios）

==================== 使用说明 ====================
【环境变量配置】
1. oppo
   - 账号列表，多账号用 & 或换行分隔
   - 格式：openid#备注名（备注可选）
   - 示例：o123456789#大号&o987654321#小号
2. wx_server_url
   - 微信Code获取服务地址，默认：http://192.168.31.196:8787
3. wx_auth
   - wx_server 服务的鉴权密钥，必填项

【运行方式】
node oppo.js
==================================================
*/
const axios = require("axios");

const APP = {
    name: "OPPO",
    appid: "wxe705c556754a1de2",
    version: 361,
};
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const MINI_API = "https://omoapplet-api-cn.heytap.com";
const H5_API = "https://hd.opposhop.cn";
const SIGN_ACTIVITY_ID = "2061050217641549824";
const CREDITS_ADD_ACTION_ID = "1788913e6d9e4683b8b9ab0088733560";
const TASK_ACTIVITY_ID = "1919591795180969984";
const BUSINESS = 1;
const SIGN_PAGE =
    "https://hd.opposhop.cn/bp/b371ce270f7509f0?nightModelEnable=true&utm_source=huiyuanwx&utm_medium=me_qiandao";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const TASKS = [
    { name: "浏览618主会场", taskId: "2059539052281208832" },
    { name: "浏览「一加杯」会场", taskId: "2066367671079018496" },
    { name: "浏览阿萨Aza 频道页", taskId: "2064969064102764544" },
    { name: "浏览教育优惠", taskId: "1919592548679294976" },
    { name: "查看附近门店", taskId: "2010985754897162240" },
    { name: "浏览活动中心", taskId: "2009574225412890624" },
];

function getTimeStr() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function log(content) {
    console.log(`[${getTimeStr()}] ${content}`);
}

function wait(min, max = null) {
    const ms = max == null ? min : Math.floor(Math.random() * (max - min + 1)) + min;
    if (ms >= 1000) {
        log(`等待 ${(ms / 1000).toFixed(2)} 秒...`);
    }
    return new Promise(resolve => setTimeout(resolve, ms));
}

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 500) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseAccount(raw = "") {
    const text = String(raw || "").trim();
    if (!text) return {};
    if (text.startsWith("{")) {
        const data = JSON.parse(text);
        return {
            openid: data.openid || data.openId || "",
            remark: data.remark || data.name || "",
        };
    }
    const [openid, remark] = text.split("#").map((item) => item.trim());
    return { openid, remark };
}

function awardTypeName(type) {
    const map = {
        0: "无奖励",
        1: "积分",
        2: "优惠券",
        3: "抽奖机会",
    };
    return map[Number(type)] || `类型${type}`;
}

function todayText() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

async function request(options) {
    const res = await axios.request({
        timeout: 25000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(options.headers || {}),
        },
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
}

async function getWxCode(openid) {
    if (!WX_AUTH) throw new Error("未配置 wx_auth，无法从 wx_server 获取 code");
    const { status, data } = await request({
        method: "POST",
        url: `${WX_SERVER_URL}/wx/code`,
        headers: {
            auth: WX_AUTH,
            "content-type": "application/json",
            Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
        },
        data: { appid: APP.appid, openid },
    });
    const code = data?.data?.code || data?.code;
    if (status !== 200 || !code) throw new Error(`获取 code 失败 HTTP ${status}: ${short(data)}`);
    return code;
}

class OppoTask {
    constructor(rawAccount, index) {
        this.index = index;
        this.account = parseAccount(rawAccount);
        this.sessionId = "";
        this.encryptedSession = "";
        this.openId = "";
        this.memberInfo = {};
        this.baseInfo = {};
        this.initialPoints = 0;
        this.finalPoints = 0;
    }

    log(message) {
        const remarkStr = this.account.remark ? `[${this.account.remark}]` : "";
        log(`账号[${this.index}]${remarkStr} ${message}`);
    }

    miniHeaders(extra = {}) {
        return {
            "content-type": "application/json",
            s_channel: "oppo",
            source_type: "2",
            s_version: "010000",
            spCallSource: "oppohy",
            Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            sessionId: this.sessionId || "",
            NEWOPPOSID: this.encryptedSession || "",
            openid: this.openId || "",
            sa_distinct_id: this.openId || "",
            constToken: this.sessionId || "",
            ...extra,
        };
    }

    h5Headers(extra = {}) {
        return {
            "content-type": "application/json",
            Origin: H5_API,
            Referer: SIGN_PAGE,
            sessionId: this.sessionId || "",
            NEWOPPOSID: this.encryptedSession || "",
            openid: this.openId || "",
            sa_distinct_id: this.openId || "",
            constToken: this.sessionId || "",
            Cookie: [
                `NEWOPPOSID=${encodeURIComponent(this.encryptedSession || "")}`,
                `sessionId=${encodeURIComponent(this.sessionId || "")}`,
                `openid=${encodeURIComponent(this.openId || "")}`,
            ].join("; "),
            ...extra,
        };
    }

    async miniRequest(method, path, data = {}) {
        const upperMethod = method.toUpperCase();
        const { status, data: result } = await request({
            method: upperMethod,
            url: `${MINI_API}${path}`,
            headers: this.miniHeaders(),
            params: upperMethod === "GET" ? data : undefined,
            data: upperMethod === "GET" ? undefined : data,
        });
        if (status !== 200) throw new Error(`${path} HTTP ${status}: ${short(result)}`);
        if (result?.ret && String(result.ret) !== "1") {
            throw new Error(`${path} 失败: ${result.errMsg || result.message || short(result)}`);
        }
        return result;
    }

    async h5Request(method, path, data = {}) {
        const upperMethod = method.toUpperCase();
        const { status, data: result } = await request({
            method: upperMethod,
            url: `${H5_API}${path}`,
            headers: this.h5Headers(),
            params: upperMethod === "GET" ? data : undefined,
            data: upperMethod === "GET" ? undefined : data,
        });
        if (status !== 200) throw new Error(`${path} HTTP ${status}: ${short(result)}`);
        if (Number(result?.code) !== 200 && result?.succeed !== true) {
            throw new Error(`${path} 失败: ${result?.message || result?.errorMessage || short(result)}`);
        }
        return result;
    }

    async login() {
        if (!this.account.openid) throw new Error("账号格式错误，请配置 wx_server 里的 openid");
        const code = await getWxCode(this.account.openid);
        const { status, data } = await request({
            method: "POST",
            url: `${MINI_API}/user/pre/auth`,
            headers: {
                "content-type": "application/json",
                Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            },
            data: { code },
        });
        if (status !== 200 || String(data?.ret) !== "1") throw new Error(`登录失败 HTTP ${status}: ${short(data)}`);
        const info = data.data || {};
        this.sessionId = info.sessionId || "";
        this.encryptedSession = info.encryptedSession || "";
        this.openId = info.openId || "";
        if (!this.sessionId) throw new Error(`登录响应缺少 sessionId: ${short(data)}`);
        this.log(`登录成功 openId=${this.openId || "未知"}`);
    }

    async queryMember() {
        const member = await this.miniRequest("GET", "/member/info", { sessionId: this.sessionId });
        const base = await this.miniRequest("GET", "/member/baseInfo", { sessionId: this.sessionId }).catch(() => ({}));
        this.memberInfo = member.data || {};
        this.baseInfo = base.data || {};
        const userName = this.memberInfo.userName || this.baseInfo.userName || "未知";
        const phone = this.baseInfo.pnumber ? `，手机号: ${this.baseInfo.pnumber}` : "";
        this.log(
            `用户信息: ${userName}${phone}，积分: ${this.memberInfo.pointAmount ?? 0}，成长值: ${
                this.memberInfo.growthValue ?? 0
            }，等级: ${this.memberInfo.gradeCode || "未知"}`
        );
    }

    async queryEntrance() {
        const result = await this.miniRequest("GET", "/activity/signIn/entrance", { sessionId: this.sessionId });
        const data = result.data || {};
        this.log(`签到入口: ${data.signInIsStarted ? "已开启" : "未开启"}，连续/累计天数: ${data.signInDays ?? "-"}`);
    }

    async getSignDetail() {
        const result = await this.h5Request("GET", "/api/cn/oapi/marketing/cumulativeSignIn/getSignInDetail", {
            activityId: SIGN_ACTIVITY_ID,
            creditsAddActionId: CREDITS_ADD_ACTION_ID,
            business: BUSINESS,
        });
        return result.data || {};
    }

    todayAward(detail = {}) {
        const today = todayText();
        const awards = Array.isArray(detail.baseAwards) ? detail.baseAwards : [];
        return awards.find((item) => String(item.signTime || "").slice(0, 10) === today) || awards[0] || {};
    }

    async querySignDetail() {
        const detail = await this.getSignDetail();
        const award = this.todayAward(detail);
        const signed = Number(award.status) === 1;
        this.log(
            `签到详情: ${signed ? "今日已签" : "今日未签"}，已签天数: ${detail.signInDayNum ?? 0}，今日奖励: ${
                award.awardValue ?? "-"
            }${award.awardType !== undefined ? awardTypeName(award.awardType) : ""}`
        );
        return { detail, signed };
    }

    async signIn() {
        const { signed } = await this.querySignDetail();
        if (signed) return this.log("签到结果: 今日已签到，跳过");
        const result = await this.h5Request("POST", "/api/cn/oapi/marketing/cumulativeSignIn/signIn", {
            activityId: SIGN_ACTIVITY_ID,
            captchaCode: "",
            creditsAddActionId: CREDITS_ADD_ACTION_ID,
            business: BUSINESS,
        });
        const data = result.data || {};
        if (data.receiveStatus === false) {
            this.log(`签到结果: 失败，${data.receiveFailMsg || result.message || "未知原因"}`);
            return;
        }
        this.log(`签到结果: 成功，获得 ${data.awardValue ?? "-"}${awardTypeName(data.awardType)}`);
        await this.querySignDetail();
    }

    async doSingleTask(task) {
        const { name, taskId } = task;
        try {
            try {
                await this.h5Request("GET", "/api/cn/oapi/marketing/taskReport/signInOrShareTask", {
                    taskId,
                    activityId: TASK_ACTIVITY_ID,
                    taskType: 1
                });
            } catch (e) {}
            await wait(800);

            const result = await this.h5Request("GET", "/api/cn/oapi/marketing/task/receiveAward", {
                taskId,
                activityId: TASK_ACTIVITY_ID,
                creditsAddActionId: CREDITS_ADD_ACTION_ID,
                business: BUSINESS
            });
            const data = result.data || {};
            if (data.receiveStatus) {
                this.log(`任务【${name}】完成，获得 ${data.awardValue ?? "-"}${awardTypeName(data.awardType)}`);
                return true;
            } else {
                const msg = result.message || result.errorMessage || "";
                if (["已领取", "已完成", "已参与"].some(k => msg.includes(k))) {
                    this.log(`任务【${name}】${msg}`);
                    return true;
                }
                this.log(`任务【${name}】失败：${msg || "未知原因"}`);
                return false;
            }
        } catch (e) {
            this.log(`任务【${name}】异常：${e.message || e}`);
            return false;
        }
    }

    async doTasks() {
        this.log("===== 开始执行浏览任务 =====");
        let okCount = 0;
        for (const task of TASKS) {
            if (await this.doSingleTask(task)) {
                okCount++;
            }
            await wait(500);
        }
        this.log(`浏览任务总进度：${okCount}/${TASKS.length}`);
    }

    async run() {
        try {
            this.log(`开始执行 ${APP.name}`);
            await this.login();
            await this.queryMember();
            this.initialPoints = Number(this.memberInfo.pointAmount ?? 0);
            await this.queryEntrance();
            await this.signIn();
            await this.doTasks();
            await this.queryMember();
            this.finalPoints = Number(this.memberInfo.pointAmount ?? 0);
            const earnedPoints = this.finalPoints - this.initialPoints;
            this.log("===== 执行完成 =====");
            this.log(`本次总收益：积分 +${earnedPoints}`);
            this.log(`当前总积分：${this.finalPoints}`);
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

async function main() {
    const envKey = "oppo";
    const rawEnv = process.env[envKey] || process.env.wx_opinion || "";
    if (!rawEnv.trim()) {
        log(`未找到环境变量 ${envKey}，请配置后再运行`);
        return;
    }

    const accountList = splitAccounts(rawEnv);
    log(`共找到${accountList.length}个账号`);
    log(`🔔${APP.name}, 开始!`);
    const startTime = Date.now();

    for (let i = 0; i < accountList.length; i++) {
        const task = new OppoTask(accountList[i], i + 1);
        await task.run();
        if (i < accountList.length - 1) {
            await wait(1500, 3000);
        }
    }

    const cost = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`🔔${APP.name}, 结束! 耗时 ${cost} 秒`);
    process.exit(0);
}

main()
    .catch((e) => {
        log(`脚本异常: ${e.message || e}`);
        process.exit(1);
    });
