/**
 * 多多果园自动化脚本 v1.0
 * 功能：偷水5次、浇水种树、签到领化肥、打卡、一日三餐领水
 * 环境变量：DDGY_ACCOUNTS (openid列表，多账号用&分隔)
 *           wx_server_url / wxcodeurl (WCS地址)
 *           wx_auth / WXAPIKEY (WCS认证)
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
const https = require("https");

// 禁用代理（容器内直连WCS）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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
  const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN;
  if (!token) {
    console.log(`[Push] ${title}: ${message}`);
    return;
  }
  try {
    await axios.post("https://www.pushplus.plus/send", null, {
      params: { token, title, content: message, template: "text" },
      timeout: 10000,
    });
  } catch (e) {
    console.log(`[Push Error] ${e.message}`);
  }
}

// ============== 核心客户端 ==============
class PDDClient {
  constructor(openid, wxServerUrl, wxAuth, presetCookies, presetPdduid) {
    this.openid = openid;
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

    // 2. GET 登录页面获取 api_uid
    const pageResp = await axios.get(
      `${BASE_URL}/garden_index_lz_0.html?_pdd_fs=1&_pdd_tc=676666&_pdd_sbs=1&fun_id=wechat_app_home&refer_page_sn=10002&refer_idx=3&xcx_version=v8.6.21`,
      {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        httpsAgent: this.agent,
        validateStatus: () => true,
        timeout: 15000,
      }
    );
    const pageCookies = pageResp.headers["set-cookie"] || [];
    for (const c of pageCookies) {
      const [nameVal] = c.split(";");
      const [name, val] = nameVal.split("=");
      cookieMap[name.trim()] = val?.trim() || "";
    }
    const api_uid = cookieMap["api_uid"];
    console.log(`[${this.openid.slice(-8)}] api_uid: ${api_uid}`);

    // 3. POST api.pinduoduo.com/login 交换 code（获取 pdd_user_id 等关键 cookie）
    let loginApiOk = false;
    try {
      const loginResp = await axios.post(
        `https://api.pinduoduo.com/login?xcx=20161201&xcx_version=v8.6.21&xcx_hash=${Date.now()}`,
        { code, has_auth: false, app_id: 33, support_enhance_type: 3, anti_content: "", xcx_version: "v8.6.21" },
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
          },
          httpsAgent: this.agent,
          validateStatus: () => true,
          timeout: 15000,
        }
      );
      loginApiOk = true;
      console.log(`[${this.openid.slice(-8)}] POST login 响应: ${JSON.stringify(loginResp.data).slice(0, 200)}`);
      // 合并 POST login 返回的 cookie
      for (const c of loginResp.headers["set-cookie"] || []) {
        const [nameVal] = c.split(";");
        const [name, val] = nameVal.split("=");
        cookieMap[name.trim()] = val?.trim() || "";
      }
    } catch (e) {
      console.log(`[${this.openid.slice(-8)}] POST login 异常: ${e.message}`);
      if (e.response) {
        console.log(`[${this.openid.slice(-8)}] POST login 错误响应: ${e.response.data?.slice?.(0, 300) || JSON.stringify(e.response.data).slice(0, 300)}`);
        for (const c of e.response.headers["set-cookie"] || []) {
          const [nameVal] = c.split(";");
          const [name, val] = nameVal.split("=");
          cookieMap[name.trim()] = val?.trim() || "";
        }
      }
    }
    console.log(`[${this.openid.slice(-8)}] POST login 后 cookie: ${JSON.stringify(cookieMap)}`);

    // 4. GET 登录页面 + code 参数 获取 tubetoken
    const loginResp = await axios.get(
      `${BASE_URL}/garden_index_lz_0.html?_pdd_fs=1&_pdd_tc=676666&_pdd_sbs=1&fun_id=wechat_app_home&refer_page_sn=10002&refer_idx=3&code=${code}&state=BASE&xcx_version=v8.6.21`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; "),
        },
        httpsAgent: this.agent,
        validateStatus: () => true,
        timeout: 15000,
      }
    );

    const loginCookies = loginResp.headers["set-cookie"] || [];
    for (const c of loginCookies) {
      const [nameVal] = c.split(";");
      const [name, val] = nameVal.split("=");
      if (val && !val.includes("1970")) cookieMap[name.trim()] = val?.trim() || "";
    }

    // 5. 提取关键字段
    this.pdduid = cookieMap["pdd_user_id"];
    const tubetoken = cookieMap["tubetoken"];
    if (tubetoken) this.tubetoken = decodeURIComponent(tubetoken);
    this.cookies = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");

    console.log(`[${this.openid.slice(-8)}] 完整 cookie: ${JSON.stringify(cookieMap)}`);

    if (!this.pdduid || !this.tubetoken) {
      throw new Error(
        `WCS登录失败: openid未关联多多果园账号。请在微信中先打开「多多果园」小程序初始化账号，\n然后将抓包中的Cookie设置为环境变量 DDGY_COOKIES 和 DDGY_PDDUID。\nCookie格式参考: api_uid=xxx; PDDAccessToken=xxx; pdd_user_id=xxx; pdd_user_uin=xxx; tubetoken=xxx; pdd_vds=xxx`
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
    const results = [];

    // 打卡 type
    const signInTypes = [201446, 201423];
    for (const type of signInTypes) {
      try {
        const result = await this.applyActivity(type, {});
        const status = result.status;
        const waterAmount = result.water_amount || 0;
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

    return results;
  }

  /**
   * 主执行流程
   */
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
async function main() {
  const wxServerUrl =
    process.env.WX_SERVER_URL ||
    process.env.wx_server_url ||
    process.env.WXCODEURL ||
    process.env.wxcodeurl;
  const wxAuth =
    process.env.WX_AUTH ||
    process.env.WXAPIKEY ||
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
    const wechatAccounts = (process.env.WECHAT_ACCOUNTS || "").split("&").filter(Boolean);
    accounts.push(...wechatAccounts);
  }

  if (accounts.length === 0) {
    console.error("缺少账号环境变量: DDGY_ACCOUNTS 或 WECHAT_ACCOUNTS");
    process.exit(1);
  }

  console.log(`= 多多果园 = 账号数: ${accounts.length}`);
  if (presetCookies) console.log(`  使用预设Cookie, pdduid=${presetPdduid}`);
  const allResults = [];

  for (const account of accounts) {
    const client = new PDDClient(account, wxServerUrl, wxAuth, presetCookies, presetPdduid);
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

  await sendPush("多多果园", pushMsg);
  console.log("\n= 执行完成 =");
}

main().catch((e) => {
  console.error("脚本执行异常:", e);
  process.exit(1);
});