/*
@Description:  淘宝闪购果园 - 浇水 + 化肥自动化脚本
cron: 0 7,12,19 * * *
*/

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || "淘宝闪购果园"; this.userIdx = 0; }
  log(msg) { console.log(String(msg)); }
  done() { process.exit(0); }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}

const $ = new Env("淘宝闪购果园");

// 代理清除
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ==================== 配置 ====================
const MTOP_HOST = "acs.m.taobao.com";
const APP_KEY = "24895413";
const PROD_VERSION = "1.2.27";

// Cache
const CACHE_FILE = path.join(__dirname, ".orchard_token_cache.json");

// ==================== mtop 签名 ====================
function mtopSign(t, sessionId) {
  if (!sessionId) return "";
  const sessionKey = sessionId.split("_")[0];
  return crypto
    .createHash("md5")
    .update(sessionKey + t)
    .digest("hex");
}

// ==================== Cookie 解析 ====================
function parseCookies(rawCookie) {
  const cookies = {};
  if (!rawCookie) return cookies;
  rawCookie
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        cookies[pair.substring(0, idx).trim()] = pair
          .substring(idx + 1)
          .trim();
      }
    });
  return cookies;
}

function getSessionId(cookies) {
  if (cookies["_m_h5_tk"]) return cookies["_m_h5_tk"];
  if (cookies["_tb_token_"]) return cookies["_tb_token_"] + "_1";
  return "";
}

// ==================== mtop 请求 ====================
function mtopRequest(api, version, data, cookies) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const sessionId = getSessionId(cookies);
    const sign = mtopSign(t, sessionId);

    const params = new URLSearchParams();
    params.append("jsv", "2.7.0");
    params.append("appKey", APP_KEY);
    params.append("t", String(t));
    params.append("sign", sign);
    params.append("api", api);
    params.append("v", version || "1.0");
    params.append("type", "originaljson");
    params.append("dataType", "json");
    if (data) params.append("data", JSON.stringify(data));

    const cookieStr = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const options = {
      hostname: MTOP_HOST,
      port: 443,
      path: `/gw/${api}/${version || "1.0"}/`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr,
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 12; RMX3301 Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36",
        "Referer": "https://r.ele.me/orchard-h5/",
        "Origin": "https://r.ele.me",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "com.ele.me",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(params.toString());
    req.end();
  });
}

// ==================== 延迟 ====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== 缓存管理 ====================
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch (e) {}
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ==================== 核心业务 ====================

/**
 * 查询果园基础信息
 */
async function queryBaseInfo(cookies) {
  const result = await mtopRequest(
    "mtop.alsc.playgame.orchard.base.info.query",
    "1.0",
    { scene: "KB_ORCHARD" },
    cookies
  );
  return result;
}

/**
 * 批量查询果园索引数据
 */
async function batchQuery(cookies) {
  const result = await mtopRequest(
    "mtop.alsc.playgame.orchard.index.batch.query",
    "1.0",
    {
      scenes: ["KB_ORCHARD"],
      fields: [
        "BASE_INFO",
        "BACKPACK",
        "ROLE_ASSET",
        "ROLE_LEVEL",
        "TASK_LIST",
        "SNAIL_INFO",
        "MATURE_FRIENDS",
        "SIGN_INFO",
        "DAILY_MISSION",
      ],
    },
    cookies
  );
  return result;
}

/**
 * 使用道具（浇水 / 化肥）
 */
async function useProp(cookies, propType, count = 1) {
  const result = await mtopRequest(
    "mtop.alsc.playgame.orchard.roleOperate.useProp",
    "1.0",
    {
      propType,
      count: String(count),
      scene: "KB_ORCHARD",
    },
    cookies
  );
  return result;
}

/**
 * 查询每日任务
 */
async function queryTasks(cookies) {
  const result = await mtopRequest(
    "mtop.ele.biz.growth.task.core.querytask",
    "1.0",
    {
      bizScene: "ORCHARD",
      taskType: "DAILY",
    },
    cookies
  );
  return result;
}

/**
 * 领取任务奖励
 */
async function receivePrize(cookies, taskId, stageId) {
  const result = await mtopRequest(
    "mtop.ele.biz.growth.task.core.receiveprize",
    "1.0",
    {
      bizScene: "ORCHARD",
      taskId,
      stageId,
    },
    cookies
  );
  return result;
}

/**
 * 签到
 */
async function signIn(cookies) {
  const result = await mtopRequest(
    "mtop.koubei.interactioncenter.orchard.sign.recordSignIn",
    "1.0",
    { scene: "KB_ORCHARD" },
    cookies
  );
  return result;
}

/**
 * 领取签到奖励
 */
async function receiveSignInAward(cookies) {
  const result = await mtopRequest(
    "mtop.koubei.interactioncenter.orchard.sign.receiveSignInAward",
    "1.0",
    { scene: "KB_ORCHARD" },
    cookies
  );
  return result;
}

/**
 * 收取进度奖励（成长阶段奖励）
 */
async function receiveProcessReward(cookies) {
  const result = await mtopRequest(
    "mtop.koubei.interactioncenter.orchard.processreward.receive",
    "1.0",
    { scene: "KB_ORCHARD" },
    cookies
  );
  return result;
}

/**
 * 查询签到信息
 */
async function querySignInInfo(cookies) {
  const result = await mtopRequest(
    "mtop.koubei.interactioncenter.orchard.sign.querySignInfo",
    "1.0",
    { scene: "KB_ORCHARD" },
    cookies
  );
  return result;
}

// ==================== 浇水 + 化肥策略 ====================

/**
 * 浇水策略：
 * 1. 查询当前养分值
 * 2. 若养分 < 50，使用化肥直到养分 >= 100
 * 3. 然后继续浇水，直到当日上限
 */
async function waterWithNutrient(cookies) {
  console.log("🌐 查询当前果园数据...");
  let batchData = null;
  try {
    batchData = await batchQuery(cookies);
    if (!batchData?.ret?.[0]?.startsWith("SUCCESS")) {
      console.log(`⚠️ 批量查询失败: ${JSON.stringify(batchData?.ret || [])}`);
      return;
    }
  } catch (e) {
    console.log(`❌ 批量查询异常: ${e.message}`);
    return;
  }

  const data = batchData.data || {};
  const role = data.role || {};
  const backpack = data.backpack || {};
  const roleAsset = data.roleAsset || {};

  // 尝试从多个位置获取养分值
  const nutrientFieldNames = [
    "nutrient", "nutritionValue", "plantNutrient",
    "nutrientValue", "growNutrient", "nutrition",
    "roleNutrient", "treeNutrient", "soilNutrient",
  ];

  let currentNutrient = null;
  for (const field of nutrientFieldNames) {
    if (role[field] != null) { currentNutrient = role[field]; break; }
    if (roleAsset[field] != null) { currentNutrient = roleAsset[field]; break; }
  }
  if (currentNutrient == null) {
    for (const field of nutrientFieldNames) {
      if (data[field] != null) { currentNutrient = data[field]; break; }
    }
  }

  console.log(`🧪 当前养分值: ${currentNutrient ?? "未找到"}`);

  // 若养分 < 50，使用化肥直到养分 >= 100
  if (currentNutrient !== null && Number(currentNutrient) < 50) {
    console.log(`🌱 养分不足(${currentNutrient})，开始使用化肥...`);
    let attempts = 0;
    while (currentNutrient !== null && Number(currentNutrient) < 100 && attempts < 10) {
      attempts++;
      const result = await useProp(cookies, "fertilizer", "1");
      if (result?.ret?.[0]?.startsWith("SUCCESS")) {
        console.log(`✅ 化肥使用成功 (${attempts})`);
        // 重新查询养分值
        try {
          const freshData = await batchQuery(cookies);
          if (freshData?.ret?.[0]?.startsWith("SUCCESS")) {
            const fd = freshData.data || {};
            const fr = fd.role || {};
            const fra = fd.roleAsset || {};
            for (const field of nutrientFieldNames) {
              if (fr[field] != null) { currentNutrient = fr[field]; break; }
              if (fra[field] != null) { currentNutrient = fra[field]; break; }
            }
            if (currentNutrient == null) {
              for (const field of nutrientFieldNames) {
                if (fd[field] != null) { currentNutrient = fd[field]; break; }
              }
            }
            console.log(`  🧪 当前养分: ${currentNutrient}`);
          }
        } catch (e) {
          console.log(`  ⚠️ 查询养分异常: ${e.message}`);
          break;
        }
        await sleep(800);
      } else {
        const msg = result?.ret?.[0] || result?.msg || "";
        console.log(`ℹ️ 化肥: ${msg}`);
        break;
      }
    }
    console.log(`🌱 化肥使用完毕`);
  }

  // 浇水直到当日上限
  console.log("💧 开始浇水（直到当日上限）...");
  let waterCount = 0;
  let hitDailyLimit = false;

  while (!hitDailyLimit) {
    const result = await useProp(cookies, "water_drop", "1");
    if (result?.ret?.[0]?.startsWith("SUCCESS")) {
      waterCount++;
      console.log(`✅ 浇水成功 (${waterCount})`);
      await sleep(800);
    } else {
      const msg = (result?.ret?.[0] || result?.msg || "").toLowerCase();
      if (
        msg.includes("daily") ||
        msg.includes("limit") ||
        msg.includes("上限") ||
        msg.includes("达到") ||
        msg.includes("exceed") ||
        msg.includes("no more") ||
        msg.includes("cannot water") ||
        msg.includes("超过")
      ) {
        console.log(`🚫 已达到当日浇水上限: ${msg}`);
        hitDailyLimit = true;
      } else {
        console.log(`ℹ️ 浇水: ${msg}`);
        hitDailyLimit = true;
      }
    }
  }

  console.log(`💧 浇水完成，共浇水 ${waterCount} 次`);
}

// ==================== 主流程 ====================

async function runForAccount(cookies, accountIndex) {
  console.log(`\n${"=".repeat(20)} 账号[${accountIndex}] ${"=".repeat(20)}`);

  // 1. 查询果园信息
  console.log("🌐 查询果园基础信息...");
  try {
    const baseInfo = await queryBaseInfo(cookies);
    if (baseInfo?.ret?.[0]?.startsWith("SUCCESS")) {
      const data = baseInfo.data || {};
      const role = data.roleInfo || {};
      console.log(
        `✅ 果园等级: ${role.level || "?"}, 亲密度: ${role.intimacy || "?"}`
      );
    } else {
      console.log(`⚠️ 查询果园信息失败: ${JSON.stringify(baseInfo?.ret || [])}`);
    }
  } catch (e) {
    console.log(`❌ 查询果园信息异常: ${e.message}`);
    return;
  }

  // 2. 批量查询（获取道具、任务等信息）
  console.log("🌐 批量查询果园数据...");
  try {
    const batchData = await batchQuery(cookies);
    if (batchData?.ret?.[0]?.startsWith("SUCCESS")) {
      const data = batchData.data || {};
      const backpack = data.backpack || {};
      const waterCount = backpack.water_drop || backpack.WATER_DROP || 0;
      const fertilizerCount = backpack.fertilizer || backpack.FERTILIZER || 0;
      console.log(`💧 水滴: ${waterCount}, 🌱 化肥: ${fertilizerCount}`);
    } else {
      console.log(`⚠️ 批量查询失败: ${JSON.stringify(batchData?.ret || [])}`);
    }
  } catch (e) {
    console.log(`❌ 批量查询异常: ${e.message}`);
  }

  // 3. 签到
  console.log("📅 执行签到...");
  try {
    const signInResult = await signIn(cookies);
    if (signInResult?.ret?.[0]?.startsWith("SUCCESS")) {
      console.log(`✅ 签到成功`);
      await sleep(500);
      const awardResult = await receiveSignInAward(cookies);
      if (awardResult?.ret?.[0]?.startsWith("SUCCESS")) {
        console.log(`🎁 签到奖励领取成功`);
      } else {
        console.log(
          `ℹ️ 签到奖励: ${JSON.stringify(awardResult?.ret || awardResult?.msg || [])}`
        );
      }
    } else {
      const msg = signInResult?.ret?.[0] || signInResult?.msg || "";
      if (msg.includes("已签到") || msg.includes("already")) {
        console.log(`ℹ️ 今日已签到`);
      } else {
        console.log(`⚠️ 签到: ${msg}`);
      }
    }
  } catch (e) {
    console.log(`❌ 签到异常: ${e.message}`);
  }

  // 4. 领取进度奖励
  console.log("🎁 收取进度奖励...");
  try {
    const processResult = await receiveProcessReward(cookies);
    if (processResult?.ret?.[0]?.startsWith("SUCCESS")) {
      console.log(`✅ 进度奖励收取成功`);
    } else {
      console.log(
        `ℹ️ 进度奖励: ${JSON.stringify(processResult?.ret || processResult?.msg || [])}`
      );
    }
  } catch (e) {
    console.log(`❌ 进度奖励异常: ${e.message}`);
  }

  // 5. 浇水 + 化肥策略
  await waterWithNutrient(cookies);

  // 6. 查询并领取任务奖励
  console.log("📋 查询并领取任务奖励...");
  try {
    const taskResult = await queryTasks(cookies);
    if (taskResult?.ret?.[0]?.startsWith("SUCCESS")) {
      const data = taskResult.data || {};
      const taskList = data.taskList || data.list || [];
      for (const task of taskList) {
        const taskId = task.taskId || task.task_id;
        const stageId = task.stageId || task.stage_id || "1";
        const status = task.status || task.stageStatus;
        if (
          status === "FINISH" ||
          status === "complete" ||
          status === "FINISHED"
        ) {
          console.log(`🎁 领取任务奖励: ${task.taskName || taskId}`);
          const reward = await receivePrize(cookies, taskId, stageId);
          if (reward?.ret?.[0]?.startsWith("SUCCESS")) {
            console.log(`  ✅ 领取成功`);
          } else {
            console.log(
              `  ℹ️ ${JSON.stringify(reward?.ret || reward?.msg || [])}`
            );
          }
          await sleep(500);
        }
      }
    } else {
      console.log(
        `ℹ️ 任务查询: ${JSON.stringify(taskResult?.ret || taskResult?.msg || [])}`
      );
    }
  } catch (e) {
    console.log(`❌ 任务异常: ${e.message}`);
  }

  console.log(`✅ 账号[${accountIndex}] 处理完成`);
}

async function main() {
  console.log("🔔 淘宝闪购果园,开始!");
  console.log(`   版本: ${PROD_VERSION}`);

  // 读取 Cookie
  const rawCookies = process.env.orchard_cookie || "";
  if (!rawCookies) {
    console.log(
      "❌ 未设置 orchard_cookie 环境变量。请设置饿了么App的Cookie。"
    );
    console.log(
      '   示例: export orchard_cookie="cookie2=xxx; _tb_token_=xxx; sgcookie=xxx; t=xxx"'
    );
    return;
  }

  // 解析多账号（用 | 分隔）
  const cookieList = rawCookies.split("|").filter(Boolean);
  console.log(`📊 共 ${cookieList.length} 个账号`);

  for (let i = 0; i < cookieList.length; i++) {
    const cookies = parseCookies(cookieList[i].trim());
    const sessionId =getSessionId(cookies);
    console.log(`   账号[${i + 1}] session: ${sessionId ? sessionId.slice(0, 10) + "..." : "N/A"}`);

    await runForAccount(cookies, i + 1);

    if (i < cookieList.length - 1) {
      console.log("⏳ 等待3秒后处理下一个账号...");
      await sleep(3000);
    }
  }

  console.log(`\n🔔 淘宝闪购果园,结束!`);
}

main().catch((e) => {
  console.error("❌ 脚本异常:", e);
  process.exit(1);
});
