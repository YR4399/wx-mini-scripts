
/*
@Description:  
cron: 30 9 * * 1
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("可口可乐小程序");
const WeChatServer = require("./wcs.js");
let ckName = `kekoukele`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wxa5811e0426a94686',
    auth: process.env.wx_auth || "your-api-key",

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
        await this.userInfo()
        await this.addSign()
    }
    async getUserToken(code) {
        let options = {
            method: 'GET',
            url: 'https://member-api.icoke.cn/api/sp-portal/store/icoke/wechat/loginNoCache/' + code,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Accept': 'application/json, text/plain, */*',
                'xweb_xhr': '1',
                'Content-Type': 'application/json',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxa5811e0426a94686/496/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        };

        let {
            data: result
        } = await axios.request(options);

        if (result?.jwtString) {
            this.token = result?.jwtString
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.message}❌`)
        }
    }
    async addSign() {
        let options = {
            method: "GET",
            url: "https://member-api.icoke.cn/api/icoke-sign/icoke/mini/sign/main/sign",
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token,
                "content-type": "application/json",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "xweb_xhr": "1",
                "Referer": "https://servicewechat.com/wxa5811e0426a94686/421/page-frame.html",
                "Referrer-Policy": "unsafe-url"
            },

        }
        try {
            let { data: res } = await axios.request(options);
            if (res.success == true) {
                $.log(`签到成功 获得【${res.point}】快乐瓶`)
            } else {
                $.log(`签到失败`)
                console.log(res);
            }
        } catch (e) {
            console.log(e);

        }
    }
    async userInfo() {
        let options = {
            method: "GET",
            url: "https://member-api.icoke.cn/api/icoke-customer/icoke/mini/customer/main/points",
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token,
                "content-type": "application/json",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "xweb_xhr": "1",
                "Referer": "https://servicewechat.com/wxa5811e0426a94686/421/page-frame.html",
                "Referrer-Policy": "unsafe-url"
            },

        }
        try {
            let { data: res } = await axios.request(options);
            $.log(`目前还剩【${res.point}】瓶 `)

        } catch (e) {
            console.log(e);

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
