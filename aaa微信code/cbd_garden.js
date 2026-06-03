/*
@Description: 茶百道果园签到+浇水+做任务
cron: 30 10 * * *
*/

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Env } = require("../tools/env.js");
const axios = require("axios");
const crypto = require("crypto");
axios.defaults.proxy = false;

const $ = new Env("茶百道果园");
const ckName = "wx_opinion";

const MINI_APP_ID = "wx2804355dbf8d15c3";
const API_BASE = "https://chabaidao-gateway2.shuxinyc.com";
const GARDEN_BASE = "https://p7600036286420m9wx-saas.bx-activity.meta-xuantan.com";
const GROUP_ID = "317964";
const MEMBER_SYSTEM_ID = "21";
const PLACE_ID = "7600036286420";
const APP_KEY = "hdzy_scsxzyqyglzxyxgs_pfaeyg";
const SIGN_SECRET = "uh3$Hg&^HK876%gbxVG7f$%p=0M~>s1x";

const UA = "Mozilla/5.0 (Linux; Android 16; M2012K11AC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 Mobile Safari/537.36 XWEB/1460149 MMWEBSDK/20260502 MMWEBID/6067 MicroMessenger/8.0.72.3100(0x28004850) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 miniProgram/wx2804355dbf8d15c3";

class WeChatServer {
    constructor(options) {
        this.serverUrl = (options.url || "http://127.0.0.1:8787").replace(/\/$/, "");
        this.appid = options.appid;
        this.auth = options.auth || "";
    }
    getCode(openid) {
        return axios.post(`${this.serverUrl}/wx/code`, { appid: this.appid, openid }, {
            headers: { auth: this.auth }, timeout: 60000
        });
    }
}

function genNonce(len = 32) {
    const chars = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
    const bytes = crypto.randomBytes(len);
    let s = "";
    for (let i = 0; i < len; i++) s += chars[bytes[i] & 63];
    return s;
}

function genSign(params) {
    const sorted = {};
    Object.keys(params).sort().forEach(k => { sorted[k] = params[k]; });
    let a = "";
    for (const k in sorted) {
        const v = sorted[k];
        a += (typeof v === "object" && v !== null) ? JSON.stringify(v) : String(v);
    }
    return crypto.createHash("md5").update(a + SIGN_SECRET).digest("hex");
}

class Task {
    constructor(user, index) {
        this.user = user;
        this.index = index;
        this.csession = null;
        this.userId = null;
        this.consumerId = null;
        this.treeId = null;
    }

    getLoginHeaders() {
        return {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "CSESSION": this.csession || "",
            "versionCode": "34613",
            "versionName": "3.4.613",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/1154/page-frame.html`,
            "Host": "chabaidao-gateway2.shuxinyc.com",
            "Accept": "*/*",
        };
    }

    getGardenHeaders(method, extraParams = {}) {
        const nonceStr = genNonce();
        const xmTimestamp = Date.now();
        const allParams = { ...extraParams, nonceStr, xmTimestamp };
        if (method.toUpperCase() === "GET" && allParams.functionId) delete allParams.functionId;
        const xmSign = genSign(allParams);

        return {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "versionCode": "34613",
            "versionName": "3.4.613",
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/1154/page-frame.html`,
            "Host": GARDEN_BASE.replace("https://", ""),
            "xmSign": xmSign,
            "xmToken": "",
            "functionId": String(extraParams.functionId || 0),
            "nonceStr": nonceStr,
            "xmTimestamp": String(xmTimestamp),
            "Accept": "*/*",
            "X-Requested-With": "com.tencent.mm",
            "Cookie": this.getCookies(),
        };
    }

    getCookies() {
        return `loginTime=${APP_KEY}=${Date.now()};userId=${APP_KEY}=${this.userId};ls=${APP_KEY}=${this.userId}-1;appKey=${APP_KEY};consumerId=${APP_KEY}=${this.consumerId};placeId=${APP_KEY}=${PLACE_ID};openId=${APP_KEY}=${this.consumerId};unionId=${APP_KEY}=`;
    }

    async login(wechat, openid) {
        // Step 1: 首次登录
        const { data: codeData1 } = await wechat.getCode(openid);
        const code1 = codeData1?.data?.code || codeData1?.code;
        if (!code1) throw new Error("获取code失败");

        const resp1 = await axios.post(`${API_BASE}/hll-auth-client/oauth2/login/get/info`, {
            token: "", groupId: GROUP_ID, memberSystemId: MEMBER_SYSTEM_ID,
            code: code1, appId: MINI_APP_ID, pureSign: true
        }, {
            headers: this.getLoginHeaders(),
            timeout: 30000, validateStatus: () => true
        });

        if (resp1.data?.code !== "000" || !resp1.data?.data?.token) {
            throw new Error(`首次登录失败: ${JSON.stringify(resp1.data)}`);
        }
        this.csession = resp1.data.data.token;
        this.userId = resp1.data.data.userId;
        this.consumerId = resp1.data.data.openId;

        // Step 2: 刷新登录
        await $.wait(800 + Math.random() * 500);
        const { data: codeData2 } = await wechat.getCode(openid);
        const code2 = codeData2?.data?.code || codeData2?.code;
        if (code2) {
            const resp2 = await axios.post(`${API_BASE}/hll-auth-client/oauth2/login/get/info`, {
                token: this.csession, groupId: GROUP_ID, memberSystemId: MEMBER_SYSTEM_ID,
                code: code2, appId: MINI_APP_ID, pureSign: false
            }, {
                headers: this.getLoginHeaders(),
                timeout: 30000, validateStatus: () => true
            });
            if (resp2.data?.code === "000" && resp2.data?.data?.token) {
                this.csession = resp2.data.data.token;
                $.log(`账号[${this.index}] 登录成功`);
            }
        }
    }

    async gardenRequest(path, method = "GET", params = {}, body = null) {
        const url = `${GARDEN_BASE}${path}`;
        const headers = this.getGardenHeaders(method, params);
        const config = { method, url, headers, timeout: 30000, validateStatus: () => true };
        if (method === "GET") config.params = params;
        else config.data = body || {};
        const resp = await axios(config);
        return resp.data;
    }

    async run() {
        const wechat = new WeChatServer({
            url: process.env.wx_server_url || "http://127.0.0.1:8787",
            appid: MINI_APP_ID,
            auth: process.env.wx_auth || ""
        });

        await this.login(wechat, this.user);

        // 1. 获取果园详情
        await $.wait(1000);
        const detail = await this.gardenRequest("/activity/function/getDetail", "GET", { functionId: 100560000 });
        if (detail.code !== "0") {
            $.log(`账号[${this.index}] 获取果园详情失败: ${detail.desc}`);
            return;
        }

        const treeConfig = detail.data?.functionConfig?.treeConfig || {};
        const waterBoxConfig = detail.data?.functionConfig?.waterBoxConfig || {};
        this.treeId = treeConfig.treeId;
        const leftActionCount = treeConfig.leftActionCount || 0;
        const haveWater = treeConfig.haveWater || 0;
        const totalWaterNum = treeConfig.totalWaterNum || 1000;
        const canReceiveCount = waterBoxConfig.canReceiveCount || 0;
        const needWaterCount = waterBoxConfig.needWaterCount || 10;

        $.log(`账号[${this.index}] 果园: 已浇水${totalWaterNum - leftActionCount}/${totalWaterNum}, 水滴${haveWater}, 可领宝箱${canReceiveCount}`);

        // 2. 签到
        await $.wait(800);
        const signDetail = await this.gardenRequest("/activity/function/getDetail", "GET", { functionId: 100560004 });
        if (signDetail.code === "0") {
            const signConfig = signDetail.data?.functionConfig || {};
            const today = new Date().toISOString().slice(0, 10);
            const dateInfo = (signConfig.dateInfoList || []).find(d => d.curDate === today);
            if (dateInfo && dateInfo.signStatus === 0) {
                // 需要签到 - 通过 handleTask 触发
                const handleResult = await this.gardenRequest("/activity/function/task/handleTask", "POST", {}, {});
                if (handleResult.code === "0") {
                    $.log(`账号[${this.index}] 签到成功: ${handleResult.data || ""}`);
                } else {
                    $.log(`账号[${this.index}] 签到: ${handleResult.desc}`);
                }
            } else {
                $.log(`账号[${this.index}] 今日已签到`);
            }
        }

        // 3. 做任务
        await $.wait(800);
        const taskResult = await this.gardenRequest("/activity/function/task/get", "GET", { functionId: 100560001 });
        if (taskResult.code === "0") {
            const taskList = taskResult.data?.taskList || [];
            for (const task of taskList) {
                if (task.status === 1) {
                    // 未完成的任务
                    $.log(`账号[${this.index}] 完成任务: ${task.taskTitle}`);
                    await $.wait(1000 + Math.random() * 1000);
                    const finishResult = await this.gardenRequest("/activity/function/task/finish", "POST", {}, {
                        actOpId: String(task.planId),
                        actionId: 0,
                        actionParams: {},
                        taskId: task.taskId,
                        timestamp: Date.now(),
                        functionId: 100560001
                    });
                    if (finishResult.code === "0") {
                        $.log(`账号[${this.index}] 任务完成: ${task.taskTitle} +${task.rewardNum}水滴`);
                    }
                }
            }
        }

        // 4. 浇水 (最多10次，每次消耗10水滴)
        await $.wait(800);
        // 重新获取水滴数量
        const detail2 = await this.gardenRequest("/activity/function/getDetail", "GET", { functionId: 100560000 });
        let currentWater = detail2.data?.functionConfig?.treeConfig?.haveWater || 0;
        let waterCount = 0;
        const maxWater = 10;

        while (currentWater >= 10 && waterCount < maxWater) {
            await $.wait(1500 + Math.random() * 2000);
            const waterResult = await this.gardenRequest("/activity/tree/watering", "POST", {}, {
                bizType: 10,
                bizId: this.treeId
            });
            if (waterResult.code === "0") {
                waterCount++;
                currentWater -= 10;
                $.log(`账号[${this.index}] 浇水${waterCount}/${maxWater} (剩余${currentWater}水滴)`);
            } else {
                $.log(`账号[${this.index}] 浇水失败: ${waterResult.desc}`);
                break;
            }
        }

        if (waterCount >= maxWater) {
            $.log(`账号[${this.index}] 已浇水${maxWater}次，尝试领取宝箱`);
            await $.wait(1000);
            // 领取宝箱
            const boxResult = await this.gardenRequest("/activity/tree/getWaterBox", "POST", {}, {
                bizType: 10,
                bizId: this.treeId
            });
            if (boxResult.code === "0") {
                $.log(`账号[${this.index}] 领取宝箱成功!`);
            } else {
                $.log(`账号[${this.index}] 领取宝箱: ${boxResult.desc}`);
            }
        }

        // 5. 获取最终状态
        await $.wait(800);
        const finalDetail = await this.gardenRequest("/activity/function/getDetail", "GET", { functionId: 100560000 });
        if (finalDetail.code === "0") {
            const tc = finalDetail.data?.functionConfig?.treeConfig || {};
            $.log(`账号[${this.index}] 最终: 已浇水${(tc.totalWaterNum || 1000) - (tc.leftActionCount || 0)}/${tc.totalWaterNum || 1000}, 水滴${tc.haveWater || 0}`);
        }

        $.log(`账号[${this.index}] 任务完成`);
    }
}

!(async () => {
    $.checkEnv(ckName);
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i], i + 1).run();
        if (i < $.userList.length - 1) await $.wait(5000 + Math.random() * 5000);
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());
