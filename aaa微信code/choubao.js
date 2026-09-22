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
臭宝乐园 微信小程序 签到得积分 换螺蛳粉
抓https://cb-bags-slb.weinian.com.cn 请求头token 仅支持单账号
WeChatCodeServer 填写wx_server_url wx_auth 用于获取code 因为抓到的有效期很短只有2小时
变量名称：choubaoleyuan
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
const $ = new Env("臭宝乐园");
const WeChatServer = require("./wcs.js");
let ckName = `choubaoleyuan`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.wx_server_url || 'http://host.docker.internal:18788',
    appid: 'wx2206cca563f6f937',
    auth: process.env.wx_auth || "",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.wcsid = this.user[0]
        this.remark = (this.user[1] || "").trim()
    }

    async run() {
       //随机延迟5-30s 模拟人工操作
       if (this.remark) _setName(this.index, this.remark);
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.wcsid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            $.log(`账号[${this.index}] 获取用户Token失败❌`)
            return
        }
        this.token = 'Bearer' + this.token
        await this.getUserInfo()
        await this.track()
        await this.checkSign()
        
    }
    async getUserToken(code) {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/bff/v1/auth/wechatLogin`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "content-type": "application/json",
                "authorization": "Bearer" + this.token
            }
            ,
            data: {
                loginCode: code
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            this.token = result.data
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token}`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/getMemberUser`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `[${result.data.nickName}] 积分[${result.data.points}]🎉`);
    _setName(this.index, this.remark || result.data.nickName);
    if (typeof logPoints === 'function') logPoints(null, result.data.points, "臭宝乐园", this.index);
    const _ep = extractPoints(result.data) || {};
    if (_ep.streak != null) _rpGet(this.index).streak = _ep.streak;
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }
    async track() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/member/v1/memberBuryPoint/add`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: { "appletVersion": "2.0.31", "phoneSystem": "Windows Unknown x64", "phoneModel": "microsoft", "functionName": "签到", "module": "首页", "linkUrl": "pages/signIn/signIn", "secondPage": "" }
        }
        await axios.request(options);
    }
    async checkSign() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/checkSignNum`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: {

            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            await this.signIn()
        } else {

        }




    }

    async signIn() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/daySign`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site"
            },
            data: {

            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `签到成功🎉`);
            const _ep = extractPoints(result.data) || {};
            const _earned = _ep.earned != null ? "今日+" + _ep.earned + "积分" : "";
            _setSign(this.index, "签到成功", _earned, "");
            if (_ep.total != null) _setSign(this.index, null, null, String(_ep.total));
            if (_ep.streak != null) _rpGet(this.index).streak = _ep.streak;
            const _lot = _digLottery(result.data);
            if (_lot) _setLottery(this.index, _lot);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
            _setSign(this.index, "签到失败:" + (result.msg || "未知"), "", "");
        }




    }








}


const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '臭宝乐园';
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
function _digLottery(obj) {
  if (obj == null || typeof obj !== "object") return "";
  const hits = [];
  const keys = ["lottery", "draw", "prize", "raffle", "turntable", "wheel", "转盘", "抽奖", "奖励"];
  const walk = (v, depth) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        const lk = String(k).toLowerCase();
        const hit = keys.some((kk) => lk.includes(kk.toLowerCase()));
        const val = v[k];
        if (hit && val != null && val !== "" && typeof val !== "object") hits.push(`${k}=${val}`);
        if (typeof val === "object") walk(val, depth + 1);
      }
      return;
    }
  };
  walk(obj, 0);
  return hits.length ? hits.join("｜") : "";
}
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
