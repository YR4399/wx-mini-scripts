/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description: 米其林会员 每日任务
cron: 30 9 * * *
------------------------------------------
#Notice:
米其林会员 每日任务
WeChatCodeServer 填写wx_server_url wx_auth 用于获取code
变量名称：miqilin
------------------------------------------
*/

const { Env } = require("../tools/env");
const { ICON, L, sectionLine, humanDelay } = require("./_decor");
const $ = new Env("米其林会员小程序");
const WeChatServer = require("./wcs.js");
const TokenCache = require("./_token_cache");
const path = require("path");
const tokenCache = new TokenCache(path.join(__dirname, "miqilin_token_cache.json"));
const ckName = "miqilin";
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram";
const wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://172.17.0.4:8787',
    appid: 'wx14413dafd16b9540',
    auth: process.env.wx_auth || "your-api-key",
});

class Task {
    constructor(env) {
        this.index = $.userIdx++;
        this.user = env.split(strSplitor);
        this.token = null;
        this.wcsid = this.user[0];
        this.isSign = false;
    }

    async run() {
        const cached = tokenCache.read(this.wcsid);
        if (cached && cached.token && cached.ts && Date.now() - cached.ts < 70000000) {
            this.token = cached.token;
        }

        let { data: codeRes } = await wechat.getCode(this.wcsid);
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code);
        }

        if (!this.token) {
            L.fail("账号[" + this.index + "] 获取用户Token失败❌");
            return;
        }

        this.token = 'Bearer ' + this.token;
        await this.getUserInfo();
        await this.doPaper();
        for (let i = 0; i < 10; i++) {
            await this.share();
        }
    }

    async share() {
        const options = {
            method: 'POST',
            url: 'https://ulp.michelin.com.cn/op/points/share/have',
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001f37) NetType/WIFI Language/zh_CN",
                "Authorization": this.token,
            },
            data: { "type": "ARTICLE", "code": "COM-MHT-93" },
        };
        let { data: result } = await axios.request(options);
        L.ok("转发:" + result?.code != 200 ? "转发失败" + result?.message : "转发成功!" + "");
    }

    async getUserToken(code) {
        let options = {
            method: 'GET',
            url: `https://ulp.michelin.com.cn/bff/wechat/login/${code}`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001f37) NetType/WIFI Language/zh_CN",
                "Referer": "https://servicewechat.com/wx14413dafd16b9540/130/page-frame.html",
            },
        };
        let { data: result } = await axios.request(options);
        this.token = result?.data?.token?.access_token;
        L.ok("🌸账号[" + this.index + "] 获取用户Token成功:" + this.token + "");
    }

    async getUserInfo() {
        try {
            let { data: result } = await axios.request({
                method: 'GET',
                url: 'https://ulp.michelin.com.cn/bff/profile',
                headers: {
                    "Host": "ulp.michelin.com.cn",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                    "Authorization": this.token,
                },
            });
            if (result?.data?.points) {
                L.ok("账号[" + this.index + "] 获取用户积分成功:" + result?.data?.points + "");
            } else {
                L.fail("账号[" + this.index + "] 获取用户积分失败❌");
            }
        } catch (e) {
            this.ckStatus = false;
            console.log(`❌查询积分失败！原因为:${e}`);
        }
    }

    async doPaper() {
        await this.getPaper();
        if (this.paperStatus) {
            await this.getOpenTpaper(this.npsPaperCode);
            let index = 1;
            for (let question of this.questionList) {
                L.info("问题" + index + ":" + question?.questionChoise?.stemHtml + "\n");
                let options = question?.questionChoise?.options;
                for (let option of options) {
                    L.info("- " + option.optionHtml + "");
                }
                let theQuestion = question.questionChoise.npsQuestionPk;
                let detail = this.stdAnswers.find(answer => theQuestion == answer.npsQuestionChoisePk) || {};
                let answer = options.find(o => o.npsQuestionChoiseOptionPk == detail.npsQuestionChoiseOptionPk);
                if (!answer) answer = options[0];
                let answerRes = await this.answer(theQuestion, answer?.npsQuestionChoiseOptionPk);
                L.info("\n答案: " + answer.optionHtml + " => " + answerRes + "");
            }
            await this.paperScore(this.paperCode);
        } else {
            L.info("答题任务:本周奖励领取已达到上限，跳过执行");
        }
    }

    async getPaper() {
        const options = {
            method: 'POST',
            url: 'https://ulp.michelin.com.cn/campaign/paper/user',
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                "Authorization": this.token,
            },
            data: {},
        };
        let { data: result } = await axios.request(options);
        if (result?.code == 200) {
            L.info("帐号[" + this.index + "]本次调查问卷为" + result?.data?.npsPaperCode + "，总共" + result?.data?.questionNum + "道题目,状态为" + result?.data?.status + "");
            if (result?.data?.status == 'DONE') this.paperStatus = false;
            this.npsPaperCode = result?.data?.npsPaperCode;
            this.paperCode = result?.data?.paperCode;
        } else {
            this.ckStatus = false;
        }
    }

    async getOpenTpaper(npsPaperCode) {
        let options = {
            method: 'GET',
            url: `https://ulp.michelin.com.cn/npspaper/nps-admin/open/api/cp/public/get_open_tpaper/${npsPaperCode}`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "",
                "Authorization": this.token,
            },
        };
        let result = await axios.request(options);
        if (result?.success) {
            this.stdAnswers = result?.data?.stdAnswers;
            this.questionList = result?.data?.questionList;
        } else {
            L.fail("🔴帐号[" + this.index + "]获取问卷列表失败！" + result?.message + "");
        }
    }

    async answer(question, answer) {
        try {
            const options = {
                url: 'https://ulp.michelin.com.cn/campaign/paper/user/answer',
                method: 'POST',
                headers: {
                    "Host": "ulp.michelin.com.cn",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                    "Authorization": this.token,
                },
                data: { "answerOptionId": [`${answer}`], "paperCode": `${this.paperCode}`, "questionId": `${question}` },
            };
            let { data: result } = await axios.request(options);
            return result?.code == 200 ? "回答成功！" : `回答失败！${result?.message}`;
        } catch (e) {
            console.log(`❌回答问题失败！原因为:${e}`);
        }
    }

    async paperScore(paperCode) {
        try {
            const options = {
                url: `https://ulp.michelin.com.cn/campaign/paper/score/${paperCode}`,
                data: {},
            };
            let { data: res } = await axios.request(options);
            L.info("提交问卷:本期问卷正确率为" + res?.data?.score + "%,排名" + res.data.rank + "");
        } catch (e) {
            console.log(`❌提交问卷失败！原因为:${e}`);
        }
    }
}

!(async () => {
  sectionLine("米麒麟", "");
    await getNotice();
$.userIdx = 0;
    $.checkEnv(ckName);
    if (process.env['wx_server_url'] && process.env['wx_auth']) {
        for (let user of $.userList) {
            await new Task(user).run();
        }
    } else {
        L.info("" + ckName + "未配置微信SERVER配置 搭建可看仓库目录下的readme.md❌");
        return;
    }
})().catch((e) => console.log(e)).finally(() => { $.sendMsg = async () => {}; $.done(); process.exit(0); });

async function getNotice() {
    try {
        let options = {
            url: 'https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json',
            headers: { "User-Agent": defaultUserAgent },
            timeout: 3000,
        };
        let { data: res } = await axios.request(options);
        $.log(res);
        return res;
    } catch (e) { }
}

// ========== PushPlus 推送 ==========
try {
    const _token = process.env.PLUSPLUS_TOKEN || process.env.PUSHPLUS_TOKEN;
    if (_token) {
        const _axios = require("axios");
        _axios.post("http://www.pushplus.plus/send", {
            token: _token, title: "米其林", content: "米其林执行完成", template: "txt"
        }, { timeout: 15000 }).then(_r => {
            if (_r.data?.code === 200) console.log("PushPlus 推送成功");
            else console.log("PushPlus 推送失败:", _r.data?.msg);
        }).catch(_e => console.log("推送异常:", _e.message));
    }
} catch (_e) { console.log("推送异常:", _e.message); }
// ========== PushPlus 推送结束 ==========