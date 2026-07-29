// 绿蜜蜂回收自动签到
// 环境变量: wx_opinion (统一) 或 lvmf (兼容)
//  openid模式: openid (需配合 wx_auth + wx_server_url)
//  token模式: 备注#access-token#user-token

const WX_SERVER_URL = (process.env.wx_server_url || "").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const APP = { appid: "wx6fcde446296d9588", version: "350" };
const DEFAULT_ACCESS_TOKEN = "0996d5cc676ee512eecfc1330768e8c4";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004539) NetType/WIFI Language/zh_CN";

function maskPhone(p) { return String(p || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2"); }
function maskToken(t) { const v=String(t||""); return v.length>18?`${v.slice(0,10)}***${v.slice(-8)}`:v.slice(0,4)+"***"; }

function parseAccount(raw) {
    const t = String(raw || "").trim();
    if (!t) return {};
    if (t.includes('#')) {
        const p = t.split('#');
        if (p.length === 3) return { remark: p[0], accessToken: p[1], userToken: p[2], type: 'token' };
        if (p.length === 2) return { remark: p[0], openid: p[1], type: 'openid' };
    }
    return { openid: t, type: 'openid', remark: `账号${t.slice(0,8)}...` };
}

class Bot {
    constructor(account, idx) {
        const a = parseAccount(account);
        this.remark = a.remark || `账号${idx}`;
        this.accessToken = a.accessToken || "";
        this.userToken = a.userToken || "";
        this.openid = a.openid || "";
        this.type = a.type || "";
        this.baseURL = "https://lmf.lvmifo.com/api";
        this.nickName = this.phone = this.userId = "";
    }

    log(m) { console.log(`[${this.remark}] ${m}`); }

    headers(extra = {}) {
        const h = { 
            'content-type': 'application/x-www-form-urlencoded',
            'version': 'v1.0.0',
            'User-Agent': USER_AGENT,
            'Host': 'lmf.lvmifo.com',
            'Referer': `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            ...extra 
        };
        if (this.accessToken) h['access-token'] = this.accessToken;
        if (this.userToken) h['user-token'] = this.userToken;
        return h;
    }

    async fetchApi(path, opts = {}) {
        const res = await fetch(`${this.baseURL}${path}`, { 
            method: 'GET', 
            ...opts, 
            headers: this.headers(opts.headers) 
        });
        return res.json();
    }

    async login() {
        try {
            const res = await fetch(`${WX_SERVER_URL}/wx/code`, {
                method: 'POST',
                headers: { 'auth': WX_AUTH, 'content-type': 'application/json' },
                body: JSON.stringify({ appid: APP.appid, openid: this.openid })
            });
            const data = await res.json();
            const code = data?.data?.code || data?.code;
            if (!code) throw new Error("获取code失败");

            const loginRes = await fetch(`${this.baseURL}/5e05692405c63`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'version': 'v1.0.0',
                    'User-Agent': USER_AGENT,
                    'lat': '', 'lng': '',
                    'access-token': DEFAULT_ACCESS_TOKEN,
                    'Host': 'lmf.lvmifo.com',
                    'user-token': '',
                    'this-shop-id': '0',
                    'Referer': `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
                },
                body: `code=${code}`
            });
            const result = await loginRes.json();
            
            if (result.code === 1 && result.data) {
                this.userToken = result.data.utoken || '';
                this.accessToken = result.data.app_access_token || DEFAULT_ACCESS_TOKEN;
                this.nickName = result.data.nick_name || result.data.app_user_name || '';
                this.phone = result.data.phone || '';
                this.userId = result.data.id || result.data.app_user_id || '';
                this.log(`登录成功: ${this.nickName} | ${maskPhone(this.phone)}`);
                return true;
            }
            throw new Error(result.msg || "登录失败");
        } catch (e) {
            this.log(`登录失败: ${e.message}`);
            return false;
        }
    }

    async run() {
        this.log(`开始执行`);

        if (this.type === 'openid' && !this.userToken) {
            if (!WX_AUTH) { this.log("未配置wx_auth"); return {}; }
            if (!await this.login()) return {};
        }
        if (!this.userToken) { this.log("无user-token"); return {}; }

        // 签到
        const sign = await this.fetchApi("/5dca57afa379e?m=toSign");
        let earn = 0, integral = 0, success = false;
        if (sign.code === 1) {
            earn = parseFloat(sign.data.get_red_packet || 0);
            integral = parseInt(sign.data.get_integral || 0);
            this.log(`签到成功 +${earn.toFixed(2)}元 +${integral}积分`);
            success = true;
        } else if (sign.msg?.includes('已签到')) {
            this.log(`今日已签到`);
            success = true;
        } else {
            this.log(`签到失败: ${sign.msg}`);
        }

        // 用户信息
        const info = await this.fetchApi("/5dca57afa379e?m=getUserInfo");
        let balance = 0, totalInt = 0;
        if (info.code === 1) {
            balance = parseFloat(info.data.amount || 0);
            totalInt = parseInt(info.data.integral || 0);
            this.nickName = info.data.nick_name || this.nickName;
            this.phone = info.data.phone || this.phone;
            this.userId = info.data.id || this.userId;
            this.log(`余额: ${balance.toFixed(2)}元 | 积分: ${totalInt}`);
        }

        return { success, earn, integral, balance, totalInt, nickName: this.nickName };
    }
}

async function main() {
    const accountStr = process.env.wx_opinion || process.env.lvmf || "";
    if (!accountStr) {
        console.log("未配置 wx_opinion 或 lvmf");
        return;
    }

    const accounts = accountStr.split('&').filter(a => a.trim());
    console.log(`共找到${accounts.length}个账号`);

    for (let i = 0; i < accounts.length; i++) {
        const bot = new Bot(accounts[i], i + 1);
        await bot.run();
        if (i < accounts.length - 1) {
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
        }
    }
}

main().catch(console.error);
