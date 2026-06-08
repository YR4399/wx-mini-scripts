#!/usr/bin/env node
// 萌叔宝贝鹅基地(优智云家) 签到脚本
// cron: 15 9 * * *
// 变量: wx_opinion (WCS openid, 多账号用&分隔)
// 依赖: wcs.js, _push_helper.js

const { Env } = require("../tools/env");
const { sendPushNotify } = require("./_push_helper");
const WeChatServer = require("./wcs.js");

const $ = new Env("萌叔宝贝鹅基地签到");
const CK_NAME = "wx_opinion";

const APPID = "wxbc996a6b14810c99";
const BASE = "https://smp-api.iyouke.com";
const VERSION = "2.30.6";

const wcs = new WeChatServer({
    url: process.env.wx_server_url || "http://172.17.0.3:8787",
    appid: APPID,
    auth: process.env.wx_auth || "your-api-key",
});

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function headers(token) {
    return {
        "Content-Type": "application/json",
        Authorization: `bearer${token}`,
        appId: APPID,
        version: VERSION,
        envVersion: "release",
        "xy-extra-data": `appid=${APPID};version=${VERSION};envVersion=release;senceId=1007`,
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
    };
}

class Task {
    constructor(openid, idx) {
        this.openid = openid;
        this.idx = idx;
        this.token = null;
        this.points = 0;
        this.seriesDays = 0;
        this.signed = false;
    }

    async run() {
        // WCS 获取 code
        const { data: codeRes } = await wcs.getCode(this.openid);
        if (!codeRes.status) {
            $.log(`[${this.idx}] WCS获取code失败: ${JSON.stringify(codeRes)}`);
            return;
        }

        // code 换 token
        await this.login(codeRes.data.code);
        if (!this.token) return;

        // 查询积分信息
        await this.queryPoints();

        // 查询签到状态
        const signList = await this.querySignList();

        // 检查今日是否已签到
        const today = signList.find((d) => d.isToday);
        if (today && (today.daySignStatus === 2 || today.daySignStatus === 6)) {
            $.log(`[${this.idx}] 今日已签到, 连签${this.seriesDays}天, 积分${this.points}`);
            return;
        }

        // 执行签到
        await this.doSign();
    }

    async login(code) {
        try {
            const axios = require("axios");
            const { data } = await axios.post(
                `${BASE}/dtapi/appLogin`,
                { principal: code, appType: 1 },
                {
                    headers: {
                        "Content-Type": "application/json",
                        appId: APPID,
                        version: VERSION,
                        envVersion: "release",
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
                    },
                    timeout: 10000,
                }
            );
            if (data.access_token) {
                this.token = data.access_token;
                $.log(`[${this.idx}] 登录成功`);
            } else {
                $.log(`[${this.idx}] 登录失败: ${JSON.stringify(data)}`);
            }
        } catch (e) {
            $.log(`[${this.idx}] 登录异常: ${e.message}`);
        }
    }

    async queryPoints() {
        try {
            const axios = require("axios");
            const { data } = await axios.get(`${BASE}/dtapi/pointsSign/user/pointsInfo/query`, {
                headers: headers(this.token),
                timeout: 10000,
            });
            if (data.error === 0 && data.data) {
                this.points = data.data.pointsNums || 0;
                this.seriesDays = data.data.seriesDays || 0;
                this.signed = data.data.signTodayResult || false;
                $.log(`[${this.idx}] 积分=${this.points}, 连签=${this.seriesDays}天`);
            }
        } catch (e) {
            $.log(`[${this.idx}] 查询积分失败: ${e.message}`);
        }
    }

    async querySignList() {
        try {
            const axios = require("axios");
            const { data } = await axios.get(`${BASE}/dtapi/pointsSign/user/sign/list`, {
                params: { v4Flag: true },
                headers: headers(this.token),
                timeout: 10000,
            });
            if (data.error === 0 && data.data) {
                return data.data;
            }
        } catch (e) {
            $.log(`[${this.idx}] 查询签到列表失败: ${e.message}`);
        }
        return [];
    }

    async doSign() {
        try {
            const axios = require("axios");
            const { data } = await axios.get(`${BASE}/dtapi/pointsSign/user/sign`, {
                params: { date: todayStr() },
                headers: headers(this.token),
                timeout: 10000,
            });
            if (data.error === 0 && data.data) {
                const reward = data.data.signReward || 0;
                const extra = data.data.extraSignReward || 0;
                $.log(`[${this.idx}] 签到成功: +${reward}积分${extra > 0 ? ` 额外+${extra}` : ""}, 当前${this.points + reward}积分`);
            } else {
                $.log(`[${this.idx}] 签到失败: ${JSON.stringify(data)}`);
            }
        } catch (e) {
            $.log(`[${this.idx}] 签到异常: ${e.message}`);
        }
    }
}

!(async () => {
    $.sendMsg = async () => {};
    $.checkEnv(CK_NAME);

    const openids = $.userList;
    if (!openids.length) {
        $.log(`未配置 ${CK_NAME}`);
        return;
    }

    $.log(`共${openids.length}个账号`);

    const summaries = [];
    for (let i = 0; i < openids.length; i++) {
        const task = new Task(openids[i], i + 1);
        await task.run();
        summaries.push({
            idx: i + 1,
            points: task.points,
            seriesDays: task.seriesDays,
            signed: task.signed,
        });
        if (i < openids.length - 1) {
            await $.wait(2000);
        }
    }

    // 推送结果
    try {
        const lines = [];
        lines.push("| # | 积分 | 连签 | 签到 |");
        lines.push("|---|------|------|------|");
        for (const s of summaries) {
            lines.push(`| ${s.idx} | ${s.points} | ${s.seriesDays}天 | ${s.signed ? "✅" : "❌"} |`);
        }
        await sendPushNotify("萌叔宝贝鹅基地签到结果", lines.join("\n"));
    } catch (e) {}
    $.done();
})().catch((e) => $.log(e.message || e)).finally(() => {
    $.sendMsg = async () => {};
    $.done();
});
