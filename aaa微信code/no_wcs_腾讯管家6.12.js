/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 腾讯电脑管家 wx code 登录并创建 sdi auth，支持任务和多抽奖
cron: 10 9 * * *
------------------------------------------
变量名：qqpcmgr
变量值：wx_server 已保存账号 openid，多账号用 & 或换行

必需变量：
wx_server_url       
wx_auth             wx_server 鉴权值

可选变量：
qqpcmgr_authCode    直接使用指定 authCode，设置后不走 wx_server
qqpcmgr_guid        默认 fff4328476c4ffc836d21e82918faa19
qqpcmgr_sdiaid      默认 2025121115391911962
qqpcmgr_version     默认 18.2.30604.301
qqpcmgr_computer    默认 smallfawn
qqpcmgr_lid         默认 Lottery2
qqpcmgr_lotteries   抽奖模块列表，用 & 分隔，如 Lottery2&LevelLottery1
qqpcmgr_tasks       是否执行任务，默认 true
------------------------------------------
*/

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const $ = {
    log: (...args) => console.log(...args),
    done: () => process.exit(0)
};

const CK_NAME = "qqpcmgr";
const WX_SERVER_URL = (process.env.wx_server_url || "").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const QRCONNECT_URL =
    process.env.qqpcmgr_qrconnect_url ||
    "https://open.weixin.qq.com/connect/qrconnect?appid=wx5cd60c5d4817a188&scope=snsapi_login&redirect_uri=https%3A%2F%2Fsecurity.guanjia.qq.com%2Flogin&state=233&login_type=jssdk&self_redirect=true";
const CLIENT_GUID = process.env.qqpcmgr_guid || "fff4328476c4ffc836d21e82918faa19";

function generateGuid(account) {
    const hash = require('crypto').createHash('md5').update(String(account)).digest('hex');
    return hash.slice(0, 32);
}
const SDIAID = process.env.qqpcmgr_sdiaid || "2025121115391911962";
const LOTTERY_ID = process.env.qqpcmgr_lid || "Lottery2";
const VERSION = process.env.qqpcmgr_version || "18.2.30612.301";
const COMPUTER_NAME = process.env.qqpcmgr_computer || "DESKTOP-6S9P0IV";
const USER_AGENT =
    process.env.qqpcmgr_ua ||
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/143.0.13.0 Tencent QQPCMgr/18.2.30612.301";
const CACHE_DIR = "./.cache";
const CACHE_EXPIRE_HOURS = parseInt(process.env.qqpcmgr_cache_expire_hours) || 720;
const DO_TASKS = true;
const DO_TASK_REPORT = process.env.qqpcmgr_task_report !== "false";
const LOTTERIES = process.env.qqpcmgr_lotteries 
    ? splitAccounts(process.env.qqpcmgr_lotteries) 
    : ["Lottery2"];
const FORCE_LOTTERY = process.env.qqpcmgr_force_lottery === "true";

function splitAccounts(raw = "") {
    return String(raw)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseAccount(accountStr) {
    const parts = accountStr.split("#");
    if (parts.length === 2) {
        return { remark: parts[0].trim(), openid: parts[1].trim() };
    }
    return { remark: accountStr, openid: accountStr };
}

function getCacheFilePath(account) {
    const name = account ? `qqpcmgr_${account.replace(/[^a-zA-Z0-9]/g, "_")}` : "qqpcmgr_default";
    return path.join(CACHE_DIR, `${name}.json`);
}

function readCache(account) {
    try {
        const filePath = getCacheFilePath(account);
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, "utf8");
        const cache = JSON.parse(content);
        if (!cache.expireTime || Date.now() > cache.expireTime) {
            $.log(`缓存已过期，将重新登录`);
            return null;
        }
        $.log(`读取缓存成功，有效期至 ${new Date(cache.expireTime).toLocaleString()}`);
        return cache.data;
    } catch (e) {
        $.log(`读取缓存失败: ${e.message}`);
        return null;
    }
}

function writeCache(account, data) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const filePath = getCacheFilePath(account);
        const cache = {
            data,
            expireTime: Date.now() + CACHE_EXPIRE_HOURS * 3600 * 1000,
            savedAt: Date.now(),
        };
        fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
        $.log(`缓存已保存到 ${filePath}`);
    } catch (e) {
        $.log(`写入缓存失败: ${e.message}`);
    }
}

function pick(source = {}, keys = []) {
    for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return "";
}

function findLoginPayload(source) {
    if (!source || typeof source !== "object") return null;
    const loginKey = pick(source, ["loginKey", "LoginKey", "loginkey", "login_key"]);
    const openid =
        pick(source, ["openid", "openId", "OpenId", "OpenID"]) ||
        pick(source.thirdPartyAccInfo, ["bindAccount", "openid", "openId", "OpenId", "OpenID"]);
    if (loginKey && openid) return source;

    for (const value of Object.values(source)) {
        if (value && typeof value === "object") {
            const found = findLoginPayload(value);
            if (found) return found;
        }
    }
    return null;
}

function cookieValue(value) {
    return String(value ?? "").replace(/[;\r\n]/g, "");
}

function buildCookie(profile) {
    const commonid = profile.commonid || profile.openid;
    const encodedNickname = encodeURIComponent(profile.nickname || "");
    const pairs = {
        _gj_acc_type: 2,
        _gj_commonid: commonid,
        _gj_version: VERSION,
        _gj_computername: COMPUTER_NAME,
        _gj_client_guid: profile.guid,
        _gj_server_guid: profile.serverGuid || "",
        _gj_vip: profile.vip || 0,
        _gj_nickname: profile.nickname || "",
        _gj_accountid: profile.account,
        _gj_loginkey: profile.loginKey,
        _gj_openid: profile.openid,
        _gj_sex: profile.sex || 0,
        _gj_headimgurl: profile.headimgurl || "",
        _gj_expired: 0,
        _gj_support: "[0,1,2,3,4,5,6,8,10,11,12,13,14,15,18]",
        _gj_encoded_nickname: encodedNickname,
        _gj_level: profile.level || 0,
    };
    return Object.entries(pairs)
        .map(([key, value]) => `${key}=${cookieValue(value)}`)
        .join("; ");
}

async function getAuthCode(account) {
    if (process.env.qqpcmgr_authCode) return process.env.qqpcmgr_authCode;
    if (!WX_AUTH) throw new Error("未配置 wx_auth，无法通过 wx_server 授权二维码");
    if (!account) throw new Error("未配置 qqpcmgr openid，无法调用 /wx/qrcodeauth");
    const uuid = await getQrUuid();
    $.log(`获取 QRConnect UUID 成功: ${uuid}`);
    const code = await qrcodeAuth(account, uuid);
    return code;
}

async function getQrUuid() {
    const { data, status } = await axios.request({
        method: "GET",
        url: QRCONNECT_URL,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    if (status !== 200) throw new Error(`获取 QRConnect 页面失败 HTTP ${status}`);
    const html = String(data || "");
    const match = html.match(/\/connect\/qrcode\/([^"'&<>]+)/) || html.match(/uuid=([^"'&<>]+)/);
    if (!match?.[1]) throw new Error("QRConnect 页面未解析到 uuid");
    return match[1];
}

async function qrcodeAuth(openid, uuid) {
    const { data, status } = await axios.request({
        method: "POST",
        url: `${WX_SERVER_URL}/wx/qrcodeauth`,
        headers: {
            auth: WX_AUTH,
            "Content-Type": "application/json",
        },
        data: { openid, uuid },
        timeout: 30000,
        validateStatus: () => true,
    });
    if (status !== 200) throw new Error(`/wx/qrcodeauth HTTP ${status}: ${JSON.stringify(data)}`);
    const code =
        data?.code ||
        data?.wxCode ||
        data?.data?.code ||
        data?.data?.wxCode ||
        data?.data?.data?.code ||
        data?.data?.data?.wxCode;
    if (!code) throw new Error(`/wx/qrcodeauth 未返回 code: ${JSON.stringify(data)}`);
    return code;
}

async function loginByCode(authCode, guid) {
    const { data } = await axios.request({
        method: "POST",
        url: "https://jprx.m.qq.com/data/3078/forward",
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://webcdn.m.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://webcdn.m.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        data: {
            req: {
                platType: 3,
                loginAccType: 32,
                authCode,
                clientGuid: guid,
            },
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    const payload = findLoginPayload(data);
    if (!payload) throw new Error(`登录响应未找到 loginKey/openid: ${JSON.stringify(data)}`);
    return payload;
}

function normalizeProfile(payload, guid) {
    const third = payload.thirdPartyAccInfo || {};
    const account = pick(payload, ["account", "accountId", "Account", "userId", "UserId", "uin"]);
    return {
        loginKey: pick(payload, ["loginKey", "LoginKey", "loginkey", "login_key"]),
        openid: pick(payload, ["openid", "openId", "OpenId", "OpenID"]) || pick(third, ["bindAccount", "openid", "openId", "OpenId", "OpenID"]),
        nickname: pick(payload, ["nickname", "nickName", "NickName"]) || pick(third, ["nickname", "nickName", "NickName"]) || "JOY",
        account,
        userId: pick(payload, ["userId", "UserId"]) || account,
        headimgurl: pick(payload, ["headimgurl", "headImgUrl", "HeadImgUrl", "headImg"]) || pick(third, ["headUrl", "headimgurl", "headImgUrl", "HeadImgUrl"]),
        guid: pick(payload, ["guid", "clientGuid", "ClientGuid"]) || guid,
        imei: pick(payload, ["imei", "Imei"]) || account,
        commonid: pick(payload, ["commonid", "commonId", "CommonId"]) || pick(third, ["commonid", "commonId", "CommonId", "unionId"]),
        serverGuid: pick(payload, ["serverGuid", "server_guid", "ServerGuid"]),
        sex: pick(payload, ["sex", "Sex"]) || 0,
        vip: pick(payload, ["vip", "Vip"]) || 0,
        level: pick(payload, ["level", "Level"]) || 0,
    };
}

async function createAuth(profile, cookie) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://sdi.m.qq.com/public/auth/create",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            sdiaid: SDIAID,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://sdi.3g.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://sdi.3g.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        data: {
            loginKey: profile.loginKey,
            openid: profile.openid,
            nickname: profile.nickname,
            account: Number(profile.account) || profile.account,
            userId: Number(profile.userId) || profile.userId,
            headimgurl: profile.headimgurl,
            guid: profile.guid,
            imei: Number(profile.imei) || profile.imei,
            loginType: "wx",
            platformId: "pcmgr16",
            loginAccType: 2,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function getLotteryStatus(sessionKey, cookie, lotteryId = LOTTERY_ID) {
    const { data, status } = await axios.request({
        method: "GET",
        url: `https://sdi.m.qq.com/private/lottery/lotteryStatus?lid=${lotteryId}`,
        headers: {
            "User-Agent": USER_AGENT,
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: SDIAID,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://sdi.3g.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://sdi.3g.qq.com/",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function doLottery(sessionKey, cookie, lotteryId = LOTTERY_ID) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://sdi.m.qq.com/private/lottery/doLottery",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: SDIAID,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://sdi.3g.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://sdi.3g.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        data: { lid: lotteryId },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function getTasks(profile, cookie) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://jprx.m.qq.com/data/3091/forward",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "sec-ch-ua": '"Chromium";v="109"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://webcdn.m.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://webcdn.m.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        data: JSON.stringify({
            req: {
                accountid: profile.account,
                loginkey: profile.loginKey,
                commonid: profile.commonid || profile.openid,
                client_guid: profile.guid,
                acctype: 2,
                client_version: "18.0.0.0",
            },
        }),
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function doTaskReport(profile, cookie, taskId, taskName) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://pcmgrmonitor.3g.qq.com/datareport",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://webcdn.m.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://webcdn.m.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        data: {
            app_key: "pcmgrweb",
            version: "1.0.0",
            gjpcVersion: "",
            guid: profile.guid,
            server_guid: profile.serverGuid || "",
            refer: "pcmgrweb_userprofile",
            event_time: Date.now(),
            event_code: "expo",
            params: {
                beaconId: profile.serverGuid || profile.guid,
                biz_id: "PC",
                page_id: "UserProfile_Icon",
                element_id: "Task",
                action_status: "Logged_In_Weixin",
                statistics: 0,
                event_params: `${taskName}_${taskId}`,
            },
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function validateCookie(cookie) {
    try {
        const config = await getHomeConfig(cookie);
        if (config.status === 200 && config.data?.userInfo) {
            return true;
        }
        return false;
    } catch (e) {
        $.log(`[验证] Cookie验证失败: ${e.message}`);
        return false;
    }
}

async function getHomeConfig(cookie) {
    const { data, status } = await axios.request({
        method: "GET",
        url: "https://luban.m.qq.com/api/public/pcmgr/v2-rights?action=getHomeConfig",
        headers: {
            "User-Agent": USER_AGENT,
            "sec-ch-ua": '"Chromium";v="109"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://webcdn.m.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://webcdn.m.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function runAccount(account, index, remark = "") {
    const guid = process.env[`${CK_NAME}_guid_${index}`] || generateGuid(account);
    const displayName = remark || account || "authCode";
    $.log(`\n┌─────────────────────────────────────────`);
    $.log(`│ [账号${index}] [${displayName}]`);
    $.log(`└─────────────────────────────────────────`);

    let profile = null;
    let cookie = null;
    let sessionKey = null;
    let needRelogin = false;

    const cached = readCache(account);
    if (cached) {
        $.log(`  📦 使用缓存数据`);
        profile = cached.profile;
        cookie = cached.cookie;
        sessionKey = cached.sessionKey;

        const validateResult = await validateCookie(cookie);
        if (!validateResult) {
            $.log(`  🔄 Cookie已失效，重新登录`);
            needRelogin = true;
        }
    } else {
        needRelogin = true;
    }

    if (needRelogin) {
        $.log(`  🔐 登录中...`);
        const authCode = await getAuthCode(account);
        const payload = await loginByCode(authCode, guid);
        profile = normalizeProfile(payload, guid);
        if (!profile.loginKey || !profile.openid) throw new Error("登录资料缺少 loginKey/openid");
        cookie = buildCookie(profile);

        const auth = await createAuth(profile, cookie);
        sessionKey = auth.data?.data?.userInfo?.sessionKey || auth.data?.data?.sessionKey || auth.data?.sessionKey;
        if (!sessionKey) throw new Error(`auth/create 未返回 sessionKey`);

        writeCache(account, { profile, cookie, sessionKey });
        $.log(`  ✅ 登录成功`);
    }

    let growthValue = 0;
    
    if (DO_TASKS) {
        const taskResult = await runTasks(sessionKey, cookie, profile, index, displayName);
        growthValue = taskResult?.growthValue || 0;
    }

    await runHomeConfig(cookie, index, displayName);
    const userLevel = globalThis.lubanConfig?.[index]?.userLevel || 0;
    const lotteries = await runLotteries(sessionKey, cookie, index, displayName);
    
    return {
        nickname: profile.nickname,
        level: userLevel,
        growthValue,
        lotteries
    };
}

async function runTasks(sessionKey, cookie, profile, index, displayName = "") {
    $.log(`[账号${index}] [${displayName}] 用户名: ${profile.nickname || "未知"}`);
    $.log(`[账号${index}] [${displayName}] 开始获取任务列表`);
    const taskList = await getTasks(profile, cookie);
    if (taskList.status !== 200 || taskList.data?.ret !== 0) {
        $.log(`[账号${index}] [${displayName}] 获取任务列表失败: ${JSON.stringify(taskList.data)}`);
        return;
    }

    const resp = taskList.data?.data?.resp;
    if (!resp || resp.result !== 0) {
        $.log(`[账号${index}] [${displayName}] 任务列表响应异常: ${JSON.stringify(resp)}`);
        return;
    }

    $.log(`[账号${index}] [${displayName}] 当前成长值: ${resp.total_growth_value} Lv.${resp.curr_lv}`);
    $.log(`[账号${index}] [${displayName}] 升级还需: ${resp.next_lv_still_need_num} 成长值 (进度 ${resp.next_lv_progress}%)`);

    const tasks = resp.item_list || [];
    $.log(`[账号${index}] [${displayName}] 获取到 ${tasks.length} 个任务:`);
    
    let completedCount = 0;
    let availableCount = 0;
    
    for (const task of tasks) {
        const taskId = task.task_id;
        const taskName = task.task_desc || "未知任务";
        const canClick = task.can_click === true;
        const statusText = task.status_text || "";
        const reward = task.value_num || 0;
        const taskType = task.task_type === 1 ? "每日" : task.task_type === 2 ? "一次性" : "设置类";

        if (!taskId) continue;

        if (!canClick || statusText.includes("已完成")) {
            $.log(`[账号${index}] [${displayName}]   [已完成] ${taskName} (+${reward}成长值, ${taskType})`);
            completedCount++;
        } else {
            $.log(`[账号${index}] [${displayName}]   [待完成] ${taskName} (+${reward}成长值, ${taskType})`);
            availableCount++;
        }
    }
    
    $.log(`[账号${index}] [${displayName}] 任务统计: 已完成 ${completedCount} 个，待完成 ${availableCount} 个`);
    
    if (DO_TASK_REPORT) {
        $.log(`[账号${index}] [${displayName}] 开始任务事件上报...`);
        for (const task of tasks) {
            const taskId = task.task_id;
            const taskName = task.task_desc || "未知任务";
            const canClick = task.can_click === true;
            const statusText = task.status_text || "";

            if (!taskId || !canClick || statusText.includes("已完成")) continue;

            $.log(`[账号${index}] [${displayName}] 上报 [${taskName}]`);
            await doTaskReport(profile, cookie, taskId, taskName);
            await sleep(500);
        }
        $.log(`[账号${index}] [${displayName}] 任务上报完成`);
    }
    
    return { growthValue: resp.total_growth_value };
}

async function runHomeConfig(cookie, index, displayName = "") {
    $.log(`[账号${index}] [${displayName}] 获取首页配置信息`);
    const config = await getHomeConfig(cookie);
    if (config.status !== 200) {
        $.log(`[账号${index}] [${displayName}] 获取首页配置失败: HTTP ${config.status}`);
        return;
    }

    const userInfo = config.data?.userInfo;
    if (userInfo) {
        $.log(`[账号${index}] [${displayName}] 用户等级: Lv.${userInfo.curr_lv}`);
        $.log(`[账号${index}] [${displayName}] 是否已转换金币: ${userInfo.coin_coverted ? '是' : '否'}`);
    }

    const levelLotteries = config.data?.level || [];
    const dailyLotteries = config.data?.daily || [];
    
    $.log(`[账号${index}] [${displayName}] 等级抽奖模块: ${levelLotteries.length} 个`);
    for (const lv of levelLotteries) {
        $.log(`[账号${index}] [${displayName}]   - ${lv.title} (Lv.${lv.min_level}-${lv.max_level}, sdi_aid=${lv.sdi_aid}, pool=${lv.adi_draw_pool_id})`);
    }
    
    $.log(`[账号${index}] [${displayName}] 每日抽奖模块: ${dailyLotteries.length} 个`);
    for (const daily of dailyLotteries) {
        $.log(`[账号${index}] [${displayName}]   - ${daily.title} (aid=${daily.aid}, pool=${daily.draw_pool_id})`);
    }
    
    globalThis.lubanConfig = globalThis.lubanConfig || {};
    globalThis.lubanConfig[index] = { levelLotteries, dailyLotteries, userLevel: userInfo?.curr_lv || 0 };
}

async function runSingleLottery(sessionKey, cookie, lotteryId, lotteryName, lotteryType, index, displayName) {
    $.log(`[账号${index}] [${displayName}] 🎲 ${lotteryName}`);
    
    const status = await getLotteryStatus(sessionKey, cookie, lotteryId);
    
    if (status.status !== 200 || status.data?.code !== 0) {
        const code = status.data?.code;
        if (code === -10) {
            throw new Error(`LOGIN_EXPIRED:${status.data?.message || "登录态过期"}`);
        }
        $.log(`[账号${index}] [${displayName}]   ❌ 获取状态失败: ${status.data?.message || "未知错误"}`);
        return { name: lotteryName, type: lotteryType, status: status.status, data: status.data };
    }
    
    const statusData = status.data.data || {};
    const drawLimited = statusData.drawLimited === true;
    const winLimited = statusData.winLimited === true;
    const canReceive = statusData.canReceive === true;
    
    if (drawLimited && !FORCE_LOTTERY) {
        $.log(`[账号${index}] [${displayName}]   ⏭️ 已达每日抽奖上限`);
        return { 
            name: lotteryName, 
            type: lotteryType, 
            status: 200, 
            data: { code: 0, message: "已达到每日抽奖次数上限", data: {} } 
        };
    }
    
    if (winLimited && !FORCE_LOTTERY) {
        $.log(`[账号${index}] [${displayName}]   ⏭️ 已达每日中奖上限`);
        return { 
            name: lotteryName, 
            type: lotteryType, 
            status: 200, 
            data: { code: 0, message: "已达到每日中奖上限", data: {} } 
        };
    }
    
    if (!canReceive && !FORCE_LOTTERY) {
        $.log(`[账号${index}] [${displayName}]   ⏭️ 当前不可抽奖`);
        return { 
            name: lotteryName, 
            type: lotteryType, 
            status: 200, 
            data: { code: 0, message: "当前不可抽奖", data: {} } 
        };
    }
    
    const lottery = await doLottery(sessionKey, cookie, lotteryId);
    const result = formatLotteryResult({ status: lottery.status, data: lottery.data });
    $.log(`[账号${index}] [${displayName}]   ${result}`);
    
    return { name: lotteryName, type: lotteryType, ...lottery };
}

async function runLotteries(sessionKey, cookie, index, displayName = "") {
    $.log(`[账号${index}] [${displayName}] 开始多抽奖模块`);
    const results = [];

    const configuredLotteries = process.env.qqpcmgr_lotteries
        ? splitAccounts(process.env.qqpcmgr_lotteries)
        : [];

    if (configuredLotteries.length > 0) {
        for (const lotteryId of configuredLotteries) {
            const result = await runSingleLottery(sessionKey, cookie, lotteryId, lotteryId, "配置抽奖", index, displayName);
            results.push(result);
            await sleep(1000);
        }
    } else {
        const luban = globalThis.lubanConfig?.[index];
        if (luban) {
            const userLevel = luban.userLevel || 0;
            const unlockedLotteries = luban.levelLotteries?.filter(lv => userLevel >= lv.min_level) || [];
            
            if (unlockedLotteries.length === 0) {
                $.log(`[账号${index}] [${displayName}] 当前等级 Lv.${userLevel}，暂未解锁任何等级抽奖`);
            } else {
                $.log(`[账号${index}] [${displayName}] 当前等级 Lv.${userLevel}，解锁 ${unlockedLotteries.length} 个等级抽奖`);
                for (const lv of unlockedLotteries) {
                    const drawPoolId = lv.adi_draw_pool_id || lv.draw_pool_id;
                    const result = await runSingleLottery(sessionKey, cookie, drawPoolId, lv.title, "等级抽奖", index, displayName);
                    results.push(result);
                    await sleep(1500);
                }
            }
            
            if (luban.dailyLotteries && luban.dailyLotteries.length > 0) {
                for (const daily of luban.dailyLotteries) {
                    const drawPoolId = daily.draw_pool_id;
                    const result = await runSingleLottery(sessionKey, cookie, drawPoolId, daily.title, "每日抽奖", index, displayName);
                    results.push(result);
                    await sleep(1500);
                }
            } else {
                const result = await runSingleLottery(sessionKey, cookie, "Lottery2", "天天惊喜", "每日抽奖", index, displayName);
                results.push(result);
            }
        } else {
            const result = await runSingleLottery(sessionKey, cookie, "Lottery2", "天天惊喜", "每日抽奖", index, displayName);
            results.push(result);
        }
    }
    
    return results;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendNotify(title, content) {
    try {
        const notify = require("./sendNotify");
        await notify.sendNotify(title, content);
        $.log(`[推送] 通知已发送`);
    } catch (e) {
        try {
            const notify = require("/ql/scripts/sendNotify");
            await notify.sendNotify(title, content);
            $.log(`[推送] 通知已发送`);
        } catch (e) {
            $.log(`[推送] 未找到 sendNotify 模块，跳过推送`);
        }
    }
}

function formatLotteryResult(result) {
    const data = result.data;
    if (result.status === 200 && data?.code === 0) {
        if (data.message) {
            return `⏭️ ${data.message}`;
        }
        const prize = data.data?.prize || data.data?.giftName || data.data?.comment || data.data?.subcomment || "未知奖品";
        const leftChance = Object.keys(data.data?.leftChance || {}).length;
        if (!leftChance && !prize.includes("币") && !prize.includes("会员") && !prize.includes("钻") && !prize.includes("VIP")) {
            return `🙅 谢谢参与`;
        }
        return `🎉 获得: ${prize}`;
    } else if (data?.message) {
        return `💫 ${data.message}`;
    } else {
        return `❌ 抽奖失败`;
    }
}

function randomDelay(minSeconds = 10, maxSeconds = 20) {
    const delay = Math.random() * (maxSeconds - minSeconds) + minSeconds;
    const ms = Math.floor(delay * 1000);
    $.log(`[风控] 等待 ${(delay / 60).toFixed(2)} 分钟 (${ms}ms)`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    const accounts = process.env.qqpcmgr_authCode ? [""] : splitAccounts(process.env[CK_NAME] || "");
    
    $.log(`\n🚀 腾讯管家任务开始`);
    $.log(`📋 检测到 ${accounts.length} 个账号:`);
    for (let i = 0; i < accounts.length; i++) {
        const accountInfo = parseAccount(accounts[i]);
        $.log(`   ${i + 1}. ${accountInfo.remark}`);
    }
    $.log("");
    
    if (!accounts.length) throw new Error(`未配置 ${CK_NAME}，或设置 qqpcmgr_authCode 直接测试`);

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
        if (i > 0) {
            await randomDelay(2, 4);
        }
        
        const accountInfo = parseAccount(accounts[i]);
        let retryCount = 0;
        const maxRetries = 2;
        let success = false;
        let result = null;
        let error = null;
        
        while (retryCount < maxRetries && !success) {
            try {
                result = await runAccount(accountInfo.openid, i + 1, accountInfo.remark);
                success = true;
            } catch (e) {
                error = e.message || e;
                $.log(`[账号${i + 1}] 失败: ${error}`);
                retryCount++;
                
                if (error.startsWith("LOGIN_EXPIRED:") && retryCount < maxRetries) {
                    $.log(`[账号${i + 1}] 检测到登录态过期，删除缓存后重试 (第${retryCount}次)`);
                    const cachePath = getCacheFilePath(accountInfo.openid);
                    if (fs.existsSync(cachePath)) {
                        fs.unlinkSync(cachePath);
                        $.log(`[账号${i + 1}] 已删除缓存文件: ${cachePath}`);
                    }
                    await sleep(2000);
                }
            }
        }
        
        if (success && result) {
            results.push({ ...accountInfo, success: true, ...result });
        } else {
            results.push({ ...accountInfo, success: false, error: error || "重试次数已达上限" });
        }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    if (results.length > 0) {
        let content = `📱 腾讯管家任务执行结果\n\n`;
        content += `📊 统计: ${results.length} 个账号 | 成功 ${successCount} | 失败 ${failCount}\n\n`;
        
        for (const r of results) {
            content += `───\n`;
            content += `${r.success ? "✅" : "❌"} ${r.remark}\n`;
            
            if (!r.success) {
                content += `   ❌ 错误: ${r.error}\n`;
            } else {
                content += `   👤 用户名: ${r.nickname || "未知"}\n`;
                content += `   📈 等级: Lv.${r.level || 0}\n`;
                content += `   ⭐ 成长值: ${r.growthValue || 0}\n`;
                
                if (r.lotteries && r.lotteries.length > 0) {
                    content += `   🎲 抽奖结果:\n`;
                    for (const lottery of r.lotteries) {
                        if (lottery.type === "每日抽奖") {
                            content += `      ${lottery.name}: ${formatLotteryResult(lottery)}\n`;
                        }
                    }
                }
            }
        }
        
        content += `\n───\n⏰ ${new Date().toLocaleString()}`;
        
        await sendNotify("腾讯管家抽奖", content);
    }
})()
    .catch((e) => $.log(`执行失败: ${e.message || e}`))
    .finally(async () => {
    try {
      const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN;
      if (token) {
        const axios = require("axios");
        const log = ($.notifyStr || []).slice(-10).join(String.fromCharCode(10));
        await axios.post("http://www.pushplus.plus/send", {
          token, title: "腾讯管家", content: log || "腾讯管家执行完成", template: "txt"
        }, { timeout: 10000 });
      }
    } catch(e) {}
    $.sendMsg = async () => {}; $.done();
  });;
