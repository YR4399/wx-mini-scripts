/*
@Description: 燕印象燕窝签到
cron: 15 8 * * *
*/
require("https").globalAgent.options.rejectUnauthorized = false;
const { Env } = require("../tools/env.js");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("燕印象燕窝签到");
const axios = require("axios");
const WeChatServer = require("./wcs.js");
const { report, extractPoints } = require("./std_report");

const MINI_APP_ID = "wx875202908b8a99cd";
const API_BASE = "https://xls.chengmenghudong.net.cn";
const SHOP_ID = "1636";

const wx_server_url = process.env.wx_server_url || "";
const wx_auth = process.env.wx_auth || "";
const wcs = new WeChatServer({ url: wx_server_url, appid: MINI_APP_ID, auth: wx_auth });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 从接口返回体按候选键名提取数值字段（防御性，缺失返回 null）
function _pickNum(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    const flat = {};
    for (const [k, v] of Object.entries(obj)) {
        flat[String(k).toLowerCase()] = v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) flat[String(k2).toLowerCase()] = v2;
        }
    }
    for (const key of keys) {
        const v = flat[key];
        if (v != null && v !== '' && !isNaN(Number(v))) return Math.trunc(Number(v));
    }
    return null;
}

class YanyinxiangClient {
    constructor(openid, index) {
        const _p = String(openid || "").split("#");
        this.openid = _p[0].trim();
        this.remark = _p[1] ? _p[1].trim() : "";
        this.index = index;
        this.session_id = "";
        this.visit_cookie = "";
    }

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "session-id": this.session_id,
            "visit-cookie": this.visit_cookie,
            "shop-id": SHOP_ID,
            "api-version": "1",
            "client-type": "wxapp",
            "version": "6.18.0",
            "versionCode": "785",
            "x-requested-with": "XMLHttpRequest",
            "xweb_xhr": "1",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.51 NetType/WIFI",
            "Referer": "https://servicewechat.com/" + MINI_APP_ID + "/13/page-frame.html",
        };
    }

    async login() {
        // 1. Get guest session
        let resp = await axios.get(API_BASE + "/shop/client/member/get-sessionid", {
            headers: { ...this.getHeaders(), "session-id": "", "visit-cookie": "" },
            timeout: 15000,
        });
        this.session_id = resp.data.session_id || "";
        this.visit_cookie = resp.data.cookie || "";

        // 2. Get wx code
        const { data } = await wcs.getCode(this.openid);
        const code = data && data.data ? data.data.code : data && data.code;
        if (!code) throw new Error("获取 code 失败");

        // 3. Login
        resp = await axios.post(API_BASE + "/shop/client/wx-app/login", {
            code: code,
            info: { nickName: "微信用户", gender: 0, avatarUrl: "", language: "", city: "", province: "", country: "" },
            rawData: "",
            signature: "",
            encryptedData: "",
            iv: "",
        }, {
            headers: this.getHeaders(),
            timeout: 15000,
        });

        const d = resp.data;
        if (d.error !== 0) throw new Error("登录失败: " + (d.message || JSON.stringify(d)));

        L.ok("账号[" + this.index + "] 登录成功: " + d.nickname || "会员" + ", ID:" + d.member_id );
        return d;
    }

    async signIn() {
        // Check status
        let resp = await axios.get(API_BASE + "/shop/apps/creditsign/client/index/index", {
            headers: this.getHeaders(), timeout: 15000,
        });
        const idx = resp.data;
        // 总积分 / 连签天数：防御性提取（extractPoints 覆盖常见连签键，_pickNum 兜底积分余额字段如 points）
        const _ep = extractPoints(idx);
        const _total = _ep.total != null ? _ep.total : _pickNum(idx, ['points', 'user_points', 'point', 'integral', 'balance', 'score', 'wealth', 'remain', 'total_points', 'total']);
        const _streak = _ep.streak != null ? _ep.streak : _pickNum(idx, ['sign_count', 'total_sign_count', 'continue_sign_count', 'series_days', 'continuous_days', 'sign_day', 'consecutive_days', 'sign_series', 'totalsign', 'signdays']);
        if (idx.today_sign === 1) {
            const reward = (idx.reward && idx.reward.sign_reward) || 0;
            L.info("账号[" + this.index + "] 今日已签到 +" + reward + "积分");
            const _pc0 = _yyReadPoints(); _yyRollDay(this.openid, _pc0); _yyWritePoints(_pc0);
            const _lt0 = _yyCurTotal(this.openid, _pc0);
            return { status: '今日已签到', reward, total: (_total != null ? String(_total) : String(_lt0)), totalLabel: (_total != null ? null : '累计积分'), streak: _streak != null ? String(_streak) : null, lottery: null };
        }

        // Do sign
        const activity_id = idx.activity_id || "3316";
        resp = await axios.post(API_BASE + "/shop/apps/creditsign/client/index/sign",
            { activity_id },
            { headers: this.getHeaders(), timeout: 15000 }
        );
        const d = resp.data;
        if (d.error === 0) {
            const msg = d.message || "";
            const m = msg.match(/\d+/);
            const reward = m ? parseInt(m[0]) : 10;
            L.ok("账号[" + this.index + "] 签到成功 +" + reward + "积分");
            // 本地累计：真实总积分接口缺失，只有当天真正签到成功才累加
            const _pc = _yyReadPoints(); _yyRollDay(this.openid, _pc);
            _yyAddGain(this.openid, reward, _pc);
            const _lt = _yyCurTotal(this.openid, _pc); _yyWritePoints(_pc);
            return { status: '签到成功', reward, total: (_total != null ? String(_total) : String(_lt)), totalLabel: '累计积分', streak: _streak != null ? String(_streak) : null, lottery: null };
        }
        if (d.message && d.message.includes("已签")) {
            L.info("账号[" + this.index + "] 今日已签到");
            const _pc1 = _yyReadPoints(); _yyRollDay(this.openid, _pc1); _yyWritePoints(_pc1);
            const _lt1 = _yyCurTotal(this.openid, _pc1);
            return { status: '今日已签到', reward: 0, total: (_total != null ? String(_total) : String(_lt1)), totalLabel: (_total != null ? null : '累计积分'), streak: _streak != null ? String(_streak) : null, lottery: null };
        }
        L.info("账号[" + this.index + "] 签到: " + (d.message || JSON.stringify(d)));
        return { status: '签到: ' + (d.message || JSON.stringify(d)), reward: 0, total: _total != null ? String(_total) : null, streak: _streak != null ? String(_streak) : null, lottery: null };
    }

    async run() {
        await this.login();
        await sleep(1000);
        return await this.signIn();
    }
}

let _rows = [];

// ---------- 本地累计积分（接口无总积分字段，本机向前累计每日签到获得积分）----------
const _YY_POINTS_FILE = require("path").join(__dirname, "yanyinxiang_points_cache.json");
const _YY_FS = require("fs");
function _yyReadPoints() {
    try { if (!_YY_FS.existsSync(_YY_POINTS_FILE)) return {}; return JSON.parse(_YY_FS.readFileSync(_YY_POINTS_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function _yyWritePoints(c) {
    try { _YY_FS.writeFileSync(_YY_POINTS_FILE, JSON.stringify(c, null, 2), "utf8"); } catch (e) { $.log("写入积分缓存失败: " + (e.message || e)); }
}
function _yyToday() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function _yyRollDay(openid, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: _yyToday() });
    if (rec.date !== _yyToday()) { rec.hist = (Number(rec.hist) || 0) + (Number(rec.gain) || 0); rec.gain = 0; rec.date = _yyToday(); }
    return rec;
}
function _yyAddGain(openid, point, cache) {
    const rec = cache[openid] || (cache[openid] = { hist: 0, gain: 0, date: _yyToday() });
    rec.gain = (Number(rec.gain) || 0) + (Number(point) || 0);
    rec.date = _yyToday();
}
function _yyCurTotal(openid, cache) { const rec = cache[openid] || { hist: 0, gain: 0 }; return (Number(rec.hist) || 0) + (Number(rec.gain) || 0); }

async function main() {
    const openids = (process.env.wx_opinion || "").split("&").filter(Boolean);
    if (!openids.length) throw new Error("未配置 wx_opinion");

    $.log("共找到" + openids.length + "个账号");

    for (let i = 0; i < openids.length; i++) {
        const client = new YanyinxiangClient(openids[i], i + 1);
        try {
            const res = await client.run();
            _rows.push({
                idx: i + 1,
                name: client.remark || ('账号' + (i + 1)),
                sign: res.status,
                earned: res.reward > 0 ? ('今日+' + res.reward + '积分') : null,
                total: res.total != null ? String(res.total) : null,
                totalLabel: res.totalLabel || null,
                streak: res.streak != null ? String(res.streak) : null,
                tasks: null,
                taskEarned: null,
                lottery: null,
            });
        } catch (e) {
            L.error("账号[" + (i + 1) + "] 异常: " + e.message);
            _rows.push({ idx: i + 1, name: client.remark || ('账号' + (i + 1)), sign: '异常: ' + e.message, earned: null, total: null, streak: null, tasks: null, taskEarned: null, lottery: null });
        }
        if (i < openids.length - 1) await sleep(3000);
    }
}

main().catch(e => $.log("ERR: " + e.message)).finally(async () => {
    try {
      await report('燕印象燕窝签到', _rows);
    } catch(e) { L.fail('report 失败: ' + e.message); }
    $.sendMsg = async () => {}; $.done();
  });
