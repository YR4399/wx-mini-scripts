/*
@Description: 快宝旧衣回收 签到+抽奖
cron: 25 8 * * *
*/
const { Env } = require("../tools/env.js");
const $ = new Env("快宝旧衣回收");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");
// ========== 推送通知 ==========
const { sendPushNotify } = require("./_push_helper");
// ========== 推送通知结束 ==========

// ========== SSL和代理修复 ==========
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
// ========== SSL和代理修复结束 ==========

const APPID = "wxbe2f25800165b6f8";
const BASE_URL = "https://vues.dd1x.cn";
const CHANNEL_ID = "5658";
const CACHE_FILE = path.join(__dirname, "kuaibao_token_cache.json");
let ckName = "wx_opinion";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const wechat = new WeChatServer({
    url: process.env.wx_server_url || "http://127.0.0.1:8787",
    appid: APPID,
    auth: process.env.wx_auth || "",
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function random(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function getHeaders(token = "") {
    const h = {"User-Agent": UA, "xweb_xhr": "1", "Referer": "https://servicewechat.com/" + APPID + "/26/page-frame.html"};
    if (token) h.token = token;
    return h;
}

function loadCache() { try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch(e) {} return {}; }
function saveCache(data) { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); }

class KuaiBao {
    constructor(openid, index) { this.index = index; this.openid = openid; this.token = ""; }

    async login() {
        $.log("账号[" + this.index + "] 登录...");
        try {
            const cr = await wechat.getCode(this.openid);
            const code = cr?.data?.data?.code || cr?.data?.code;
            if (!code) { $.log("账号[" + this.index + "] WCS未返回code"); return false; }
            const url = BASE_URL + "/api/kuaibao/login/wx_login?code=" + encodeURIComponent(code) + "&channelId=" + CHANNEL_ID;
            const r = await axios.get(url, { headers: getHeaders(), timeout: 15000 });
            if (r.data?.code === 0 && r.data.data?.token) {
                this.token = r.data.data.token;
                $.log("账号[" + this.index + "] 登录成功 mid=" + (r.data.data.mid || ""));
                return true;
            }
            $.log("账号[" + this.index + "] 登录失败: " + (r.data?.msg || JSON.stringify(r.data)));
        } catch(e) { $.log("账号[" + this.index + "] 登录异常: " + e.message); }
        return false;
    }

    async checkAndSign() {
        $.log("========== 快宝 账号[" + this.index + "] ==========");
        const cache = loadCache();
        if (cache[this.openid]?.token) this.token = cache[this.openid].token;

        if (this.token) {
            try {
                const r = await axios.get(BASE_URL + "/ali/getUserInfo", { headers: getHeaders(this.token), timeout: 10000 });
                r.data?.code === 0 ? $.log("账号[" + this.index + "] 缓存token有效") : (this.token = "");
            } catch(e) { $.log("账号[" + this.index + "] token验证异常: " + e.message); this.token = ""; }
        }

        if (!this.token) {
            if (!await this.login()) return { ok: false, reason: "登录失败" };
            cache[this.openid] = { token: this.token };
            saveCache(cache);
        }

        // 签到状态
        const si = await axios.get(BASE_URL + "/api/v2/get_sign_list", { headers: getHeaders(this.token), timeout: 10000 });
        if (si.data?.code !== 0) return { ok: false, reason: "查询失败" };
        const signDayNum = si.data.data?.signDayNum || 0;
        const infos = si.data.data?.signDayInfos || [];
        const signed = infos.find(d => d.dayStatus === 1);
        $.log("账号[" + this.index + "] 签到: " + (signed ? "已签" : "未签") + " | 连续" + signDayNum + "天");

        let signMsg = signed ? "已签" : "";
        if (!signed) {
            const sr = await axios.get(BASE_URL + "/api/v2/sign_join", { headers: getHeaders(this.token), timeout: 10000 });
            if (sr.data?.code === 0) {
                const reward = sr.data.data?.name || "?";
                $.log("账号[" + this.index + "] 签到成功: " + reward);
                signMsg = "签到:" + reward;
            } else {
                $.log("账号[" + this.index + "] 签到失败: " + (sr.data?.msg || ""));
                return { ok: false, reason: sr.data?.msg || "未知", signDayNum };
            }
        }

        // 抽奖
        let lotteryMsg = "";
        try {
            const li = await axios.get(BASE_URL + "/front/activity/get_lottery_info?id=13&channelId=" + CHANNEL_ID,
                { headers: getHeaders(this.token), timeout: 10000 }
            );
            const count = parseInt(li.data?.data?.member_count || li.data?.data?.lottery?.member_count || 0);
            $.log("账号[" + this.index + "] 可抽奖 " + count + " 次");
            const prizes = [];
            for (let d = 0; d < count; d++) {
                if (d > 0) await sleep(random(2000, 4000));
                const lr = await axios.get(BASE_URL + "/front/activity/get_lottery_result?id=13",
                    { headers: getHeaders(this.token), timeout: 10000 }
                );
                if (lr.data?.code === 0) {
                    const prize = lr.data.data?.prizeName || "?";
                    const recId = lr.data.data?.record_id;
                    prizes.push(prize);
                    $.log("账号[" + this.index + "] 抽奖" + (d+1) + ": " + prize);
                    if (recId) {
                        await axios.get(BASE_URL + "/front/activity/update_lottery_result?id=" + recId,
                            { headers: getHeaders(this.token), timeout: 8000 }
                        ).catch(() => {});
                    }
                } else {
                    $.log("账号[" + this.index + "] 抽奖" + (d+1) + "失败: " + (lr.data?.msg || ""));
                }
            }
            lotteryMsg = prizes.length ? "抽:" + prizes.join(",") : (count + "次");
        } catch(e) { $.log("账号[" + this.index + "] 抽奖异常: " + e.message); lotteryMsg = "抽奖异常"; }

        return { ok: true, status: signMsg + (lotteryMsg ? " | " + lotteryMsg : ""), signDayNum };
    }
}

async function main() {
    $.log("=== 快宝旧衣回收 开始 ===");
$.userIdx = 0;
    $.checkEnv(ckName);
    const accounts = $.userList || [];
    if (accounts.length === 0) { $.log("未配置 wx_opinion"); return; }
    $.log("共 " + accounts.length + " 个账号");

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
        if (i > 0) { const d = random(3000, 8000); await sleep(d); }
        const b = new KuaiBao(accounts[i], i + 1);
        try { results.push(Object.assign({ openid: accounts[i] }, await b.checkAndSign())); }
        catch(e) { $.log("账号[" + (i+1) + "] 异常: " + e.message); results.push({ openid: accounts[i], index: i+1, ok: false, reason: e.message }); }
    }

    const ok = results.filter(r => r.ok);
    $.log("=== 汇总: " + ok.length + "/" + results.length + " ===");
    let msg = "快宝 " + ok.length + "/" + results.length;
    for (const r of results) msg += "\n账号[" + r.index + "] " + (r.ok ? "OK " + (r.status || "") : "FAIL " + (r.reason || ""));
    sendPushNotify("快宝旧衣回收", msg);
    $.log("=== 快宝旧衣回收 结束 ===");
}

main().catch(e => { $.log("异常: " + e.message); sendPushNotify("快宝旧衣回收", "异常: " + e.message); });
