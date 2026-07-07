/*
@Description:  ????(zcjs) ???? + ????
cron: 0 8 * * *
*/

// ==================== ?? ====================
class Env {
    constructor(name) { this.name = name || '??????'; this.userIdx = 0; }
    log(msg) { console.log(String(msg)); }
    done() { process.exit(0); }
    wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env("??????");

// ????
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
process.env.ALL_PROXY = "";
process.env.all_proxy = "";

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== ?? ====================

// API????????????????????????
const REMOTE_CONFIG_URLS = [
    "http://114.132.167.117/zcjs.json",
    "https://d5na8xugvi220.cloudfront.net/zcjs.json",
];

const FALLBACK_API_DOMAINS = [
    "https://daziran.xglrz.com/api",
    "https://daziran.atjxd.com/api",
    "https://bziran.xglrz.com/api",
];

// TOKEN????????accessToken?refreshToken??????????
const TOKEN_CACHE_FILE = path.join(__dirname, "zcjs_token_cache.json");

// ????
// ???? ZCJS_ACCOUNTS: ????? ???:??
// ??: account1:pass1,account2:pass2
const ACCOUNTS_ENV = process.env.ZCJS_ACCOUNTS || "";

// ==================== Token ?? ====================

function readCache() {
    try { return fs.existsSync(TOKEN_CACHE_FILE) ? JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {} : {}; }
    catch { return {}; }
}
function writeCache(c) {
    try { fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(c, null, 2), "utf8"); }
    catch (e) { $.log(`??????: ${e.message}`); }
}

function getCachedToken(userName) {
    const cache = readCache();
    const entry = cache[userName];
    if (!entry) return null;
    // accessToken ????????30?????
    const age = Date.now() - entry.savedAt;
    if (age > 30 * 60 * 1000) return null; // 30????
    return entry;
}

function setCachedToken(userName, accessToken, refreshToken) {
    const cache = readCache();
    cache[userName] = { accessToken, refreshToken, savedAt: Date.now() };
    writeCache(cache);
}

function clearCachedToken(userName) {
    const cache = readCache();
    delete cache[userName];
    writeCache(cache);
}

// ==================== ?????? ====================

async function fetchApiDomain() {
    for (const url of REMOTE_CONFIG_URLS) {
        try {
            const resp = await axios.get(url, { timeout: 8000 });
            if (resp.data && resp.data.domain && resp.data.domain.length > 0) {
                const domain = resp.data.domain[0].apiDomain; // ???01
                $.log(`[??] ??????: ${domain}`);
                return domain;
            }
        } catch { }
    }
    $.log(`[??] ???????????????: ${FALLBACK_API_DOMAINS[0]}`);
    return FALLBACK_API_DOMAINS[0];
}

// ==================== API ?? ====================

let API_BASE = "https://daziran.xglrz.com/api";

// ?????????app?$http?
async function apiCall(endpoint, method = "GET", data = null, token = null) {
    const headers = { "Content-Type": "application/json" };
    if (token) {
        headers["accessToken"] = token.accessToken;
    }
    const config = {
        url: API_BASE + endpoint,
        method,
        headers,
        data: data || undefined,
        timeout: 15000,
    };
    try {
        const resp = await axios(config);
        if (resp.status !== 200) {
            return { code: -1, message: `HTTP ${resp.status}` };
        }
        const body = resp.data;
        if (body.code === 200) {
            return { code: 200, data: body.data || body, message: body.message || "??" };
        }
        // 401 -> refresh token
        if (body.code === 401 && token) {
            const newToken = await refreshToken(token);
            if (newToken) {
                headers["accessToken"] = newToken.accessToken;
                const retry = await axios({ url: API_BASE + endpoint, method, headers, data: data || undefined, timeout: 15000 });
                if (retry.status === 200 && retry.data.code === 200) {
                    return { code: 200, data: retry.data.data || retry.data, message: retry.data.message || "??" };
                }
                return { code: retry.data.code, message: retry.data.message || "??", data: retry.data };
            }
            return { code: 401, message: "??????????" };
        }
        return { code: body.code || -1, message: body.message || "????", data: body.data };
    } catch (e) {
        return { code: -1, message: e.message || "??????" };
    }
}

// ??Token
async function refreshToken(token) {
    try {
        const resp = await axios({
            url: API_BASE + "/refreshToken",
            method: "PUT",
            headers: { "Content-Type": "application/json", "refreshToken": token.refreshToken },
            timeout: 15000,
        });
        if (resp.status === 200 && resp.data.code === 200) {
            const newData = resp.data.data || resp.data;
            const newToken = {
                accessToken: newData.accessToken || token.accessToken,
                refreshToken: newData.refreshToken || token.refreshToken,
            };
            $.log(`[Token] ????`);
            return newToken;
        }
    } catch { }
    return null;
}

// ==================== ?? ====================

async function login(userName, password) {
    $.log(`[??] ${userName}`);
    const body = { terminal: 1, userName, password };
    const result = await apiCall("/login", "POST", body);
    if (result.code === 200) {
        const d = result.data;
        const accessToken = d.accessToken || d.token || "";
        const refreshTk = d.refreshToken || "";
        $.log(`[??] ?? (accessToken: ${accessToken.slice(0, 8)}...)`);
        return { accessToken, refreshToken: refreshTk, userInfo: d };
    }
    $.log(`[??] ??: ${result.message}`);
    return null;
}

// ==================== ?? ====================

async function signIn(token, userName) {
    $.log(`[??] ????...`);
    const result = await apiCall("/user/sign", "GET", null, token);
    if (result.code === 200) {
        const d = result.data;
        const msg = d.message || d.msg || "????";
        $.log(`[??] ??: ${msg}`);
        if (d.coins !== undefined) $.log(`[??] ????: ${d.coins}`);
        if (d.points !== undefined) $.log(`[??] ????: ${d.points}`);
        return d;
    }
    $.log(`[??] ??: ${result.message}`);
    return null;
}

// ??????
async function getSignList(token) {
    const result = await apiCall("/user/signInList", "GET", null, token);
    if (result.code === 200) {
        const d = result.data;
        if (d && d.list) {
            $.log(`[????] ????: ${d.list.length} ?`);
            if (d.continuousDays !== undefined) $.log(`[????] ??: ${d.continuousDays} ?`);
            if (d.totalDays !== undefined) $.log(`[????] ??: ${d.totalDays} ?`);
        }
        return d;
    }
    return null;
}

// ==================== ??? ====================

async function run() {
    $.log(`\n======== ???????? ========\n`);

    // 1. ??API??
    API_BASE = await fetchApiDomain();
    $.log(`[API] ????: ${API_BASE}`);

    // 2. ??????
    const accounts = [];
    if (ACCOUNTS_ENV) {
        const parts = ACCOUNTS_ENV.split(",");
        for (const p of parts) {
            const [userName, password] = p.trim().split(":");
            if (userName && password) {
                accounts.push({ userName, password });
            }
        }
    }
    if (accounts.length === 0) {
        $.log(`[??] ???????????? ZCJS_ACCOUNTS ??? ???:??????????`);
        $.log(`[??] ZCJS_ACCOUNTS=user1:pass1,user2:pass2`);
        return;
    }
    $.log(`[??] ? ${accounts.length} ???`);

    // 3. ?????
    for (let i = 0; i < accounts.length; i++) {
        const { userName, password } = accounts[i];
        $.log(`\n--- ??[${i + 1}/${accounts.length}]: ${userName} ---`);

        // ??????token
        let token = getCachedToken(userName);

        // ????token???????
        if (!token) {
            token = await login(userName, password);
            if (!token) continue;
            setCachedToken(userName, token.accessToken, token.refreshToken);
        } else {
            $.log(`[Token] ????token`);
        }

        // ????
        const signResult = await signIn(token, userName);
        if (signResult === null && token) {
            // ???????token??????refreshToken??
            $.log(`[Token] ????...`);
            const newToken = await refreshToken(token);
            if (newToken) {
                setCachedToken(userName, newToken.accessToken, newToken.refreshToken);
                await signIn(newToken, userName);
            } else {
                // ?????????????
                clearCachedToken(userName);
                $.log(`[Token] ?????????`);
                token = await login(userName, password);
                if (token) {
                    setCachedToken(userName, token.accessToken, token.refreshToken);
                    await signIn(token, userName);
                }
            }
        }

        // ??????
        if (token) {
            await $.wait(1000);
            await getSignList(token);
        }
    }

    $.log(`\n======== ???????? ========`);
}

// ==================== ?? ====================

run().catch(e => {
    $.log(`[??] ${e.message}`);
    $.log(e.stack);
}).finally(() => $.done());

