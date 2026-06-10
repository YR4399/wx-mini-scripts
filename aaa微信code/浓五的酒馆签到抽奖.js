/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 30 9 * * *
------------------------------------------
#Notice:   
浓五的酒馆 微信小程序 签到得积分 
WeChatCodeServer 填写wx_server_url wx_auth 用于获取code 
变量名称：nwdjg
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

const {
    Env
} = require("../tools/env")
const $ = new Env("浓五的酒馆签到+抽奖");
const WeChatServer = require("./wcs.js");
let ckName = `nwdjg`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wxed3cf95a14b58a26',
    auth: process.env.wx_auth || "your-api-key",
}
);
// 浓友购小程序
let wechatNYG = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wx99fa98e883130aa3',
    auth: process.env.wx_auth || "your-api-key",
}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.points = 0
        this.nygToken = null
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

        // 积分>=84时跳转浓友购小程序抽奖
        if (this.points >= 84) {
            $.log(`🌸账号[${this.index}] 积分[${this.points}]>=84，开始浓友购抽奖任务`)
            await this.doLottery()
        } else {
            $.log(`🌸账号[${this.index}] 积分[${this.points}]<84，跳过抽奖任务`)
        }
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
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'authorization': '',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/260/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            },
            data: data
        };
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0' || result?.code == 0) {
            this.token = result.data
            $.log(`🌸账号[${this.index}] 获取用户Token成功`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }

    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/mini/wly/user/info`,
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/260/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9',
                authorization: this.token
            }
        }
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0' || result?.code == 0) {
            this.points = result.data.member.points
            $.log(`🌸账号[${this.index}] 用户[${result.data.member.mobile}] 积分[${this.points}]`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/promotion/sign/today?promotionId=PI6a168f58584101000a6b2c7f`,
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/260/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9',
                authorization: this.token
            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '0' || result?.code == 0) {
            let signDays = result.data.signDays
            let prizeName = result.data.prize?.prizeName || '未知'
            let today = result.data.today
            if (today) {
                $.log(`🌸账号[${this.index}] 今日已签到，签到天数[${signDays}]，获得[${prizeName}]`)
            } else {
                $.log(`🌸账号[${this.index}] 签到成功✅ 签到天数[${signDays}]，获得[${prizeName}]`)
            }
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
        }
    }

    // 浓友购小程序登录
    async loginNYG() {
        let { data: codeRes } = await wechatNYG.getCode(this.wcsid)
        if (!codeRes.status) {
            $.log(`🌸账号[${this.index}] 获取浓友购code失败❌`)
            return false
        }
        let options = {
            method: 'POST',
            url: 'https://www.wlnxjc.com:8088/app-api/member/auth/weixin-mini-app-login',
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json;charset=UTF-8',
                'platform': 'WechatMiniProgram',
                'tenant-id': '1',
                'terminal': '10',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wx99fa98e883130aa3/49/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            },
            data: {
                "loginCode": codeRes.data.code,
                "state": "default",
                "sourceId": "1"
            }
        };
        let { data: result } = await axios.request(options);
        if (result?.code == 0) {
            this.nygToken = result.data.accessToken
            $.log(`🌸账号[${this.index}] 浓友购登录成功`)
            return true
        } else {
            $.log(`🌸账号[${this.index}] 浓友购登录失败:${result.msg}❌`)
            return false
        }
    }

    // 浓友购抽奖
    async doLottery() {
        let loginOk = await this.loginNYG()
        if (!loginOk) return

        // 查询浓友购积分
        await this.getNYGIntegral()

        let activityId = '2064174568711602177'
        let drawResults = []

        for (let i = 0; i < 3; i++) {
            await $.wait(Math.floor(Math.random() * 3 + 1) * 1000);
            let drawResult = await this.drawOnce(activityId)
            if (drawResult) {
                drawResults.push(drawResult)
                // 领取奖品
                await this.receivePrize(drawResult.recordId)
            } else {
                $.log(`🌸账号[${this.index}] 第${i + 1}次抽奖失败❌`)
            }
        }

        // 输出抽奖结果汇总
        $.log(`\n========== 账号[${this.index}] 抽奖结果汇总 ==========`)
        for (let i = 0; i < drawResults.length; i++) {
            let r = drawResults[i]
            $.log(`  第${i + 1}次: [${r.awardName}] - ${r.prizeName}`)
        }
        $.log(`=========================================\n`)

        // 查询抽奖后积分
        await this.getNYGIntegral()
    }

    // 单次抽奖
    async drawOnce(activityId) {
        let options = {
            method: 'POST',
            url: `https://www.wlnxjc.com:8088/app-api/promotion/activity/draw?activityId=${activityId}`,
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json;charset=UTF-8',
                'authorization': this.nygToken,
                'platform': 'WechatMiniProgram',
                'tenant-id': '1',
                'terminal': '10',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wx99fa98e883130aa3/49/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            },
            data: { "activityId": activityId }
        };
        try {
            let { data: result } = await axios.request(options);
            if (result?.code == 0 && result.data?.lottery) {
                let lottery = result.data.lottery
                $.log(`🌸账号[${this.index}] 抽奖成功: [${lottery.awardName}] - ${lottery.prizeName}`)
                return {
                    recordId: result.data.recordId,
                    awardName: lottery.awardName,
                    prizeName: lottery.prizeName,
                    integral: lottery.integral
                }
            } else {
                $.log(`🌸账号[${this.index}] 抽奖失败:${result?.msg || '未知错误'}❌`)
                return null
            }
        } catch (e) {
            $.log(`🌸账号[${this.index}] 抽奖异常:${e.message}❌`)
            return null
        }
    }

    // 领取奖品
    async receivePrize(recordId) {
        let options = {
            method: 'POST',
            url: 'https://www.wlnxjc.com:8088/app-api/promotion/activity/receive',
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json;charset=UTF-8',
                'authorization': this.nygToken,
                'platform': 'WechatMiniProgram',
                'tenant-id': '1',
                'terminal': '10',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wx99fa98e883130aa3/49/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            },
            data: { "id": recordId }
        };
        try {
            let { data: result } = await axios.request(options);
            if (result?.code == 0) {
                $.log(`🌸账号[${this.index}] 领奖成功`)
            } else {
                $.log(`🌸账号[${this.index}] 领奖失败:${result?.msg}❌`)
            }
        } catch (e) {
            $.log(`🌸账号[${this.index}] 领奖异常:${e.message}❌`)
        }
    }

    // 查询浓友购积分
    async getNYGIntegral() {
        let options = {
            method: 'GET',
            url: 'https://www.wlnxjc.com:8088/app-api/member/integral/get',
            headers: {
                'User-Agent': defaultUserAgent,
                'Content-Type': 'application/json;charset=UTF-8',
                'authorization': this.nygToken,
                'platform': 'WechatMiniProgram',
                'tenant-id': '1',
                'terminal': '10',
                'xweb_xhr': '1',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'cors',
                'sec-fetch-dest': 'empty',
                'referer': 'https://servicewechat.com/wx99fa98e883130aa3/49/page-frame.html',
                'accept-language': 'zh-CN,zh;q=0.9'
            }
        };
        try {
            let { data: result } = await axios.request(options);
            if (result?.code == 0) {
                $.log(`🌸账号[${this.index}] 浓友购积分[${result.data.integral}]`)
            }
        } catch (e) { }
    }
}

!(async () => {
    await getNotice()
    $.checkEnv(ckName);
    if (!$.userList.length || ($.userList.length === 1 && !$.userList[0])) {
      $.checkEnv("wx_opinion");
    }
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
