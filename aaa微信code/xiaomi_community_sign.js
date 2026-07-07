/*
@Description:  ?????? (xiaomi_community)
cron: 0 9 * * *
??: ??????Cookie???Cookie?????
  1. ??????? https://web.vip.miui.com/page/info/mio/mio/checkIn ???????
  2. F12 Network ? ???? api.vip.miui.com ?? ? ?? Cookie
  3. ?????? XIAOMI_COOKIES = ???Cookie???
*/

class Env {
    constructor(name) { this.name = name || '??????'; this.userIdx = 0; }
    log(msg) { console.log(String(msg)); }
    done() { process.exit(0); }
    wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env("??????");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = "";
process.env.http_proxy = process.env.https_proxy = "";
process.env.ALL_PROXY = process.env.all_proxy = "";

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== ?? ====================

const API_BASE = "https://api.vip.miui.com";
const COOKIE_CACHE_FILE = path.join(__dirname, "xiaomi_cookie_cache.json");

// ??????
// XIAOMI_COOKIES = ???Cookie???
// XIAOMI_SERVICETOKEN = miui_vip_serviceToken ?
// XIAOMI_CUSERID = cUserId ?
const RAW_COOKIES = process.env.XIAOMI_COOKIES || "";

// ==================== Cookie ?? ====================

function parseCookies(raw) {
    if (!raw) return null;
    const cookies = {};
    raw.split(/;\s*/).forEach(p => {
        const eq = p.indexOf('=');
        if (eq > 0) {
            const k = p.substring(0, eq).trim();
            const v = p.substring(eq + 1).trim();
            cookies[k] = v;
        }
    });
    // ?????token
    if (!cookies.miui_vip_serviceToken && !cookies.cUserId) return null;
    return cookies;
}

function cookiesToStr(cookies) {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ?HAR?????Cookie?????????????????
const DEFAULT_COOKIES = parseCookies(RAW_COOKIES);

// ==================== API ?? ====================

async function apiCall(endpoint, method = "GET", data = null, cookies = null) {
    const cookieStr = cookies ? cookiesToStr(cookies) : "";
    if (!cookieStr) return { code: -1, message: "???Cookie" };

    const headers = {
        "Cookie": cookieStr,
        "User-Agent": "Mozilla/5.0 (Linux; Android 16; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119",
        "Origin": "https://web.vip.miui.com",
        "Referer": "https://web.vip.miui.com/",
        "Accept": "application/json, text/plain, */*",
    };

    try {
        const resp = await axios({
            url: API_BASE + endpoint,
            method,
            headers,
            data: data || undefined,
            timeout: 15000,
        });
        if (resp.status !== 200) {
            return { code: -1, message: `HTTP ${resp.status}` };
        }
        const body = resp.data;
        if (body.message === "success" || body.code === 200) {
            return { code: 200, data: body.entity || body, message: body.message || "??" };
        }
        if (body.status === 401 || resp.status === 401) {
            return { code: 401, message: "Cookie?????????" };
        }
        return { code: body.status || -1, message: body.message || "????", data: body.entity };
    } catch (e) {
        if (e.response && e.response.status === 401) {
            return { code: 401, message: "Cookie?????????" };
        }
        return { code: -1, message: e.message || "??????" };
    }
}

// ==================== ?? API ====================

// ??????
async function getCheckinInfo(cookies) {
    const ep = "/mtop/planet/vip/user/getUserCheckinInfoV2?ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&country=CN";
    const result = await apiCall(ep, "GET", null, cookies);
    if (result.code === 200 && result.data) {
        return result.data;
    }
    return null;
}

// ????
async function doCheckin(cookies) {
    const ep = "/mtop/planet/vip/user/checkinV2?ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119";
    const result = await apiCall(ep, "POST", null, cookies);
    if (result.code === 200) {
        return result.data;
    }
    return null;
}

// ??????????
async function getCakeList(cookies) {
    const ep = "/mtop/planet/vip/member/getCheckinPageCakeList?ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&country=CN";
    const result = await apiCall(ep, "GET", null, cookies);
    if (result.code === 200 && result.data) {
        return result.data;
    }
    return null;
}

// ==================== ??? ====================

async function run() {
    $.log(`\n======== ???????? ========\n`);

    // ??Cookie
    let cookies = null;
    if (RAW_COOKIES) {
        cookies = parseCookies(RAW_COOKIES);
        if (cookies) {
            $.log(`[Cookie] ??? (cUserId: ${(cookies.cUserId || '').slice(0, 16)}...)`);
            $.log(`[Cookie] serviceToken: ${(cookies.miui_vip_serviceToken || '').slice(0, 16)}...`);
        }
    }

    if (!cookies) {
        $.log(`[??] ???Cookie?`);
        $.log(`[??] ??????? XIAOMI_COOKIES`);
        $.log(`[??] ????:`);
        $.log(`   1. ?? https://web.vip.miui.com/page/info/mio/mio/checkIn ???`);
        $.log(`   2. F12 ? Network ? ? api.vip.miui.com ??`);
        $.log(`   3. ?? Request Headers ???? Cookie ???`);
        $.log(`[??] XIAOMI_COOKIES=cUserId=xxx; miui_vip_serviceToken=yyy; miui_vip_ph=zzz...`);
        return;
    }

    // 1. ??????
    $.log(`\n[??] ??????...`);
    const info = await getCheckinInfo(cookies);
    if (!info) {
        $.log(`[??] ???? (Cookie?????)`);
        return;
    }

    $.log(`[????] ${info.hasCheckIn ? '? ???' : '? ???'}`);
    $.log(`[????] ${info.continueCheckInDays || 0} ?`);
    $.log(`[???]   ${info.totalCheckInDays || 0} ?`);
    if (info.growScore !== undefined) $.log(`[???]   ${info.growScore}`);
    if (info.prizePoolList) {
        for (const pool of info.prizePoolList) {
            if (pool.prizeStage) $.log(`[??] ${pool.prizeStage}: ${pool.description || ''}`);
        }
    }

    // 2. ?????????????
    if (info.hasCheckIn) {
        $.log(`\n[??] ????????`);
    } else {
        $.log(`\n[??] ????...`);
        const result = await doCheckin(cookies);
        if (result !== null) {
            const points = typeof result === 'number' ? result : (result.growScore || result.points || result.score || '?');
            $.log(`[??] ? ????? ${points} ???`);
        } else {
            $.log(`[??] ? ??`);
        }
    }

    // 3. ????????
    $.log(`\n[??] ????????...`);
    const cakeList = await getCakeList(cookies);
    if (cakeList && Array.isArray(cakeList)) {
        for (const cake of cakeList) {
            const progress = cake.progress || 0;
            const target = cake.target || 0;
            const rewarded = cake.rewarded || false;
            $.log(`[??] ${cake.name || '??'} ${progress}/${target} ${rewarded ? '???' : '???'}`);
        }
    }

    $.log(`\n======== ???????? ========`);
}

// ==================== ?? ====================

run().catch(e => {
    $.log(`[??] ${e.message}`);
    $.log(e.stack);
}).finally(() => $.done());

