/*
@Description: 鸿星尔克 每日签到 + 任务列表查询 + 任务奖励领取
cron: 30 8 * * *
环境变量:
  - wx_opinion: WeChat openId，多账号用 & 分隔（仅用于显示账号名）
    示例: oLvh-0ydiGAnlYBAVXbouPVAxXN4&oLvh-06JSe-78wETfzEs0o0cPAJU
  - wx_server_url: WCS 地址（可选，当前登录不依赖 WCS）
  - wx_auth: WCS 密钥（可选）

  ⚠️ 重要：unionId 是微信开放平台的统一标识
    - 同一开放平台下所有微信号的 unionId 相同 → erke 服务器上为同一个会员
    - 不同开放平台的微信号 unionId 不同 → 可独立签到不同会员

  多会员配置方式（选其一）：
  方式A: ERKE_UNIONID 指定单个 unionid（所有账号共享）
    示例: ERKE_UNIONID=o36lGwNFK47WEM5XV0dxrWmaqvh0

  方式B: ERKE_CONFIG 为每个账号指定独立 unionid（推荐多会员）
    格式: unionid&openid&openid&openid&...
    示例: o36lGwNFK47WEM5XV0dxrWmaqvh0&owNAX6j8Yq8L9MxVq8K5xKq8K5xK&o36lGwNFK47WEM5XV0dxrWmaqvh0
          ↑第一列是unionid，后续是各账号的wx_opinion

登录原理:
  1. erke 服务器用 unionid 做用户匹配
  2. 用 unionid 作为 openid 参数调用 POST /on_login.json 即可登录
  3. 所有业务 API 用返回的 memberId 签名调用
*/

// 禁用系统代理
["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"].forEach(k => delete process.env[k]);

const $ = {
    log: (...args) => console.log(...args),
    done: () => process.exit(0)
};

// ===== 核心参数 =====
const APP_ID = "wxa1f1fa3785a47c7d";
const SECRET = "damogic8888";
const BASE_URL = "https://hope.demogic.com/gic-wx-app";
const VERSION = "3.9.78";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541a35) XWEB/19977";

// ===== 签名算法 (SunnyNet 抓包还原) =====
function calcSign(memberId, timestamp) {
    const random = Math.floor(Math.random() * 10000000);
    const transId = APP_ID + timestamp;
    const signStr = `timestamp=${timestamp}transId=${transId}secret=${SECRET}random=${random}memberId=${memberId}`;
    const crypto = require("crypto");
    const sign = crypto.createHash("md5").update(signStr).digest("hex");
    return { sign, transId, random, timestamp };
}

function nowBeijing() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ===== 请求构建 =====
function buildHeaders(enterpriseId) {
    return {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "sign": enterpriseId,
        "channelEntrance": "wx_app",
        "Referer": `https://servicewechat.com/${APP_ID}/90/page-frame.html`,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "xweb_xhr": "1",
    };
}

function buildBody(memberId, enterpriseId, unionid, openid, wxOpenid, signData) {
    const params = new URLSearchParams({
        memberId,
        cliqueId: "-1",
        cliqueMemberId: "-1",
        useClique: "0",
        enterpriseId,
        unionid,
        openid,
        wxOpenid,
        random: String(signData.random),
        appid: APP_ID,
        transId: signData.transId,
        sign: signData.sign,
        timestamp: signData.timestamp,
        gicWxaVersion: VERSION,
    });
    return params.toString();
}

// ===== HTTP 工具 (原生 fetch) =====
async function httpPost(url, body, headers, isJson = false) {
    const opts = {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15000),
    };
    const res = await fetch(url, opts);
    return await res.json();
}

async function httpGet(url, paramsObj, headers) {
    const urlObj = new URL(url);
    for (const [k, v] of Object.entries(paramsObj || {})) {
        urlObj.searchParams.set(k, v);
    }
    const opts = {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000),
    };
    const res = await fetch(urlObj.toString(), opts);
    return await res.json();
}

// ===== 缓存 =====
const fs = require("fs");
const path = require("path");
const CACHE_DIR = path.join(__dirname, ".cache");
function getCachePath(unionid) {
    const safe = unionid.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(CACHE_DIR, `erke_${safe}_member.json`);
}
function saveMember(unionid, memberId) {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const fp = getCachePath(unionid);
    fs.writeFileSync(fp, JSON.stringify({ unionid, memberId, time: Date.now() }, null, 2));
}
function loadMember(unionid) {
    const fp = getCachePath(unionid);
    if (fs.existsSync(fp)) {
        try { return JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { return null; }
    }
    return null;
}

// ===== 核心类 =====
class ErkeSign {
    constructor(unionid, enterpriseId, idx, displayName, openid, memberId) {
        this.unionid = unionid;
        // openid 参数：优先用传入的 wx_opinion，否则用 unionid
        // erke 服务器用 openid 做用户匹配，但 unionid 是跨平台唯一标识
        this.openid = openid || unionid;
        this.wxOpenid = "";
        this.enterpriseId = enterpriseId;
        this.idx = idx;
        this.displayName = displayName || "";
        this.memberId = memberId || null;
    }

    log(msg) {
        $.log(`[会员${this.idx}] [${this.displayName}] ${msg}`);
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // 通过 on_login.json 获取 memberId
    async login() {
        const ts = nowBeijing();
        const r = Math.floor(Math.random() * 10000000);
        const tid = APP_ID + ts;
        const signStr = `timestamp=${ts}transId=${tid}secret=${SECRET}random=${r}memberId=`;
        const crypto = require("crypto");
        const sign = crypto.createHash("md5").update(signStr).digest("hex");

        const body = new URLSearchParams({
            spickLogin: "true",
            openid: this.openid,      // openid 做用户匹配
            scene: "1037",
            memberId: "",             // 空表示新用户/首次登录
            cliqueId: "-1",
            cliqueMemberId: "-1",
            useClique: "0",
            enterpriseId: this.enterpriseId,
            unionid: this.unionid,    // unionid 做跨平台用户匹配
            wxOpenid: this.wxOpenid,
            random: String(r),
            appid: APP_ID,
            transId: tid,
            sign,
            timestamp: ts,
            gicWxaVersion: VERSION,
        }).toString();

        try {
            const res = await httpPost(`${BASE_URL}/on_login.json`, body, buildHeaders(this.enterpriseId));
            const mi = res?.response?.memberInfo || {};
            const mid = mi?.memberId;
            if (mid) {
                this.memberId = mid;
                saveMember(this.unionid, mid);
                this.log(`✅ 登录成功: ${mi.memberName || "?"} | memberId=${mid}`);
                return true;
            }
            this.log(`❌ 登录失败: ${res?.errmsg || JSON.stringify(res)}`);
            return false;
        } catch (e) {
            this.log(`❌ 登录异常: ${e.message}`);
            return false;
        }
    }

    // 用缓存的 memberId 调用所有 API
    getSignData() {
        if (!this.memberId) {
            throw new Error("未登录，memberId 为空");
        }
        return calcSign(this.memberId, nowBeijing());
    }

    // 签到
    async signIn() {
        const ts = nowBeijing();
        const sd = calcSign(this.memberId, ts);
        const body = new URLSearchParams({
            memberId: this.memberId,
            cliqueId: "-1",
            enterpriseId: this.enterpriseId,
            unionid: this.unionid,
            openid: this.openid,
            wxOpenid: this.wxOpenid,
            random: String(sd.random),
            appid: APP_ID,
            transId: sd.transId,
            sign: sd.sign,
            timestamp: sd.timestamp,
            gicWxaVersion: VERSION,
        }).toString();

        try {
            const res = await httpPost(`${BASE_URL}/member_sign.json`, body, buildHeaders(this.enterpriseId));
            const code = res?.code || res?.response?.errcode;
            const msg = res?.message || res?.response?.errmsg || "";
            if (code === 0 || code === "0000" || code === "1001") {
                this.log(`✅ 签到: ${msg}`);
                return true;
            } else {
                this.log(`ℹ️ 签到: ${msg} (code=${code})`);
                return code === 900001; // 已签到也算成功
            }
        } catch (e) {
            this.log(`❌ 签到异常: ${e.message}`);
            return false;
        }
    }

    // 查询积分 / 签到状态
    async getMemberAsset() {
        const sd = this.getSignData();

        try {
            const res = await httpGet(`${BASE_URL}/get-member-asset.json`, {
                memberId: this.memberId,
                enterpriseId: this.enterpriseId,
                unionid: this.unionid,
                openid: this.openid,
                wxOpenid: this.wxOpenid,
                random: sd.random,
                appid: APP_ID,
                transId: sd.transId,
                sign: sd.sign,
                timestamp: sd.timestamp,
                gicWxaVersion: VERSION,
                cliqueId: "-1",
                cliqueMemberId: "-1",
                useClique: "0",
                dataIconKeyList: "D007,D015,D006,D021,D022",
            }, {
                "User-Agent": UA,
                "sign": this.enterpriseId,
                "channelEntrance": "wx_app",
                "Referer": `https://servicewechat.com/${APP_ID}/90/page-frame.html`,
            });

            const result = res?.result;
            if (result) {
                this.log(`💰 可用积分: ${result.D007 || 0}`);
                if (result.D021 !== undefined) {
                    this.log(result.D021 === 1
                        ? `✅ 今日已签到 (连签 ${result.D022 || 0} 天)`
                        : `⚠️ 今日尚未签到`);
                }
                return result;
            }
            this.log(`❌ 查询积分失败: ${JSON.stringify(res)}`);
            return null;
        } catch (e) {
            this.log(`❌ 查询积分异常: ${e.message}`);
            return null;
        }
    }

    // 查询会员卡片信息
    async getMemberCardInfo() {
        const sd = this.getSignData();
        const body = buildBody(this.memberId, this.enterpriseId, this.unionid, this.openid, this.wxOpenid, sd);

        try {
            const res = await httpPost(`${BASE_URL}/get_member_card_info.json`, body, buildHeaders(this.enterpriseId));
            const member = res?.response?.member;
            if (member) {
                this.log(`👤 会员: ${member.memberName || "未设置"} | 等级: ${member.gradeName || "?"} | 积分: ${member.accumulatPoints || 0}`);
                return member;
            }
            this.log(`❌ 获取会员信息失败: ${JSON.stringify(res)}`);
            return null;
        } catch (e) {
            this.log(`❌ 获取会员信息异常: ${e.message}`);
            return null;
        }
    }

    // 查询任务列表
    async getMissionList() {
        const sd = this.getSignData();
        const body = buildBody(this.memberId, this.enterpriseId, this.unionid, this.openid, this.wxOpenid, sd);

        try {
            const res = await httpPost(`${BASE_URL}/member_mission.json`, body, buildHeaders(this.enterpriseId));
            const missions = res?.response?.missionList || [];
            if (missions.length === 0) {
                this.log(`⚠️ 未获取到任务列表`);
                return [];
            }
            this.log(`📋 任务列表 (${missions.length} 个):`);
            for (const m of missions) {
                const statusText = m.status === 0 ? "[未完成]" : m.status === 1 ? "[已完成]" : m.status === 2 ? "[已参与]" : `[${m.status}]`;
                this.log(`  ${statusText} ${m.missionName} → ${m.rewardShowBack} | code=${m.missionCode}`);
            }
            return missions;
        } catch (e) {
            this.log(`❌ 获取任务列表异常: ${e.message}`);
            return [];
        }
    }

    // 领取任务奖励
    async claimReward(mission) {
        if (mission.status !== 1) return;

        const ts = nowBeijing();
        const sd = calcSign(this.memberId, ts);
        const body = new URLSearchParams({
            memberId: this.memberId,
            enterpriseId: this.enterpriseId,
            unionid: this.unionid,
            openid: this.openid,
            wxOpenid: this.wxOpenid,
            missionCode: mission.missionCode,
            missionMemberLogId: mission.missionMemberLogId || "",
            random: sd.random,
            appid: APP_ID,
            transId: sd.transId,
            sign: sd.sign,
            timestamp: sd.timestamp,
            gicWxaVersion: VERSION,
            cliqueId: "-1",
            cliqueMemberId: "-1",
            useClique: "0",
        }).toString();

        try {
            const res = await httpPost(`${BASE_URL}/mission_receive.json`, body, buildHeaders(this.enterpriseId));
            const code = res?.code || res?.response?.errcode;
            const msg = res?.message || res?.response?.errmsg || "";
            if (code === "0000" || code === 0) {
                this.log(`🎁 领取: ${mission.missionName} → ${msg}`);
                return true;
            } else {
                this.log(`⚠️ 领取: ${msg} (code=${code})`);
                return false;
            }
        } catch (e) {
            this.log(`⚠️ 领取异常: ${e.message}`);
            return false;
        }
    }

    async run() {
        $.log(`\n${"=".repeat(50)}`);
        $.log(`[账号${this.idx}] 鸿星尔克 - ${this.displayName || this.unionid.slice(0, 8)}`);
        $.log(`${"=".repeat(50)}`);

        // 尝试从缓存加载 memberId
        if (!this.memberId) {
            const cached = loadMember(this.unionid);
            if (cached && cached.memberId) {
                this.memberId = cached.memberId;
                this.log(`📦 从缓存加载 memberId`);
            }
        }

        // 1. 登录（获取或验证 memberId）
        if (!this.memberId) {
            const loginOk = await this.login();
            if (!loginOk) {
                this.log(`❌ 登录失败，跳过此账号`);
                return false;
            }
        }

        // 2. 签到
        await this.signIn();
        await this.sleep(2000);

        // 3. 查询积分和签到状态
        await this.getMemberAsset();
        await this.sleep(1500);

        // 4. 查询会员信息
        await this.getMemberCardInfo();
        await this.sleep(1500);

        // 5. 查询任务列表
        const missions = await this.getMissionList();
        await this.sleep(1000);

        // 6. 尝试领取已完成任务的奖励
        for (const m of missions) {
            if (m.status === 1) {
                this.log(`  🏆 尝试领取: ${m.missionName}`);
                await this.claimReward(m);
                await this.sleep(1000);
            }
        }

        return true;
    }
}

// ===== 主流程 =====
async function main() {
    $.log("🔔 鸿星尔克签到,开始");

    const ENTERPRISE_ID = "ff8080817d9fbda8017dc20674f47fb6";
    const DEFAULT_UNIONID = "o36lGwNFK47WEM5XV0dxrWmaqvh0";

    // 解析账号列表
    // 优先级: ERKE_CONFIG (多unionid) > wx_opinion + ERKE_UNIONID (单unionid)
    const erkeConfig = process.env.ERKE_CONFIG;
    const wxOpinions = (process.env.wx_opinion || "").split("&").filter(Boolean);
    const erkeUnionid = process.env.ERKE_UNIONID;

    let accounts = [];

    if (erkeConfig) {
        // ERKE_CONFIG: unionid&openid1&openid2&...
        const parts = erkeConfig.split("&").filter(Boolean);
        if (parts.length >= 2) {
            const unionid = parts[0];
            for (const [i, openid] of parts.slice(1).entries()) {
                accounts.push({ unionid, openid, displayName: openid.slice(0, 8) });
            }
        }
    }

    if (accounts.length === 0) {
        // 使用 wx_opinion 列表
        const unionid = erkeUnionid || DEFAULT_UNIONID;
        if (wxOpinions.length > 0) {
            for (const openid of wxOpinions) {
                accounts.push({ unionid, openid, displayName: openid.slice(0, 8) });
            }
        } else {
            // 没有配置任何账号，使用默认 unionid
            accounts.push({ unionid, openid: unionid, displayName: unionid.slice(0, 8) });
        }
    }

    $.log(`📋 检测到 ${accounts.length} 个账号`);

    // 按 unionid 去重 — 同一 unionid 在 erke 服务器上就是同一个会员
    const uniqueMap = new Map();
    for (const acc of accounts) {
        if (!uniqueMap.has(acc.unionid)) {
            uniqueMap.set(acc.unionid, []);
        }
        uniqueMap.get(acc.unionid).push(acc);
    }

    const dedupedAccounts = [];
    for (const [unionid, accs] of uniqueMap) {
        if (accs.length > 1) {
            const names = accs.map(a => a.displayName).join(", ");
            $.log(`⚠️ 以下账号共享同一 unionid (${unionid.slice(0, 8)}...)，仅签到一次: ${names}`);
        }
        dedupedAccounts.push(accs[0]);
    }

    $.log(`🔑 去重后实际签到: ${dedupedAccounts.length} 个 unionid`);
    for (const [i, acc] of dedupedAccounts.entries()) {
        $.log(`  会员${i + 1}: unionid=${acc.unionid.slice(0, 8)}... (来自 ${acc.displayName})`);
    }

    let success = 0, fail = 0;
    for (const [i, acc] of dedupedAccounts.entries()) {
        const signer = new ErkeSign(
            acc.unionid,
            ENTERPRISE_ID,
            i + 1,
            acc.displayName,
            acc.openid  // 用 wx_opinion 作为 openid（erke 服务器可能用它辅助匹配）
        );
        try {
            const ok = await signer.run();
            if (ok) success++; else fail++;
        } catch (e) {
            $.log(`[会员${i + 1}] ❌ 异常: ${e.message}`);
            fail++;
        }
        if (i < dedupedAccounts.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    $.log(`\n📊 统计: ${dedupedAccounts.length} 个会员 | 成功 ${success} | 失败 ${fail}`);
    $.log("🔔 鸿星尔克签到,结束");
    $.done();
}

main().catch(e => { $.log("❌ 主流程异常:", e.message); $.done(); });
