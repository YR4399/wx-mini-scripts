/**
 * Env - 环境变量工具类（兼容 QLScriptPublic / smallfawn 脚本模板）
 * 从 process.env 读取，支持 & 或换行分隔的多账号
 */
class Env {
    constructor(taskName = "unknown", isReadEnv = true) {
        this.taskName = taskName;
        this.startTime = Date.now();
        this.userIdx = 1;
        if (isReadEnv) {
            this.readEnv();
        }
        this.log(`🔔 ${this.taskName},开始!`);
    }

    readEnv(envName) {
        let raw = '';
        if (envName && process.env[envName]) raw = process.env[envName];
        if (!raw && process.env[this.taskName]) raw = process.env[this.taskName];
        if (!raw) raw = process.env['wx_opinion'] || '';
        if (!raw) return;
        const parts = raw.replace(/\r\n/g, '\n').split(/[\n&]+/);
        this.accounts = parts.filter(p => p.trim()).map(p => p.trim());
        this.accountCount = this.accounts.length;
        this.account = this.accounts[0] || '';
    }

    get userList() { return this.accounts || []; }
    get userCount() { return this.accountCount || 0; }

    nick(openid = "") {
        const oid = String(openid);
        if (!oid) return oid;
        try {
            const raw = process.env.NICK_MAP || '';
            for (const seg of raw.replace(/\r\n/g, '\n').split(/[\n&]+/)) {
                const i = seg.indexOf(':');
                if (i > 0 && seg.slice(0, i).trim() === oid) return seg.slice(i + 1).trim() || oid;
            }
        } catch (e) {}
        return oid;
    }

    get(key) { return process.env[key] || ''; }
    set(key, value) { process.env[key] = value; }

    log(msg) { console.log(`[${this.taskName}] ${msg}`); }
    info(msg) { this.log(msg); }
    warn(msg) { console.warn(`[${this.taskName}] WARN: ${msg}`); }
    err(msg) { console.error(`[${this.taskName}] ERROR: ${msg}`); }
    ok(msg) { this.log(`✅ ${msg}`); }
    done(msg) { this.log(msg ? `📋 ${msg}` : `🔔 ${this.taskName},结束!`); }
    isDebug() { return (process.env.DEBUG || 'false').toLowerCase() === 'true'; }

    async httpRequest(method, url, body = null, headers = {}) {
        const axios = require('axios');
        try {
            const opts = { method, url, headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 15000, validateStatus: () => true };
            if (method.toUpperCase() === 'POST' && body) {
                if (typeof body === 'string') { opts.data = body; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
                else { opts.data = body; }
            } else if (body && typeof body === 'object') {
                opts.params = body;
            }
            const res = await axios(opts);
            return { status: res.status, body: res.data };
        } catch (e) { return { status: 0, body: null, error: e.message }; }
    }

    checkEnv(envName) {
        if (envName) this.readEnv(envName);
        if (!this.account && this.accountCount === 0) {
            this.warn('未配置账号（环境变量为空）');
            this.done('无账号，跳过执行');
            return false;
        }
        return true;
    }

    time() { return Math.floor(Date.now() / 1000); }

    wait(ms, max) {
        let delay;
        if (max !== undefined) {
            delay = Math.floor(Math.random() * (max - ms + 1) + ms);
        } else {
            delay = ms;
        }
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    randomNumber(len = 6) {
        let n = '';
        for (let i = 0; i < len; i++) n += Math.floor(Math.random() * 10);
        return n;
    }

    uuid() {
        const hex = '0123456789abcdef';
        const s = [];
        for (let i = 0; i < 36; i++) {
            s.push(hex[Math.floor(Math.random() * 16)]);
        }
        s[8] = s[13] = s[18] = s[23] = '-';
        s[14] = '4';
        s[19] = hex[(parseInt(s[19], 16) & 3) | 8];
        return s.join('');
    }

    randomString(length = 8) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        return result;
    }

    sendMsg(title, body) { $notification.send(title, body); }
    getdata() { return {}; }
    isNode() { return typeof process !== 'undefined'; }
    finish() {
        const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
        console.log(`[${this.taskName}] 完成，耗时 ${duration}s`);
    }
}

const DING_WEBHOOK = process.env.DING_WEBHOOK || "https://oapi.dingtalk.com/robot/send?access_token=0ad9275e32710fa5a60f26a4541d361d73c8f5f87f4da6cdfa4573c54498c37f";
const DING_SECRET = process.env.DING_SECRET || "SECc3bf9e69fa3270efa2ffc9613eadbe9de92b687a0236a3fec2c014c38d003abb";

const $notification = {
    send(title, body = '') {
        try {
            const crypto = require('crypto');
            const ts = Date.now();
            const sign = encodeURIComponent(crypto.createHmac('sha256', DING_SECRET).update(ts + "\n" + DING_SECRET).digest('base64'));
            const url = DING_WEBHOOK + "&timestamp=" + ts + "&sign=" + sign;
            const payload = JSON.stringify({ msgtype: "markdown", markdown: { title: String(title).slice(0, 50), text: body } });
            const http = require('https');
            const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let rbody = '';
                res.on('data', chunk => rbody += chunk);
                res.on('end', () => {
                    try {
                        const r = JSON.parse(rbody);
                        if (r.errcode !== 0) console.error('钉钉推送失败: ' + JSON.stringify(r));
                    } catch (e) {}
                });
            });
            req.on('error', (e) => console.error('钉钉推送请求失败: ' + e.message));
            req.write(payload);
            req.end();
        } catch (e) {
            console.error(`[${title}] 推送异常: ${e.message}`);
        }
    }
};

module.exports = { Env, $notification };