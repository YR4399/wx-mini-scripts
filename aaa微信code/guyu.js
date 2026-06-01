

/*
@Description: 谷雨小程序签到
cron: 30 9 * * 1
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("谷雨小程序");
const WeChatServer = require("./wcs.js");
let ckName = `guyu`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'https://xxx',
    appid: 'wxda948f3be0afc375',
    auth: process.env.wx_auth || "",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.isSign = false
    }

    async run() {
        //随机延迟5-30s 模拟人工操作
        await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.wcsid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            $.log(`账号[${this.index}] 获取用户Token失败❌`)
            return
        }
        await this.signIn()
        await this.getUserPoints()
    }
    async getUserToken(code) {
        let data = JSON.stringify({
            "code": "" + code,
            "appid": "wxda948f3be0afc375",
            "shopId": null,
            "envVersion": "release",
            "isEnterpriseWx": false,
            "scene": 1168,
            "referrerInfo": {
                "appId": "wxda948f3be0afc375"
            }
        });

        let options = {
            method: 'POST',
            url: 'https://mall-mobile-v6.vecrp.com/mobile/wxAppLogin',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json;charset=UTF-8',
                'xweb_xhr': '1',
                'appid': 'wxda948f3be0afc375',
                'token': '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxda948f3be0afc375/65/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };

        let {
            data: result
        } = await axios.request(options);
        console.log(result);

        if (result?.success) {
            this.token = result.result.mobileToken
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.message}❌`)
        }
    }
    sha1(str) {
        return require("crypto").createHash("sha1").update(str).digest("hex");
    }
    request(options) {

        var sign,
            n = void 0
            , d = {},
            l = "R6WbJ830wNsEdjH9GumwKYiYxHz0K9QD",
            n = (new Date).getTime(),
            d = "post" === options.method || "POST" === options.method ? {
                body: JSON.stringify(options.data),
                secretKey: l,
                ts: n
            } : Object.assign({}, options.params, {
                secretKey: l,
                ts: n
            }),
            sign = this.sha1(function (e) {
                var t, a = [];
                for (t in e) {
                    var r = t + e[t];
                    a.push(r)
                }
                a.sort();
                var u = "";
                return a.map((function (e) {
                    "" === u ? u = e : u += e
                }
                )),
                    u
            }(d))
        let baseHeaders = {
            host: "mall-mobile-v6.vecrp.com",
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9",
            "appid": "wxda948f3be0afc375",
            "content-type": "application/json;charset=UTF-8",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027",
            "sign": "" + sign,
            "starttime": "" + n,
            "token": "" + this.token,
            "ts": "" + n,
            "x-tracedid": "" + $.uuid(),
            "xweb_xhr": "1",
            "Referer": "https://servicewechat.com/wxda948f3be0afc375/65/page-frame.html",
        }
        options.headers = Object.assign(options.headers, baseHeaders)

        return axios.request(options)
    }
    async signIn() {
        let options = {
            method: 'POST',
            url: `https://mall-mobile-v6.vecrp.com/mobile/activity/sign/sign`,

            headers: {},
            data: {
                activityId: 'cdd30467-abb8-4944-8941-2879aa950a86',
                shopId: '100186753',
                signDate: $.time(`yyyy-M-dd`),
            }

        };
        let {
            data: result
        } = await this.request(options);
        if (result?.success) {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `签到成功`);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
        }




    }
    async getUserPoints() {
        let options = {
            method: 'GET',
            url: `https://mall-mobile-v6.vecrp.com/mobile/customer/getMyAllPoint`,
            params: {
                shopId: '100186753'
            },
            headers: {},

        }
        let {
            data: result
        } = await this.request(options);
        if (result?.success) {
            $.log(`账号[${this.index}]` + `积分:${result.result[0].score}`);
        } else {
            $.log(`账号[${this.index}] 获取积分-失败:${result.msg}❌`)
        }
    }








}

!(async () => {
    await getNotice()
    $.checkEnv(ckName);
    if (process.env['wx_server_url'] && process.env['wx_auth']) {
        for (let user of $.userList) {
            await new Task(user).run();
        }
    } else {

        $.log(`${ckName}未配置微信SERVER配置 搭建可看仓库目录下的readme.md❌`)
        return
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
