/*
@Description: 五道口小程序签到
cron: 30 9 * * *
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("浓五的酒馆");
const WeChatServer = require("./wcs.js"); 
let ckName = `nwdjg`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wxed3cf95a14b58a26',
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
        this.token = 'Bearer ' + this.token

        await this.getUserInfo()
        await this.doSign()
    }
    async getUserToken(code) {
        let data = ({
            "code": code,
            "appId": "wxed3cf95a14b58a26"
        });

        let options = {
            method: 'POST',
            url: 'https://stdcrm.dtmiller.com/std-weixin-mp-service/miniApp/custom/login',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'authorization': '',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/255/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0') {
            this.token = result.data
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/mini/wly/user/info`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'authorization': '',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/255/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9',
                authorization: this.token
            }

        }
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0') {
            $.log(`🌸账号[${this.index}] 获取用户信息[${result.data.member.mobile}] 积分[${result.data.member.points}]`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/promotion/sign/today?promotionId=PI69cb44d522cc56000aa80bbe`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'authorization': '',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/255/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9',
                authorization: this.token
            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '0') {
            //打印签到结果
            $.log(`签到天数：${sign_data['data']['signDays']}`)
            $.log(`签到成功`);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
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
