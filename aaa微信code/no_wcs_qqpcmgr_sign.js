/*
@Description: 腾讯电脑管家 wx code 登录并创建 sdi auth
cron: 10 9 * * *
*/
const { Env } = require("../tools/env.js");
const { sendPushNotify } = require("./_push_helper");
const axios = require("axios");

const $ = new Env("腾讯电脑管家登录抽奖");
const CK_NAME = "wx_opinion";
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const QRCONNECT_URL = process.env.qqpcmgr_qrconnect_url ||
    "https://open.weixin.qq.com/connect/qrconnect?appid=wx5cd60c5d4817a188&scope=snsapi_login&redirect_uri=https%3A%2F%2Fsecurity.guanjia.qq.com%2Flogin&state=233&login_type=jssdk&self_redirect=true";
const CLIENT_GUID = process.env.qqpcmgr_guid || "fff4328476c4ffc836d21e82918faa19";
const SDIAID = process.env.qqpcmgr_sdiaid || "2025121115391911962";
const LOTTERY_ID = process.env.qqpcmgr_lid || "Lottery2";
const VERSION = process.env.qqpcmgr_version || "18.2.30604.301";
const COMPUTER_NAME = process.env.qqpcmgr_computer || "smallfawn";
const USER_AGENT = process.env.qqpcmgr_ua ||
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/143.0.13.0 Tencent QQPCMgr/18.2.30604.301";

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
    const openid = pick(source, ["openid", "openId", "OpenId", "OpenID"]) ||
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

function buildCookie(profile) {
    const commonid = profile.commonid || profile.openid;
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
        _gj_encoded_nickname: encodeURIComponent(profile.nickname || ""),
        _gj_level: profile.level || 0,
    };
    return Object.entries(pairs).map(([k, v]) => `${k}=${String(v ?? "").replace(/[;\r\n]/g, "")}`).join("; ");
}

async function getQrUuid() {
    const { data, status } = await axios.get(QRCONNECT_URL, {
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9" },
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
    const { data, status } = await axios.post(`${WX_SERVER_URL}/wx/qrcodeauth`, { openid, uuid }, {
        headers: { auth: WX_AUTH, "Content-Type": "application/json" },
        timeout: 30000,
        validateStatus: () => true,
    });
    if (status !== 200) throw new Error(`/wx/qrcodeauth HTTP ${status}`);
    const code = data?.code || data?.wxCode || data?.data?.code || data?.data?.wxCode || data?.data?.data?.code;
    if (!code) throw new Error(`/wx/qrcodeauth 未返回 code: ${JSON.stringify(data)}`);
    return code;
}

async function loginByCode(authCode, guid) {
    const { data } = await axios.post("https://jprx.m.qq.com/data/3078/forward", {
        req: { platType: 3, loginAccType: 32, authCode, clientGuid: guid },
    }, {
        headers: {
            "User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*", "Content-Type": "application/json",
            "Origin": "https://webcdn.m.qq.com", "Referer": "https://webcdn.m.qq.com/", "Accept-Language": "zh-CN,zh;q=0.9",
        },
        timeout: 20000,
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
        openid: pick(payload, ["openid", "openId", "OpenId", "OpenID"]) || pick(third, ["bindAccount", "openid"]),
        nickname: pick(payload, ["nickname", "nickName", "NickName"]) || pick(third, ["nickname"]) || "JOY",
        account, userId: pick(payload, ["userId", "UserId"]) || account,
        headimgurl: pick(payload, ["headimgurl", "headImgUrl"]) || pick(third, ["headUrl", "headimgurl"]),
        guid: pick(payload, ["guid", "clientGuid"]) || guid,
        imei: pick(payload, ["imei", "Imei"]) || account,
        commonid: pick(payload, ["commonid", "commonId"]) || pick(third, ["commonid", "unionId"]),
        serverGuid: pick(payload, ["serverGuid", "server_guid"]),
        sex: pick(payload, ["sex"]) || 0, vip: pick(payload, ["vip"]) || 0, level: pick(payload, ["level"]) || 0,
    };
}

async function createAuth(profile, cookie) {
    const { data, status } = await axios.post("https://sdi.m.qq.com/public/auth/create", {
        loginKey: profile.loginKey, openid: profile.openid, nickname: profile.nickname,
        account: Number(profile.account) || profile.account, userId: Number(profile.userId) || profile.userId,
        headimgurl: profile.headimgurl, guid: profile.guid,
        imei: Number(profile.imei) || profile.imei, loginType: "wx", platformId: "pcmgr16", loginAccType: 2,
    }, {
        headers: {
            "User-Agent": USER_AGENT, "Content-Type": "application/json",
            sdiaid: SDIAID, "Origin": "https://sdi.3g.qq.com", "Referer": "https://sdi.3g.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9", "Cookie": cookie,
        },
        timeout: 20000, validateStatus: () => true,
    });
    return { status, data };
}

async function doLottery(sessionKey, cookie) {
    const { data, status } = await axios.post("https://sdi.m.qq.com/private/lottery/doLottery", { lid: LOTTERY_ID }, {
        headers: {
            "User-Agent": USER_AGENT, "Content-Type": "application/json",
            sessionkey: sessionKey, sdiaid: SDIAID,
            "Origin": "https://sdi.3g.qq.com", "Referer": "https://sdi.3g.qq.com/",
            "Accept-Language": "zh-CN,zh;q=0.9", "Cookie": cookie,
        },
        timeout: 20000, validateStatus: () => true,
    });
    return { status, data };
}

async function runAccount(openid, index) {
    const guid = process.env[`qqpcmgr_guid_${index}`] || CLIENT_GUID;
    $.log(`\n[账号${index}] 开始处理 ${String(openid).slice(0, 10)}***`);

    const uuid = await getQrUuid();
    $.log(`[账号${index}] UUID: ${uuid}`);

    const authCode = await qrcodeAuth(openid, uuid);
    $.log(`[账号${index}] authCode: ${String(authCode).slice(0, 8)}***`);

    const payload = await loginByCode(authCode, guid);
    const profile = normalizeProfile(payload, guid);
    if (!profile.loginKey || !profile.openid) throw new Error("登录资料缺少 loginKey/openid");

    const cookie = buildCookie(profile);
    $.log(`[账号${index}] nickname=${profile.nickname} account=${profile.account}`);

    const auth = await createAuth(profile, cookie);
    $.log(`[账号${index}] auth/create HTTP ${auth.status}`);

    const sessionKey = auth.data?.data?.userInfo?.sessionKey || auth.data?.data?.sessionKey || auth.data?.sessionKey;
    if (!sessionKey) throw new Error(`auth/create 未返回 sessionKey: ${JSON.stringify(auth.data)}`);

    const lottery = await doLottery(sessionKey, cookie);
    $.log(`[账号${index}] doLottery(${LOTTERY_ID}) HTTP ${lottery.status}`);
    $.log(`[账号${index}] 结果: ${JSON.stringify(lottery.data)}`);
}

(async () => {
    $.checkEnv(CK_NAME);
    if (!WX_AUTH) { $.log("未配置 wx_auth"); return; }
    const accounts = $.userList;
    if (!accounts.length) { $.log("未配置 wx_opinion"); return; }
    $.log(`共${accounts.length}个账号`);

    const summaries = [];
    for (let i = 0; i < accounts.length; i++) {
        try {
            await runAccount(accounts[i], i + 1);
            summaries.push(`[${i + 1}] 成功`);
        } catch (e) {
            $.log(`[账号${i + 1}] 失败: ${e.message || e}`);
            summaries.push(`[${i + 1}] 失败: ${e.message || e}`);
        }
        if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    $.log("\n========== 汇总 ==========");
    summaries.forEach(s => $.log(s));
})().catch((e) => $.log(e.message || e))
    .finally(async () => {
        try {
            const logs = $.notifyStr || [];
            if (logs.length > 0) await sendPushNotify("腾讯电脑管家抽奖结果", logs.join("\n"));
        } catch (_) {}
        process.exit(0);
    });
