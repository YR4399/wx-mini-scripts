/*
@Description:  甘源食品 签到
cron: 30 8 * * *
*/
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("甘源食品");
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
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx7a9e86cc8eba9970";
const KDT_ID = 122444839;
const CHECKIN_ID = 3081108;
const API_BASE = "https://h5.youzan.com";
const UIC_URL = "https://uic.youzan.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "gy_token_cache.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

function readCache() {
    try { return fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {} : {}; }
    catch { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); }
    catch (e) { L.error("缓存写入失败: " + e.message); }
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        const _a = String(openid || "").trim().split("#");
        this.openid = _a[0].trim();
        this.remark = (_a[1] || "").trim();
        this.token = "";
        this.sessionId = "";
        this.userId = 0;
        this.mobile = "";
        this.uuid = "gy" + Date.now() + Math.random().toString(36).slice(2, 10);
    }

    get headers() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/99/page-frame.html`,
            "xweb_xhr": "1",
            "Accept": "application/json",
        };
    }

    getCached() {
        const c = readCache();
        return c[this.openid] || null;
    }
    saveCache() {
        const c = readCache();
        c[this.openid] = { token: this.token, sessionId: this.sessionId, userId: this.userId, mobile: this.mobile, ts: Date.now() };
        writeCache(c);
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`WCS 未返回 code`);
        return code;
    }

    async login() {
        const code = await this.getLoginCode();
        const ftime = Date.now();
        const body = {
            appId: MINI_APP_ID,
            code,
            platformName: "weapp",
            signature: "windows",
            clientId: "4d65249d377b2c3ed8",
            grantType: "yz_union",
            inWsc: true,
            kdtId: String(KDT_ID),
            extraBizData: {
                enterOptions: {
                    extKdtId: KDT_ID,
                    path: "pages/home/dashboard/index",
                    query: { kdt_id: String(KDT_ID), shopAutoEnter: "1" },
                    scene: 1007,
                    referrerInfo: {},
                    apiCategory: "default",
                },
                guideBizDataMap: { from_params: "" },
                sceneData: {},
            },
        };
        const extraData = JSON.stringify({
            sid: "",
            version: "2.211.6.103",
            clientType: "weapp-miniprogram",
            client: "weapp",
            bizEnv: "",
            uuid: this.uuid,
            ftime,
        });
        const resp = await axios.post(
            `${UIC_URL}/passport/general/auth.json?kdt_id=${KDT_ID}&app_id=${MINI_APP_ID}`,
            body,
            {
                headers: {
                    ...this.headers,
                    "Content-Type": "application/json",
                    "Extra-Data": extraData,
                    "page-path": "pages/home/dashboard/index",
                },
                timeout: 15000,
                validateStatus: () => true,
            }
        );
        if (resp.data?.code !== 0 || !resp.data?.data?.sessionId) {
            throw new Error(`登录失败: ${JSON.stringify(resp.data)}`);
        }
        const d = resp.data.data;
        this.token = d.accessToken || "";
        this.sessionId = d.sessionId || "";
        this.userId = d.userId || 0;
        this.mobile = d.mobile || "";
        if (!this.token) throw new Error(`登录未返回 token`);
        this.saveCache();
        L.ok("账号[" + this.index + "] 登录成功 uid=" + this.userId + " " + this.mobile + "");
    }

    async get(path, params = {}) {
        const q = { app_id: MINI_APP_ID, kdt_id: KDT_ID, access_token: this.token, ...params };
        const extraData = JSON.stringify({
            is_weapp: 1,
            sid: this.sessionId,
            version: "2.211.6.103",
            client: "weapp",
            bizEnv: "wsc",
            uuid: this.uuid,
            ftime: Date.now(),
        });
        const hdrs = {
            ...this.headers,
            "Cookie": `KDTSESSIONID=${this.sessionId}`,
            "Extra-Data": extraData,
        };
        const resp = await axios.get(`${API_BASE}${path}`, {
            params: q,
            headers: hdrs,
            timeout: 15000,
            validateStatus: () => true,
        });
        if (resp.data?.code !== 0 && resp.data?.code !== 200) throw new Error(resp.data?.msg || JSON.stringify(resp.data));
        return resp.data.data || resp.data;
    }

    async resolveCheckinId() {
        // 动态获取签到活动ID（活动ID可能轮换），失败回落到 CHECKIN_ID
        const probes = [
            ["/wscump/checkin/show_checkin_page_v2.json", ["checkinId"]],
            ["/wscump/checkin/check-in-info.json", ["checkInId", "checkinId", "check_in_id"]],
        ];
        for (const [p, keys] of probes) {
            try {
                const d = await this.get(p, {});
                for (const k of keys) {
                    if (d && d[k]) { L.info("账号[" + this.index + "] 动态 checkinId=" + d[k] + ""); return String(d[k]); }
                }
            } catch (e) { /* 试下一个 */ }
        }
        L.warn("账号[" + this.index + "] 动态取 checkinId 失败，回落到 " + CHECKIN_ID + "");
        return CHECKIN_ID;
    }

    async run() {
        const cached = this.getCached();        if (cached?.token && cached?.sessionId) {
            this.token = cached.token;
            this.sessionId = cached.sessionId;
            this.userId = cached.userId;
            this.mobile = cached.mobile;
            L.info("账号[" + this.index + "] 使用缓存 uid=" + this.userId + "");
            try {
                await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "2.211.6.103" });
            } catch {
                L.warn("账号[" + this.index + "] 缓存失效，重新登录");
                this.token = "";
            }
        }
        if (!this.token) await this.login();
        if (!this.token) return;
        if (this.remark) _setName(this.index, this.remark);

        // 签到
        try {
            const checkinId = await this.resolveCheckinId();
            const url = `${API_BASE}/wscump/checkin/checkinV2.json?app_id=${MINI_APP_ID}&kdt_id=${KDT_ID}&access_token=${this.token}&checkinId=${checkinId}`;
            const extraData = JSON.stringify({
                is_weapp: 1,
                sid: this.sessionId,
                version: "2.211.6.103",
                client: "weapp",
                bizEnv: "wsc",
                uuid: this.uuid,
                ftime: Date.now(),
            });
            const resp2 = await axios.get(url, {
                headers: {
                    ...this.headers,
                    "Cookie": `KDTSESSIONID=${this.sessionId}`,
                    "Extra-Data": extraData,
                },
                timeout: 15000,
                validateStatus: () => true,
            });
            const result = resp2.data;
            if (result?.code === 0 || result?.data?.success) {
                const award = result?.data?.list?.[0]?.infos?.title || "+奖励";
                L.ok("账号[" + this.index + "] 签到成功: " + award + "");
                if (award) _rpGet(this.index).earned = award;
                const _ep = extractPoints(result) || {};
                if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
                if (_ep.total != null) _rpGet(this.index).total = String(_ep.total);
                const _lot = _digLottery(result);
                if (_lot) _setLottery(this.index, _lot);
                _setSign(this.index, "签到成功", award || null, _ep.total != null ? String(_ep.total) : null);
            } else if (/已达最大参与|已签到|已签|already|limit/i.test(result?.msg || "")) {
                L.info("账号[" + this.index + "] 今日已签到");
                const _ep = extractPoints(result) || {};
                if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
                if (_ep.total != null) _rpGet(this.index).total = String(_ep.total);
                _setSign(this.index, "今日已签到", null, _ep.total != null ? String(_ep.total) : null);
            } else {
                L.error("账号[" + this.index + "] 签到失败: " + (result?.msg || JSON.stringify(result)));
            }
        } catch (e) {
            L.error("账号[" + this.index + "] 签到异常: " + e.message);
        }

        // 积分
        try {
            const stats = await this.get("/wscuser/membercenter/stats.json", { currentKdtId: KDT_ID, version: "2.211.6.103" });
            const pts = stats?.stats?.points;
            L.info("账号[" + this.index + "] 当前积分: " + pts ?? "?" + "");
            if (pts != null) _rpGet(this.index).total = String(pts);
        } catch {}
    }
}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '甘源食品';
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
function _digLottery(obj) {
  if (obj == null) return "";
  const flat = (function _f(o, pre, acc) {
    acc = acc || {};
    if (Array.isArray(o)) { o.forEach((v, i) => _f(v, pre ? pre + "." + i : "" + i, acc)); return acc; }
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const nv = o[k];
        const nk = pre ? pre + "." + k : k;
        if (nv && typeof nv === "object") _f(nv, nk, acc);
        else acc[nk.toLowerCase()] = nv;
      }
      return acc;
    }
    if (pre) acc[pre] = obj;
    return acc;
  })(obj, "", {});
  const keys = Object.keys(flat);
  const hit = (re) => keys.filter(k => re.test(k));
  const lotteryKeys = hit(/lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift/);
  const out = [];
  for (const k of lotteryKeys) {
    let v = flat[k];
    if (v == null) continue;
    if (typeof v === "object") v = JSON.stringify(v);
    const s = String(v);
    if (s && s !== "{}" && s !== "[]") out.push(s);
  }
  return out.join("｜");
}
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


!(async () => {
  sectionLine("甘源食品", "");
$.userIdx = 0;
    $.checkEnv(ckName);
    for (const user of $.userList) {
        await new Task(user).run();
    }
})().catch(e => L.error("主流程异常: " + (e && e.message) + "\n" + (e && e.stack))).then(async () => {
    const _logs = $.notifyStr || [];
    if (_logs.length > 0) await sendPushNotify(origin_title, _logs.join("\n"));
  }).finally(() => $.done());
