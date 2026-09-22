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
qqpcmgr_max_comments 每天评论软件条数，默认 10（每条 +20 成长值；但服务端有「评论成长值总上限 +2000」，
                     到顶后 getTasks 会把「评论1款软件」置为 can_click=false、status_text="已达总上限+2000"，
                     脚本检测到即跳过评论环节，不再浪费请求）
qqpcmgr_comment_always 评论任务已完成时是否继续评论赚成长值，默认 true（受上面的总上限约束）
qqpcmgr_auto_take   是否自动领取「待领取」奖品，默认 true
qqpcmgr_max_take    单次最多领取几个奖品，默认 6（服务端另有每日兑换上限）
qqpcmgr_take_qq     领奖目标QQ（可空）：
                      · 单个值 = 所有账号的奖品都领到这个QQ，如 485293174
                      · 多个值(用 & 或换行分隔) = 按账号顺序一一对应，某位留空 = 该账号不领
                      · 留空 = **不领取**（安全默认：绝不领到账号绑定的QQ）
                      · 只有显式写 currentLogin / self / 自己 时，该账号才用自己的绑定QQ
                    注：绑定的QQ往往是陌生号，误领过去就找不回来了，所以默认一律不领。
------------------------------------------
奖品的口径（抓包确认，sdi 中台 taker 接口）：
  · 我的奖品列表 GET https://sdi.m.qq.com/private/taker/queryDrawlogList
  · 领取奖品     POST https://sdi.m.qq.com/private/taker/giveout {drawLogId, take:{qq:"..."}}
    state: 0 已失效 / 1 待领取 / 2 领取中 / 3 已领取 / 4 领取失败
    Q币、QQSVIP 等虚拟奖品用 take={qq:"目标QQ号"} 直领；该 QQ 可以是任意号码，
    不限于登录账号绑定的QQ（抓包确认：App 领奖表单就是让用户手输 QQ/微信号）。
    ⚠ 每日兑换上限（2026-09-17 实测确认，两轮跨天验证）：
      口径 = 「奖品(bonusId) × 收奖QQ × 每天 1 次」，次日自动重置。
      证据：同一个 drawLogId(bonusId=2631) 头天领 485293174 报「已达上限」，
            第二天同一奖品再领 485293174 成功；同日换收奖QQ也能再领一次。
      ⇒ 多个账号领到同一个 QQ 时，并不是共用 1 个总额度，而是每个「奖品」各有 1 次/天；
        同一奖品（如「天天惊喜-1Q币」当月同 bonusId）当天只能过一个到该 QQ，剩余次日继续。
      ⇒ 脚本撞到上限只跳过该奖品、继续试其它奖品，不会整轮退出。
    ⚠ 已过 takeTimeEnd 的奖品**服务端仍可能受理**（实测把 8/31 截止的 1Q币 成功领出），
      所以脚本对「已过截止」项也会试领一次，服务端说失效才记入失效。
    实物(ship)需要收货信息，脚本不代领。
------------------------------------------
*/

const axios = require("axios");
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

// 全量日志收集，供推送兜底使用（原脚本引用了不存在的 $.notifyStr，导致推送内容恒为空）
const NOTIFY_LOG = [];
const $ = {
    notifyStr: NOTIFY_LOG,
    log: (...args) => {
        const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        console.log(line);
        NOTIFY_LOG.push(line);
    },
    done: () => process.exit(0)
};

// 清空系统代理(容器有172.23.224.1:7890代理会拦截请求)
["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"].forEach(k => process.env[k] = "");

const CK_NAME = "qqpcmgr";
const wx_server_url = (process.env.wx_server_url || "").replace(/\/$/, "");
const wx_auth = process.env.wx_auth || "";
const QRCONNECT_URL =
    process.env.qqpcmgr_qrconnect_url ||
    "https://open.weixin.qq.com/connect/qrconnect?appid=wx5cd60c5d4817a188&scope=snsapi_login&redirect_uri=https%3A%2F%2Fsecurity.guanjia.qq.com%2Flogin&state=233&login_type=jssdk&self_redirect=true";
const CLIENT_GUID = process.env.qqpcmgr_guid || "fff4328476c4ffc836d21e82918faa19";

function generateGuid(account) {
    const hash = require('crypto').createHash('md5').update(String(account)).digest('hex');
    return hash.slice(0, 32);
}
// 天天惊喜(monthly)池 sdi_aid，也是 getLotteryStatus/doLottery 的默认池
const SDIAID = process.env.qqpcmgr_sdiaid || "2025121115391911962";
const LOTTERY_ID = process.env.qqpcmgr_lid || "Lottery2";
const VERSION = process.env.qqpcmgr_version || "18.2.30648.204";
const COMPUTER_NAME = process.env.qqpcmgr_computer || "DESKTOP-6S9P0IV";
const USER_AGENT =
    process.env.qqpcmgr_ua ||
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/143.0.13.0 Tencent QQPCMgr/18.2.30612.301";
const CACHE_DIR = "./.cache";
const CACHE_EXPIRE_HOURS = parseInt(process.env.qqpcmgr_cache_expire_hours) || 720;
const DO_TASKS = process.env.qqpcmgr_tasks !== "false";
const DO_TASK_REPORT = process.env.qqpcmgr_task_report !== "false";
const LOTTERIES = process.env.qqpcmgr_lotteries 
    ? splitAccounts(process.env.qqpcmgr_lotteries) 
    : ["Lottery2"];
const FORCE_LOTTERY = process.env.qqpcmgr_force_lottery === "true";
const ENABLE_COMMENTS = process.env.qqpcmgr_comments !== "false";
// 每天评论条数：默认 10 条（每日评论加成长值上限即 10 条，每条 +20 成长值）
const MAX_COMMENTS = parseInt(process.env.qqpcmgr_max_comments) || 10;
// 评论任务已完成时是否继续评论（新软件每条都加成长值，所以默认继续）
const COMMENT_ALWAYS = process.env.qqpcmgr_comment_always !== "false";
// 奖品中心：自动领取「待领取」奖品 / 单次领取上限
const AUTO_TAKE = process.env.qqpcmgr_auto_take !== "false";
const MAX_TAKE = parseInt(process.env.qqpcmgr_max_take) || 6;
// 领奖目标QQ：留空=账号自身绑定QQ；单值=全部共用；多值(&或换行)=按账号顺序对应
const TAKE_QQ_LIST = (process.env.qqpcmgr_take_qq || "").trim()
    ? splitAccounts(process.env.qqpcmgr_take_qq)
    : [];
const TAKE_TYPES = ["qqcoin", "pcm_direct_proivde", "mp_qqmusic_common", "mp_qq_member", "yxlb", "common_mp"];
const BONUS_STATE = ["已失效", "待领取", "领取中", "已领取", "领取失败"];
const COMMENT_CONTENTS = ["好用","非常实用","功能强大","推荐使用","很好用","速度很快","操作简单","体验不错","非常满意","值得推荐","简单易用","功能齐全","运行流畅","很喜欢","方便快捷"];
// 抓包确认: 真实 App 只评论 softId=57289 (/softwareDetail/57289 发布评论返回 code=0)
const COMMENT_SOFTID = parseInt(process.env.qqpcmgr_comment_softid) || 57289;
const COMMENT_MIN_DELAY = parseInt(process.env.qqpcmgr_comment_min_delay) || 8000;
const COMMENT_MAX_DELAY = parseInt(process.env.qqpcmgr_comment_max_delay) || 12000;
// 软件池与已评论记录（修复：固定评论同一款软件永远不加成长值，改为轮换评论新软件）
const SOFT_POOL_FILE = path.join(CACHE_DIR, "qqpcmgr_soft_pool.json");
const QQPCMGR_CLIENT_VER = "18.2.30648.204";

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
    if (!wx_auth) throw new Error("未配置 wx_auth，无法通过 wx_server 授权二维码");
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
        timeout: 30000,
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
        url: `${wx_server_url}/wx/qrcodeauth`,
        headers: {
            auth: wx_auth,
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
        timeout: 30000,
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

async function createAuth(profile, cookie, sdiAid) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://sdi.m.qq.com/public/auth/create",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            sdiaid: sdiAid || SDIAID,
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

async function getLotteryStatus(sessionKey, cookie, lotteryId = LOTTERY_ID, sdiaidHeader) {
    const { data, status } = await axios.request({
        method: "GET",
        url: `https://sdi.m.qq.com/private/lottery/lotteryStatus?lid=${lotteryId}`,
        headers: {
            "User-Agent": USER_AGENT,
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: sdiaidHeader || SDIAID,
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

async function doLottery(sessionKey, cookie, lotteryId = LOTTERY_ID, sdiaidHeader) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://sdi.m.qq.com/private/lottery/doLottery",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: sdiaidHeader || SDIAID,
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

// ====== 奖品中心：我的奖品 / 待领取（抓包确认 sdi 中台 taker 接口）======

// 同名奖品合并计数："1Q币×4、2Q币"
function countBy(items) {
    const m = new Map();
    for (const it of items || []) {
        const k = it && it.name ? it.name : "奖品";
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join("、");
}

function fmtDay(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = (n) => String(n).padStart(2, "0");
    const s = new Date(d.getTime() + 8 * 3600 * 1000);
    return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`;
}

// 计算某账号的领奖目标QQ（index 为 1 起的账号序号）
// ⚠ 安全策略（2026-09-17）：**绝不默认领到账号绑定的QQ**（那些号用户不认识，领过去等于丢）。
//   · 未配置 qqpcmgr_take_qq / 该账号位为空 → 返回 ""（本次不领取）
//   · 只有显式写 currentLogin / self / 自己 才允许用该账号的绑定QQ
//   · 变量里写的必须是纯数字QQ，解析不出数字也返回 ""（不领取）
function resolveTakeQq(profile, index) {
    const self = String(profile.account || "").trim();
    if (!TAKE_QQ_LIST.length) return "";
    const slot = TAKE_QQ_LIST.length === 1
        ? TAKE_QQ_LIST[0]
        : (TAKE_QQ_LIST[Math.min(Math.max((index || 1) - 1, 0), TAKE_QQ_LIST.length - 1)] || "");
    const v = String(slot || "").trim();
    if (!v) return "";
    if (/^(currentlogin|self|自己|绑定|本账号)$/i.test(v)) return self;
    const digits = v.replace(/[^0-9]/g, "");
    return digits;
}

// 我的奖品列表（不传 drawPoolId 即全部奖池）
async function getDrawlogList(sessionKey, cookie, sdiaidHeader, drawPoolId) {
    const q = drawPoolId ? `?drawPoolId=${encodeURIComponent(drawPoolId)}` : "";
    const { data, status } = await axios.request({
        method: "GET",
        url: `https://sdi.m.qq.com/private/taker/queryDrawlogList${q}`,
        headers: {
            "User-Agent": USER_AGENT,
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: sdiaidHeader || SDIAID,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            Origin: "https://sdi.3g.qq.com",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Referer: "https://sdi.3g.qq.com/",
            Accept: "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Cookie: cookie,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

// 领取奖品：Q币/QQSVIP 等虚拟奖品传 take={qq: 目标QQ号}（目标QQ由 qqpcmgr_take_qq 指定，绝不是绑定QQ）
async function takeBonus(sessionKey, cookie, drawLogId, take, sdiaidHeader) {
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://sdi.m.qq.com/private/taker/giveout",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "sec-ch-ua": '"Chromium";v="109"',
            sessionkey: sessionKey,
            sdiaid: sdiaidHeader || SDIAID,
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
        data: { drawLogId, take },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

// 拉取奖品清单 + 自动领取待领取奖品
async function runBonusCenter(profile, cookie, sessionKey, index, displayName) {
    // pending=未过期待领取；stale=takeTimeEnd 已过但服务端仍为「待领取」（实测仍可能领到，故也尝试）
    const out = { total: 0, pending: [], stale: [], claimed: [], expired: [], failed: [], note: "" };
    let sk = sessionKey;
    try {
        const pa = await createAuth(profile, cookie, SDIAID);
        sk = pa?.data?.data?.userInfo?.sessionKey || sessionKey;
    } catch (e) { /* 沿用原 sessionKey */ }

    let resp;
    try {
        resp = await getDrawlogList(sk, cookie, SDIAID);
    } catch (e) {
        out.note = `奖品列表请求异常: ${e.message}`;
        $.log(`[账号${index}] [${displayName}] 🎁 ${out.note}`);
        return out;
    }
    if (resp.status !== 200 || resp.data?.code !== 0) {
        out.note = `奖品列表获取失败 HTTP ${resp.status} ${cleanMessage(resp.data?.message) || ""}`.trim();
        $.log(`[账号${index}] [${displayName}] 🎁 ${out.note}`);
        return out;
    }

    const list = resp.data?.data?.drawlogList || [];
    out.total = list.length;
    const now = Date.now();
    for (const p of list) {
        if (p.state !== 1) continue; // 仅待领取
        const expired = p.takeTimeEnd ? new Date(p.takeTimeEnd).getTime() < now : false;
        const item = { id: p.drawLogId, bonusId: String(p.bonusId || ""), name: p.comment || `奖品#${p.bonusId}`, pool: p.subcomment || p.drawPoolId || "", type: p.type || "", end: p.takeTimeEnd || "" };
        if (expired) out.stale.push(item); else out.pending.push(item);
    }

    $.log(`[账号${index}] [${displayName}] 🎁 我的奖品共 ${list.length} 条，待领取 ${out.pending.length + out.stale.length}（可领 ${out.pending.length} / 已过截止 ${out.stale.length}）`);
    for (const it of out.pending) $.log(`[账号${index}] [${displayName}]   ⏳ 待领取: ${it.name}（${it.pool}）${it.end ? "截止 " + fmtDay(it.end) : ""}`);
    for (const it of out.stale) $.log(`[账号${index}] [${displayName}]   ⌛ 已过截止: ${it.name}（${it.pool}）${it.end ? "截止 " + fmtDay(it.end) : ""}（仍会试领一次）`);

    if (!AUTO_TAKE) { out.note = "自动领取已关闭(qqpcmgr_auto_take=false)"; return out; }

    const qq = resolveTakeQq(profile, index);
    const selfQq = String(profile.account || "");
    if (qq && qq !== selfQq) {
        $.log(`[账号${index}] [${displayName}] 🎯 领奖目标QQ: ${qq}（账号绑定QQ ${selfQq || "未知"} 不参与领取）`);
    } else if (qq && qq === selfQq) {
        $.log(`[账号${index}] [${displayName}] 🎯 领奖目标QQ: ${qq}（变量显式指定用绑定QQ）`);
    } else {
        $.log(`[账号${index}] [${displayName}] ⛔ 未指定领奖目标QQ（qqpcmgr_take_qq 为空或该账号位留空）→ 本次不领取任何奖品，避免领到不认识的绑定QQ`);
    }
    let done = 0;
    // 实测：每日兑换上限按「奖品(bonusId) × 收奖QQ」计数，所以撞上限只跳过该奖品，其它奖品继续試
    const cappedBonus = new Set();
    const cappedLogged = new Set();
    const queue = [...out.pending, ...out.stale];
    if (out.stale.length) $.log(`[账号${index}] [${displayName}] 🔎 有 ${out.stale.length} 个已过截止的奖品，仍会尝试领取（服务端可能仍受理）`);
    for (const it of queue) {
        if (done >= MAX_TAKE) { out.note = `本次领取上限 ${MAX_TAKE} 个，剩余留到明天`; break; }
        if (it.bonusId && cappedBonus.has(it.bonusId)) {
            if (!cappedLogged.has(it.bonusId)) {
                cappedLogged.add(it.bonusId);
                $.log(`[账号${index}] [${displayName}]   ⏭️ 跳过同类奖品「${it.name}」：该奖品今日在 QQ ${qq} 已达上限（次日自动继续）`);
            }
            continue;
        }
        if (!TAKE_TYPES.includes(it.type)) {
            const reason = it.type === "ship" ? "实物奖品需收货信息，脚本不代领" : `暂不支持的类型 ${it.type || "未知"}`;
            out.failed.push({ ...it, reason });
            continue;
        }
        if (!qq) { out.failed.push({ ...it, reason: "未指定领奖目标QQ（qqpcmgr_take_qq 为空），为防误领到绑定QQ，本次不领取" }); continue; }
        let r;
        try {
            r = await takeBonus(sk, cookie, it.id, { qq });
        } catch (e) {
            out.failed.push({ ...it, reason: `请求异常: ${e.message}` });
            continue;
        }
        const code = r.data?.code;
        if (code === 0) {
            done++;
            out.claimed.push(it);
            $.log(`[账号${index}] [${displayName}]   ✅ 已领取: ${it.name}（${it.pool}）`);
        } else {
            const msg = cleanMessage(r.data?.message) || `HTTP ${r.status}`;
            out.failed.push({ ...it, reason: msg });
            $.log(`[账号${index}] [${displayName}]   ❌ 领取失败: ${it.name} :: ${msg}`);
            if (msg.includes("已达上限")) {
                if (it.bonusId) cappedBonus.add(it.bonusId);
                out.note = "部分奖品今日兑换已达上限（上限按 奖品×收奖QQ 计），其余奖品继续、剩余的明天自动再来";
                continue; // 关键：不整轮退出，其它奖品仍可能领到
            }
            if (msg.includes("过期") || msg.includes("失效")) { out.expired.push(it); }
        }
        await sleep(900 + Math.random() * 900);
    }
    // 复查一次，以服务端状态为准重新归类（这轮领到了没、哪些还挂着，一并以服务端为准）
    if (queue.length) {
        try {
            const again = await getDrawlogList(sk, cookie, SDIAID);
            const rows = again.data?.data?.drawlogList || [];
            const nw = Date.now();
            out.pending = []; out.stale = [];
            for (const p of rows) {
                if (p.state !== 1) continue;
                const item = { id: p.drawLogId, bonusId: String(p.bonusId || ""), name: p.comment || `奖品#${p.bonusId}`, pool: p.subcomment || p.drawPoolId || "", type: p.type || "", end: p.takeTimeEnd || "" };
                if (p.takeTimeEnd && new Date(p.takeTimeEnd).getTime() < nw) out.stale.push(item); else out.pending.push(item);
            }
        } catch (e) { /* 复查失败就保留本地判断 */ }
    }
    $.log(`[账号${index}] [${displayName}] 🎁 奖品处理完成: 本次领取 ${out.claimed.length} 项，仍待领取 ${out.pending.length + out.stale.length} 项（可领 ${out.pending.length} / 已过截止 ${out.stale.length}）${out.note ? "（" + out.note + "）" : ""}`);
    return out;
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

async function postComment(cookie, profile, softId, content, score) {
  try {
    const resp = await axios({ url: "https://softcenter.qq.com/coralapi/publishcomment/" + softId, method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie,
        "account": String(profile.account || ""), "guid": profile.guid || "",
        "loginkey": profile.loginKey || "", "logintype": "2",
        "openid": profile.openid || "", "devicename": COMPUTER_NAME,
        "User-Agent": USER_AGENT, "Origin": "https://cdn.m.qq.com", "Referer": "https://cdn.m.qq.com/" },
      data: { content, scorenum: score, guid: profile.guid || "", devicename: COMPUTER_NAME,
        client_version: QQPCMGR_CLIENT_VER, supply_id: "", os_type: 2, web_version: "1.8.0", web_env: "release" },
      timeout: 15000 });
    return resp.data;
  } catch(e) { return { code: -1, message: e.message }; }
}

// ====== 评论轮换：每款软件只加一次成长值，固定评论同一款永远不加分 ======
function loadSoftPool() {
  try {
    if (fs.existsSync(SOFT_POOL_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SOFT_POOL_FILE, "utf8"));
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) { $.log(`读取软件池失败: ${e.message}`); }
  return null;
}

function getCommentedFilePath(account) {
  return path.join(CACHE_DIR, `qqpcmgr_commented_${String(account || "default").replace(/[^a-zA-Z0-9]/g, "_")}.json`);
}

function loadCommentedSet(account) {
  try {
    const f = getCommentedFilePath(account);
    if (fs.existsSync(f)) return new Set(JSON.parse(fs.readFileSync(f, "utf8")));
  } catch (e) { $.log(`读取评论记录失败: ${e.message}`); }
  return new Set();
}

function saveCommentedSet(account, set) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(getCommentedFilePath(account), JSON.stringify([...set]));
  } catch (e) { $.log(`保存评论记录失败: ${e.message}`); }
}

async function getGrowthValue(profile, cookie) {
  try {
    const r = await getTasks(profile, cookie);
    if (r.status === 200 && r.data?.data?.resp) return Number(r.data.data.resp.total_growth_value);
  } catch (e) {}
  return null;
}

// 兜底：无软件池时维持原固定评论逻辑
async function _commentFallback(cookie, profile, index, displayName) {
  const sid = COMMENT_SOFTID;
  let ok = 0, fail = 0;
  $.log(`[账号${index}] [${displayName}] Commenting on softId=${sid} (max ${MAX_COMMENTS}, 慢速)`);
  for (let i = 0; i < MAX_COMMENTS; i++) {
    const txt = COMMENT_CONTENTS[Math.floor(Math.random()*COMMENT_CONTENTS.length)];
    const scr = Math.floor(Math.random()*2)+4;
    const r = await postComment(cookie, profile, sid, txt, scr);
    const ec = r && r.code;
    if (ec === 0) {
      ok++; fail = 0;
      $.log(`[账号${index}] [${displayName}]   ✅ OK ${i+1}: sid=${sid}, score=${scr} "${txt}"`);
    } else {
      fail++;
      $.log(`[账号${index}] [${displayName}]   ❌ FAIL ${i+1}: sid=${sid} code=${ec ?? "?"} ${r && r.message ? "| " + r.message : ""}`);
      if (ec === 3020) { $.log(`[账号${index}] [${displayName}]   ⚠️ softId=${sid} 不支持/已达评论上限，停止`); break; }
      if (fail >= 3) { $.log(`[账号${index}] [${displayName}]   ⚠️ 连续失败过多，停止`); break; }
    }
    const d = COMMENT_MIN_DELAY + Math.random() * (COMMENT_MAX_DELAY - COMMENT_MIN_DELAY);
    $.log(`[账号${index}] [${displayName}]   ⏳ 等待 ${Math.round(d/1000)}s`);
    await sleep(d);
  }
  $.log(`[账号${index}] [${displayName}] 评论完成: ${ok}/${MAX_COMMENTS}`);
  if (ok > 0) globalThis._commentedAccounts.add(index);
  return { ok, delta: 0 };
}

async function runSoftwareComments(cookie, profile, index, displayName) {
  if (!ENABLE_COMMENTS) { $.log("Comment disabled"); return { ok: 0, delta: 0 }; }

  // 防止账号后续环节(抽奖等)异常触发整段重试时，重复评论快速耗尽账号评论配额
  globalThis._commentedAccounts = globalThis._commentedAccounts || new Set();
  if (globalThis._commentedAccounts.has(index)) {
    $.log(`[账号${index}] [${displayName}] 本进程已评论过，跳过（避免重试重复评论）`);
    return { ok: 0, delta: 0 };
  }

  // 评论成长值已达服务端总上限（+2000）：再评论只留评论、不再加成长值 → 直接跳过，省掉 10 次请求与两分钟
  if (globalThis._commentCapReached && globalThis._commentCapReached[index]) {
    $.log(`[账号${index}] [${displayName}] ⚠️ 评论成长值已达总上限(+2000)，评论不再加分，跳过评论环节`);
    return { ok: 0, delta: 0, capped: true };
  }

  // 评论任务已完成时：默认仍继续评论（每评论一款新软件都有成长值），设 qqpcmgr_comment_always=false 可恢复只在任务待完成时评论
  const pending = globalThis._commentTaskPending ? globalThis._commentTaskPending[index] : undefined;
  if (pending === false && !COMMENT_ALWAYS) {
    $.log(`[账号${index}] [${displayName}] 评论任务已完成/不存在，且未开启持续评论，跳过`);
    return { ok: 0, delta: 0 };
  }
  if (pending === false) {
    $.log(`[账号${index}] [${displayName}] 评论任务已完成，继续评论赚成长值（今日目标 ${MAX_COMMENTS} 条）`);
  }

  const pool = loadSoftPool();
  if (!pool) {
    $.log(`[账号${index}] [${displayName}] ⚠️ 未找到软件池(.cache/qqpcmgr_soft_pool.json)，回退固定评论 softId=${COMMENT_SOFTID}`);
    return await _commentFallback(cookie, profile, index, displayName);
  }

  // 该账号已评论过的软件集合（每款只加一次成长值）
  const accKey = profile.openid || profile.account || String(index);
  const commented = loadCommentedSet(accKey);
  const candidates = pool.filter(s => !commented.has(String(s.id)));
  if (candidates.length === 0) {
    $.log(`[账号${index}] [${displayName}] ⚠️ 可评论的新软件已用尽(已评论 ${commented.size} 款)，评论不再加成长值`);
    return { ok: 0, delta: 0 };
  }

  // 打乱后取前 MAX_COMMENTS 款未评论过的新软件
  const chosen = [...candidates].sort(() => Math.random() - 0.5).slice(0, MAX_COMMENTS);

  const preGrowth = await getGrowthValue(profile, cookie);
  $.log(`[账号${index}] [${displayName}] 评论前成长值: ${preGrowth}`);

  let ok = 0, fail = 0;
  const newlyCommented = [];
  for (const soft of chosen) {
    const sid = Number(soft.id);
    const txt = COMMENT_CONTENTS[Math.floor(Math.random()*COMMENT_CONTENTS.length)];
    const scr = Math.floor(Math.random()*2)+4;
    $.log(`[账号${index}] [${displayName}]   💬 评论新软件: ${soft.name} (SoftID=${sid})`);
    const r = await postComment(cookie, profile, sid, txt, scr);
    const ec = r && r.code;
    if (ec === 0) {
      ok++;
      newlyCommented.push(String(sid));
      $.log(`[账号${index}] [${displayName}]   ✅ OK: sid=${sid}, score=${scr} "${txt}"`);
    } else {
      fail++;
      $.log(`[账号${index}] [${displayName}]   ❌ FAIL: sid=${sid} code=${ec ?? "?"} ${r && r.message ? "| " + r.message : ""}`);
      if (ec === 3020) $.log(`[账号${index}] [${displayName}]   ⚠️ sid=${sid} 不支持评论/已达上限，不记录`);
    }
    const d = COMMENT_MIN_DELAY + Math.random() * (COMMENT_MAX_DELAY - COMMENT_MIN_DELAY);
    $.log(`[账号${index}] [${displayName}]   ⏳ 等待 ${Math.round(d/1000)}s`);
    await sleep(d);
  }

  // 仅记录评论成功的软件，下次不再重复
  if (newlyCommented.length) {
    for (const sid of newlyCommented) commented.add(sid);
    saveCommentedSet(accKey, commented);
  }

  // 回查成长值，确认加分是否到账
  let delta = 0;
  if (ok > 0) {
    const postGrowth = await getGrowthValue(profile, cookie);
    if (postGrowth != null && preGrowth != null) {
      delta = postGrowth - preGrowth;
      if (delta > 0) {
        $.log(`[账号${index}] [${displayName}] 📈 评论成长值 +${delta} (${preGrowth} → ${postGrowth})`);
      } else {
        $.log(`[账号${index}] [${displayName}] ⚠️ 评论后成长值未变化(${preGrowth} → ${postGrowth})，本批软件可能此前已评论过`);
      }
    }
  }

  $.log(`[账号${index}] [${displayName}] 评论完成: 新软件 ${ok}/${chosen.length} 款`);
  if (ok > 0) globalThis._commentedAccounts.add(index);
  return { ok, delta };
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

// ====== 活动任务执行 ======

const DO_ACTIVITY_TASKS = process.env.qqpcmgr_activity_tasks !== "false";

async function getActivityTasks(profile, cookie) {
    // 活动任务列表可能来自不同的接口
    // 尝试从 luban 获取活动任务
    const urls = [
        "https://luban.m.qq.com/api/public/pcmgr/v2-rights?action=getActivityTasks"
    ];
    for (const url of urls) {
        try {
            const { data, status } = await axios.request({
                method: "GET", url,
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
            if (status === 200) return { status, data, url };
        } catch (e) {}
    }
    return { status: 0, data: null, url: "" };
}

async function completeTask(taskId, taskName, profile, cookie, index, displayName) {
    // 尝试通过 luban API 完成任务
    const { data, status } = await axios.request({
        method: "POST",
        url: "https://luban.m.qq.com/api/public/pcmgr/v2-rights/completeTask",
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
            taskId: String(taskId),
            taskName: taskName,
            accountid: profile.account,
            loginkey: profile.loginKey,
            commonid: profile.commonid || profile.openid,
            client_guid: profile.guid,
            acctype: 2,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    return { status, data };
}

async function doActivityTask(taskId, taskName, profile, cookie, sessionKey, index, displayName) {
    $.log(`[账号${index}] [${displayName}]   🏃 执行活动任务 [${taskName}]`);

    // 1. 先上报任务事件
    try {
        await doTaskReport(profile, cookie, taskId, taskName);
    } catch (e) {}

    // 2. 尝试完成任务
    const result = await completeTask(taskId, taskName, profile, cookie, index, displayName);
    if (result.status === 200 && result.data?.ret === 0) {
        $.log(`[账号${index}] [${displayName}]   ✅ 活动任务 [${taskName}] 完成!`);
        return true;
    }

    // 3. 如果 luban API 失败，尝试直接通过 jprx 完成任务
    try {
        const { data, status } = await axios.request({
            method: "POST",
            url: "https://jprx.m.qq.com/data/3092/forward",
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
            data: JSON.stringify({
                req: {
                    task_id: taskId,
                    accountid: profile.account,
                    loginkey: profile.loginKey,
                    commonid: profile.commonid || profile.openid,
                    client_guid: profile.guid,
                    acctype: 2,
                },
            }),
            timeout: 20000,
            validateStatus: () => true,
        });
        // 注意：HTTP 200 不代表任务真的完成 —— 服务端在 body 里给 resp.result(0=成功) / ret
        const ret = data && data.ret;
        const resultCode = data && data.data && data.data.resp && data.data.resp.result;
        if (status === 200 && ret === 0 && resultCode === 0) {
            $.log(`[账号${index}] [${displayName}]   ✅ 活动任务 [${taskName}] 通过 jprx 完成`);
            return true;
        }
        if (status === 200) {
            $.log(`[账号${index}] [${displayName}]   ℹ️ 活动任务 [${taskName}] 服务端未认可(ret=${ret}, result=${resultCode})，需真机客户端操作`);
        }
    } catch (e) {}

    $.log(`[账号${index}] [${displayName}]   ⚠️ 活动任务 [${taskName}] 可能失败 (API 可能不支持直接完成)`);
    return false;
}

async function runActivityTasks(sessionKey, cookie, profile, index, displayName) {
    if (!DO_ACTIVITY_TASKS) { $.log(`[账号${index}] [${displayName}] 活动任务已禁用`); return; }
    
    $.log(`[账号${index}] [${displayName}] 获取活动任务列表...`);
    
    // 从任务列表获取活动任务 (已有的 getTasks 接口)
    const taskList = await getTasks(profile, cookie);
    if (taskList.status !== 200 || taskList.data?.ret !== 0) {
        $.log(`[账号${index}] [${displayName}] 获取任务列表失败，跳过活动任务`);
        return;
    }
    
    const resp = taskList.data?.data?.resp;
    if (!resp || resp.result !== 0) return;
    
    const tasks = resp.item_list || [];
    
    // 筛选出可点击且未完成的任务，但排除设置类任务 (task_type 3)
    const activityTasks = tasks.filter(t => 
        t.can_click === true && 
        (!t.status_text || !t.status_text.includes("已完成")) &&
        t.task_type !== 3
    );
    
    if (activityTasks.length === 0) {
        $.log(`[账号${index}] [${displayName}] 没有待完成的活动任务`);
        return;
    }
    
    $.log(`[账号${index}] [${displayName}] 找到 ${activityTasks.length} 个待完成的活动任务`);
    
    let done = 0;
    for (const task of activityTasks) {
        const ok = await doActivityTask(task.task_id, task.task_desc || "未知任务", 
            profile, cookie, sessionKey, index, displayName);
        if (ok) done++;
        await sleep(1000 + Math.random() * 1000);
    }
    
    $.log(`[账号${index}] [${displayName}] 活动任务完成: ${done}/${activityTasks.length}`);
    
    // 完成活动任务后重新获取一次任务列表，看成长值是否变化
    const updated = await getTasks(profile, cookie);
    if (updated.status === 200 && updated.data?.data?.resp) {
        const newResp = updated.data.data.resp;
        $.log(`[账号${index}] [${displayName}] 更新后成长值: ${newResp.total_growth_value} Lv.${newResp.curr_lv}`);
    }
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

// 实测(2026-09-17)：sdi 的 sessionKey 是「单会话」——同账号在别处重新登录后，
// 旧 sessionKey 立即失效，但 Cookie 仍然有效（validateCookie 会通过），
// 之后所有接口静默返回 result:2 / code:4002，日志看起来一切正常其实全废。
// 所以这里加一道 sessionKey 校验，失效就重新登录，避免整天白跑。
async function validateSessionKey(profile, cookie) {
    if (!profile || !profile.account || !profile.loginKey) return true;
    try {
        const r = await getTasks(profile, cookie);
        const resp = r && r.data && r.data.data && r.data.data.resp;
        if (resp && Number(resp.result) !== 0) return false;
        return true;
    } catch (e) {
        $.log(`[验证] sessionKey 校验异常(按有效处理): ${e.message}`);
        return true;
    }
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
        } else {
            const sessionOk = await validateSessionKey(profile, cookie);
            if (!sessionOk) {
                $.log(`  🔄 sessionKey 已失效（Cookie 仍有效），重新登录`);
                needRelogin = true;
            }
        }
    } else {
        needRelogin = true;
    }

    if (needRelogin) {
        $.log(`  🔐 登录中...`);
        // jprx/open.weixin 偶发超时，无缓存的账号会因此整天跑不起来，这里做退避重试
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const authCode = await getAuthCode(account);
                const payload = await loginByCode(authCode, guid);
                profile = normalizeProfile(payload, guid);
                if (!profile.loginKey || !profile.openid) throw new Error("登录资料缺少 loginKey/openid");
                cookie = buildCookie(profile);

                const auth = await createAuth(profile, cookie);
                sessionKey = auth.data?.data?.userInfo?.sessionKey || auth.data?.data?.sessionKey || auth.data?.sessionKey;
                if (!sessionKey) throw new Error(`auth/create 未返回 sessionKey`);

                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                if (attempt < 3) {
                    $.log(`  ⚠️ 登录失败(${(e && e.message) || e})，${attempt * 5}s 后重试 (${attempt}/2)`);
                    await sleep(attempt * 5000);
                }
            }
        }
        if (lastErr) throw lastErr;

        writeCache(account, { profile, cookie, sessionKey });
        $.log(`  ✅ 登录成功`);
    }

    let growthValue = 0;
    
    if (DO_TASKS) {
        const taskResult = await runTasks(sessionKey, cookie, profile, index, displayName);
        growthValue = taskResult?.growthValue || 0;
    }

    const commentResult = await runSoftwareComments(cookie, profile, index, displayName);

    // 执行活动任务
    await runActivityTasks(sessionKey, cookie, profile, index, displayName);

    await runHomeConfig(cookie, index, displayName);
    const userLevel = globalThis.lubanConfig?.[index]?.userLevel || 0;
    const lotteries = await runLotteries(sessionKey, cookie, index, displayName, profile);
    // 抽奖后处理奖品中心：列出全部奖品 + 自动领取「待领取」项
    const bonus = await runBonusCenter(profile, cookie, sessionKey, index, displayName);

    // 写入面板标准报告行（std_report 钉钉 markdown），奖品信息直接可见
    _setName(index, profile.nickname || displayName);
    _setSign(index, "任务完成");
    if (parseInt(commentResult?.ok || 0) > 0) {
        _setSign(index, null, `评论 ${commentResult.ok} 款软件 +${commentResult.delta || 0} 成长值`, null);
    }
    if (commentResult?.capped) {
        _addTask(index, "评论成长值", "已达总上限(+2000)，不再加分(已跳过评论)");
    }
    const winList = (lotteries || []).filter((x) => x && x.prize);
    const prizeBrief = [];
    if (winList.length) prizeBrief.push(`本次中奖 ${winList.map((x) => x.prize).join("/")}`);
    if (bonus.claimed.length) prizeBrief.push(`今日已领 ${countBy(bonus.claimed)}`);
    if (bonus.pending.length) prizeBrief.push(`待领取 ${countBy(bonus.pending)}`);
    if (bonus.stale.length) prizeBrief.push(`已过截止待试领 ${countBy(bonus.stale)}`);
    if (!bonus.pending.length && !bonus.stale.length && !bonus.claimed.length && bonus.total) prizeBrief.push(`奖品已全部领取(${bonus.total} 条)`);
    if (prizeBrief.length) _setLottery(index, prizeBrief.join(" ｜ "));
    else if (bonus.note) _setLottery(index, bonus.note);
    for (const p of bonus.pending.slice(0, 4)) {
        _addTask(index, "待领取", `${p.name}${p.pool ? "（" + p.pool + "）" : ""}${p.end ? " 截止 " + fmtDay(p.end) : ""}`);
    }
    for (const p of bonus.stale.slice(0, 2)) {
        _addTask(index, "已过截止", `${p.name}${p.pool ? "（" + p.pool + "）" : ""}${p.end ? " 截止 " + fmtDay(p.end) : ""}（次日仍会试领）`);
    }
    for (const p of bonus.claimed.slice(0, 3)) {
        _addTask(index, "已领取", `${p.name}${p.pool ? "（" + p.pool + "）" : ""}`);
    }
    if (bonus.expired.length) _addTask(index, "已失效", `${bonus.expired.length} 项（服务端判定过期/失效）`);
    if (bonus.note) _addTask(index, "提示", bonus.note);

    return {
        nickname: profile.nickname,
        level: userLevel,
        growthValue,
        commentOk: commentResult?.ok || 0,
        commentGrowth: commentResult?.delta || 0,
        lotteries,
        bonus
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
    // 记录评论类任务是否仍处于待完成，供 runSoftwareComments 判断是否值得评论
    globalThis._commentTaskPending = globalThis._commentTaskPending || {};
    globalThis._commentTaskPending[index] = tasks.some(t =>
        (t.task_desc || "").includes("评论") &&
        t.can_click === true &&
        !(t.status_text || "").includes("已完成"));
    // 评论成长值有「总上限」：评满后服务端把该任务置为 can_click=false 且 status_text 带「已达总上限+2000」
    // （实测 2026-09-21：每条 +20、上限 2000 = 100 条；到顶后评论仍返回 code=0 但成长值不再变化 → 没必要再评）
    globalThis._commentCapReached = globalThis._commentCapReached || {};
    globalThis._commentCapReached[index] = tasks.some(t =>
        (t.task_desc || "").includes("评论") && /已达总上限|已达上限/.test(t.status_text || ""));
    $.log(`[账号${index}] [${displayName}] 获取到 ${tasks.length} 个任务 (评论任务待完成: ${globalThis._commentTaskPending[index]}${globalThis._commentCapReached[index] ? "，评论成长值已达总上限" : ""})`);
    
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
    // 真实响应中"天天惊喜"在 monthly 数组(autoHide:true)，daily 字段通常为空
    const dailyLotteries = config.data?.daily || config.data?.monthly || [];
    
    $.log(`[账号${index}] [${displayName}] 等级抽奖模块: ${levelLotteries.length} 个`);
    for (const lv of levelLotteries) {
        $.log(`[账号${index}] [${displayName}]   - ${lv.title} (Lv.${lv.min_level}-${lv.max_level}, sdi_aid=${lv.sdi_aid}, pool=${lv.adi_draw_pool_id})`);
    }
    
    $.log(`[账号${index}] [${displayName}] 每日抽奖模块(含天天惊喜): ${dailyLotteries.length} 个`);
    for (const daily of dailyLotteries) {
        $.log(`[账号${index}] [${displayName}]   - ${daily.title} (sdi_aid=${daily.sdi_aid}, pool=${daily.draw_pool_id || daily.adi_draw_pool_id})`);
    }
    
    globalThis.lubanConfig = globalThis.lubanConfig || {};
    globalThis.lubanConfig[index] = { levelLotteries, dailyLotteries, userLevel: userInfo?.curr_lv || 0 };
}

async function runSingleLottery(sessionKey, cookie, lotteryId, lotteryName, lotteryType, index, displayName, profile, sdiAid) {
    $.log(`[账号${index}] [${displayName}] 🎲 ${lotteryName}`);
    
    if (lotteryType === "等级抽奖") {
        // 抓包确认: 真实 App 所有抽奖 lid 均为 Lottery2, 靠 sdiaid 表头区分奖池
        const pa = await createAuth(profile, cookie, sdiAid || SDIAID);
        const lk = pa?.data?.data?.userInfo?.sessionKey || sessionKey;
        const st = await getLotteryStatus(lk, cookie, "Lottery2", sdiAid || SDIAID);
        if (st.status !== 200 || st.data?.code !== 0) {
            const code = st.data?.code;
            if (code === -10) throw new Error(`LOGIN_EXPIRED:${st.data?.message || "登录态过期"}`);
            const emsg = cleanMessage(st.data?.message) || "未知错误";
            $.log(`[账号${index}] [${displayName}]   ❌ 获取状态失败: ${emsg}`);
            return { name: lotteryName, type: lotteryType, status: st.status, data: st.data, resultText: `❌ 获取状态失败: ${emsg}`, prize: "" };
        }
        const sd = st.data.data || {};
        if (process.env.qqpcmgr_debug_lottery === "true") {
            $.log(`   [debug] lotteryStatus 原始响应: ${JSON.stringify(st.data)}`);
        }
        // 输出奖池奖品列表，让日志可读
        if (Array.isArray(sd.bonus) && sd.bonus.length) {
            $.log(`[账号${index}] [${displayName}]   🎁 本池奖品: ${sd.bonus.map(b => b.comment || b.bonusId).join(" / ")}`);
        }
        const skip2 = (text) => {
            $.log(`[账号${index}] [${displayName}]   ${text}`);
            return { name: lotteryName, type: lotteryType, status: 200, data: { code: 0, data: {} }, resultText: text, prize: "" };
        };
        // 等级池: winLimitDays=400 属于"长周期限中1次"(中过就再也不会中)，与每日池(天天惊喜)严格区分
        if (sd.drawLimited && !FORCE_LOTTERY) return skip2(`⏭️ 等级池今日次数已用完，明天再抽`);
        if (sd.winLimited && !FORCE_LOTTERY) {
            const days = Number(sd.winLimitDays) || 1;
            return skip2(days > 1 ? `⏭️ 等级池已中过奖（${days}天内限中${sd.winLimitTimes || 1}次）` : `⏭️ 等级池今日已中过奖，明天再抽`);
        }
        if (!sd.canReceive && !FORCE_LOTTERY) return skip2(`⏭️ 暂不可抽奖${cleanMessage(sd.message) ? `（${cleanMessage(sd.message)}）` : ""}`);
        const lottery2 = await doLottery(lk, cookie, "Lottery2", sdiAid || SDIAID);
        const parsed2 = parseLotteryOutcome({ status: lottery2.status, data: lottery2.data }, sd.bonus);
        $.log(`[账号${index}] [${displayName}]   ${parsed2.text}`);
        return { name: lotteryName, type: lotteryType, status: lottery2.status, data: lottery2.data, resultText: parsed2.text, prize: parsed2.prize };
    }

    // 所有抽奖 lid 均为 Lottery2，靠 sdiaid 表头区分奖池（含天天惊喜）。
    // 注意：此处不能用 lotteryId（那是 draw_pool_id 如 26WX_ttjx），否则 doLottery 返回异常响应。
    // 按当前池 sdiAid 重新 createAuth 获取对应 sessionKey（与等级抽奖分支一致，避免跨池 session 不匹配）
    const pa = await createAuth(profile, cookie, sdiAid || SDIAID);
    const lk = pa?.data?.data?.userInfo?.sessionKey || sessionKey;
    const status = await getLotteryStatus(lk, cookie, LOTTERY_ID, sdiAid || SDIAID);
    
    if (status.status !== 200 || status.data?.code !== 0) {
        const code = status.data?.code;
        if (code === -10) {
            throw new Error(`LOGIN_EXPIRED:${status.data?.message || "登录态过期"}`);
        }
        const emsg = cleanMessage(status.data?.message) || "未知错误";
        $.log(`[账号${index}] [${displayName}]   ❌ 获取状态失败: ${emsg}`);
        return { name: lotteryName, type: lotteryType, status: status.status, data: status.data, resultText: `❌ 获取状态失败: ${emsg}`, prize: "" };
    }
    
    const statusData = status.data.data || {};
    if (process.env.qqpcmgr_debug_lottery === "true") {
        $.log(`   [debug] lotteryStatus 原始响应: ${JSON.stringify(status.data)}`);
    }
    // 输出奖池奖品列表，让日志可读
    if (Array.isArray(statusData.bonus) && statusData.bonus.length) {
        $.log(`[账号${index}] [${displayName}]   🎁 本池奖品: ${statusData.bonus.map(b => b.comment || b.bonusId).join(" / ")}`);
    }
    const drawLimited = statusData.drawLimited === true;
    const winLimited = statusData.winLimited === true;
    const canReceive = statusData.canReceive === true;

    const skip = (text) => {
        $.log(`[账号${index}] [${displayName}]   ${text}`);
        return { name: lotteryName, type: lotteryType, status: 200, data: { code: 0, data: {} }, resultText: text, prize: "" };
    };

    if (drawLimited && !FORCE_LOTTERY) return skip(`⏭️ 今日次数已用完，明天再抽`);
    if (winLimited && !FORCE_LOTTERY) {
        const days = Number(statusData.winLimitDays) || 1;
        return skip(days > 1 ? `⏭️ 已中过奖（${days}天内限中${statusData.winLimitTimes || 1}次）` : `⏭️ 今日已中过奖，明天再抽`);
    }
    if (!canReceive && !FORCE_LOTTERY) {
        return skip(`⏭️ 暂不可抽奖${cleanMessage(statusData.message) ? `（${cleanMessage(statusData.message)}）` : ""}`);
    }

    const lottery = await doLottery(lk, cookie, LOTTERY_ID, sdiAid || SDIAID);
    const parsed = parseLotteryOutcome({ status: lottery.status, data: lottery.data }, statusData.bonus);
    $.log(`[账号${index}] [${displayName}]   ${parsed.text}`);

    return { name: lotteryName, type: lotteryType, ...lottery, resultText: parsed.text, prize: parsed.prize };
}

async function runLotteries(sessionKey, cookie, index, displayName = "", profile) {
    $.log(`[账号${index}] [${displayName}] 开始多抽奖模块`);
    const results = [];

    const configuredLotteries = process.env.qqpcmgr_lotteries
        ? splitAccounts(process.env.qqpcmgr_lotteries)
        : [];

    if (configuredLotteries.length > 0) {
        for (const lotteryId of configuredLotteries) {
            const result = await runSingleLottery(sessionKey, cookie, lotteryId, lotteryId, "配置抽奖", index, displayName, profile);
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
                    const result = await runSingleLottery(sessionKey, cookie, drawPoolId, lv.title, "等级抽奖", index, displayName, profile, lv.sdi_aid);
                    results.push(result);
                    await sleep(1500);
                }
            }
            
            if (luban.dailyLotteries && luban.dailyLotteries.length > 0) {
                for (const daily of luban.dailyLotteries) {
                    const drawPoolId = daily.draw_pool_id || daily.adi_draw_pool_id;
                    const result = await runSingleLottery(sessionKey, cookie, drawPoolId, daily.title, "每日抽奖", index, displayName, profile, daily.sdi_aid);
                    results.push(result);
                    await sleep(1500);
                }
            } else {
                // 兜底：真实天天惊喜池 sdi_aid=2025121115391911962
                const result = await runSingleLottery(sessionKey, cookie, "Lottery2", "天天惊喜", "每日抽奖", index, displayName, profile, SDIAID);
                results.push(result);
            }
        } else {
            const result = await runSingleLottery(sessionKey, cookie, "Lottery2", "天天惊喜", "每日抽奖", index, displayName, profile, SDIAID);
            results.push(result);
        }
    }
    
    return results;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let PUSHED = false;
let FAIL_DETAIL = "";

// 面板托管的 sendNotify 需要 DAIDAI_NOTIFY_URL/TOKEN + 面板已配置通知渠道，
// 缺任一项都会抛错。原实现把这类错误统一显示成"未找到模块"，极具误导性，这里如实输出原因并自动降级。
async function sendNotify(title, content) {
    for (const modPath of [path.join(__dirname, "../sendNotify"), "/ql/scripts/sendNotify"]) {
        let notify;
        try {
            notify = require(modPath);
        } catch (e) {
            continue; // 模块不存在，静默跳到下一个
        }
        try {
            await notify.sendNotify(title, content);
            $.log(`[推送] 面板通知已发送`);
            PUSHED = true;
            return true;
        } catch (e) {
            $.log(`[推送] 面板通道不可用(${(e && e.message) || e})，降级 std_report`);
            break;
        }
    }
    return await _stdSendPush(title, content);
}

// 服务端 message 常带 "日志id=>uuid" 尾巴，推送里没有意义，清掉
function cleanMessage(msg) {
    return String(msg || "").replace(/\s*日志id=>[\w-]+/g, "").trim();
}

// 从 doLottery 响应里提取奖品名。
// 关键增强: 中奖响应有时只回 bonusId，用 lotteryStatus 拿到的奖池 bonus 列表反查真实奖品名。
function extractPrize(data, bonusList) {
    const d = (data && data.data) || {};
    const pool = Array.isArray(bonusList) ? bonusList : [];

    const nameOf = (v) => {
        if (v === null || v === undefined || v === "") return "";
        if (typeof v === "string" || typeof v === "number") {
            // 纯 bonusId(如 "2636") 先尝试反查奖池
            const hit = pool.find((b) => String(b.bonusId) === String(v));
            if (hit) return hit.comment || hit.name || String(v);
            // 反查不到的纯数字 ID 标注为"奖品#ID"而非裸推，避免误导成真实奖品名
            if (/^\d+$/.test(String(v))) return `奖品#${v}`;
            return String(v);
        }
        if (typeof v === "object") {
            if (v.comment || v.name || v.title || v.prizeName || v.bonusName || v.desc) {
                return v.comment || v.name || v.title || v.prizeName || v.bonusName || v.desc;
            }
            if (v.bonusId) {
                const hit = pool.find((b) => String(b.bonusId) === String(v.bonusId));
                if (hit) return hit.comment || hit.name || String(v.bonusId);
            }
            return "";
        }
        return "";
    };

    const first = (v) => (Array.isArray(v) ? v[0] : v);

    const candidates = [
        d.prize, d.giftName, d.name, d.awardName, d.prizeName, d.itemName,
        d.gift, d.award, d.reward, d.winBonus, d.bonus, d.bonusInfo, d.bonusId,
        first(d.awardList), first(d.gifts), first(d.items), first(d.bonusList), first(d.bonuses),
    ];
    for (const c of candidates) {
        const n = nameOf(c);
        if (n) return n;
    }
    return "";
}

// 统一解析抽奖结果 -> { text, prize }
// prize 非空即代表本次真实中奖，用于推送汇总
function parseLotteryOutcome(result, bonusList) {
    const data = result.data;
    if (process.env.qqpcmgr_debug_lottery === "true") {
        $.log(`   [debug] doLottery 原始响应: ${JSON.stringify(data)}`);
    }
    if (result.status === 200 && data) {
        const d = data.data || {};
        const prize = extractPrize(data, bonusList);
        if (prize) return { text: `🎉 恭喜获得: ${prize}`, prize };

        // code=0 且无奖品 = 本次抽奖未中（中奖才会返回奖品，未中不再笼统显示"今日已抽奖"）
        if (data.code === 0) {
            return { text: "😅 未中奖，明日再试", prize: "" };
        }
        const msg = cleanMessage(data.message);
        if (msg && msg.includes("已达") && msg.includes("上限")) return { text: `⏭️ ${msg}`, prize: "" };
        if (msg && msg.includes("当前不可")) return { text: `⏭️ ${msg}`, prize: "" };
        if (data.code !== 0 && msg) return { text: `💫 ${msg}`, prize: "" };
        return { text: "✅ 完成", prize: "" };
    }
    const msg = cleanMessage(data && data.message);
    if (msg) return { text: `💫 ${msg}`, prize: "" };
    return { text: "❌ 失败", prize: "" };
}

// 兼容旧调用；推送阶段改用已缓存的 resultText，避免二次解析重复打 debug 日志
function formatLotteryResult(result, bonusList) {
    if (result && typeof result.resultText === "string") return result.resultText;
    return parseLotteryOutcome(result, bonusList).text;
}

function randomDelay(minSeconds = 10, maxSeconds = 20) {
    const delay = Math.random() * (maxSeconds - minSeconds) + minSeconds;
    const ms = Math.floor(delay * 1000);
    $.log(`[风控] 等待 ${(delay / 60).toFixed(2)} 分钟 (${ms}ms)`);
    return new Promise(resolve => setTimeout(resolve, ms));
}


const { report: _stdReport, sendPush: _stdSendPush } = require("./std_report");
let _rpRows = [];
let _rpApp = '';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", tasks: [], lottery: "" };
  return _rpRows[idx];
}
function logPoints(todayPoints, totalPoints, app, idx, status) {
  _rpApp = app || _rpApp;
  const r = _rpGet(idx);
  if (status != null && status !== "") r.sign = String(status);
  if (totalPoints != null && totalPoints !== "" && !isNaN(Number(totalPoints))) r.total = String(totalPoints);
  if (todayPoints != null && todayPoints !== "" && !isNaN(Number(todayPoints)) && Number(todayPoints) !== 0) r.earned = "今日+" + todayPoints + "积分";
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null) r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
async function doPush() { /* 由 flushLogPoints 统一经 std_report 推送 */ }
let _rpFlushed = false;
async function flushLogPoints(app) {
  if (_rpFlushed) return;
  _rpApp = app || _rpApp;
  const rows = _rpRows.filter(Boolean);
  if (!rows.length) return;
  _rpFlushed = true;
  await _stdReport(_rpApp, rows);
  PUSHED = true; // 已走标准推送通道，避免 finally 再补一条「执行异常」
}
{
  const _oe = process.exit.bind(process);
  process.exit = function (code) {
    const p = flushLogPoints(_rpApp);
    if (p && typeof p.then === 'function') p.then(() => _oe(code)).catch(() => _oe(code));
    else _oe(code);
  };
}
process.on('beforeExit', () => { flushLogPoints(_rpApp); });

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
        // 本次中奖（来自本轮抽奖响应）
        const wins = [];
        for (const r of results) {
            for (const lo of r.lotteries || []) {
                if (lo && lo.prize) {
                    wins.push({ who: r.remark || r.nickname || "账号", pool: lo.name, prize: lo.prize });
                }
            }
        }
        // 奖品信息（待领取 / 本次已领 / 已过期）——直接展示，不再依赖中奖文案
        const pendingAll = [], takenAll = [], expiredAll = [], failNotes = [];
        for (const r of results) {
            const who = r.remark || r.nickname || "账号";
            const b = r.bonus || {};
            for (const it of b.pending || []) pendingAll.push({ who, ...it });
            for (const it of b.claimed || []) takenAll.push({ who, ...it });
            for (const it of b.expired || []) expiredAll.push({ who, ...it });
            for (const it of b.failed || []) if (it.reason && failNotes.indexOf(it.reason) < 0) failNotes.push(it.reason);
            if (b.note && failNotes.indexOf(b.note) < 0) failNotes.push(b.note);
        }

        let content = "";
        content += `🎁 奖品信息\n`;
        if (pendingAll.length) {
            content += `⏳ 待领取 ${pendingAll.length} 项\n`;
            for (const p of pendingAll) {
                content += `   ${p.who}：${p.name}${p.pool ? "（" + p.pool + "）" : ""}${p.end ? " 截止 " + fmtDay(p.end) : ""}\n`;
            }
        } else {
            content += `⏳ 待领取 0 项\n`;
        }
        if (takenAll.length) {
            content += `✅ 本次已领取 ${takenAll.length} 项\n`;
            for (const p of takenAll) content += `   ${p.who}：${p.name}${p.pool ? "（" + p.pool + "）" : ""}\n`;
        }
        if (expiredAll.length) content += `⌛ 已过期/失效 ${expiredAll.length} 项\n`;
        if (failNotes.length) content += `⚠️ ${failNotes.slice(0, 3).join("；")}\n`;
        if (wins.length) {
            content += `🏆 本次中奖 ${wins.length} 项\n`;
            for (const w of wins) content += `   🎉 ${w.who}：${w.prize}${w.pool && w.pool !== w.prize ? "（" + w.pool + "）" : ""}\n`;
        }
        content += `\n`;

        content += `📱 腾讯管家任务执行结果\n`;
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

                if (r.commentOk > 0) {
                    content += `   💬 评论新软件: ${r.commentOk} 款`;
                    if (r.commentGrowth > 0) content += ` (+${r.commentGrowth} 成长值)`;
                    content += `\n`;
                }

                if (r.bonus && (r.bonus.total || r.bonus.note)) {
                    content += `   🎁 奖品: 待领取 ${(r.bonus.pending || []).length} / 本次领取 ${(r.bonus.claimed || []).length} / 已过期 ${(r.bonus.expired || []).length}\n`;
                    for (const p of r.bonus.pending || []) content += `      ⏳ ${p.name}${p.pool ? "（" + p.pool + "）" : ""}${p.end ? " 截止 " + fmtDay(p.end) : ""}\n`;
                    for (const p of r.bonus.claimed || []) content += `      ✅ 已领 ${p.name}\n`;
                    if (r.bonus.note) content += `      ℹ️ ${r.bonus.note}\n`;
                }

                if (r.lotteries && r.lotteries.length > 0) {
                    content += `   🎲 抽奖结果:\n`;
                    for (const lottery of r.lotteries) {
                        const badge = lottery.type === "等级抽奖" ? "🏅 " : "";
                        content += `      ${badge}${lottery.name}: ${formatLotteryResult(lottery)}\n`;
                    }
                }
            }
        }

        content += `\n───\n⏰ ${new Date().toLocaleString()}`;

        // 推送统一走面板标准通道(std_report 钉钉 markdown，与其余脚本一致)：
        // 奖品信息已在报告行的「抽奖获得 / 明细」里，正文只在最后兜底时使用
        FAIL_DETAIL = content;
        await flushLogPoints("腾讯管家");
    }
})()
    .catch((e) => $.log(`执行失败: ${e.message || e}`))
    .finally(async () => {
        // 正常流程已由 flushLogPoints 推送；只有完全没推成时，才补一条兜底日志
        if (!PUSHED) {
            const tail = NOTIFY_LOG.slice(-25).join("\n");
            await _stdSendPush("腾讯管家 ⚠️ 执行异常", (FAIL_DETAIL || "脚本未正常产出结果，末尾日志：") + "\n\n" + (tail || "无日志"));
        }
        $.done();
    });
