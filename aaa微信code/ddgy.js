/**
 * 多多果园自动化脚本 v1.0
 * 功能：偷水5次、浇水种树、签到领化肥、打卡、一日三餐领水
 * 环境变量：DDGY_ACCOUNTS (openid列表，多账号用&分隔)
 *           wx_server_url / wx_server_url (WCS地址)
 *           wx_auth / wx_auth (WCS认证)
 *
 * API 接口说明：
 *   POST /manor/steal/water - 偷水 (friend_uid, steal_type)
 *   POST /manor/common/water/gain - 领取水滴 (type/activityId)
 *   POST /manor/water/cost - 浇水种树 (cost_water_amount)
 *   POST /manor/common/apply/activity - 签到/打卡 (type)
 *   POST /manor/mission/list - 任务列表
 *   POST /manor/mission/complete - 完成任务 (mission_type)
 *   POST /manor/mission/complete/gain - 领取奖励 (mission_type)
 *   POST /manor-query/proxy/friend/home/page - 获取好友列表
 *   POST /manor/report - 上报
 */
const axios = require("axios");
// __NET_RETRY__
axios.interceptors.response.use(
  (r) => r,
  async (e) => {
    const cfg = e.config || {};
    cfg.__rc = (cfg.__rc || 0) + 1;
    const m = String((e && (e.message || e.code)) || "");
    const net = !e.response && /timeout|ECONNABORTED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang|network|connection/i.test(m);
    if (net && cfg.__rc <= 3) {
      await new Promise((s) => setTimeout(s, 2000 * cfg.__rc));
      const { __rc, ...rest } = cfg;
      return axios.request(rest);
    }
    throw e;
  }
);
const https = require("https");

// 禁用代理（容器内直连WCS）
require("https").globalAgent.options.rejectUnauthorized = false;
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

// ============== 配置 ==============
const APP_ID = "wx32540bd863b27570";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841 miniProgram/wx32540bd863b27570";
const BASE_URL = "https://mobile.yangkeduo.com/proxy/api/api";

// ============== 推送 ==============
async function sendPush(title, message) {
  console.log(`[Push→std_report] ${title}`);
}

// ============== 核心客户端 ==============
class PDDClient {
  constructor(openid, wxServerUrl, wxAuth, presetCookies, presetPdduid, index) {
    const _parts = String(openid || "").split("#");
    this.openid = _parts[0].trim();
    this.remark = (_parts[1] || "").trim();
    this.index = index || 1;
    this.wxServerUrl = wxServerUrl;
    this.wxAuth = wxAuth;
    this.pdduid = presetPdduid || null;
    this.tubetoken = null;
    this.cookies = presetCookies || "";
    this.agent = new https.Agent({ rejectUnauthorized: false });
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** WCS 获取微信 code */
  async getWxCode() {
    const resp = await axios.post(
      `${this.wxServerUrl}/wx/code`,
      { openid: this.openid, appid: APP_ID },
      {
        headers: {
          "Content-Type": "application/json",
          auth: this.wxAuth,
        },
        timeout: 15000,
        httpsAgent: this.agent,
      }
    );
    if (resp.data && resp.data.data && resp.data.data.code) return resp.data.data.code;
    throw new Error(`获取code失败: ${JSON.stringify(resp.data)}`);
  }

  /** 登录果园 */
  async login() {
    // 如果已有预设 cookie，直接使用
    if (this.cookies && this.pdduid) {
      console.log(`[${this.openid.slice(-8)}] 使用预设Cookie...`);

      // 从 cookie 提取 tubetoken
      const tMatch = this.cookies.match(/tubetoken=([^;]+)/);
      if (tMatch) this.tubetoken = decodeURIComponent(tMatch[1]);

      if (this.tubetoken) {
        console.log(`[${this.openid.slice(-8)}] 预设Cookie有效, pdduid=${this.pdduid}`);
        return;
      }

      // 尝试用预设cookie获取tubetoken
      try {
        const friendData = await this.getFriendHomePage();
        if (friendData.tubetoken) {
          this.tubetoken = friendData.tubetoken;
          console.log(`[${this.openid.slice(-8)}] 预设Cookie有效, pdduid=${this.pdduid}`);
          return;
        }
      } catch (e) {
        console.log(`[${this.openid.slice(-8)}] 预设Cookie无效: ${e.message}`);
        this.cookies = "";
        this.pdduid = null;
      }
    }

    // 预设 cookie 无效，尝试 WCS 登录
    console.log(`[${this.openid.slice(-8)}] 尝试WCS登录...`);

    // 1. 获取 WCS code
    const code = await this.getWxCode();
    console.log(`[${this.openid.slice(-8)}] WCS code: ${code.slice(0, 12)}...`);

    const cookieMap = {};

    // 3. POST login → verify 流程（带正确anti-content）
    const antiContent = "3akAfa5e-eCEX5UEs2UX39qnGgon0ToXpmxn5EonGBYy0dYOq9xnqPxX0TjX0tqXpTYXWv5M48dI4PmtfJ9EkfM1BAKejed7KLeF3fW7OxVdlzekcVHUcWZFRtmzcewB-7crsWHgeUvv-fTzfP7LwH31DSz99QF6X98";

    // 3a. POST login
    let loginResult = null;
    let loginCookies = [];
    try {
      const loginResp = await axios.post(
        `https://api.pinduoduo.com/login?xcx=20161201&xcx_version=v8.6.21&xcx_hash=${Date.now()}`,
        { code, has_auth: false, app_id: 33, support_enhance_type: 3, anti_content: antiContent, xcx_version: "v8.6.21" },
        {
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json;charset=UTF-8",
            Accept: "*/*",
            Referer: "https://servicewechat.com/wx32540bd863b27570/1840/page-frame.html",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
            "HD-XCX-MODEL": "microsoft",
            "X-XCX-QUERIES": "mini_program_name=pdd;mp_theme_version=v8.6.21",
            Cookie: Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; "),
          },
          httpsAgent: this.agent,
          validateStatus: () => true,
          timeout: 15000,
        }
      );
      loginResult = loginResp.data;
      loginCookies = loginResp.headers["set-cookie"] || [];
      console.log(`[${this.openid.slice(-8)}] POST login: ${JSON.stringify(loginResult).slice(0, 200)}`);
      console.log(`[${this.openid.slice(-8)}] POST login cookies: ${JSON.stringify(loginCookies)}`);

      for (const c of loginCookies) {
        const [nameVal] = c.split(";");
        const [name, val] = nameVal.split("=");
        cookieMap[name.trim()] = val?.trim() || "";
      }

      // 3b. 如果54002需要verify
      if (loginResult.error_code === 54002 && loginResult.verify_auth_token) {
        console.log(`[${this.openid.slice(-8)}] 54002, verifying...`);
        try {
          const verifyResp = await axios.post(
            `https://api.pinduoduo.com/verify/login?xcx=20161201&xcx_version=v8.6.21&xcx_hash=${Date.now()}&verify_auth_token=${loginResult.verify_auth_token}`,
            { code, has_auth: false, app_id: 33, support_enhance_type: 3, anti_content: antiContent, xcx_version: "v8.6.21" },
            {
              headers: {
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json;charset=UTF-8",
                Accept: "*/*",
                Referer: "https://servicewechat.com/wx32540bd863b27570/1840/page-frame.html",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "cross-site",
                "HD-XCX-MODEL": "microsoft",
                "X-XCX-QUERIES": "mini_program_name=pdd;mp_theme_version=v8.6.21",
                Cookie: Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; "),
              },
              httpsAgent: this.agent,
              validateStatus: () => true,
              timeout: 15000,
            }
          );
          loginResult = verifyResp.data;
          loginCookies = verifyResp.headers["set-cookie"] || [];
          console.log(`[${this.openid.slice(-8)}] verify: ${JSON.stringify(loginResult).slice(0, 200)}`);
          console.log(`[${this.openid.slice(-8)}] verify cookies: ${JSON.stringify(loginCookies)}`);

          for (const c of loginCookies) {
            const [nameVal] = c.split(";");
            const [name, val] = nameVal.split("=");
            cookieMap[name.trim()] = val?.trim() || "";
          }
        } catch (e) {
          console.log(`[${this.openid.slice(-8)}] verify error: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[${this.openid.slice(-8)}] POST login error: ${e.message}`);
    }

    // 4. 从登录响应提取 uid
    if (loginResult && loginResult.uid) {
      this.pdduid = String(loginResult.uid);
    }

    // 5. 构建完整cookie
    this.cookies = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");
    if (loginResult && loginResult.access_token) {
      this.cookies += `; PDDAccessToken=${loginResult.access_token}`;
    }
    if (loginResult && loginResult.uin) {
      this.cookies += `; pdd_user_uin=${loginResult.uin}`;
    }
    console.log(`[${this.openid.slice(-8)}] pdduid=${this.pdduid}, token=${loginResult?.access_token ? "有" : "无"}`);

    // 6. 获取tubetoken
    try {
      const friendData = await this.getFriendHomePage();
      if (friendData.tubetoken) this.tubetoken = friendData.tubetoken;
      if (friendData.pdd_user_id && !this.pdduid) this.pdduid = String(friendData.pdd_user_id);
    } catch (e) {
      console.log(`[${this.openid.slice(-8)}] tubetoken失败: ${e.message}`);
    }

    if (!this.pdduid || !this.tubetoken) {
      throw new Error(
        `WCS登录失败(PDD返回40003)。当前PDD反爬机制无法通过WCS自动登录。\n\n` +
        `请手动获取Cookie:\n` +
        `1. 打开浏览器访问 https://mobile.yangkeduo.com/garden_index_lz_0.html\n` +
        `2. F12打开开发者工具 → Network面板\n` +
        `3. 找到任意manor开头的API请求(如 manor-query/proxy/friend/home/page)\n` +
        `4. 复制该请求的完整Cookie值\n\n` +
        `然后在呆呆面板设置环境变量:\n` +
        `  DDGY_COOKIES = <完整Cookie>\n` +
        `  DDGY_PDDUID = <pdd_user_id的值>\n\n` +
        `Cookie格式示例: api_uid=xxx; pdd_user_id=123; pdd_user_uin=xxx; PDDAccessToken=xxx; tubetoken=xxx; pdd_vds=xxx`
      );
    }

    console.log(`[${this.openid.slice(-8)}] 登录成功, pdduid=${this.pdduid}`);
  }

  /** 发起 API 请求 */
  async request(path, data = {}) {
    const body = { ...data, tubetoken: this.tubetoken, fun_pl: 2 };

    const resp = await axios.post(
      `${BASE_URL}${path}?pdduid=${this.pdduid}`,
      body,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json;charset=UTF-8",
          Cookie: this.cookies,
          Origin: "https://mobile.yangkeduo.com",
          Referer: "https://mobile.yangkeduo.com/garden_index_lz_0.html",
          Accept: "application/json, text/plain, */*",
        },
        timeout: 15000,
        httpsAgent: this.agent,
        validateStatus: () => true,
      }
    );

    // 更新 tubetoken
    if (resp.data && resp.data.tubetoken) this.tubetoken = resp.data.tubetoken;

    // 更新 cookies
    const newCookies = resp.headers["set-cookie"] || [];
    if (newCookies.length > 0) {
      this.cookies = newCookies.map((c) => c.split(";")[0].trim()).join("; ");
      const m = this.cookies.match(/pdd_user_id=(\d+)/);
      if (m) this.pdduid = m[1];
    }

    return resp.data;
  }

  /** 获取好友列表 */
  async getFriendHomePage() {
    return await this.request("/manor-query/proxy/friend/home/page", {});
  }

  /** 偷水 */
  async stealWater(friendUid) {
    return await this.request("/manor/steal/water", {
      friend_uid: friendUid,
      steal_type: 10,
      dog_status: 2,
    });
  }

  /** 浇水种树 */
  async waterTree(amount = 30) {
    return await this.request("/manor/water/cost", {
      screen_token: "",
      atw: false,
      location_auth: false,
      last_stay_time: 74,
      can_trigger_random_mission: false,
      product_scene: 0,
      minor: false,
      ext_params: { can_trigger201824: true },
      mission_type: 0,
      cost_water_amount: amount,
      merge_cost: true,
      fun_id: "wechat_app_home",
      lower_end_device: false,
      cost_water_competition_in_scene_icon: false,
      is_small_screen: true,
    });
  }

  /** 领取水滴 */
  async gainWater(type) {
    return await this.request("/manor/common/water/gain", {
      fun_id: "wechat_app_home",
      type,
      params: { activityId: type },
    });
  }

  /** 签到/打卡 */
  async applyActivity(type, params = {}) {
    return await this.request("/manor/common/apply/activity", {
      type,
      params,
    });
  }

  /** 获取任务列表 */
  async getMissionList() {
    return await this.request("/manor/mission/list", {
      mission_types: [],
      source: "friend_home_page",
      activity_id_list: [
        201427, 201423, 200332, 200144, 200338, 200217, 200214,
        200250, 200251, 201763, 202003, 201011, 201816,
      ],
      fun_id: "wechat_app_home",
    });
  }

  /** 完成任务 */
  async completeMission(missionType) {
    return await this.request("/manor/mission/complete", {
      mission_type: missionType,
    });
  }

  /** 领取任务奖励 */
  async gainMissionReward(missionType) {
    return await this.request("/manor/mission/complete/gain", {
      mission_type: missionType,
      gain_time: 1,
      no_reward: false,
      store_to_water_bag: false,
    });
  }

  /** 上报 */
  async report() {
    return await this.request("/manor/report", {});
  }

  // ========== 业务方法 ==========

  /**
   * 偷水5次
   * 逻辑：通过 robot_steal_status_map 获取每个好友的偷水状态
   * status: 1=可偷, 2=已偷过, 3=冷却中
   * statusMap 的 key 即为 friend_uid
   */
  async stealWater5Times() {
    console.log(`[${this.openid.slice(-8)}] 开始偷水...`);
    let stealCount = 0;
    let totalStolen = 0;
    const results = [];

    // 获取好友状态
    let friendData;
    try {
      friendData = await this.getFriendHomePage();
    } catch (e) {
      console.log(`  [失败] 获取好友列表: ${e.message}`);
      return results;
    }

    const activity201423 =
      (friendData.activity_vo_map || {})["201423"] || {};
    if (!activity201423.robots) {
      console.log(`  [失败] 未找到好友列表`);
      return results;
    }

    let statusMap = activity201423.robot_steal_status_map || {};

    // 尝试偷水直到5次或无法继续
    let consecutiveFailures = 0;
    while (stealCount < 5 && consecutiveFailures < 8) {
      // 查找可偷水的好友 (status === 1)
      let stoleThisRound = false;

      for (const [friendUid, sdata] of Object.entries(statusMap)) {
        if (stealCount >= 5) break;
        if (!sdata.steal_water_status) continue;

        const st = sdata.steal_water_status;
        if (st.status !== 1) continue; // 只偷 status===1 的

        try {
          const result = await this.stealWater(parseInt(friendUid));
          const amount = result.steal_amount || result.water_amount || 0;
          totalStolen += amount;
          stealCount++;
          stoleThisRound = true;
          consecutiveFailures = 0;

          // 找到好友名
          const nickName = this._findNickName(friendUid, activity201423.robots);
          results.push(`偷水 ${nickName || friendUid}: +${amount}💧`);
          console.log(
            `  [成功] 偷水 ${nickName || friendUid}: +${amount}💧 (第${stealCount}/5次)`
          );

          // 偷水后刷新状态
          friendData = await this.getFriendHomePage();
          if (friendData.activity_vo_map && friendData.activity_vo_map["201423"]) {
            Object.assign(activity201423, friendData.activity_vo_map["201423"]);
            statusMap = activity201423.robot_steal_status_map || {};
          }
          break;
        } catch (e) {
          console.log(`  [失败] 偷水 ${friendUid}: ${e.message}`);
          consecutiveFailures++;
        }
      }

      if (!stoleThisRound) {
        consecutiveFailures++;
        console.log(`  所有好友暂不可偷，等待刷新...`);
        await this.sleep(3000);

        try {
          friendData = await this.getFriendHomePage();
          if (friendData.activity_vo_map && friendData.activity_vo_map["201423"]) {
            Object.assign(activity201423, friendData.activity_vo_map["201423"]);
            statusMap = activity201423.robot_steal_status_map || {};
          }
        } catch (e) {
          // ignore
        }
      }
    }

    console.log(
      `[${this.openid.slice(-8)}] 偷水完成: 共偷 ${stealCount}/5 次, 获得 ${totalStolen}💧`
    );
    return results;
  }

  _findNickName(uid, robots) {
    // statusMap key 是好友 uid，需要从 robots 列表中匹配
    // 但 robots 没有 uid 字段，只有 avatar 和 nick_name
    // 所以直接用 uid 作为标识
    return null;
  }

  /**
   * 浇水种树 - 尽可能多地浇水
   */
  async doWaterTree() {
    console.log(`[${this.openid.slice(-8)}] 开始浇水...`);
    const results = [];
    let totalWatered = 0;
    let totalCost = 0;

    // 先获取当前水滴量
    let waterAmount = null;
    try {
      const friendData = await this.getFriendHomePage();
      waterAmount = friendData.water_amount || null;
    } catch (e) {
      // ignore
    }

    // 最多浇20次，每次30💧
    for (let i = 0; i < 20; i++) {
      try {
        const result = await this.waterTree(30);
        const nowAmount = result.now_water_amount || 0;
        const progress = result.product ? result.product.progress : null;
        totalWatered++;
        totalCost += 30;

        if (i === 0 || i === totalWatered - 1 || totalWatered <= 3) {
          results.push(
            `第${totalWatered}次浇水30💧, 剩余:${nowAmount}, 进度:${progress || "-"}`
          );
          console.log(
            `  [浇水] 第${totalWatered}次: +30💧, 剩余:${nowAmount}, 进度:${progress || "-"}`
          );
        }

        // 如果水滴不足，停止
        if (nowAmount < 30) break;

        await this.sleep(500);
      } catch (e) {
        console.log(`  [失败] 浇水: ${e.message}`);
        results.push(`浇水失败: ${e.message}`);
        break;
      }
    }

    console.log(
      `[${this.openid.slice(-8)}] 浇水完成: 共浇 ${totalWatered} 次, 消耗 ${totalCost}💧`
    );
    return results;
  }

  /**
   * 一日三餐领水 + 任务奖励领取
   */
  async doThreeMealsWater() {
    console.log(`[${this.openid.slice(-8)}] 开始一日三餐领水...`);
    const results = [];
    let totalGained = 0;

    // 1. 基础领水 (activityId 201429)
    try {
      const result = await this.gainWater(201429);
      const waterAmount = result.water_amount || 0;
      totalGained += waterAmount;
      results.push(`基础领水: 当前水滴${waterAmount}💧`);
      console.log(`  [成功] 基础领水: 当前水滴${waterAmount}💧`);
    } catch (e) {
      console.log(`  [失败] 基础领水: ${e.message}`);
      results.push(`基础领水失败: ${e.message}`);
    }

    await this.sleep(1000);

    // 2. 通过 mission 领取可领奖的任务奖励
    try {
      const missions = await this.getMissionList();
      if (missions && missions.mission_list) {
        const mList = missions.mission_list;
        for (const [mtype, mdata] of Object.entries(mList)) {
          if (mdata.unified_status === 250) {
            try {
              const reward = await this.gainMissionReward(parseInt(mtype));
              if (reward && reward.reward_list && reward.reward_list.length > 0) {
                const r = reward.reward_list[0];
                const rewardType = r.reward_type === 1 ? "水滴" : `类型${r.reward_type}`;
                results.push(
                  `领取任务奖励(type=${mtype}): +${r.reward_amount}${rewardType}`
                );
                totalGained += r.reward_amount || 0;
                console.log(
                  `  [成功] 领取任务(type=${mtype}): +${r.reward_amount}${rewardType}`
                );
              }
            } catch (e) {
              // ignore
            }
          }
        }
      }
    } catch (e) {
      console.log(`  [失败] 获取任务列表: ${e.message}`);
    }

    // 3. 尝试完成更多任务并领奖
    try {
      const missions = await this.getMissionList();
      if (missions && missions.mission_list) {
        const mList = missions.mission_list;
        for (const [mtype, mdata] of Object.entries(mList)) {
          // unified_status: 200=进行中可完成
          if (mdata.unified_status === 200) {
            try {
              const completeResult = await this.completeMission(parseInt(mtype));
              if (completeResult && completeResult.result === true) {
                results.push(`完成任务(type=${mtype}): 成功`);
                console.log(`  [成功] 完成任务(type=${mtype}): 成功`);

                try {
                  const reward = await this.gainMissionReward(parseInt(mtype));
                  if (reward && reward.reward_list && reward.reward_list.length > 0) {
                    const r = reward.reward_list[0];
                    const rewardType = r.reward_type === 1 ? "水滴" : `类型${r.reward_type}`;
                    results.push(`  领取奖励: +${r.reward_amount}${rewardType}`);
                    totalGained += r.reward_amount || 0;
                  }
                } catch (e) {
                  // ignore
                }
              }
            } catch (e) {
              // ignore
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }

    console.log(
      `[${this.openid.slice(-8)}] 领水完成, 共获得 ${totalGained}💧`
    );
    return results;
  }

  /**
   * 签到/打卡
   */
  async doSignIn() {
    console.log(`[${this.openid.slice(-8)}] 开始签到/打卡...`);
    _setSign(this.index, "签到成功", "", null);
    let _water = 0;
    const results = [];

    // 打卡 type
    const signInTypes = [201446, 201423];
    for (const type of signInTypes) {
      try {
        const result = await this.applyActivity(type, {});
        const status = result.status;
        const waterAmount = result.water_amount || 0;
        _water += Number(waterAmount) || 0;
        const _ep = extractPoints(result) || {};
        if (_ep.total != null) _setSign(this.index, null, null, String(_ep.total));
        if (_ep.streak != null) _rpGet(this.index).streak = _ep.streak;
        const _lot = _digLottery(result);
        if (_lot) _setLottery(this.index, _lot);
        if (status === 1) {
          results.push(`打卡(type=${type}): 成功, 水滴:${waterAmount}💧`);
          console.log(
            `  [成功] 打卡(type=${type}): 成功, 水滴:${waterAmount}💧`
          );
        } else {
          results.push(`打卡(type=${type}): 已打卡/不可打卡`);
          console.log(
            `  [提示] 打卡(type=${type}): 已打卡/不可打卡`
          );
        }
      } catch (e) {
        console.log(`  [失败] 打卡(type=${type}): ${e.message}`);
        results.push(`打卡(type=${type})失败: ${e.message}`);
      }
      await this.sleep(1000);
    }

    // 尝试完成签到相关任务
    const signInMissionTypes = [36069, 37210, 38199];
    for (const mtype of signInMissionTypes) {
      try {
        const completeResult = await this.completeMission(mtype);
        if (completeResult && completeResult.result === true) {
          results.push(`完成任务(missionType=${mtype}): 成功`);
          console.log(`  [成功] 完成任务(missionType=${mtype}): 成功`);

          try {
            const reward = await this.gainMissionReward(mtype);
            if (reward && reward.reward_list && reward.reward_list.length > 0) {
              const r = reward.reward_list[0];
              results.push(`  领取奖励: +${r.reward_amount}`);
            }
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {
        // ignore - 任务可能不可完成
      }
      await this.sleep(500);
    }

    if (_water > 0) _setSign(this.index, "签到成功", "今日+" + _water + "💧", null);
    return results;
  }
  async run() {
    const allResults = [];

    try {
      // 登录
      await this.login();

      // 1. 一日三餐领水 + 任务奖励
      const waterResults = await this.doThreeMealsWater();
      allResults.push(...waterResults.map((r) => `[领水] ${r}`));

      // 2. 偷水5次
      const stealResults = await this.stealWater5Times();
      allResults.push(...stealResults.map((r) => `[偷水] ${r}`));

      // 3. 浇水种树
      const waterTreeResults = await this.doWaterTree();
      allResults.push(...waterTreeResults.map((r) => `[浇水] ${r}`));

      // 4. 签到/打卡
      const signInResults = await this.doSignIn();
      allResults.push(...signInResults.map((r) => `[签到] ${r}`));

      // 5. 上报
      try {
        await this.report();
        allResults.push("[上报] 成功");
      } catch (e) {
        allResults.push(`[上报] 失败: ${e.message}`);
      }

      return {
        openid: this.openid,
        pdduid: this.pdduid,
        success: true,
        results: allResults,
      };
    } catch (e) {
      return {
        openid: this.openid,
        pdduid: this.pdduid,
        success: false,
        error: e.message,
        results: allResults,
      };
    }
  }
}

// ============== 入口 ==============

const { report: _stdReport, extractPoints } = require("./std_report");
let _rpRows = [];
let _rpApp = '多多果园';
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


async function main() {
  const wxServerUrl =
    process.env.wx_server_url ||
    process.env.wx_server_url ||
    process.env.WXCODEURL ||
    process.env.wx_server_url;
  const wxAuth =
    process.env.wx_auth ||
    process.env.wx_auth ||
    process.env.WX_SERVER_APIKEY;

  if (!wxServerUrl || !wxAuth) {
    console.error("缺少环境变量: wx_server_url 和 wx_auth");
    process.exit(1);
  }

  // 从环境变量读取预设 cookie
  const presetCookies = process.env.DDGY_COOKIES || "";
  const presetPdduid = process.env.DDGY_PDDUID || "";

  // 解析账号
  const accounts = (process.env.DDGY_ACCOUNTS || "").split("&").filter(Boolean);
  if (accounts.length === 0) {
    const wechatAccounts = (process.env.wx_opinion || "").split("&").filter(Boolean);
    accounts.push(...wechatAccounts);
  }

  if (accounts.length === 0) {
    console.error("缺少账号环境变量: DDGY_ACCOUNTS 或 wx_opinion");
    process.exit(1);
  }

  console.log(`= 多多果园 = 账号数: ${accounts.length}`);
  if (presetCookies) console.log(`  使用预设Cookie, pdduid=${presetPdduid}`);
  const allResults = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const client = new PDDClient(account, wxServerUrl, wxAuth, presetCookies, presetPdduid, i + 1);
    _setName(i + 1, client.remark || client.openid);
    const result = await client.run();
    allResults.push(result);

    const status = result.success ? "✅" : "❌";
    console.log(
      `\n${status} 账号 ${account.slice(-8)} (pdduid:${result.pdduid || "-"})`
    );
    if (result.error) {
      console.log(`  错误: ${result.error}`);
    }
    result.results.forEach((r) => console.log(`  ${r}`));

    await client.sleep(3000);
  }

  // 推送
  const pushMsg = allResults
    .map((r) => {
      const prefix = r.success ? "✅" : "❌";
      const lines = r.results.length > 0 ? `\n${r.results.join("\n")}` : "";
      return `${prefix} ${r.openid.slice(-8)}${lines}`;
    })
    .join("\n\n");

  // 推送统一走 std_report 双引擎（钉钉 markdown），由 beforeExit 钩子触发
  console.log("\n= 执行完成 =");
}

main().catch((e) => {
  console.error("脚本执行异常:", e);
  process.exit(1);
});