/*
@Description:  ???? (xiaomi_community) ????
cron: 5 9 * * *
??: 
  Cookie?????
  1. ??????? https://web.vip.miui.com/page/info/mio/mio/checkIn ???
  2. F12 ? Network ? ? api.vip.miui.com ?? ? ???? Cookie
  3. ????? XIAOMI_COOKIES = ??Cookie???
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
const RAW_COOKIES = process.env.XIAOMI_COOKIES || "";

// ==================== Cookie ?? ====================

function parseCookies(raw) {
    if (!raw) return null;
    const cookies = {};
    raw.split(/;\s*/).forEach(p => {
        const eq = p.indexOf('=');
        if (eq > 0) {
            cookies[p.substring(0, eq).trim()] = p.substring(eq + 1).trim();
        }
    });
    if (!cookies.miui_vip_serviceToken) return null;
    return cookies;
}

function cookiesToStr(cookies) {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ==================== API ????? multipart/form-data?====================

async function apiCallGet(endpoint, cookies) {
    const cookieStr = cookiesToStr(cookies);
    try {
        const resp = await axios({
            url: API_BASE + endpoint,
            method: "GET",
            headers: {
                "Cookie": cookieStr,
                "User-Agent": "Mozilla/5.0 (Linux; Android 16; M2012K11AC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119",
                "Origin": "https://web.vip.miui.com",
                "Referer": "https://web.vip.miui.com/",
                "Accept": "application/json",
            },
            timeout: 15000,
        });
        const body = resp.data;
        if (body.message === "success" && body.status === 200) {
            return { code: 200, data: body.entity || body };
        }
        return { code: body.status || 500, message: body.message || "????" };
    } catch (e) {
        return { code: -1, message: e.message || "??????" };
    }
}

// checkinV2 ? multipart/form-data POST
async function checkinPost(cookies) {
    const cookieStr = cookiesToStr(cookies);
    const ph = encodeURIComponent(cookies.miui_vip_ph || '');
    const url = `${API_BASE}/mtop/planet/vip/user/checkinV2?ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&device=alioth&miui_vip_ph=${ph}`;
    
    const boundary = "----XiaoMiCheckInBoundary";
    // ?token???captcha??????
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n\r\n--${boundary}--\r\n`;

    try {
        const resp = await axios({
            url,
            method: "POST",
            headers: {
                "Cookie": cookieStr,
                "User-Agent": "Mozilla/5.0 (Linux; Android 16; M2012K11AC) AppleWebKit/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119",
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Origin": "https://web.vip.miui.com",
                "X-Requested-With": "com.xiaomi.vipaccount",
                "Accept": "application/json",
            },
            data: body,
            timeout: 15000,
        });
        const d = resp.data;
        // ??: {status:200, message:"success", entity:5}
        // ???: {status:500, message:"???????..."}
        if (d.status === 200) {
            return { code: 200, data: d.entity, message: d.message };
        }
        return { code: d.status || 500, message: d.message || "????" };
    } catch (e) {
        return { code: -1, message: e.message || "??????" };
    }
}

// ==================== ?? API ====================

// ??????
const CK_PARAMS = "ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&device=alioth";

async function getCheckinInfo(cookies) {
    const r = await apiCallGet(`/mtop/planet/vip/user/getUserCheckinInfoV2?${CK_PARAMS}`, cookies);
    if (r.code === 200 && r.data) return r.data;
    return null;
}

// ????
async function doCheckin(cookies) {
    return await checkinPost(cookies);
}

// ??????
async function getCakeList(cookies) {
    const r = await apiCallGet(`/mtop/planet/vip/member/getCheckinPageCakeList?${CK_PARAMS}`, cookies);
    if (r.code === 200 && r.data) return r.data;
    return null;
}

// ==================== ??? ====================

async function run() {
    $.log(`\n======== ???????? ========\n`);

    const cookies = parseCookies(RAW_COOKIES);
    if (!cookies) {
        $.log(`[??] ?????Cookie?`);
        $.log(`[??] ?????? XIAOMI_COOKIES`);
        $.log(`   1. ?? https://web.vip.miui.com/page/info/mio/mio/checkIn`);
        $.log(`   2. ???F12 ? Network ? ? api.vip.miui.com ??`);
        $.log(`   3. ?? Request Headers ????Cookie`);
        return;
    }
    $.log(`[Cookie] cUserId: ${(cookies.cUserId || '').slice(0, 12)}...`);
    $.log(`[Cookie] serviceToken: ${(cookies.miui_vip_serviceToken || '').slice(0, 12)}...`);

    // 1. ??????
    $.log(`\n[??] ??????...`);
    const info = await getCheckinInfo(cookies);
    if (!info) {
        $.log(`[??] ???Cookie?????`);
        return;
    }
    const hasChecked = info.hasCheckIn === true;
    $.log(`[??] ${hasChecked ? '? ???' : '? ???'}`);
    $.log(`[??] ${info.continueCheckInDays || 0} ?`);
    if (info.totalCheckInDays !== undefined) $.log(`[??] ${info.totalCheckInDays} ?`);
    if (info.growScore !== undefined) $.log(`[???] ${info.growScore}`);

    // 2. ??
    if (hasChecked) {
        $.log(`\n[??] ????????`);
    } else {
        $.log(`\n[??] ????...`);
        const r = await doCheckin(cookies);
        if (r.code === 200) {
            $.log(`[??] ? ????? ${r.data} ???`);
        } else {
            $.log(`[??] ${r.message}`);
        }
    }

    // 3. ????
    $.log(`\n[??] ??????...`);
    const cakeList = await getCakeList(cookies);
    if (cakeList && Array.isArray(cakeList)) {
        for (const cake of cakeList) {
            const name = cake.head?.name || cake.name || '??';
            const prog = cake.progress ?? 0;
            const tgt = cake.target ?? 0;
            $.log(`  ${name}: ${prog}/${tgt}${cake.rewarded ? ' ???' : ''}`);
        }
    }

    $.log(`\n======== ???????? ========`);
}

// ==================== ?? ====================

run().catch(e => {
    $.log(`[??] ${e.message}`);
    $.log(e.stack);
}).finally(() => $.done());

