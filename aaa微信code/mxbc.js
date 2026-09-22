// ========== 环境配置 ==========
process.env.http_proxy = "";
process.env.https_proxy = "";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.all_proxy = "";
process.env.ALL_PROXY = "";
/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  蜜雪冰城APP/小程序
cron: 30 8 * * *
------------------------------------------
#Notice:   
变量名：mxbc
变量值：wx_server 里的 openid/账号标识，多账号&或换行
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

const { Env } = require("../tools/env.js")
const $ = new Env("蜜雪冰城");
let ckName = `mxbc`;
const strSplitor = "#";
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
const MINI_APP_ID = "wx7696c66d2245d107";
const APP_ID = "d82be6bbc1da11eb9dd000163e122ecb";
const API_BASE = "https://mxsa.mxbc.net/api";
const APP_VERSION = "2.8.28";
const TOKEN_CACHE_FILE = path.join(__dirname, "mxbc_token_cache.json");
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:8787',
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "your-api-key",

}
);

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}


class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.wcsid = this.user[0]
        this.remark = this.user[1] ? this.user[1].trim() : "";
        this.ck = "";
        this.loginCode = "";
        this.activityOrigin = ""
        this.activityUrl = ""
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);

        const cachedToken = this.getCachedToken();
        if (cachedToken) {
            this.ck = cachedToken;
            $.log(`账号[${this.index}]  使用缓存token验证`);
            await this.user_info();
        }

        if (!this.ckStatus) {
            this.removeCachedToken();
            await this.loginByWxCode()
            if (!this.ckStatus) { _setSign(this.index, "登录失败"); return; }
            await this.user_info()
        }
        if (!this.ckStatus) { _setSign(this.index, "登录失败"); return; }
        await this.task_signin();
        await this.getLoginUrl()
        if (this.activityOrigin) {
            await this.getActivityToken()
            await this.activityIndex()
        }

    }
    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.wcsid]?.accessToken || "";
    }
    saveCachedToken() {
        if (!this.ck) return;
        const cache = readTokenCache();
        cache[this.wcsid] = {
            accessToken: this.ck,
            mobilePhone: this.mobilePhone || "",
            updatedAt: new Date().toISOString()
        };
        writeTokenCache(cache);
    }
    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.wcsid]) {
            delete cache[this.wcsid];
            writeTokenCache(cache);
        }
    }
    getSignedBody(params = {}) {
        const body = {
            ...params,
            t: Date.now(),
            appId: APP_ID
        };
        const content = Object.keys(body)
            .sort()
            .filter(key => body[key] || body[key] === 0)
            .map(key => {
                const value = typeof body[key] === "object" ? JSON.stringify(body[key]) : body[key];
                return `${key}=${value}`;
            })
            .join("&");
        return {
            ...body,
            sign: this.getSHA256withRSA(content)
        };
    }
    getMiniHeaders(accessToken = "") {
        return {
            'Host': 'mxsa.mxbc.net',
            'Connection': 'keep-alive',
            'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 MicroMessenger/7.0.4.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF',
            'xweb_xhr': 1,
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': 'https://servicewechat.com/wx7696c66d2245d107/59/page-frame.html',
            'Accept-Language': 'en-us,en',
            'Accept-Encoding': 'gzip, deflate',
            'version': APP_VERSION
        };
    }
    async getLoginCode(force = false) {
        if (this.loginCode && !force) return this.loginCode;
        const { data: codeRes } = await wechat.getCode(this.wcsid);
        const code = codeRes?.code || codeRes?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(codeRes)}`);
        this.loginCode = code;
        return this.loginCode;
    }
    async getOpenId() {
        try {
            let options = {
                method: 'POST',
                url: `${API_BASE}/v1/app/code2Session`,
                headers: this.getMiniHeaders(),
                data: this.getSignedBody({ miniAppId: MINI_APP_ID, code: await this.getLoginCode(true) })
            }
            let { data: result } = await axios.request(options);
            if (result.code == 0) {
                this.openId = result.data.openid

                this.unionId = result.data.unionid
                $.log(`账号[${this.index}]  code2Session成功`);
                return true
            } else {
                $.log(`账号[${this.index}]  code2Session失败❌ ${result.msg || ""}`);
                this.ckStatus = false

                console.log(result);
                return false
            }
        } catch (e) {
            $.log(`账号[${this.index}]  code2Session异常❌ ${e.message || e}`);
            this.ckStatus = false
            return false
        }
    }
    async loginByWxCode() {
        try {
            const ok = await this.getOpenId();
            if (!ok) return;
            let options = {
                method: 'POST',
                url: `${API_BASE}/v1/app/regByUnionid`,
                headers: this.getMiniHeaders(),
                data: this.getSignedBody({
                    code: this.loginCode,
                    openId: this.openId,
                    unionid: this.unionId,
                    third: "wxmini",
                    miniAppId: MINI_APP_ID
                })
            };
            let { data: result } = await axios.request(options);
            if (result.code == 0) {
                this.ck = result.data.accessToken;
                this.ckStatus = !!this.ck;
                this.mobilePhone = result.data.mobilePhone;
                this.saveCachedToken();
                $.log(`账号[${this.index}]  登录成功: [${maskPhone(this.mobilePhone) || "未绑定手机号"}]`);
            } else {
                $.log(`账号[${this.index}]  登录失败❌ ${result.msg || ""}`);
                this.ckStatus = false;
                console.log(result);
            }
        } catch (e) {
            $.log(`账号[${this.index}]  登录异常❌ ${e.response?.data?.msg || e.message || e}`);
            this.ckStatus = false;
        }
    }
    async user_info() {
        let time = Date.now()
        try {
            let options = {
                url: `https://mxsa.mxbc.net/api/v1/customer/info?appId=d82be6bbc1da11eb9dd000163e122ecb&t=${time}&sign=${this.getSHA256withRSA('appId=d82be6bbc1da11eb9dd000163e122ecb&t=' + time)}`,
                headers: {
                    'Host': 'mxsa.mxbc.net',
                    'Connection': 'keep-alive',
                    'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 MicroMessenger/7.0.4.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF',
                    'xweb_xhr': 1,
                    'Access-Token': this.ck,
                    'Content-Type': 'application/json',
                    'Accept': '*/*',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                    'Referer': 'https://servicewechat.com/wx7696c66d2245d107/59/page-frame.html',
                    'Accept-Language': 'en-us,en',
                    'Accept-Encoding': 'gzip, deflate',

                }
            }
            let { data: result } = await axios.request(options);
            if (result.code == 0) {
                this.mobilePhone = result.data.mobilePhone;
                $.log(`账号[${this.index}]  用户CK有效: [${result.data.mobilePhone}] 雪王币剩余[${result.data.customerPoint}]`);
                this.ckStatus = true;
                const _pt = result.data.customerPoint;
                if (_pt != null && _pt !== "" && !isNaN(Number(_pt))) _rpGet(this.index).total = String(_pt);

            } else {
                $.log(`账号[${this.index}]  用户CK失效:,原因未知！`);
                this.ckStatus = false

                console.log(result);
            }
        } catch (e) {
            $.log(`账号[${this.index}]  用户信息校验异常❌ ${e.response?.data?.msg || e.message || e}`);
            this.ckStatus = false
        }
    }
    async getLoginUrl() {
        try {
            let timestamp = Date.now();
            const options = {
                method: 'GET',
                url: `https://mxsa.mxbc.net/api/v1/duiba/getLoginUrl`,
                params: {
                    "appId": "d82be6bbc1da11eb9dd000163e122ecb",
                    "t": timestamp,
                    "sign": this.getSHA256withRSA('appId=d82be6bbc1da11eb9dd000163e122ecb&t=' + timestamp)
                },
                headers: {
                    'Host': 'mxsa.mxbc.net',
                    'Connection': 'keep-alive',
                    'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 MicroMessenger/7.0.4.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF',
                    'xweb_xhr': 1,
                    'Access-Token': '' + this.ck,
                    'Content-Type': 'application/json',
                    'Accept': '*/*',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                    'Referer': 'https://servicewechat.com/wx7696c66d2245d107/59/page-frame.html',
                    'Accept-Language': 'en-us,en',
                    'Accept-Encoding': 'gzip, deflate',

                }
            };

            let { data: res } = await axios.request(options);
            if (res?.code == 0) {
                this.activityOrigin = new URL(res?.data.loginUrl).origin;
                this.activityUrl = res?.data.loginUrl;
                return res?.data.loginUrl;
            } else {
                $.log(`获取跳转Url失败！原因未知！${res.msg}`);

            }

        } catch (e) {
            $.log(`❌获取跳转Url失败！原因为${e}`);
        }
    }
    ObjectKeys2LowerCase(e) { return e = Object.fromEntries(Object.entries(e).map((([e, t]) => [e.toLowerCase(), t]))), new Proxy(e, { get: function (e, t, r) { return Reflect.get(e, t.toLowerCase(), r) }, set: function (e, t, r, n) { return Reflect.set(e, t.toLowerCase(), r, n) } }) }


    //获取活动token
    async getActivityToken() {
        try {
            const opts = {
                method: "GET",
                url: this.activityUrl,
                maxRedirects: 0,
                // 关键点 2: 默认 Axios 认为非 2xx 是错误，需定义 302 为合法状态
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // 允许 302 (或 3xx) 进入 .then
                },
                headers: {}
            }
            let res = await axios.request(opts);

            let headers = this.ObjectKeys2LowerCase(res?.headers);
            //对青龙进行兼容
            let session = Array.isArray(headers['set-cookie']) ? [...new Set(headers['set-cookie'])].join("") : headers['set-cookie'];

            let [wdata4, w_ts, _ac, wdata3, dcustom] = session.match(/(wdata4|w_ts|_ac|wdata3|dcustom)=.+?;/g)
            this.session = wdata4 + w_ts + _ac + wdata3 + dcustom;
            $.log(`✅ 获取活动token成功！`)


        } catch (e) {

            $.log(`⛔️ 获取活动token失败！${e}`);
        }
    }
    async activityIndex() {
        try {
            const opts = {
                url: this.activityOrigin + "/chome/index",
                params: {
                    from: "login",
                    spm: "76177.1.1.1"
                },
                headers: {
                    'Cookie': this.session,

                    'User-Agent': `Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X)mxsa_mxbc`,
                }
            }

            await axios.request(opts);
            $.log(`✅ 访问雪王铺:调用成功!`);
        } catch (e) {

            $.log(`⛔️ 访问雪王铺:调用失败!${e}`);
        }
    }
    async task_signin() {
        try {
            let time = Date.now()
            let options = {
                url: `https://mxsa.mxbc.net/api/v1/customer/signin?appId=d82be6bbc1da11eb9dd000163e122ecb&t=${time}&sign=${this.getSHA256withRSA('appId=d82be6bbc1da11eb9dd000163e122ecb&t=' + time)}`,
                headers: {
                    'Host': 'mxsa.mxbc.net',
                    'Connection': 'keep-alive',
                    'user-agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 MicroMessenger/7.0.4.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF',
                    'xweb_xhr': 1,
                    'Access-Token': this.ck,
                    'Content-Type': 'application/json',
                    'Accept': '*/*',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                    'Referer': 'https://servicewechat.com/wx7696c66d2245d107/59/page-frame.html',
                    'Accept-Language': 'en-us,en',
                    'Accept-Encoding': 'gzip, deflate',

                }
            }
            //console.log(options);
            let { data: result } = await axios.request(options);
            //console.log(result);
            if (result.code == 0) {
                $.log(`账号[${this.index}]  签到成功:累计签到 [${result.data.ruleValueGrowth}]天 本次获得[${result.data.ruleValuePoint}]币`);
                const _rp = _rpGet(this.index);
                _setSign(this.index, "签到成功");
                const ep = extractPoints(result);
                if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "币";
                else if (result.data?.ruleValuePoint != null && !isNaN(Number(result.data.ruleValuePoint))) _rp.earned = "今日+" + result.data.ruleValuePoint + "币";
                if (result.data?.ruleValueGrowth != null && !isNaN(Number(result.data.ruleValueGrowth))) _rp.streak = String(result.data.ruleValueGrowth);
                if (ep.total != null) _rp.total = String(ep.total);
                _setLottery(this.index, _digLottery(result));
                this.ckStatus = true;

            } else {
                const msg = String(result.msg || "");
                if (/已签到|重复|今日已签|已经/.test(msg)) {
                    $.log(`账号[${this.index}]  今日已签到`);
                    _setSign(this.index, "今日已签到");
                } else {
                    $.log(`账号[${this.index}]  签到:失败 ❌ 了呢,原因未知！`);
                    _setSign(this.index, "签到失败: " + msg.slice(0, 40));
                    console.log(result);
                }
            }
        } catch (e) {
            console.log(e);
        }
    }
    getSHA256withRSA(content) {
        const crypto = require("crypto");

        var privateKeyString = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCtypUdHZJKlQ9L
L6lIJSphnhqjke7HclgWuWDRWvzov30du235cCm13mqJ3zziqLCwstdQkuXo9sOP
Ih94t6nzBHTuqYA1whrUnQrKfv9X4/h3QVkzwT+xWflE+KubJZoe+daLKkDeZjVW
nUku8ov0E5vwADACfntEhAwiSZUALX9UgNDTPbj5ESeII+VztZ/KOFsRHMTfDb1G
IR/dAc1mL5uYbh0h2Fa/fxRPgf7eJOeWGiygesl3CWj0Ue13qwX9PcG7klJXfToI
576MY+A7027a0aZ49QhKnysMGhTdtFCksYG0lwPz3bIR16NvlxNLKanc2h+ILTFQ
bMW/Y3DRAgMBAAECggEBAJGTfX6rE6zX2bzASsu9HhgxKN1VU6/L70/xrtEPp4SL
SpHKO9/S/Y1zpsigr86pQYBx/nxm4KFZewx9p+El7/06AX0djOD7HCB2/+AJq3iC
5NF4cvEwclrsJCqLJqxKPiSuYPGnzji9YvaPwArMb0Ff36KVdaHRMw58kfFys5Y2
HvDqh4x+sgMUS7kSEQT4YDzCDPlAoEFgF9rlXnh0UVS6pZtvq3cR7pR4A9hvDgX9
wU6zn1dGdy4MEXIpckuZkhwbqDLmfoHHeJc5RIjRP7WIRh2CodjetgPFE+SV7Sdj
ECmvYJbet4YLg+Qil0OKR9s9S1BbObgcbC9WxUcrTgECgYEA/Yj8BDfxcsPK5ebE
9N2teBFUJuDcHEuM1xp4/tFisoFH90JZJMkVbO19rddAMmdYLTGivWTyPVsM1+9s
tq/NwsFJWHRUiMK7dttGiXuZry+xvq/SAZoitgI8tXdDXMw7368vatr0g6m7ucBK
jZWxSHjK9/KVquVr7BoXFm+YxaECgYEAr3sgVNbr5ovx17YriTqe1FLTLMD5gPrz
ugJj7nypDYY59hLlkrA/TtWbfzE+vfrN3oRIz5OMi9iFk3KXFVJMjGg+M5eO9Y8m
14e791/q1jUuuUH4mc6HttNRNh7TdLg/OGKivE+56LEyFPir45zw/dqwQM3jiwIz
yPz/+bzmfTECgYATxrOhwJtc0FjrReznDMOTMgbWYYPJ0TrTLIVzmvGP6vWqG8rI
S8cYEA5VmQyw4c7G97AyBcW/c3K1BT/9oAj0wA7wj2JoqIfm5YPDBZkfSSEcNqqy
5Ur/13zUytC+VE/3SrrwItQf0QWLn6wxDxQdCw8J+CokgnDAoehbH6lTAQKBgQCE
67T/zpR9279i8CBmIDszBVHkcoALzQtU+H6NpWvATM4WsRWoWUx7AJ56Z+joqtPK
G1WztkYdn/L+TyxWADLvn/6Nwd2N79MyKyScKtGNVFeCCJCwoJp4R/UaE5uErBNn
OH+gOJvPwHj5HavGC5kYENC1Jb+YCiEDu3CB0S6d4QKBgQDGYGEFMZYWqO6+LrfQ
ZNDBLCI2G4+UFP+8ZEuBKy5NkDVqXQhHRbqr9S/OkFu+kEjHLuYSpQsclh6XSDks
5x/hQJNQszLPJoxvGECvz5TN2lJhuyCupS50aGKGqTxKYtiPHpWa8jZyjmanMKnE
dOGyw/X4SFyodv8AEloqd81yGg==
-----END PRIVATE KEY-----
`;

        return crypto
            .createSign("RSA-SHA256")
            .update(content)
            .sign(privateKeyString, "base64")
            .replace(/\//g, "_")
            .replace(/\+/g, "-");

    }







}


const { report: _stdReport, extractPoints } = require("./std_report");
function _digLottery(obj) {
  if (obj == null) return "";
  const flat = (function _f(o, pre, acc) {
    acc = acc || {};
    if (Array.isArray(o)) { o.forEach((v, i) => _f(v, pre ? pre + "." + i : "" + i, acc)); return acc; }
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const nv = o[k]; const nk = pre ? pre + "." + k : k;
        if (nv && typeof nv === "object") _f(nv, nk, acc); else acc[nk.toLowerCase()] = nv;
      }
      return acc;
    }
    if (pre) acc[pre] = obj; return acc;
  })(obj, "", {});
  const keys = Object.keys(flat);
  const hit = (re) => keys.filter(k => re.test(k));
  const lotteryKeys = hit(/lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift/);
  const out = [];
  for (const k of lotteryKeys) {
    let v = flat[k]; if (v == null) continue;
    if (typeof v === "object") v = JSON.stringify(v);
    const s = String(v); if (s && s !== "{}" && s !== "[]") out.push(s);
  }
  return out.join("｜");
}
let _rpRows = [];
let _rpApp = '蜜雪冰城';
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", tasks: [], lottery: "" };
  return _rpRows[idx];
}
function logPoints(todayPoints, totalPoints, app, idx, status) {
  _rpApp = app || _rpApp;
  const r = _rpGet(idx);
  if (status != null && status !== "") r.sign = String(status);
  if (totalPoints != null && totalPoints !== "" && !isNaN(Number(totalPoints))) r.total = String(totalPoints);
  if (todayPoints != null && todayPoints !== "" && !isNaN(Number(todayPoints)) && Number(todayPoints) !== 0) r.earned = "今日+" + todayPoints + "积分";
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null) r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
async function doPush() { /* 由 flushLogPoints 统一经 std_report 推送 */ }
let _rpFlushed = false;
async function flushLogPoints(app) {
  if (_rpFlushed) return;
  _rpApp = app || _rpApp;
  const rows = _rpRows.filter(Boolean);
  if (!rows.length) return;
  _rpFlushed = true;
  await _stdReport(_rpApp, rows);
}
{
  const _oe = process.exit.bind(process);
  process.exit = function (code) {
    const p = flushLogPoints(_rpApp);
    if (p && typeof p.then === 'function') p.then(() => _oe(code)).catch(() => _oe(code));
    else _oe(code);
  };
}
process.on('beforeExit', () => { flushLogPoints(_rpApp); });


!(async () => {
    await getNotice()
    $.checkEnv(ckName);

    for (let user of $.userList) {
        await new Task(user).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000
        }
        let {
            data: res
        } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }

}
