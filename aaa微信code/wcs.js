process.env.http_proxy = "";
process.env.https_proxy = "";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.all_proxy = "";
process.env.ALL_PROXY = "";
const axios = require("axios");

/* ============================================================
 * WCS（微信code）上游请求统一封装
 * 针对「WCS 上游未返回登录 code，疑似 wcs 服务端故障」做：
 *   1) 运行前延迟（进程首次请求前 sleep 一次，避免瞬时打满上游）
 *   2) 失败重试 + 重试间隔延迟（网络异常 / 上游返回但无 code 均重试）
 * 可通过环境变量调参（单位 ms / 次）：
 *   WCS_PRE_DELAY     运行前延迟，默认 3000
 *   WCS_RETRY         重试次数，默认 3
 *   WCS_RETRY_DELAY   重试间隔，默认 3000
 * ============================================================ */
const WCS_PRE_DELAY = parseInt(process.env.WCS_PRE_DELAY || "3000", 10);
const WCS_RETRY = parseInt(process.env.WCS_RETRY || "3", 10);
const WCS_RETRY_DELAY = parseInt(process.env.WCS_RETRY_DELAY || "3000", 10);

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 进程级标记：运行前延迟只在整个进程首次请求时触发一次
let _preDelayDone = false;

class WeChatCodeServer {
    constructor(options) {
        this.serverUrl = options.url;
        this.appid = options.appid;
        this.auth = options.auth;
    }

    async _request(path, body, label) {
        // —— 运行前延迟（每个脚本进程仅一次）——
        if (!_preDelayDone) {
            _preDelayDone = true;
            if (WCS_PRE_DELAY > 0) {
                console.log(`[WCS] ${label} 运行前延迟 ${WCS_PRE_DELAY}ms，规避上游瞬时故障`);
                await sleep(WCS_PRE_DELAY);
            }
        }

        let lastErr;
        for (let attempt = 1; attempt <= WCS_RETRY; attempt++) {
            try {
                const res = await axios.post(this.serverUrl + path, body, {
                    headers: { 'auth': this.auth },
                    timeout: 30 * 1000
                });
                const data = res && res.data;
                // 与脚本侧一致：成功拿到登录 code 才视为可用
                const hasCode = data && (data.code || (data.data && data.data.code));
                if (!hasCode) {
                    // 把上游真实原因带出来（如 oauth 的 data.error），否则只报"服务端故障"没法排查
                    const upMsg = (data && (data.message || (data.data && (data.data.error || data.data.msg)))) || "";
                    lastErr = new Error(`WCS 上游未返回登录 code${upMsg ? `（${upMsg}）` : ""}`);
                    console.log(`[WCS] ${label} 上游未返回登录 code（第 ${attempt}/${WCS_RETRY} 次）：${upMsg || "无返回信息"}`);
                } else {
                    console.log(`[WCS] ${label} 成功（第 ${attempt} 次）`);
                    return res;
                }
            } catch (err) {
                lastErr = err;
                const msg = (err && err.message) || String(err);
                console.log(`[WCS] ${label} 请求失败（第 ${attempt}/${WCS_RETRY} 次）：${msg}`);
            }
            // 非最后一次才等待重试
            if (attempt < WCS_RETRY) {
                console.log(`[WCS] ${label} 重试前延迟 ${WCS_RETRY_DELAY}ms`);
                await sleep(WCS_RETRY_DELAY);
            }
        }
        throw lastErr || new Error("WCS 上游未返回登录 code，疑似 wcs 服务端故障");
    }

    getCode(openid) {
        console.log('等待获取code:');
        return this._request('/wx/code', { appid: this.appid, openid }, '获取code');
    }

    /* 公众号网页 H5 授权（open.weixin oauth2/authorize）：
     * 入参 openid + 公众号 appid + 业务 redirect_uri（可选 scope/state）
     * 返回 axios 响应，body.data = { code, url, full_url }
     *   code      —— 一次性 H5 授权码（约 5 分钟有效、只能用一次）
     *   url       —— 拼好 code 的业务回调地址，直接 GET 它即可换到站点登录态
     *   full_url  —— open.weixin authorize 全量地址（含 uin/key/pass_ticket，一般不用）
     * 用法：const res = await wcs.oauth(openid, { appid, redirect_uri, scope: "snsapi_userinfo" })
     *       const loginUrl = (res.data.data || res.data).url
     */
    oauth(openid, opts = {}) {
        console.log('等待获取OAuth跳转:');
        const body = {
            openid,
            appid: opts.appid || this.appid,
            scope: opts.scope || 'snsapi_userinfo',
            state: opts.state || 'STATE',
            redirect_uri: opts.redirect_uri
        };
        return this._request('/wx/oauth', body, '获取OAuth跳转');
    }

    cloudInit(openid) {
        console.log('等待云函数初始化:');
        return this._request('/wx/call/init', { appid: this.appid, openid }, '云函数初始化');
    }

    cloudCall(openid) {
        console.log('等待云函数调用:');
        return this._request('/wx/cloud/call', { appid: this.appid, openid }, '云函数调用');
    }
}
module.exports = WeChatCodeServer;
