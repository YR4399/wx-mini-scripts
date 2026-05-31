/*
@Description:  
cron: 30 9 * * 1
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("stokke小程序");
const WeChatServer = require("./wcs.js"); 
let ckName = `stokke`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wxe232c36aaca3dc1a',
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


        await this.getUserInfo()
         await this.doSign()
    }
    async getUserToken(code) {
        let data = ({
            "code": code,
            "spread_spid": 0,
            "type": "routine",
            "inviteCode": "",
            "inviteTime": ""
        });

        let options = {
            method: 'POST',
            url: 'https://www.stokkeshop.cn/api/front/wechat/authorize/program/login?code=' + code,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };

        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '200') {
            this.token = result.data.token
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.message}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://www.stokkeshop.cn/api/front/user`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '' + this.token + '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `[${result.data.nickname}] 积分[${result.data.integral}]🎉`);

        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.message}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'POST',
            url: `https://www.stokkeshop.cn/api/front/integral-task/finishWeekSign`,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'Authori-zation': '' + this.token + '',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://servicewechat.com/wxe232c36aaca3dc1a/54/page-frame.html',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            data: {}
        };
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '200') {
            //打印签到结果

            $.log(`签到成功 🎉`);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.message}❌`)
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
