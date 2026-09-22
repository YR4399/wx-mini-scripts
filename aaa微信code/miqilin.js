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
@Description:  
cron: 30 9 * * *
------------------------------------------
#Notice:   
米其林会员 每日任务
WeChatCodeServer 填写wx_server_url wx_auth 用于获取code 
变量名称：miqilin
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
const $ = new Env("米其林会员小程序");
const WeChatServer = require("./wcs.js"); 
let ckName = `miqilin`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://192.168.31.196:12081',
    appid: 'wx14413dafd16b9540',
    auth: process.env.wx_auth || "your-api-key",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.wcsid = this.user[0]
        this.remark = this.user[1] ? this.user[1].trim() : "";
        this.isSign = false
    }

    async run() {
        if (this.remark) _setName(this.index, this.remark);
        //随机延迟5-30s 模拟人工操作
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.wcsid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            $.log(`账号[${this.index}] 获取用户Token失败❌`)
            _setSign(this.index, "登录失败");
            return
        }
        this.token = 'Bearer ' + this.token
        await this.getUserInfo()
        await this.doPaper()
        for (let i = 0; i < 10; i++) {
            await this.share();
        }
        _setSign(this.index, "每日任务执行完成");
    }
    async share() {
        const options = {
            method: 'POST',
            url: `https://ulp.michelin.com.cn/op/points/share/have`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001f37) NetType/WIFI Language/zh_CN",
                "Authorization": this.token,
            },
            data: { "type": "ARTICLE", "code": "COM-MHT-93" }
        };
        //post方法
        let { data: result } = await axios.request(options);

        $.log(`转发:${result?.code != 200 ? "转发失败" + result?.message : "转发成功!"}`)
    }
    async getUserToken(code) {
        let options = {
            method: 'GET',
            url: `https://ulp.michelin.com.cn/bff/wechat/login/${code}`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001f37) NetType/WIFI Language/zh_CN",
                "Referer": "https://servicewechat.com/wx14413dafd16b9540/130/page-frame.html"
            }

        }
        let {
            data: result
        } = await axios.request(options);

        this.token = result?.data?.token?.access_token;
        $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)

    }

    async getUserInfo() {
        try {
            let { data: result } = await axios.request({
                method: 'GET',
                url: `https://ulp.michelin.com.cn/bff/profile`,
                headers: {
                    "Host": "ulp.michelin.com.cn",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                    "Authorization": this.token,
                }
            });


            if (result?.data?.points) {
                $.log(`账号[${this.index}] 获取用户积分成功:${result?.data?.points}`)
                const _rp = _rpGet(this.index);
                const _pt = result.data.points;
                if (_pt != null && _pt !== "" && !isNaN(Number(_pt))) _rp.total = String(_pt);
                const ep = extractPoints(result);
                if (ep.earned != null) _rp.earned = "今日+" + ep.earned + "积分";
            } else {
                $.log(`账号[${this.index}] 获取用户积分失败❌`)
            }


        } catch (e) {
            this.ckStatus = false;
            console.log(`❌查询积分失败！原因为:${e}`);
        }
    }
    async doPaper() {
        //获取问卷
        await this.getPaper();
        //是否已完成问卷
        if (this.paperStatus) {
            //获取本期问卷题目
            await this.getOpenTpaper(this.npsPaperCode);
            let index = 1;
            for (let question of this.questionList) {
                $.log(`问题${index}:${question?.questionChoise?.stemHtml}\n`);
                let options = question?.questionChoise.options;
                for (let option of options) {
                    $.log(`- ${option.optionHtml}`);
                }
                let theQuestion = question.questionChoise.npsQuestionPk;
                //查找对应题目答案
                let detail = this.stdAnswers.find(answer => theQuestion == answer.npsQuestionChoisePk) || {};
                let answer = options.find(o => o.npsQuestionChoiseOptionPk == detail.npsQuestionChoiseOptionPk);
                if (!answer) answer = options[0]; // 如果没有找到匹配的答案，默认选择第一个选项
                //提交答案
                let answerRes = await this.answer(theQuestion, answer?.npsQuestionChoiseOptionPk);
                $.log(`\n答案: ${answer.optionHtml} => ${answerRes}`);
            }
            //提交问卷
            await this.paperScore(this.paperCode);
        } else {
            $.log(`答题任务:本周奖励领取已达到上限，跳过执行`);
        }
    }

    //获取本期答卷
    async getPaper() {

        const options = {
            method: 'POST',
            url: `https://ulp.michelin.com.cn/campaign/paper/user`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                "Authorization": this.token,
            },
            data: {}
        };

        let { data: result } = await axios.request(options);
        if (result?.code == 200) {
            $.log(`帐号[${this.index}]本次调查问卷为${result?.data?.npsPaperCode}，总共${result?.data?.questionNum}道题目,状态为${result?.data?.status}`);
            //如果已经答题，则跳过执行答题任务
            if (result?.data?.status == 'DONE') this.paperStatus = false;
            //获取本期问卷期数
            this.npsPaperCode = result?.data?.npsPaperCode;
            //获取本期问卷验证编号
            this.paperCode = result?.data?.paperCode;
        } else {
            this.ckStatus = false;
        }

    }
    //获取问卷题目
    async getOpenTpaper(npsPaperCode) {

        let options = {
            method: 'GET',
            url: `https://ulp.michelin.com.cn/npspaper/nps-admin/open/api/cp/public/get_open_tpaper/${npsPaperCode}`,
            headers: {
                "Host": "ulp.michelin.com.cn",
                "User-Agent": "",
                "Authorization": this.token,
            }
        }

        //post方法
        let result = await axios.request(options);
        if (result?.success) {
            //答案
            this.stdAnswers = result?.data?.stdAnswers;
            //题目
            this.questionList = result?.data?.questionList;
        } else {
            $.log(`🔴帐号[${this.index}]获取问卷列表失败！${result?.message}`)
        }

    }

    async answer(question, answer) {
        try {
            const options = {
                url: `https://ulp.michelin.com.cn/campaign/paper/user/answer`,
                method: 'POST',
                headers: {
                    "Host": "ulp.michelin.com.cn",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249",
                    "Authorization": this.token,
                },
                data: { "answerOptionId": [`${answer}`], "paperCode": `${this.paperCode}`, "questionId": `${question}` }
            };
            //post方法
            let { data: result } = await axios.request(options);
            return result?.code == 200 ? "回答成功！" : `回答失败！${result?.message}`
        } catch (e) {
            console.log(`❌回答问题失败！原因为:${e}`);
        }
    }

    async paperScore(paperCode) {
        try {
            const options = {
                url: `https://ulp.michelin.com.cn/campaign/paper/score/${paperCode}`,
                data: {}
            };
            //post方法
            let { data: res } = await axios.request(options);
            $.log(`提交问卷:本期问卷正确率为${res?.data?.score}%,排名${res.data.rank}`);
        } catch (e) {
            console.log(`❌提交问卷失败！原因为:${e}`);
        }
    }



}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '米其林';
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
