/*
@Description: 问问农会员 签到 + 做任务 (quncrm SCRM)
cron: 30 8 * * *

逆向来源: wxapkg wxc5d513880ace81a4 (v22) app-service.js / member app-service.js
  平台: quncrm SCRM (consumer-api.quncrm.com / oauth.quncrm.com)
  登录: POST {oauthApiBaseUrl}/{accountId}/v2/weapp/oauth
        body = { scope:"base", code:<WCS jscode>, watermark:{appid}, is_group:"false" }
        resp.accessToken -> 后续请求头 X-Access-Token
  accountId(品牌): 634f5f28a0e71c29500b0313 -> 请求头 X-Account-Id
  签到: GET  /modules/campaigncenter/signin/stats   (看 hasSignedInToday/consecutiveDays)
        POST /modules/campaigncenter/signin          (body {templateIds:[]})
  任务: GET  /v2/memberTasks                         (分页: page 参数, 每页20, 无 listCondition 支持)
        POST /v2/member/tasks/perfection             (完善资料, body {taskCode})
        POST /v2/member/tasks/getRewardTimes         (领奖次数查询, body {taskCodes})
  说明: 该平台会员任务奖励由后端在"用户真实行为达成"后自动发放,
        无人工领取接口(getRewardTimes 仅查询可用次数)。
        本脚本对"完善资料"(scoreCampaignInformation)类型尝试 perfection,
        仅当账号资料已填妥才会实际发放积分/成长; 其余行为类任务(invitation/scoreTask/task)
        需在小程序内由用户完成。脚本以"枚举+尝试+报告"方式实现"做任务"。
  公共请求头: X-Account-Id / X-Access-Token / X-Requested-With: XMLHttpRequest
  公共参数: clientTime(ms) / envVersion:"release"
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("问问农会员");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wxc5d513880ace81a4";
const ACCOUNT_ID = "634f5f28a0e71c29500b0313";
const OAUTH_BASE = `https://oauth.quncrm.com/${ACCOUNT_ID}`;
const CONSUMER_BASE = process.env.wenwennong_api || "https://consumer-api.quncrm.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "wenwennong_token_cache.json");
let ckName = "wx_opinion";

const wechat = new (require("./wcs.js"))({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

// ---------- token cache ----------
function loadCache() {
    try { return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf-8")); } catch { return {}; }
}
function saveCache(c) { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2)); }
let CACHE = loadCache();

// ---------- request helper (带 401 自动重登) ----------
async function api(method, urlPath, { params, data, token, ignoreErr } = {}) {
    const headers = {
        "X-Account-Id": ACCOUNT_ID,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json",
    };
    if (token) headers["X-Access-Token"] = token;
    const cfg = {
        method,
        url: CONSUMER_BASE + urlPath,
        headers,
        timeout: 30000,
        withCredentials: true,
    };
    cfg.params = { clientTime: Date.now(), envVersion: "release", ...(params || {}) };
    if (method.toUpperCase() === "POST") cfg.data = data || {};
    try {
        const r = await axios.request(cfg);
        return r.data;
    } catch (e) {
        if (ignoreErr) return null;
        throw e;
    }
}

// WCS 取 code (只接受 string, 瞬时故障退避重试)
async function getCode(openid) {
    for (let i = 0; i < 3; i++) {
        try {
            const { data: res } = await wechat.getCode(openid);
            const code = res?.data?.code || res?.code;
            if (typeof code === "string" && code.length > 10) return code;
            const msg = JSON.stringify(res || {}).slice(0, 160);
            if (/account not found|not found/i.test(msg)) {
                L.warn(`WCS账号不存在，跳过: ${msg}`);
                return null;
            }
            L.info(`取code异常(${msg})，重试...`);
        } catch (e) {
            L.info(`取code异常(${e.message})，重试...`);
        }
        await $.wait(2000 * (i + 1));
    }
    return null;
}

function parseToken(res) {
    const body = res || {};
    const accessToken = body.accessToken || body?.data?.accessToken || body?.data?.data?.accessToken;
    const member = body.member || body?.data?.member || null;
    return { accessToken, member };
}

// 判断 axios 错误是否为网络瞬时错误(无 HTTP 状态码: 超时/连接重置/DNS 等)
function _isNetErr(e) {
    if (!e) return false;
    const c = e.code || "";
    if (["ECONNABORTED","ETIMEDOUT","ECONNRESET","ENOTFOUND","EAI_AGAIN","ECONNREFUSED"].includes(c)) return true;
    const m = (e.message || "").toLowerCase();
    return /timeout|network|connection|socket hang|econn/.test(m);
}

class Account {
    constructor(openid, nick) {
        this.openid = openid;
        this.nick = nick || openid;
        this.token = (CACHE[openid] && CACHE[openid].accessToken) || null;
        this.member = (CACHE[openid] && CACHE[openid].member) || null;
    }
    tag(s) { return `【${this.nick}】${s}`; }

    // 封装请求: 遇 401/403 自动重登; 遇网络瞬时错误(超时/重置)自动重试
    async call(method, urlPath, opts = {}, _ad = 0, _nd = 0) {
        if (!this.token) await this.login();
        try {
            return await api(method, urlPath, { ...opts, token: this.token });
        } catch (e) {
            const st = e.response?.status;
            const isAuth = (st === 401 || st === 403 || e.response?.data?.code === 40001);
            const isNet = (!st && _isNetErr(e));
            if (isAuth && _ad < 2) {
                L.info(this.tag("token失效, 重新登录后重试"));
                if (await this.login()) return this.call(method, urlPath, opts, _ad + 1, _nd);
                throw e;
            }
            if (isNet && _nd < 2) {
                L.info(this.tag(`网络瞬时错误(${e.message}), 重试 ${_nd + 1}/2`));
                await $.wait(2000 * (_nd + 1));
                return this.call(method, urlPath, opts, _ad, _nd + 1);
            }
            throw e;
        }
    }

    async login() {
        const code = await getCode(this.openid);
        if (!code) return false;
        const body = {
            scope: "base",
            code: String(code),
            watermark: { appid: MINI_APP_ID },
            is_group: "false",
        };
        try {
            let res = null;
        for (let _la = 0; _la < 3; _la++) {
            try {
                res = await axios.request({
                    method: "POST",
                    url: OAUTH_BASE + "/v2/weapp/oauth",
                    headers: {
                        "X-Account-Id": ACCOUNT_ID,
                        "X-Requested-With": "XMLHttpRequest",
                        "Content-Type": "application/json",
                    },
                    data: body,
                    timeout: 45000,
                });
                break;
            } catch (e) {
                const _code = e.code || "";
                const _net = ["ECONNABORTED","ETIMEDOUT","ECONNRESET","ENOTFOUND","EAI_AGAIN"].includes(_code) || /timeout|network|connection/i.test(e.message || "");
                if (_net && _la < 2) {
                    L.info(this.tag(`登录请求瞬时错误(${e.message}), 重试 ${_la + 1}/2`));
                    await $.wait(2000 * (_la + 1));
                    continue;
                }
                throw e;
            }
        }
        const { accessToken, member } = parseToken(res.data);
            if (!accessToken) {
                L.error(this.tag(`登录失败: ${JSON.stringify(res.data).slice(0, 160)}`));
                return false;
            }
            this.token = accessToken;
            this.member = member;
            CACHE[this.openid] = { accessToken, member, ts: Date.now() };
            saveCache(CACHE);
            L.ok(this.tag(`登录成功 openId=${member?.openId || "?"}`));
            return true;
        } catch (e) {
            const d = e.response?.data;
            L.error(this.tag(`登录异常: ${e.message} ${d ? JSON.stringify(d).slice(0, 160) : ""}`));
            return false;
        }
    }

    async ensureToken() {
        if (this.token) {
            try {
                const st = await api("GET", "/modules/campaigncenter/signin/stats", { token: this.token, ignoreErr: true });
                if (st && (st.code === 401 || st.code === 403 || st.code === 40001)) {
                    return this.login();
                }
                return true;
            } catch { return this.login(); }
        }
        return this.login();
    }

    // 签到
    async doSign() {
        let stats;
        try {
            stats = await this.call("GET", "/modules/campaigncenter/signin/stats");
        } catch (e) {
            L.warn(this.tag(`查签到状态失败: ${e.message}`));
            return { signed: false, consecutiveDays: null };
        }
        const d = stats?.data || stats || {};
        const cd = d.consecutiveDays || d.consecutiveDaysInPeriod || null;
        L.info(this.tag(`签到状态: ${JSON.stringify(d).slice(0, 220)}`));
        const signed = d.hasSignedInToday || d.isSignInToday || d.signed || d.isSigned;
        if (signed) {
            L.ok(this.tag(`今日已签到 (连续${d.consecutiveDays || d.consecutiveDaysInPeriod || "?"}天)`));
            return { signed: true, skipped: true, consecutiveDays: cd };
        }
        try {
            const res = await this.call("POST", "/modules/campaigncenter/signin", { data: { templateIds: [] } });
            L.info(this.tag(`签到返回: ${JSON.stringify(res?.data || res).slice(0, 200)}`));
            L.ok(this.tag("签到成功 ✓"));
            return { signed: true, consecutiveDays: cd };
        } catch (e) {
            const st = e.response?.status;
            const msg = JSON.stringify(e.response?.data || "");
            if (st === 400 && /已签到|signed|重复|today/i.test(msg)) {
                L.ok(this.tag("今日已签到 (服务端确认)"));
                return { signed: true, consecutiveDays: cd };
            }
            L.warn(this.tag(`签到失败: ${st} ${msg.slice(0, 160)}`));
            return { signed: false, consecutiveDays: cd };
        }
    }

    // 任务: 枚举全部 + 尝试完善资料 + 报告奖励可用次数
    async doTasks() {
        // 1) 分页拉取全部任务 (listCondition 不被 grpc-gateway 支持, 用 page 翻页, 按 code 去重)
        const seen = new Map();
        let page = 1;
        while (page <= 12) {
            let list;
            try {
                list = await this.call("GET", "/v2/memberTasks", { params: { page } });
            } catch (e) {
                L.warn(this.tag(`任务列表第${page}页失败: ${e.response?.status || e.message}`));
                break;
            }
            const items = list?.items || list?.data?.items || [];
            if (!Array.isArray(items) || items.length === 0) break;
            const before = seen.size;
            for (const t of items) if (t && t.code && !seen.has(t.code)) seen.set(t.code, t);
            // 该接口每页固定返回相同 20 条(服务端 total 统计有偏差), 新页无新增即视为末页
            if (items.length < 20 || seen.size === before) break;
            page++;
        }
        const tasks = [...seen.values()];
        if (!tasks.length) { L.warn(this.tag("未获取到任务列表")); return { total: 0, perfTried: 0, perfOk: 0, claimed: 0, claimable: 0 }; }

        const byType = {};
        for (const t of tasks) { const ty = t.type || "?"; byType[ty] = (byType[ty] || 0) + 1; }
        L.info(this.tag(`任务总数(去重): ${tasks.length}  分类: ${JSON.stringify(byType)}`));

        // 2) 领取奖励次数查询 (只读, 无人工领取接口)
        let rewardMap = {};
        try {
            const codes = tasks.map(t => t.code).filter(Boolean);
            const rw = await this.call("POST", "/v2/member/tasks/getRewardTimes", { data: { taskCodes: codes } });
            const arr = rw?.rewardTimes || rw?.data?.rewardTimes || [];
            for (const x of arr) if (x && x.taskCode) rewardMap[x.taskCode] = x;
        } catch (e) {
            L.info(this.tag(`奖励次数查询失败(忽略): ${e.response?.status || e.message}`));
        }

        // 3) 对 scoreCampaignInformation (完善资料/完善种植资料) 尝试 perfection
        let perfTried = 0, perfOk = 0;
        for (const t of tasks) {
            if (t.type !== "scoreCampaignInformation") continue;
            perfTried++;
            const score = t.reward?.score?.value || t.reward?.amountScore?.value || 0;
            const growth = t.reward?.growth?.value || t.reward?.amountGrowth?.value || 0;
            let note = `待完善资料`;
            try {
                const r = await this.call("POST", "/v2/member/tasks/perfection", { data: { taskCode: t.code } });
                if (r && (r.score > 0 || r.growth > 0 || r.rewarded)) {
                    perfOk++;
                    note = `已发放 积分+${r.score || score} 成长+${r.growth || growth}`;
                } else if (r && r.rewarded === false) {
                    note = `未发放(资料未填妥, 需在小程序完善)`;
                }
            } catch (e) {
                note = `尝试失败(${e.response?.status || e.message})`;
            }
            L.info(this.tag(`◆ ${t.name} [${t.code}] 奖励 ${score}分/${growth}成长 -> ${note}`));
        }

        // 4) 报告: 已领 / 可领
        let claimed = 0, claimable = 0;
        for (const t of tasks) {
            const rw = rewardMap[t.code];
            if (!rw) continue;
            if ((rw.receivedRewardCount || 0) > 0) claimed++;
            else if (rw.hasLeftTaskRewards) claimable++;
        }
        L.ok(this.tag(`任务报告: 共${tasks.length}个 | 完善资料尝试${perfTried}次(实际发放${perfOk}次) | 已领奖励${claimed}个 | 可领奖励${claimable}个(需用户行为达成后自动发放)`));
        return { total: tasks.length, perfTried, perfOk, claimed, claimable };
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


const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = "问问农会员";
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", streak: "", tasks: [], lottery: "", taskEarned: "" };
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
function _setStreak(idx, n) { if (n != null && n !== "") _rpGet(idx).streak = String(n); }
function _setTaskEarned(idx, text) { if (text != null && text !== "") _rpGet(idx).taskEarned = String(text); }
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


async function main() {
    sectionLine("问问农会员");
    const openids = (process.env[ckName] || "").split("&").map((s) => s.trim()).filter(Boolean);
    if (!openids.length) { L.fail("未配置 wx_opinion"); return; }
    const nickMap = parseNickMap();
    let success = 0;
    for (let i = 0; i < openids.length; i++) {
        const oid = openids[i];
        const idx = i + 1;
        const acc = new Account(oid, nickMap[oid] || oid);
        _setName(idx, acc.nick);
        try {
            L.info(acc.tag("开始"));
            if (!(await acc.ensureToken())) { L.warn(acc.tag("登录失败, 跳过")); _setSign(idx, "登录失败"); continue; }
            await humanDelay();
            const sg = await acc.doSign();
            _setSign(idx, sg.signed ? (sg.skipped ? "今日已签到" : "签到成功") : "签到失败");
            if (sg.consecutiveDays != null && sg.consecutiveDays !== "") _setStreak(idx, sg.consecutiveDays);
            await humanDelay();
            const tk = await acc.doTasks();
            if (tk && tk.total) _setTaskEarned(idx, `任务${tk.total}个(完善${tk.perfOk}/${tk.perfTried}发放, 已领${tk.claimed}/可领${tk.claimable})`);
            success++;
            L.ok(acc.tag("完成"));
        } catch (e) {
            L.error(acc.tag(`执行异常: ${e.message}`));
            if (!_rpGet(idx).sign) _setSign(idx, "执行异常");
        }
        sectionLine("");
    }
    L.ok(`成功处理 ${success}/${openids.length} 个账号`);
}

(async () => {
    try { await main(); }
    catch (e) { L.fail("运行异常: " + e.message); }
    finally {
        await flushLogPoints(_rpApp);
        $.done();
    }
})();
