/*
@Description: 泰山小程序签到
cron: 30 9 * * *
*/

const {
    Env
} = require("../tools/env")
const $ = new Env("谢瑞麟小程序签到");
const WeChatServer = require("./wcs.js");
let ckName = `tslj`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wx439d0e0cc6742818',
    auth: process.env.wx_auth || "your-api-key",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.openid = null
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
        if (!this.isSign) await this.doSign()
    }
    async getUserToken(code) {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/auth/login`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "content-type": "application/json",

                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249"
            }
            ,
            data:
                { "code": code }
        }
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0') {
            this.token = result.data.user_info.token
            this.openid = result.data.user_info.openid
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/user/index`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/x-www-form-urlencoded",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: { "openid": this.openid }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '0') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `[${result.data.mobile}] 积分[${result.data.integral}]🎉`);
            for (let task of result.data.task_list) {
                if (task.name == '每日签到') {
                    this.isSign = task.status
                }
            }
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/userSignIn/signIn`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/x-www-form-urlencoded",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site"
            },
            data: { "openid": `${this.openid}` }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '0') {
            //打印签到结果
            const { integral, total_days } = result?.data;
            $.log(`签到成功, 已连续签到 ${total_days} 天, 获得 ${integral} 积分 🎉`);
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
