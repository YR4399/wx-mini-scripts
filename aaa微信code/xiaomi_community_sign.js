/*
@Description:  ???? (xiaomi_community) ????
cron: 5 9 * * *
??:
  ??A: Cookie?????????F12???
  ??B: ??????????????login_user_agent?
*/

class Env {
    constructor(name) { this.name = name || '??????'; this.userIdx = 0; }
    log(msg) { console.log(String(msg)); }
    done() { process.exit(0); }
    wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env("??????");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"].forEach(k => process.env[k] = "");

const axios = require("axios");

// ==================== ?? ====================

const API_BASE = "https://api.vip.miui.com";

// ????
const RAW_COOKIES = process.env.XIAOMI_COOKIES || "";

// ==================== Cookie ?? ====================

function parseCookies(raw) {
    if (!raw) return null;
    const c = {};
    raw.split(/;\s*/).forEach(p => { const i = p.indexOf('='); if (i > 0) c[p.slice(0,i).trim()] = p.slice(i+1).trim(); });
    if (!c.miui_vip_serviceToken) return null;
    return c;
}
function cookiesToStr(c) { return Object.entries(c).map(([k,v]) => `${k}=${v}`).join('; '); }

// ==================== API ?? ====================

async function apiGET(endpoint, cookies) {
    try {
        const resp = await axios.get(API_BASE + endpoint, {
            headers: {
                "Cookie": cookiesToStr(cookies),
                "User-Agent": "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119",
                "Origin": "https://web.vip.miui.com",
                "Referer": "https://web.vip.miui.com/",
            },
            timeout: 15000,
        });
        const d = resp.data;
        if (d.message === "success" && d.status === 200) return { code: 200, data: d.entity };
        return { code: d.status || 500, message: d.message || "??" };
    } catch (e) { return { code: -1, message: e.message }; }
}

// ????token??????token??????
async function getSignToken() {
    return "";
}

// ==================== ?? API ====================

const CK_PARAMS = "ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&device=alioth";

async function getCheckinInfo(cookies) {
    const r = await apiGET(`/mtop/planet/vip/user/getUserCheckinInfoV2?${CK_PARAMS}`, cookies);
    if (r.code === 200 && r.data) return r.data;
    return null;
}

function randomStr(len) {
    return Math.random().toString(36).slice(2, 2 + len);
}

async function doCheckin(cookies, token) {
    const ph = encodeURIComponent(cookies.miui_vip_ph || '');
    const url = `${API_BASE}/mtop/planet/vip/user/checkinV2?${CK_PARAMS}&miui_vip_ph=${ph}`;
    const boundary = "----XB" + randomStr(8);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token || ''}\r\n--${boundary}--\r\n`;
    try {
        const resp = await axios.post(url, body, {
            headers: {
                "Cookie": cookiesToStr(cookies),
                "User-Agent": "Mozilla/5.0 (Linux; Android 16; M2012K11AC) AppleWebKit/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119",
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Origin": "https://web.vip.miui.com",
                "X-Requested-With": "com.xiaomi.vipaccount",
            },
            timeout: 15000,
        });
        const d = resp.data;
        if (d.status === 200) return { code: 200, data: d.entity, message: d.message };
        return { code: d.status || 500, message: d.message || "????" };
    } catch (e) {
        return { code: -1, message: e.message };
    }
}

// ==================== ??? ====================

async function run() {
    $.log(`\n======== ???????? ========\n`);

    const cookies = parseCookies(RAW_COOKIES);
    if (!cookies) {
        $.log(`[??] ???Cookie????? XIAOMI_COOKIES`);
        $.log(`??: ????? https://web.vip.miui.com/page/info/mio/mio/checkIn`);
        $.log(`?? F12 ? Network ? api.vip.miui.com ?? ? ?? Cookie`);
        return;
    }
    const uid = cookies.cUserId || cookies.userId || "";
    $.log(`[Cookie] cUserId: ${(uid).slice(0,12)}...`);

    // 1. ????token??token??????
    $.log(`\n[Token] ????...`);
    const token = await getSignToken(cookies, uid);
    $.log(`[Token] ${token ? '???token' : '???token'}`);

    // 2. ??????
    $.log(`\n[??] ??????...`);
    const info = await getCheckinInfo(cookies);
    if (!info) {
        $.log(`[??] ???Cookie?????`);
        return;
    }
    $.log(`[??] ${info.hasCheckIn ? '? ???' : '? ???'}`);
    $.log(`[??] ${info.continueCheckInDays || 0} ?`);
    if (info.growScore !== undefined) $.log(`[???] ${info.growScore}`);

    // 3. ??
    if (info.hasCheckIn) {
        $.log(`\n[??] ????????`);
    } else {
        $.log(`\n[??] ????...`);
        const r = await doCheckin(cookies, token || "");
        if (r.code === 200) {
            $.log(`[??] ? ????? ${r.data} ???`);
        } else {
            $.log(`[??] ${r.message}`);
            if (r.message && r.message.includes('cookie')) {
                $.log(`[??] Cookie?????????`);
            }
        }
    }

    $.log(`\n======== ???????? ========`);
}

run().catch(e => {
    $.log(`[??] ${e.message}`);
    $.log(e.stack);
}).finally(() => $.done());

