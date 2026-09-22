const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '冰菓';
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
/*
@Description: 冰菓签到+积分任务
cron: 30 8 * * *
*/
require("https").globalAgent.options.rejectUnauthorized = false;
const { Env } = require("../tools/env.js");
const $ = new Env("冰菓签到");
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

const MINI_APP_ID = "wxb53d38f30a126806";
const API_BASE = "https://smp-api.iyouke.com/dtapi";
const TOKEN_CACHE = path.join(__dirname, "icelolly_token.json");
let ckName = "wx_opinion";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://host.docker.internal:18788",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841";

axios.defaults.proxy = false;

// ========== Task 类 ==========
class Task {
    constructor(openid, index) {
        const _a = String(openid || "").trim().split("#");
        this.openid = _a[0].trim();
        this.remark = (_a[1] || "").trim();
        this.index = index;
        this.token = null;
        this.userId = null;
        this.nickName = null;
    }

    getHeaders() {
        const h = {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "appId": MINI_APP_ID,
            "version": "2.34.4",
            "envVersion": "release",
            "xy-extra-data": `appid=${MINI_APP_ID};version=2.34.4;envVersion=release;senceId=1007`,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/8/page-frame.html`,
            "xweb_xhr": "1",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        };
        if (this.token) h["Authorization"] = "bearer" + this.token;
        return h;
    }

    // ========== Token 缓存 ==========
    loadCache() {
        try {
            if (fs.existsSync(TOKEN_CACHE)) {
                const data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
                const entry = data[this.openid];
                if (entry) {
                    this.token = entry.token;
                    this.userId = entry.userId;
                    this.nickName = entry.nickName;
                    return true;
                }
            }
        } catch (_) {}
        return false;
    }

    saveCache() {
        try {
            let data = {};
            if (fs.existsSync(TOKEN_CACHE)) {
                data = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
            }
            data[this.openid] = { token: this.token, userId: this.userId, nickName: this.nickName };
            fs.writeFileSync(TOKEN_CACHE, JSON.stringify(data), "utf8");
        } catch (_) {}
    }

    // ========== WCS 登录 ==========
    async getWxCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.data?.code || data?.code;
        if (!code) throw new Error(`WCS 获取 code 失败: ${JSON.stringify(data)}`);
        return code;
    }

    async login() {
        // 尝试缓存 token
        if (this.loadCache()) {
            $.log(`账号[${this.index}] 使用缓存 token`);
            const valid = await this.getUserInfo();
            if (valid) return true;
            $.log(`账号[${this.index}] 缓存 token 失效，重新登录`);
            this.token = null;
        }

        const code = await this.getWxCode();
        $.log(`账号[${this.index}] 获取 code 成功`);

        const resp = await axios.post(`${API_BASE}/appLogin`, {
            appType: 1,
            principal: code
        }, { headers: this.getHeaders(), timeout: 30000 });

        const d = resp.data;
        if (!d || !d.access_token) {
            throw new Error(`登录失败: ${JSON.stringify(d)}`);
        }
        this.token = d.access_token;
        this.userId = d.userId || d.ecode;
        this.nickName = d.nickName || "";
        this.saveCache();
        $.log(`账号[${this.index}] 登录成功: ${this.nickName} 积分过期: ${d.expires_in || '?'}s`);
        return true;
    }

    // ========== 用户信息 ==========
    async getUserInfo() {
        try {
            const resp = await axios.post(`${API_BASE}/p/user/userInfo`, {}, {
                headers: this.getHeaders(), timeout: 15000, validateStatus: () => true
            });
            return resp.data && resp.data.userId;
        } catch (e) {
            $.log(`账号[${this.index}] 验证token: ${e.response?.status || e.message}`);
            return false;
        }
    }

    // ========== 积分查询 ==========
    async getPoints() {
        const resp = await axios.post(`${API_BASE}/points/user/centerInfo`, {}, {
            validateStatus: () => true,
            headers: this.getHeaders(), timeout: 15000
        });
        const d = resp.data;
        if (d?.success) return d.data.pointsBalance || 0;
        return 0;
    }

    // ========== 签到 ==========
    async sign() {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
        const resp = await axios.get(`${API_BASE}/pointsSign/user/sign`, {
            headers: { ...this.getHeaders(), "Content-Type": undefined },
            params: { date: today },
            timeout: 15000,
            validateStatus: () => true
        });
        const d = resp.data;
        if (d?.success) {
            const reward = d.data?.signReward || 0;
            $.log(`账号[${this.index}] 签到成功 +${reward}积分`);
            if (reward) _rpGet(this.index).earned = "今日+" + reward + "积分";
            const _ep = extractPoints(d) || {};
            if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
            if (_ep.total != null) _rpGet(this.index).total = String(_ep.total);
            const _lot = _digLottery(d);
            if (_lot) _setLottery(this.index, _lot);
            _setSign(this.index, "签到成功", reward ? "今日+" + reward + "积分" : null, _ep.total != null ? String(_ep.total) : null);
            return reward;
        }
        const msg = d?.error || d?.message || JSON.stringify(d);
        if (msg && (msg.toString().includes("已签") || msg.toString().includes("signed"))) {
            $.log(`账号[${this.index}] 今日已签到`);
            const _ep = extractPoints(d) || {};
            if (_ep.streak != null) _rpGet(this.index).streak = String(_ep.streak);
            if (_ep.total != null) _rpGet(this.index).total = String(_ep.total);
            _setSign(this.index, "今日已签到", null, _ep.total != null ? String(_ep.total) : null);
            return 0;
        }
        $.log(`账号[${this.index}] 签到失败(${resp.status}): ${msg}`);
        return 0;
    }

    // ========== 任务列表 ==========
    async getTaskList() {
        const resp = await axios.post(`${API_BASE}/points/task/list`, {}, {
            headers: this.getHeaders(), timeout: 15000
        });
        if (resp.data?.success) return resp.data.data || [];
        return [];
    }





    // ========== 主流程 ==========
    async run() {
        $.log(`\n========== 冰菓 账号[${this.index}] ${this.openid.slice(0, 8)}*** ==========`);
        if (this.remark) _setName(this.index, this.remark);
        else if (this.nickName) _setName(this.index, this.nickName);

        await this.login();
        const pointsBefore = await this.getPoints();
        $.log(`账号[${this.index}] 当前积分: ${pointsBefore}`);

        // 签到
        const signReward = await this.sign();

        // 查询任务
        let tasks = []; try { tasks = await this.getTaskList(); } catch (e) { $.log(`账号[${this.index}] 获取任务列表失败: ${e.response?.status || e.message}`); }
        if (tasks.length > 0) {
            $.log(`账号[${this.index}] 发现 ${tasks.length} 个任务`);
        }

        const pointsAfter = await this.getPoints();
        $.log(`账号[${this.index}] 签到后积分: ${pointsAfter}`);
        if (pointsAfter != null) {
            _rpGet(this.index).total = String(pointsAfter);
            if (typeof logPoints === 'function') logPoints(null, pointsAfter, '冰菓', this.index, '签到成功');
        }
        $.log(`账号[${this.index}] 任务完成`);
    }
}

// ========== 主入口 ==========
!(async () => {
$.userIdx = 0;
    $.checkEnv(ckName);
    const accounts = $.userList;
    $.log(`共找到${accounts.length}个账号`);

    for (let i = 0; i < accounts.length; i++) {
        try { await new Task(accounts[i], i + 1).run(); } catch (e) { $.log(`账号[${i+1}] 异常: ${e.response?.status || e.message || e}`); }
        if (i < accounts.length - 1) await $.wait(3000 + Math.random() * 5000);
    }
})().catch((e) => $.log(e.message || e))
    .finally(async () => {
        try {
            const _logs = $.notifyStr || [];
            if (_logs.length > 0) await sendPushNotify("冰菓签到", _logs.join("\n"));
        } catch (_) {}
        $.done && $.done();
    });
