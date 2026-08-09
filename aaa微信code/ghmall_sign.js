/*
@Description: 天津贵和购物中心 签到 + 勋章任务领奖 (猫酷 Mallcoo SaaS)
cron: 25 8 * * *

逆向来源: wxapkg wx12e08615b315e107 (v36)
  解包: __APP__.wxapkg / _package_libs_.wxapkg / _views_user_.wxapkg
  平台: 猫酷 Mallcoo (m.mallcoo.cn)，同一套代码分发给上百家商场，仅 mallId 不同
  mallId: 10245 (天津贵和购物中心，归属集团"天津鲁能购物中心" GroupID=235)

  登录: POST https://m.mallcoo.cn/api/passport/wx/mp/login
        body { mallId, mpAppId, mpAuthCode:<WCS code>, Header:{Token:"",systemInfo} }
        -> d.token + d.projectType，拼成 "token,projectType" 作为后续 Header.Token

  请求封装 (utils/util/netUtil.js i.invoke):
        全部 POST + application/json，业务参数与 Header 同级平铺在 body
        body.Header = { Token, systemInfo }
        响应 m===1 成功 / m===320|311 token失效 / 其余为业务错误(e 为文案)

  签到 (views/user/checkin/index/index，在 _views_user_ 子包内):
        POST api/user/user/CheckinBefore   {MallId, IsCheckMemberCard:true}
             -> IsOpenCheckin / IsCheckIn / IsOpenCheckinForPosition
             -> m=2000 未开启签到，m=2054 分组签到，m=2058 需绑会员卡
        POST api/user/User/CheckinV2       {MallID, Longitude, Latitude, InMall}
             -> d.Msg "签到成功，奖励2积分"，d.RewardType 1积分/2券/3抽奖
        POST api/user/User/GetCheckinDetail{MallID} -> ContinueDay / CheckinBonusSum

  任务 (勋章任务 medal mission):
        POST api/medal/missionGroup/getListByUserID {mallId} -> [{missionGroupID, missionList:[...]}]
             注意是大写 UserID，小写 UserId 那个是主包里的旧写法，两者都通但语义一致
        POST api/medal/mission/receivePrize          {mallId, missionId}
        missionStatus: 1未开始 2未完成 3去完成 4可领奖 5已领取 6已结束 7条件未满足 8已完成
        脚本只领 status=4 的奖励；其余状态需用户在小程序内实际产生消费/浏览行为
        (该商场当前未配置勋章任务，接口返回空数组，属正常)

  说明: lib/apiSecurity 会给 /api/user/ 加 /v-sg 签名段，但依赖未下发的 secretConfig，
        try/catch 兜底后返回空对象，实测不加签名可正常调用，故不实现。
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const { sendPushNotify } = require("./_push_helper");
const $ = new Env("天津贵和购物中心");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wx12e08615b315e107";
const MALL_ID = Number(process.env.ghmall_id || 10245);
const DOMAIN = "https://m.mallcoo.cn/";
const MINI_VERSION = "std2.80.0.lp";
const TOKEN_CACHE_FILE = path.join(__dirname, "ghmall_token_cache.json");
const ckName = "wx_opinion";

const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40 MiniProgramEnv/iOS";

const SYSTEM_INFO = {
    model: "iPhone 13",
    SDKVersion: "3.5.5",
    system: "iOS 16.6",
    version: "8.0.40",
    miniVersion: MINI_VERSION,
};

const wechat = new (require("./wcs.js"))({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

// ---------- token cache ----------
function loadCache() {
    try { return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8")); } catch { return {}; }
}
function saveCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2)); } catch {}
}
let CACHE = loadCache();

// ---------- 通用请求 ----------
// mallcoo 全部走 POST + JSON，业务字段与 Header 平铺同级
// m.mallcoo.cn 偶发连接超时/RST(限流)，网络层错误退避重试；业务错误码不重试
// 登录必须传 retry=0：code 一次性，重发会 40163
async function invoke(urlPath, data = {}, token = "", retry = 2) {
    const body = { ...data, Header: { Token: token || "", systemInfo: SYSTEM_INFO } };
    let lastErr;
    for (let i = 0; i <= retry; i++) {
        try {
            const r = await axios.request({
                method: "POST",
                url: DOMAIN + urlPath,
                headers: { "Content-Type": "application/json", "User-Agent": UA },
                data: body,
                timeout: 25000,
                validateStatus: () => true,
            });
            if (typeof r.data !== "object" || r.data === null) {
                throw new Error(`HTTP ${r.status} 非JSON响应`);
            }
            return r.data;
        } catch (e) {
            lastErr = e;
            if (i < retry) {
                L.info(`  ↻ ${urlPath} 网络异常(${e.message})，${3 * (i + 1)}s后重试`);
                await $.wait(3000 * (i + 1));
            }
        }
    }
    throw lastErr;
}

const isTokenInvalid = (res) => res && (res.m === 320 || res.m === 311);

// WCS 取 code (只接受 string, 瞬时故障退避重试)
async function getCode(openid) {
    for (let i = 0; i < 3; i++) {
        try {
            const { data: res } = await wechat.getCode(openid);
            const code = res?.data?.code || res?.code;
            if (typeof code === "string" && code.length > 10) return code;
            const msg = JSON.stringify(res || {}).slice(0, 160);
            if (/account not found|not found/i.test(msg)) {
                L.fail($.tag(`WCS账号不存在，跳过: ${msg}`));
                return null;
            }
            L.info($.tag(`取code异常(${msg})，重试...`));
        } catch (e) {
            L.info($.tag(`取code异常(${e.message})，重试...`));
        }
        await $.wait(2000 * (i + 1));
    }
    return null;
}

class Account {
    constructor(openid, nick) {
        this.openid = openid;
        this.nick = nick || openid;
        const c = CACHE[openid] || {};
        this.token = c.token || null;
        this.userId = c.userId || null;
        this.mobile = c.mobile || null;
        this.summary = [];
    }
    tag(s) { return `【${this.nick}】${s}`; }
    note(s) { this.summary.push(s); }

    // 业务请求：token 失效自动重登一次
    async call(urlPath, data = {}) {
        if (!this.token && !(await this.login())) throw new Error("登录失败");
        let res = await invoke(urlPath, data, this.token);
        if (isTokenInvalid(res)) {
            L.info(this.tag("token已失效，重新登录后重试"));
            if (await this.login()) res = await invoke(urlPath, data, this.token);
        }
        return res;
    }

    // 登录整体重试：code 一次性，网络失败必须重新取 code，不能复用旧 code
    async login() {
        const MAX = 3;
        for (let i = 1; i <= MAX; i++) {
            const code = await getCode(this.openid);
            if (!code) return false;
            try {
                const res = await invoke("api/passport/wx/mp/login", {
                    mallId: MALL_ID,
                    mpAppId: MINI_APP_ID,
                    mpAuthCode: String(code),
                }, "", 0);
                // m=328 该微信号未在本商场注册会员（没绑手机号），非脚本错误
                if (res.m === 328) {
                    L.warn(this.tag("该账号未注册本商场会员，请先在小程序内绑定手机号"));
                    return false;
                }
                if (res.m !== 1 || !res.d || !res.d.token) {
                    L.fail(this.tag(`登录失败: ${JSON.stringify(res).slice(0, 200)}`));
                    return false;
                }
                const d = res.d;
                // netUtil 存的就是 "token,projectType" 这种拼接形式，服务端按此解析
                this.token = `${d.token},${d.projectType}`;
                this.userId = d.userId;
                this.mobile = d.mobile;
                CACHE[this.openid] = {
                    token: this.token, userId: d.userId, mobile: d.mobile, ts: Date.now(),
                };
                saveCache(CACHE);
                const mask = d.mobile ? String(d.mobile).replace(/(\d{3})\d{4}(\d{4})/, "$1****$2") : "?";
                L.ok(this.tag(`登录成功 uid=${d.userId} 手机=${mask}`));
                return true;
            } catch (e) {
                if (i < MAX) {
                    L.info(this.tag(`登录网络异常(${e.message})，第${i}次重试...`));
                    await $.wait(5000 * i);
                } else {
                    L.fail(this.tag(`登录异常(已重试${MAX}次): ${e.message}`));
                }
            }
        }
        return false;
    }

    // 缓存 token 复用：拿一个便宜的接口探活，失效则重登
    async ensureToken() {
        if (!this.token) return this.login();
        try {
            const res = await invoke("api/user/User/GetUser", { mallId: MALL_ID }, this.token);
            if (isTokenInvalid(res)) return this.login();
            if (res.m === 1) {
                L.info(this.tag(`复用缓存token uid=${res.d?.ID || this.userId}`));
                return true;
            }
            return this.login();
        } catch { return this.login(); }
    }

    async doSign() {
        // 1) 前置：是否开启签到 / 今日是否已签
        let before;
        try {
            before = await this.call("api/user/user/CheckinBefore", {
                MallId: MALL_ID, IsCheckMemberCard: true,
            });
        } catch (e) {
            L.warn(this.tag(`签到前置检查失败: ${e.message}`));
            this.note("签到: 前置检查失败");
            return;
        }

        const bd = before.d || {};
        if (before.m === 2000 || bd.IsOpenCheckin === false) {
            L.warn(this.tag("该商场未开启签到"));
            this.note("签到: 商场未开启");
            return;
        }
        if (before.m === 2058) {
            L.warn(this.tag(`需先绑定会员卡: ${bd.MemberCardListStr || ""}`));
            this.note("签到: 需绑定会员卡");
            return;
        }
        if (before.m !== 1 && before.m !== 2054) {
            L.warn(this.tag(`签到前置异常: m=${before.m} ${before.e || ""}`));
        }
        if (bd.IsCheckIn === true) {
            L.info(this.tag("今日已签到"));
            this.note("签到: 今日已签到");
            await this.showDetail();
            return;
        }

        // 2) 签到。InMall=2 表示按定位校验，本商场 IsOpenCheckinForPosition=false 走 0
        const inMall = bd.IsOpenCheckinForPosition ? 2 : 0;
        let res;
        try {
            res = await this.call("api/user/User/CheckinV2", {
                MallID: MALL_ID, Longitude: 0, Latitude: 0, InMall: inMall,
            });
        } catch (e) {
            L.fail(this.tag(`签到请求失败: ${e.message}`));
            this.note("签到: 请求失败");
            return;
        }

        if (res.m === 1 && res.d) {
            const d = res.d;
            const msg = d.Msg || (d.RewardType === 1 ? `奖励${d.Content}积分` : "签到成功");
            L.ok(this.tag(`签到成功: ${msg}`));
            this.note(`签到: ${msg}`);
            if (d.RewardType === 3 && d.LotteryCount > 0) {
                L.ok(this.tag(`🎁 额外获得 ${d.LotteryCount} 次抽奖机会`));
            }
        } else if (/已签到|重复|already/i.test(res.e || "")) {
            L.info(this.tag(`今日已签到 (服务端: ${res.e})`));
            this.note("签到: 今日已签到");
        } else {
            L.warn(this.tag(`签到失败: m=${res.m} ${res.e || ""}`));
            this.note(`签到失败: ${res.e || "m=" + res.m}`);
        }
        await this.showDetail();
    }

    async showDetail() {
        try {
            const res = await this.call("api/user/User/GetCheckinDetail", { MallID: MALL_ID });
            if (res.m === 1 && res.d) {
                const d = res.d;
                L.info(this.tag(`连续签到 ${d.ContinueDay || 0} 天，累计签到积分 ${d.CheckinBonusSum || 0}`));
                this.note(`连签${d.ContinueDay || 0}天 累计${d.CheckinBonusSum || 0}分`);
            }
        } catch { /* 详情非关键，忽略 */ }
    }

    // 勋章任务：拉分组 -> 领取 missionStatus=4 的奖励
    async doTasks() {
        let res;
        try {
            res = await this.call("api/medal/missionGroup/getListByUserID", { mallId: MALL_ID });
        } catch (e) {
            L.warn(this.tag(`任务列表获取失败: ${e.message}`));
            return;
        }
        if (res.m !== 1) {
            L.warn(this.tag(`任务列表异常: m=${res.m} ${res.e || ""}`));
            return;
        }

        const groups = Array.isArray(res.d) ? res.d : [];
        const tasks = groups.reduce((acc, g) => acc.concat(g.missionList || []), []);
        if (!tasks.length) {
            L.info(this.tag("暂无勋章任务 (该商场未配置)"));
            this.note("任务: 无");
            return;
        }

        const STATUS = {
            1: "未开始", 2: "未完成", 3: "去完成", 4: "可领奖",
            5: "已领取", 6: "已结束", 7: "条件未满足", 8: "已完成",
        };
        let claimed = 0, failed = 0;
        const pending = [];

        for (const t of tasks) {
            const mid = t.missionID ?? t.missionId ?? t.id;
            const name = t.missionName || t.name || t.missionDesc || `任务${mid}`;
            const st = t.missionStatus;
            const prog = t.targetCount ? ` (${t.progressCount || 0}/${t.targetCount})` : "";

            if (st !== 4) {
                if (st === 2 || st === 3) pending.push(name);
                L.info(this.tag(`◆ ${name}${prog} - ${STATUS[st] || st}`));
                continue;
            }
            if (mid === undefined || mid === null) {
                L.warn(this.tag(`◆ ${name} 可领奖但缺少 missionId，跳过`));
                continue;
            }
            try {
                const r = await this.call("api/medal/mission/receivePrize", {
                    mallId: MALL_ID, missionId: mid,
                });
                if (r.m === 1 && r.d) {
                    claimed++;
                    L.ok(this.tag(`🎁 ${name} 奖励领取成功`));
                } else {
                    failed++;
                    L.warn(this.tag(`◆ ${name} 领奖失败: ${r.e || "m=" + r.m}`));
                }
            } catch (e) {
                failed++;
                L.warn(this.tag(`◆ ${name} 领奖异常: ${e.message}`));
            }
            await humanDelay();
        }

        L.ok(this.tag(`任务: 共${tasks.length}个，领奖成功${claimed}个${failed ? `，失败${failed}个` : ""}`));
        this.note(`任务${tasks.length}个 领奖${claimed}个`);
        if (pending.length) {
            L.info(this.tag(`待完成(需小程序内实际行为): ${pending.slice(0, 5).join("、")}`));
        }
    }
}

function parseNickMap() {
    const raw = process.env.NICK_MAP || "";
    if (!raw) return {};
    if (raw.trim().startsWith("{")) {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    const m = {};
    raw.split("&").forEach((pair) => {
        const [oid, nick] = pair.split(":");
        if (oid) m[oid.trim()] = (nick || "").trim() || oid.trim();
    });
    return m;
}

async function main() {
    sectionLine("天津贵和购物中心");
    const openids = (process.env[ckName] || "").split("&").map((s) => s.trim()).filter(Boolean);
    if (!openids.length) { L.fail("未配置 wx_opinion"); return; }
    const nickMap = parseNickMap();
    let success = 0;

    for (const oid of openids) {
        const acc = new Account(oid, nickMap[oid] || oid);
        try {
            L.info(acc.tag("开始"));
            if (!(await acc.ensureToken())) { L.info(acc.tag("跳过该账号")); continue; }
            await humanDelay();
            await acc.doSign();
            await humanDelay();
            await acc.doTasks();
            success++;
            L.ok(acc.tag(`完成 | ${acc.summary.join(" | ")}`));
        } catch (e) {
            L.fail(acc.tag(`执行异常: ${e.message}`));
        }
        sectionLine("");
    }
    L.ok(`成功处理 ${success}/${openids.length} 个账号`);
}

(async () => {
    try { await main(); }
    catch (e) { L.fail("运行异常: " + e.message); }
    finally {
        if (typeof sendPushNotify === "function") {
            try { await sendPushNotify($); } catch {}
        }
        $.done();
    }
})();
