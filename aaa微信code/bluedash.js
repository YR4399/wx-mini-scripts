process.env.http_proxy = "";
process.env.https_proxy = "";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.all_proxy = "";
process.env.ALL_PROXY = "";
/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: BLUE DASH 布鲁大师小程序签到
cron: 30 8 * * *
------------------------------------------
变量名：bluedash
变量值：wx_server 里的 openid/账号标识，多账号用 & 或换行
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("BLUE DASH 布鲁大师签到");
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

const MINI_APP_ID = "wx73555499305578f8";
const API_BASE = "https://wxsc.blue-dash.com/prod-api";
const LOGIN_TYPE = "34";
const LOGIN_STATE = "blue_dash";
const TOKEN_CACHE_FILE = path.join(__dirname, "bluedash_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "bluedash";

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

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

class Task {
    constructor(raw) {
        const _parts = String(raw || "").split("#");
        this.openid = _parts[0].trim();
        this.remark = (_parts[1] || "").trim();
        this.index = $.userIdx++;
        this.authorization = "";
        this.refreshToken = "";
        this.user = {};
        this.nickname = "";
        this.totalScore = null;
        this.signedRecorded = false;
    }

    async run() {
        if (this.remark) _row(this.index).name = this.remark;
        const cached = this.getCachedToken();
        if (cached) {
            this.applyToken(cached);
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.authorization) {
            await this.loginByWxCode();
            if (!this.authorization) { _setSign(this.index, "登录失败", "", ""); return; }
        }

        await this.getSignList();
        await this.doSign();
        await this.getUser();
        if (!this.signedRecorded) _setSign(this.index, "未执行签到", "", this.totalScore != null ? String(this.totalScore) : "");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.authorization) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            authorization: this.authorization,
            refreshToken: this.refreshToken,
            nickname: this.user.nickname || "",
            mobile: this.user.mobile || "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.openid]) {
            delete cache[this.openid];
            writeTokenCache(cache);
        }
        this.authorization = "";
        this.refreshToken = "";
    }

    applyToken(data = {}) {
        const accessToken = data.accessToken || data.access_token || "";
        this.authorization = data.authorization || data.Authorization || (accessToken ? `Bearer ${accessToken}` : "");
        this.refreshToken = data.refreshToken || data.refresh_token || "";
    }

    getHeaders(extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/39/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            ...extra,
        };
        if (this.authorization) headers.Authorization = this.authorization;
        return headers;
    }

    async request({ method = "GET", apiPath, params = {}, data = {}, skipToken = false }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.getHeaders(method === "POST" ? { "Content-Type": "application/json" } : {}),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;
        if (skipToken) delete options.headers.Authorization;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!result || result.code !== 0) {
            const message = result?.msg || result?.message || JSON.stringify(result);
            const err = new Error(message);
            err.code = result?.code;
            throw err;
        }
        return result.data;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const data = await this.request({
                method: "POST",
                apiPath: "/app-api/member/auth/social-login",
                skipToken: true,
                data: {
                    code,
                    type: LOGIN_TYPE,
                    state: LOGIN_STATE,
                },
            });
            this.applyToken(data);
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getUser();
            return true;
        } catch (e) {
            return false;
        }
    }

    async getUser() {
        const data = await this.request({ apiPath: "/app-api/member/user/get" });
        this.user = data || {};
        this.saveCachedToken();
        this.nickname = data?.nickname || "";
        this.totalScore = data?.score ?? null;
        const _rn = _row(this.index); if (!this.remark && this.nickname) _rn.name = this.nickname; if (this.totalScore != null) _rn.total = String(this.totalScore);
        $.log(`账号[${this.index}] 用户: ${data?.nickname || ""} ${maskPhone(data?.mobile) || ""} 积分=${data?.score ?? "未知"}`);
        return data;
    }

    async getSignList() {
        try {
            const data = await this.request({
                apiPath: "/app-api/member/sign-log/page",
                params: {
                    pageNo: 1,
                    pageSize: 100,
                },
            });
            const list = data?.pageResult?.list || [];
            const today = new Date().toISOString().slice(0, 10);
            this.isTodaySign = list.some((item) => item?.date === today);
            $.log(`账号[${this.index}] 签到记录: 连续${data?.coiledDay || 0}天 今日=${this.isTodaySign ? "已签" : "未签"}`);
            if (data?.coiledDay != null) _row(this.index).streak = data.coiledDay;
        } catch (e) {
            $.log(`账号[${this.index}] 查询签到记录失败: ${e.message || e}`);
            if (e.code === 401 || /token|登录|授权/i.test(String(e.message || e))) this.removeCachedToken();
        }
    }

    async doSign() {
        if (this.isTodaySign) {
            $.log(`账号[${this.index}] 今日已签到`);
            _setSign(this.index, "今日已签到", "", this.totalScore != null ? String(this.totalScore) : ""); this.signedRecorded = true;
            return;
        }
        try {
            const data = await this.request({
                method: "POST",
                apiPath: "/app-api/member/sign-log/sign",
            });
            const earned = data?.score ?? data ?? "未知";
            $.log(`账号[${this.index}] 签到成功: +${earned}积分`);
            _setSign(this.index, "签到成功", `+${earned}积分`, this.totalScore != null ? String(this.totalScore) : ""); this.signedRecorded = true;
            const _lot = _digLottery(data); if (_lot) _row(this.index).lottery = _lot;
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复|今日.*签/i.test(message)) {
                $.log(`账号[${this.index}] 今日已签到`);
                _setSign(this.index, "今日已签到", "", this.totalScore != null ? String(this.totalScore) : ""); this.signedRecorded = true;
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            _setSign(this.index, "签到失败: " + message, "", this.totalScore != null ? String(this.totalScore) : ""); this.signedRecorded = true;
            if (e.code === 401 || /token|登录|授权/i.test(message)) this.removeCachedToken();
        }
    }
}


// ===== 统一推送 (标准格式 v1) =====
const { report } = require("./std_report");
const _report = [];
function _row(idx) { if (!_report[idx]) _report[idx] = { idx }; return _report[idx]; }
function _setSign(idx, sign, earned, total) {
  const r = _row(idx);
  r.sign = sign;
  if (earned != null) r.earned = earned;
  if (total != null) r.total = total;
}
// 通用抽奖/奖品提取：扫描 lottery/draw/prize/转盘 等字段
function _digLottery(obj) {
  if (!obj || typeof obj !== "object") return "";
  const hits = [];
  const walk = (o, d) => {
    if (d > 5 || !o || typeof o !== "object" || hits.length > 6) return;
    for (const k of Object.keys(o)) {
      const lk = String(k).toLowerCase();
      if (/(lottery|draw|prize|转盘|turntable|raffle)/.test(lk)) {
        const v = o[k];
        if (v == null || v === "") continue;
        if (typeof v === "object") {
          const t = [v.title, v.name, v.desc, v.prizeName, v.prize].filter((x) => x != null && x !== "").map(String).join(" ");
          if (t) hits.push(t);
        } else hits.push(String(v));
      } else if (typeof o[k] === "object") walk(o[k], d + 1);
      if (hits.length > 6) return;
    }
  };
  walk(obj, 0);
  return hits.join(" ｜ ");
}
async function _flush() {
  const accs = _report.filter(Boolean);
  if (accs.length) await report("BLUE DASH 布鲁大师签到", accs);
}
{
  const _oe = process.exit.bind(process);
  process.exit = function (c) { const p = _flush(); if (p && typeof p.then === "function") p.then(() => _oe(c)).catch(() => _oe(c)); else _oe(c); };
}
process.on("beforeExit", _flush);


!(async () => {
    $.checkEnv(ckName);
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
