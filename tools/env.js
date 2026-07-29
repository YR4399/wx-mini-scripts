/**
 * Env - 环境变量工具类（兼容smallfawn/wx-mini-scripts脚本模板）
 * 从 process.env 读取，支持 & 或换行分隔的多账号
 */
class Env {
    constructor(taskName = "unknown", isReadEnv = true) {
        this.taskName = taskName;
        this.startTime = Date.now();
        if (isReadEnv) {
            this.readEnv();
        }
    }

    readEnv() {
        // 优先用脚本名作为环境变量名，回退到 wx_opinion
        let raw = process.env[this.taskName] || '';
        if (!raw) raw = process.env['wx_opinion'] || '';
        if (!raw) return;
        const parts = raw.replace(/\r\n/g, '\n').split(/[\n&]+/);
        this.accounts = parts.filter(p => p.trim()).map(p => p.trim());
        this.accountCount = this.accounts.length;
        this.account = this.accounts[0] || '';
    }

    // === 账号方法 ===
    // 兼容脚本使用 $.userList 而不是 $.accounts
    get userList() {
        return this.accounts || [];
    }

    get(key) {
        return process.env[key] || '';
    }

    set(key, value) {
        process.env[key] = value;
    }

    // === 日志方法 ===
    log(msg) { console.log(`[${this.taskName}] ${msg}`); }
    info(msg) { this.log(msg); }
    warn(msg) { console.warn(`[${this.taskName}] WARN: ${msg}`); }
    err(msg) { console.error(`[${this.taskName}] ERROR: ${msg}`); }
    ok(msg) { this.log(`✅ ${msg}`); }
    done(msg) { this.log(`📋 ${msg || '完成'}`); }
    isDebug() { return (process.env.DEBUG || 'false').toLowerCase() === 'true'; }

    // === HTTP请求方法 ===
    async httpRequest(method, url, body = null, headers = {}) {
        const axios = require('axios');
        try {
            const opts = {
                method, url,
                headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
                timeout: 15000,
                validateStatus: () => true
            };
            if (method.toUpperCase() === 'POST' && body) {
                if (typeof body === 'string') {
                    opts.data = body;
                    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                } else {
                    opts.data = body;
                }
            } else if (body && typeof body === 'object') {
                opts.params = body;
            }
            const res = await axios(opts);
            return { status: res.status, body: res.data };
        } catch (e) {
            return { status: 0, body: null, error: e.message };
        }
    }

    // === 环境检查 ===
    checkEnv() {
        // readEnv() 已从 wx_opinion 回退加载，accountCount===0 说明真的没有
        if (!this.account && this.accountCount === 0) {
            this.warn('未配置账号（wx_opinion 或脚本名环境变量为空）');
            this.done('无账号，跳过执行');
            return false;
        }
        if (!this.account) {
            return true;
        }
        return true;
    }

    // === 时间方法 ===
    time() {
        return Math.floor(Date.now() / 1000);
    }

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // === 随机字符串 ===
    randomString(length = 8) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // === 消息推送 ===
    sendMsg(title, body) {
        $notification.send(title, body);
    }

    // === 数据获取（通用） ===
    getdata() {
        // placeholder
        return {};
    }

    isNode() {
        return typeof process !== 'undefined';
    }

    finish() {
        const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
        console.log(`[${this.taskName}] 完成，耗时 ${duration}s`);
    }
}

// 兼容 $notification 调用（用于部分脚本）
const $notification = {
    send(title, body = '') {
        const token = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN || '';
        if (!token) {
            console.log(`[${title}] ${body}`);
            return;
        }
        const http = require('https');
        const data = JSON.stringify({ token, title, content: body });
        const options = {
            hostname: 'www.pushplus.plus',
            path: '/send',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        };
        const req = http.request(options, (res) => {
            let rbody = '';
            res.on('data', chunk => rbody += chunk);
            res.on('end', () => {
                try {
                    const r = JSON.parse(rbody);
                    if (r.code !== 0) console.error(`推送失败: ${JSON.stringify(r)}`);
                } catch (e) { /* ignore */ }
            });
        });
        req.on('error', (e) => console.error(`推送请求失败: ${e.message}`));
        req.write(data);
        req.end();
    }
};

module.exports = { Env, $notification };
