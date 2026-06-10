// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

/*
@Description: 大参林小程序签到+做任务
cron: 35 8 * * *
*/

const { Env } = require("../tools/env.js");
const $ = new Env("大参林小程序签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const WeChatServer = require("./wcs.js");

// 跳过TLS证书验证 + 禁用代理
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

const MINI_APP_ID = "wx16ed9a8bbb188228";
const PAGE_VERSION = "992";
const CRM_BASE = "https://crmweixin.dslbuy.com";
const SIGN_BASE = CRM_BASE;
const ACTIVITY_BASE = "https://dcapi.dslbuy.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "dasenlin_token_cache.json");
const SIGN_SALT = "LYq76ucaPg2nsO7E";
const ACTIVITY_ID = "1654405290741305345";
const STORE_NO = "2000014618";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://192.168.31.196:8787",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function todayText() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex").toLowerCase();
}

function getMessage(result) {
    return result?.message || result?.msg || result?.resp_msg || JSON.stringify(result);
}

function isSuccess(result) {
    return result && (Number(result.status) === 200 || result.code === "A0200" || result.resp_code === "0000");
}

function isTokenError(message) {
    return /300|311|token|登录|授权|未登录|无效|过期|您好，请登录/i.test(String(message || ""));
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        this.account = String(account || "").trim();
        this.token = "";
        this.userInfo = {};
        this.signInfo = null;
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getSignInfo();
        await this.signIn();
        await this.getSignInfo();
        await this.doTasks();
    }

    getCachedToken() {
        const cache = readTokenCache();
        const item = cache[this.account];
        return item && item.token ? item : null;
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.account] = {
            token: this.token,
            userInfo: this.userInfo || {},
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.account]) {
            delete cache[this.account];
            writeTokenCache(cache);
        }
        this.token = "";
        this.userInfo = {};
    }

    applyToken(data = {}) {
        this.token = data.token || data.mini_token || "";
        this.userInfo = data.userInfo || {};
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...extra,
        };
    }

    async request({ base = SIGN_BASE, method = "GET", apiPath, params = {}, data = {}, raw = false, stringifyPost = false, urlToken = false }) {
        const upperMethod = method.toUpperCase();
        const token = this.token;
        const options = {
            method: upperMethod,
            url: `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
            proxy: false,
        };

        if (token && urlToken) {
            if (options.url.includes("?")) options.url += `&mini_token=${encodeURIComponent(token)}`;
            else options.url += `?mini_token=${encodeURIComponent(token)}`;
        }

        const payload = token ? { ...data, mini_token: token, type: data.type ?? 1 } : { ...data };
        if (upperMethod === "GET") options.params = token ? { ...params, mini_token: token, type: params.type ?? 1 } : params;
        else options.data = stringifyPost ? JSON.stringify(payload) : payload;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (raw) return result;
        if (!isSuccess(result)) throw new Error(getMessage(result));
        return result.data ?? result.datas ?? result;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.account);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const result = await axios.request({
                method: "POST",
                url: `${CRM_BASE}/member-center/entrance/registryByWeiXinCode`,
                headers: this.getHeaders(),
                data: {
                    code,
                    storeNo: "",
                },
                timeout: 20000,
                validateStatus: () => true,
                proxy: false,
            });
            if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.data)}`);
            const body = result.data;
            if (!isSuccess(body)) throw new Error(getMessage(body));
            const data = body.data || {};
            this.token = data.token || "";
            const crm = data.crmMemberInfo || {};
            const third = data.miniUserThirdVo || {};
            this.userInfo = {
                id: data.id || crm.id || "",
                name: crm.name || crm.nickName || data.nickName || "",
                phone: crm.phone || crm.mobile || data.phone || data.mobile || "",
                mobile: crm.mobile || crm.phone || data.mobile || data.phone || "",
                tier: crm.tier || data.tier || "",
                point: crm.point || data.point || "",
                openId: third.openId || "",
                unionId: third.unionId || "",
            };
            if (!this.token) throw new Error(`登录响应未返回token: ${JSON.stringify(body)}`);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功${this.userInfo.phone ? `: ${maskPhone(this.userInfo.phone)}` : ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignInfo(needLog = true) {
        const data = await this.request({
            base: SIGN_BASE,
            apiPath: "/integralmall/signTemp/getByUser.do",
            raw: true,
        });
        if (!isSuccess(data)) throw new Error(getMessage(data));
        const result = data?.data?.result || data?.datas?.result || {};
        this.signInfo = result;
        const member = data?.data?.member || {};
        const miniUser = data?.data?.miniUser || {};
        const phone = this.userInfo.phone || this.userInfo.mobile || member.phone || member.mobile || miniUser.mobile || "";
        this.userInfo = {
            ...this.userInfo,
            name: this.userInfo.name || member.name || miniUser.name || "",
            phone,
            mobile: phone,
            tier: this.userInfo.tier || member.tier || miniUser.tier || "",
            point: member.point ?? miniUser.point ?? this.userInfo.point ?? "",
        };
        this.saveCachedToken();

        if (needLog) {
            const userSign = result.userSign || {};
            const signed = this.isSignedToday(userSign.signDate);
            $.log(`账号[${this.index}] 会员: ${this.userInfo.name || "未知"} ${maskPhone(phone)}`);
            $.log(`账号[${this.index}] 签到状态: 连续${userSign.signDay ?? userSign.successionDay ?? 0}天 今日=${signed ? "已签" : "未签"}`);
        }
        return result;
    }

    isSignedToday(signDate) {
        if (!signDate) return false;
        const date = new Date(Number(signDate) || signDate);
        if (Number.isNaN(date.getTime())) return false;
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}` === todayText();
    }

    async signIn() {
        const userSign = this.signInfo?.userSign || {};
        if (this.isSignedToday(userSign.signDate)) {
            $.log(`账号[${this.index}] 今日已签到`);
            return;
        }

        const mobile = this.userInfo.phone || this.userInfo.mobile;
        if (!mobile) {
            $.log(`账号[${this.index}] 签到失败: 未获取到会员手机号`);
            return;
        }

        try {
            await this.request({
                base: SIGN_BASE,
                apiPath: "/integralmall/userSign/updateFormId.do",
                data: {
                    remind: false,
                },
            }).catch(() => {});

            const timestamp = Math.round(Date.now() / 1000);
            const sign = md5(`${mobile}${timestamp}${SIGN_SALT}`);
            // 抓包显示 sign.do 使用 GET + URL参数
            const result = await this.request({
                base: SIGN_BASE,
                method: "GET",
                apiPath: "/integralmall/userSign/sign.do",
                params: {
                    mobile,
                    timestamp,
                    sign,
                    storeNo: STORE_NO,
                },
                raw: true,
                urlToken: true,
            });

            if (Number(result.status) === 1 || /今日已签到/.test(getMessage(result))) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            if (!isSuccess(result)) throw new Error(getMessage(result));

            const data = result.data || {};
            if (data.yearPointFull) {
                $.log(`账号[${this.index}] 签到成功，本年积分已达上限`);
                return;
            }
            const integral = data.integral ?? result.message ?? "";
            $.log(`账号[${this.index}] 签到成功${integral !== "" && integral !== "0" ? `: +${integral}积分` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/今日已签到|已签到/.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }

    // ========== 任务相关 ==========

    async getTaskList() {
        try {
            const result = await this.request({
                base: ACTIVITY_BASE,
                method: "GET",
                apiPath: "/dc-biz-activity/applet/ginsengTask/userTasks",
                params: {
                    activityId: ACTIVITY_ID,
                    storeNo: STORE_NO,
                },
                raw: true,
                urlToken: true,
            });
            if (!isSuccess(result)) {
                $.log(`账号[${this.index}] 获取任务列表失败: ${getMessage(result)}`);
                return [];
            }
            const taskInfos = result?.datas?.userTaskInfos || [];
            return taskInfos;
        } catch (e) {
            $.log(`账号[${this.index}] 获取任务列表异常: ${e.message || e}`);
            return [];
        }
    }

    async completeTask(taskId) {
        try {
            const result = await this.request({
                base: ACTIVITY_BASE,
                method: "POST",
                apiPath: "/dc-biz-activity/applet/gameTask/addTaskRecord",
                data: {
                    activityId: ACTIVITY_ID,
                    taskId,
                    storeNo: STORE_NO,
                },
                raw: true,
                urlToken: true,
            });
            if (!isSuccess(result)) {
                return { ok: false, msg: getMessage(result) };
            }
            const data = result?.datas || {};
            return { ok: true, awardNum: data.awardNum || 0, msg: getMessage(result) };
        } catch (e) {
            return { ok: false, msg: e.message || String(e) };
        }
    }

    async claimTaskAwards() {
        try {
            // 1. 获取未领取的水滴记录
            const result = await this.request({
                base: ACTIVITY_BASE,
                method: "GET",
                apiPath: "/dc-biz-activity/applet/ginsengDripRecord/userNewDrip",
                params: {
                    activityId: ACTIVITY_ID,
                },
                raw: true,
                urlToken: true,
            });
            if (!isSuccess(result)) {
                $.log(`账号[${this.index}] 查询水滴失败: ${getMessage(result)}`);
                return;
            }
            const dripList = result?.datas || [];
            if (!dripList.length) {
                $.log(`账号[${this.index}] 无待领取水滴`);
                return;
            }

            // 2. 收集所有 dripRecordIds
            const allIds = [];
            for (const item of dripList) {
                if (item.dripRecordIds && item.dripRecordIds.length) {
                    allIds.push(...item.dripRecordIds);
                    $.log(`账号[${this.index}] 待领取: ${item.dripNum}g水滴 (${item.dripRecordIds.length}条记录)`);
                }
            }

            if (!allIds.length) {
                $.log(`账号[${this.index}] 无待领取水滴记录`);
                return;
            }

            // 3. 调用 getDrip 领取水滴
            const claimResult = await this.request({
                base: ACTIVITY_BASE,
                method: "POST",
                apiPath: "/dc-biz-activity/applet/ginsengDripRecord/getDrip",
                data: {
                    dripRecordIds: allIds,
                },
                raw: true,
                urlToken: true,
            });

            if (isSuccess(claimResult)) {
                const totalDrip = dripList.reduce((sum, item) => sum + (item.dripNum || 0), 0);
                $.log(`账号[${this.index}] ✅ 领取水滴成功: +${totalDrip}g (${allIds.length}条记录)`);
            } else {
                $.log(`账号[${this.index}] ❌ 领取水滴失败: ${getMessage(claimResult)}`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 领取奖励异常: ${e.message || e}`);
        }
    }

    async doTasks() {
        $.log(`账号[${this.index}] --- 开始做任务 ---`);
        const taskList = await this.getTaskList();
        if (!taskList.length) {
            $.log(`账号[${this.index}] 无任务列表`);
            return;
        }

        // 可自动完成的任务类型：9=浏览任务, 3=领取优惠券, 6=签到(已做)
        const completableTypes = [9, 3];
        const skipTypes = [1, 2, 5, 7, 8, 11, 12]; // 需要真实操作的跳过

        let completedCount = 0;
        for (const task of taskList) {
            const { taskId, showTaskName, taskType, awardDrip, timeDripNum, completeNum } = task;
            const maxComplete = timeDripNum || 1;
            const alreadyDone = completeNum || 0;

            if (alreadyDone >= maxComplete) {
                continue; // 已完成
            }

            if (!completableTypes.includes(taskType)) {
                continue; // 不可自动完成
            }

            // 浏览任务 / 领券 等
            const remaining = maxComplete - alreadyDone;
            for (let i = 0; i < remaining; i++) {
                const res = await this.completeTask(taskId);
                if (res.ok) {
                    completedCount++;
                    $.log(`账号[${this.index}] ✅ ${showTaskName} +${awardDrip}水滴`);
                } else {
                    $.log(`账号[${this.index}] ❌ ${showTaskName}: ${res.msg}`);
                    break; // 失败则跳过该任务
                }
                await new Promise(r => setTimeout(r, 1500)); // 延迟
            }
        }

        if (completedCount > 0) {
            await this.claimTaskAwards();
        }

        // 浇水
        await this.watering();

        // 再获取一次任务列表显示总水滴
        try {
            const freshList = await this.getTaskList();
            let totalDrip = 0;
            for (const t of freshList) {
                totalDrip += (t.completeNum || 0) * (t.awardDrip || 0);
            }
            $.log(`账号[${this.index}] 任务完成, 今日水滴约: ${totalDrip}g`);
        } catch (e) { /* ignore */ }

        $.log(`账号[${this.index}] --- 任务结束 ---`);
    }

    async watering() {
        try {
            // 先获取用户等级信息
            const levelInfo = await this.request({
                base: ACTIVITY_BASE,
                method: "GET",
                apiPath: "/dc-biz-activity/applet/ginsengGameRecord/userLevelInfo",
                params: {
                    activityId: ACTIVITY_ID,
                },
                raw: true,
                urlToken: true,
            });

            if (!isSuccess(levelInfo)) {
                $.log(`账号[${this.index}] 获取等级信息失败: ${getMessage(levelInfo)}`);
                return;
            }

            const levelData = levelInfo?.datas || {};
            const levelName = levelData.levelName || "未知";
            const dripTotal = levelData.dripTotal || 0;
            const usedDripNum = levelData.usedDripNum || 0;
            const availableDrip = dripTotal - usedDripNum;

            $.log(`账号[${this.index}] 当前等级: ${levelName}, 可用水滴: ${availableDrip}g`);

            if (availableDrip <= 0) {
                $.log(`账号[${this.index}] 无可用浇水水滴`);
                return;
            }

            // 浇水
            const result = await this.request({
                base: ACTIVITY_BASE,
                method: "POST",
                apiPath: "/dc-biz-activity/applet/ginsengDripRecord/watering",
                data: {
                    activityId: ACTIVITY_ID,
                    dripNum: availableDrip,
                    storeNo: STORE_NO,
                },
                raw: true,
                urlToken: true,
            });

            if (!isSuccess(result)) {
                $.log(`账号[${this.index}] 浇水失败: ${getMessage(result)}`);
                return;
            }

            const data = result?.datas || {};
            const upgrade = data.upgrade || false;
            const newLevel = data.ginsengLevels?.[0];
            if (upgrade && newLevel) {
                $.log(`账号[${this.index}] 🌱 浇水成功! 升级到: ${newLevel.levelName} (Lv.${newLevel.level})`);
            } else {
                $.log(`账号[${this.index}] 💧 浇水成功! 使用${availableDrip}g水滴`);
            }
        } catch (e) {
            $.log(`账号[${this.index}] 浇水异常: ${e.message || e}`);
        }
    }
}

!(async () => {
    
    $.checkEnv(ckName);
    for (const account of $.userList) {
        await new Task(account).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(async () => {
    // ========== push result ==========
    try {
        const _logs = $.notifyStr || [];
        if (_logs.length > 0) {
            await sendPushNotify("大参林小程序签到", _logs.join("\n"));
        }
    } catch(_e) {}
    // ========== push end ==========
    $.sendMsg = async () => {}; $.log = async () => {};
    process.exit(0);
});
