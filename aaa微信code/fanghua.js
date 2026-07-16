#!/usr/bin/env node
/**
 * 芳华未来 - 签到 + 课程视频 + 刷短视频
 *
 * 环境变量: FHWL=账号1@密码1&账号2@密码2
 */

const https = require("https");
const notifyLines = [];
const _origLog = console.log;
console.log = function (...args) {
  try { notifyLines.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(" ")); } catch (e) {}
  _origLog.apply(console, args);
};
async function sendToPushPlus(title, content) {
  const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN || "";
  if (!token || !content.trim()) return;
    if (content.length > 6000) content = content.slice(-6000);
  const payload = { token, title, content, template: "txt" };
  try {
    if (typeof axios !== "undefined") {
      await axios.post("https://www.pushplus.plus/send", payload, { timeout: 10000 });
    } else {
      const data = JSON.stringify(payload);
      await new Promise((resolve, reject) => {
        const req = https.request("https://www.pushplus.plus/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          timeout: 10000,
        }, (res) => { res.resume(); res.on("end", resolve); });
        req.on("error", reject); req.write(data); req.end();
      });
    }
    _origLog("✅ PushPlus推送成功: " + title);
  } catch (e) { _origLog("❌ PushPlus推送失败: " + (e.message || e)); }
}
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://api.cdwjyyh.com";
// 抓包/逆向确认: 部分接口带 /course_auto 前缀, 实际走 h5api.his.cdwjyyh.com
const BASE_URL_HIS = "https://h5api.his.cdwjyyh.com";
// 直播类接口 (appLive 前缀) 走独立域名, 鉴权用 liveToken 当作 AppToken
const BASE_URL_LIVE = "https://api.fhhx.runtzh.com";
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 16; M2012K11AC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 (Immersed/30.47619) Html5Plus/1.0";

const TOKEN_CACHE = path.join(__dirname, "fanghua_token_cache.json");

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(account, msg) {
  const pad = "═".repeat(4);
  console.log(`${pad} ${account} ${pad} ${msg}`);
}

function logInfo(account, msg) {
  console.log(`  📌 [${account}] ${msg}`);
}

function logSuccess(account, msg) {
  console.log(`  ✅ [${account}] ${msg}`);
}

function logWarn(account, msg) {
  console.log(`  ⚠️  [${account}] ${msg}`);
}

function logError(account, msg) {
  console.log(`  ❌ [${account}] ${msg}`);
}

function printBanner() {
  console.log("");
  console.log("  ╔═══════════════════════════════════╗");
  console.log("  ║  🌸  芳华未来  签到·课程·刷视频·其他任务   ║");
  console.log("  ╚═══════════════════════════════════╝");
  console.log("");
}

/**
 * 通用 HTTPS POST/GET 请求
 */
async function request({
  method = "POST",
  url,
  headers = {},
  body = null,
  timeout = 15000,
  baseURL = BASE_URL,
}) {
  return new Promise((resolve, reject) => {
    // 支持相对路径(配合 baseURL) 或完整 URL(向后兼容现有调用)
    const fullUrl = /^https?:/i.test(url) ? url : baseURL + url;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json;charset=UTF-8",
        "CompanyUserToken": "",
        ...headers,
      },
      timeout,
      rejectUnauthorized: true,
    };

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ statusCode: res.statusCode, headers: res.headers, data: text });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 解析 JSON 响应
 */
function parseResp(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, code: -1, msg: "parse_error" };
  }
}

/**
 * 读取 / 写入 token 缓存
 */
function loadCache() {
  try {
    if (fs.existsSync(TOKEN_CACHE)) {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(cache, null, 2), "utf8");
}

/**
 * 获取或刷新 token
 */
async function getToken(phone, pwd, cache) {
  const key = phone;
  if (cache[key]) {
    const { token, liveToken } = cache[key];
    try {
      const resp = await request({
        method: "GET",
        url: `${BASE_URL}/app/user/getUserInfo`,
        headers: { AppToken: token, liveToken: liveToken || "" },
      });
      const data = parseResp(resp.data);
      if (data.code === 200) {
        return {
          token,
          liveToken: liveToken || "",
          userId: data.user?.userId || cache[key].userId,
          nickName: data.user?.nickName || "",
        };
      }
    } catch {
      // token 失效，重新登录
    }
  }

  const resp = await request({
    url: `${BASE_URL}/app/app/login`,
    body: {
      phone,
      password: pwd,
      jpushId: crypto.randomUUID().replace(/-/g, ""),
      loginType: 1,
      source: "huawei",
    },
  });
  const data = parseResp(resp.data);
  if (data.code !== 200) {
    throw new Error(`登录失败: ${data.msg || JSON.stringify(data)}`);
  }

  const token = data.token;
  const liveToken = data.liveToken || "";
  const userId = data.user?.userId;
  const nickName = data.user?.nickName || "";

  cache[key] = { token, liveToken, userId, nickName };
  saveCache(cache);
  return { token, liveToken, userId, nickName };
}

// ─────────────────────────────────────────────
// API 函数
// ─────────────────────────────────────────────

/**
 * 签到
 */
async function sign({ token, liveToken }) {
  const signResp = await request({
    method: "GET",
    url: `${BASE_URL}/app/integral/getUserSign`,
    headers: { AppToken: token, liveToken },
  });
  const signData = parseResp(signResp.data);
  if (signData.code !== 200) {
    return { signed: false, msg: `查询签到状态失败: ${signData.msg}` };
  }

  if (signData.isDaySign) {
    return { signed: true, msg: `今日已签到 (连续${signData.signNum}天)` };
  }

  const doResp = await request({
    url: `${BASE_URL}/app/integral/sign`,
    headers: { AppToken: token, liveToken },
    body: {},
  });
  const doData = parseResp(doResp.data);
  if (doData.code === 200) {
    return { signed: true, msg: doData.msg || "签到成功" };
  }
  return { signed: false, msg: `签到失败: ${doData.msg}` };
}

/**
 * 获取当前积分
 */
async function getWallet({ token, liveToken, userId }) {
  const resp = await request({
    method: "GET",
    url: `${BASE_URL}/app/common/getWallet/${userId}?userId=${userId}`,
    headers: { AppToken: token, liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code === 200 && data.data) {
    return data.data.integral;
  }
  return null;
}

/**
 * 获取课程列表 (推荐, isTui=1)
 */
async function getCourseList({ token, liveToken }) {
  const resp = await request({
    method: "GET",
    url: `${BASE_URL}/app/course/getCourseList?isTui=1&pageNum=1&pageSize=10`,
    headers: { AppToken: token, liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code !== 200) return [];
  return (data.data?.list || []).filter((c) => c.isIntegral === 1);
}

/**
 * 获取课程下的视频列表
 */
async function getCourseVideoList({ token, liveToken, courseId }) {
  const resp = await request({
    method: "GET",
    url: `${BASE_URL}/app/course/getCourseVideoList?courseId=${courseId}&pageNum=1&pageSize=50`,
    headers: { AppToken: token, liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code !== 200) return [];
  return (data.data?.list || []).filter((v) => v.videoId);
}

/**
 * 获取短视频列表 (翻页)
 */
async function getVideoList({ token, liveToken, pageNum, lastVideoId }) {
  const resp = await request({
    method: "GET",
    url: `${BASE_URL}/app/video/getVideoList-new?keyword=&isRandom=1&videoId=${lastVideoId || ""}&pageNum=${pageNum}&pageSize=10`,
    headers: { AppToken: token, liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code !== 200) return [];
  return (data.data?.list || []).filter((v) => v.id && v.src);
}

/**
 * 上报视频播放行为
 */
async function trackVideo({ token, liveToken, videoId, event }) {
  await request({
    url: `${BASE_URL}/app/video/track`,
    headers: { AppToken: token, liveToken },
    body: { videoId: String(videoId), event },
  });
}

/**
 * 上报课程学习记录
 */
async function addStudyCourse({ token, liveToken, courseId, videoId, duration }) {
  await request({
    url: `${BASE_URL}/app/course/addStudyCourse`,
    headers: { AppToken: token, liveToken },
    body: { courseId: Number(courseId), duration, videoId: Number(videoId) },
  });
}

/**
 * 点赞视频
 */
async function doLike({ token, liveToken, videoId }) {
  await request({
    url: `${BASE_URL}/app/video/doLike`,
    headers: { AppToken: token, liveToken },
    body: { videoId: String(videoId) },
  });
}

/**
 * 领取积分 (type=2 学知识)
 */
async function addIntegral({ token, liveToken }) {
  const resp = await request({
    url: `${BASE_URL}/app/integral/addIntegral`,
    headers: { AppToken: token, liveToken },
    body: { type: 2 },
  });
  return parseResp(resp.data);
}

// ─────────────────────────────────────────────
// 其他日常任务 (APK 逆向发现)
// ─────────────────────────────────────────────

/**
 * 分享健康 (每日分享任务, logType=3)
 * POST https://api.cdwjyyh.com/app/integral/shareHealth
 */
async function shareHealth({ token, liveToken }) {
  const resp = await request({
    url: "/app/integral/shareHealth",
    method: "POST",
    baseURL: BASE_URL,
    headers: { AppToken: token, liveToken },
    body: { logType: 3 },
  });
  return parseResp(resp.data);
}

/**
 * 领取签到奖励 (签到转盘)
 * POST https://api.cdwjyyh.com/app/integral/claimSignReward
 */
async function claimSignReward({ token, liveToken }) {
  const resp = await request({
    url: "/app/integral/claimSignReward",
    method: "POST",
    baseURL: BASE_URL,
    headers: { AppToken: token, liveToken },
    body: { source: 3, appId: "wx703c4bd07bbd1695" },
  });
  return parseResp(resp.data);
}

/**
 * 新人转盘抽奖
 * POST https://api.cdwjyyh.com/app/newUser/sendTurntableReward
 */
async function sendTurntableReward({ token, liveToken }) {
  const resp = await request({
    url: "/app/newUser/sendTurntableReward",
    method: "POST",
    baseURL: BASE_URL,
    headers: { AppToken: token, liveToken },
    body: {},
  });
  return parseResp(resp.data);
}

/**
 * 领取福袋
 * POST https://h5api.his.cdwjyyh.com/app/luckyBag/receiveLuckyBag  (/course_auto 前缀)
 */
async function receiveLuckyBag({ token, liveToken }) {
  const resp = await request({
    url: "/app/luckyBag/receiveLuckyBag",
    method: "POST",
    baseURL: BASE_URL_HIS,
    headers: { AppToken: token, liveToken },
    body: {},
  });
  return parseResp(resp.data);
}

// ─────────────────────────────────────────────
// 新增任务 (APK 逆向: 评论 / 直播奖励 / 阅读资讯 / 学习科普 / 课程奖励)
// ─────────────────────────────────────────────

const COMMENT_TEXTS = [
  "讲得真好，受益匪浅！",
  "内容很实用，收藏了~",
  "通俗易懂，赞一个",
  "学到了很多健康知识，谢谢分享",
  "老师讲得很细致，支持！",
];

/**
 * 视频评论  POST https://api.cdwjyyh.com/app/video/addComment
 * body: { videoId, content, parentId }
 */
async function videoComment({ token, liveToken, videoId, content }) {
  const resp = await request({
    url: "/app/video/addComment",
    method: "POST",
    baseURL: BASE_URL,
    headers: { AppToken: token, liveToken },
    body: { videoId: String(videoId), content, parentId: "" },
  });
  return parseResp(resp.data);
}

/**
 * 课程评论  POST https://api.cdwjyyh.com/app/course/comment/addComment
 * body: { courseId, content }
 */
async function courseComment({ token, liveToken, courseId, content }) {
  // 视频评论用 String(videoId) 成功, 课程评论需同样传字符串 courseId
  const variants = [
    { parentId: 0 },
    { parentId: "" },
    {},
  ];
  let lastErr = null;
  for (const v of variants) {
    const resp = await request({
      url: "/app/course/comment/addComment",
      method: "POST",
      baseURL: BASE_URL,
      headers: { AppToken: token, liveToken },
      body: { courseId: String(courseId), content, ...v },
    });
    const r = parseResp(resp.data);
    if (r.code === 200) return r;
    lastErr = r;
  }
  return lastErr || { code: -1, msg: "评论失败" };
}

/**
 * 评论任务: 给 1 个视频 + 1 门课程 各发一条好评
 */
async function commentTask({ token, liveToken }) {
  const results = [];
  // 视频评论
  const videos = await getVideoList({ token, liveToken, pageNum: 1, lastVideoId: "" });
  if (videos.length > 0) {
    const v = videos[0];
    const r = await videoComment({
      token, liveToken, videoId: v.id,
      content: COMMENT_TEXTS[randInt(0, COMMENT_TEXTS.length - 1)],
    });
    results.push({ name: "视频评论", code: r.code, msg: r.msg });
  }
  // 课程评论: 部分课程评论区关闭会导致服务端报错, 遍历多个课程找到可评论的
  const courses = await getCourseList({ token, liveToken });
  let courseCommented = false;
  let lastErr = null;
  const content = COMMENT_TEXTS[randInt(0, COMMENT_TEXTS.length - 1)];
  for (const c of courses.slice(0, 6)) {
    try {
      const r = await courseComment({ token, liveToken, courseId: c.courseId, content });
      if (r.code === 200) {
        results.push({ name: "课程评论", code: 200, msg: r.msg });
        courseCommented = true;
        break;
      }
      lastErr = r;
    } catch (e) {
      lastErr = { code: -1, msg: e.message };
    }
  }
  if (!courseCommented) {
    // 课程评论接口对自动化请求返回通用服务端错误(需先进入课程详情页上下文),
    // 非脚本 bug, 此处降级为提示, 不影响其他任务
    results.push({ name: "课程评论", code: -1, msg: "服务端限制(需先进入课程详情),已跳过" });
  }
  return results;
}

/**
 * 直播列表  GET https://api.fhhx.runtzh.com/appLive/app/live/liveList
 * 直播类接口鉴权: AppToken = liveToken
 */
async function getLiveList({ liveToken }) {
  const resp = await request({
    url: "/appLive/app/live/liveList?pageNum=1&pageSize=10",
    method: "GET",
    baseURL: BASE_URL_LIVE,
    headers: { AppToken: liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code === 200 && data.data) {
    const list = data.data.list || data.data || [];
    return Array.isArray(list) ? list : [];
  }
  return [];
}

/**
 * 直播完成奖励  POST .../live/completion/receive-points?liveId=X  body: liveId
 */
async function liveReceivePoints({ liveToken, liveId }) {
  const resp = await request({
    url: `/appLive/app/live/completion/receive-points?liveId=${liveId}`,
    method: "POST",
    baseURL: BASE_URL_LIVE,
    headers: { AppToken: liveToken },
    body: String(liveId),
  });
  return parseResp(resp.data);
}

/**
 * 直播抽奖领取  POST .../live/liveLottery/claim  body: { lotteryId }
 */
async function liveLotteryClaim({ liveToken, lotteryId }) {
  const resp = await request({
    url: "/appLive/app/live/liveLottery/claim",
    method: "POST",
    baseURL: BASE_URL_LIVE,
    headers: { AppToken: liveToken },
    body: { lotteryId },
  });
  return parseResp(resp.data);
}

/**
 * 直播红包领取  POST .../live/liveRed/claim  body: { redId }
 */
async function liveRedClaim({ liveToken, redId }) {
  const resp = await request({
    url: "/appLive/app/live/liveRed/claim",
    method: "POST",
    baseURL: BASE_URL_LIVE,
    headers: { AppToken: liveToken },
    body: { redId },
  });
  return parseResp(resp.data);
}

/**
 * 直播奖励任务: 取直播列表 -> 尝试领取完成奖励/抽奖/红包 (均需实际观看, 多数会跳过)
 */
async function liveRewardsTask({ liveToken }) {
  const results = [];
  const lives = await getLiveList({ liveToken });
  if (lives.length === 0) {
    results.push({ name: "看直播奖励", code: -1, msg: "当前无直播" });
    return results;
  }
  const live = lives[0];
  const liveId = live.liveId || live.id;
  if (liveId) {
    const r = await liveReceivePoints({ liveToken, liveId });
    results.push({ name: "直播完成奖励", code: r.code, msg: r.msg });
    // lotteryId / redId 需进入直播间详情, 此处仅尝试常见字段
    if (live.lotteryInfo && live.lotteryInfo.lotteryId) {
      const lr = await liveLotteryClaim({ liveToken, lotteryId: live.lotteryInfo.lotteryId });
      results.push({ name: "直播抽奖", code: lr.code, msg: lr.msg });
    }
    if (live.redInfo && live.redInfo.redId) {
      const rr = await liveRedClaim({ liveToken, redId: live.redInfo.redId });
      results.push({ name: "直播红包", code: rr.code, msg: rr.msg });
    }
  }
  return results;
}

/**
 * 医生文章列表  GET https://api.cdwjyyh.com/app/doctorArticle/getDoctorArticleList
 */
async function getDoctorArticleList({ token, liveToken }) {
  const resp = await request({
    url: "/app/doctorArticle/getDoctorArticleList?pageNum=1&pageSize=10",
    method: "GET",
    baseURL: BASE_URL,
    headers: { AppToken: token, liveToken },
  });
  const data = parseResp(resp.data);
  if (data.code === 200 && data.data) {
    const list = data.data.list || data.data || [];
    return Array.isArray(list) ? list : [];
  }
  return [];
}

/**
 * 阅读资讯任务: 浏览若干医生文章 (阅读量上报), 并尝试对首篇留言
 */
async function readNewsTask({ token, liveToken }) {
  const results = [];
  const articles = await getDoctorArticleList({ token, liveToken });
  if (articles.length === 0) {
    results.push({ name: "阅读资讯", code: -1, msg: "无文章" });
    return results;
  }
  let readCount = 0;
  for (const a of articles.slice(0, 3)) {
    const id = a.articleId || a.id;
    if (!id) continue;
    // 阅读详情 (上报浏览)
    await request({
      url: `/app/doctorArticle/getDoctorArticleById?id=${id}`,
      method: "GET",
      baseURL: BASE_URL,
      headers: { AppToken: token, liveToken },
    });
    readCount++;
    await sleep(randInt(2000, 4000));
  }
  results.push({ name: "阅读资讯", code: 200, msg: `已浏览 ${readCount} 篇` });
  return results;
}

/**
 * 学习科普: 任务中心 id:3 (每集 +200 芳华币, isCourse)
 * 复用课程学习流程, 额外学习 2 集科普类课程
 */
async function studyKepuTask({ token, liveToken }) {
  const results = [];
  const courses = await getCourseList({ token, liveToken });
  let studied = 0;
  for (const course of courses.slice(0, 2)) {
    const videos = await getCourseVideoList({ token, liveToken, courseId: course.courseId });
    if (videos.length === 0) continue;
    const video = videos[0];
    try {
      const r = await watchCourseVideo({
        token, liveToken, courseId: course.courseId, videoId: video.videoId,
      });
      studied++;
      results.push({ name: `学习科普(${course.courseId})`, code: r.earned ? 200 : -1, msg: r.msg });
    } catch (e) {
      results.push({ name: `学习科普(${course.courseId})`, code: -1, msg: e.message });
    }
    await sleep(randInt(3000, 6000));
  }
  if (studied === 0) results.push({ name: "学习科普", code: -1, msg: "无可学课程" });
  return results;
}

/**
 * 课程奖励 (积分瓜分活动): POST /course_auto/app/course/rewardRound/claimApp
 * 需 roundId + goodsId, 来自"积分瓜分"活动页 (活动开启时才有).
 * 先 isClaimApp 判断是否可领, 再 claimApp. 自动场景难以稳定获取 roundId,
 * 故由环境变量 FHWL_COURSE_ROUND / FHWL_COURSE_GOODS 提供, 未配置则跳过.
 */
async function claimCourseReward({ token, liveToken, roundId, goodsId }) {
  const isClaim = await request({
    url: "/app/course/rewardRound/isClaimApp",
    method: "POST",
    baseURL: BASE_URL_HIS,
    headers: { AppToken: token, liveToken },
    body: { roundId, goodsId },
  });
  const ic = parseResp(isClaim.data);
  if (ic.code === 200 && ic.data && ic.data.isClaim) {
    const resp = await request({
      url: "/app/course/rewardRound/claimApp",
      method: "POST",
      baseURL: BASE_URL_HIS,
      headers: { AppToken: token, liveToken },
      body: { roundId, goodsId },
    });
    return parseResp(resp.data);
  }
  return { code: ic.code ?? -1, msg: ic.msg || "暂不可领取(活动未开启或已领)" };
}

// ─────────────────────────────────────────────
// 业务逻辑
// ─────────────────────────────────────────────

/**
 * 观看一个课程视频（含重试）
 */
async function watchCourseVideo({ token, liveToken, courseId, videoId }) {
  const watchTime = randInt(12, 15);
  await sleep(watchTime * 1000);
  await addStudyCourse({ token, liveToken, courseId, videoId, duration: watchTime });
  // 重试最多 3 次获取奖励
  for (let retry = 0; retry < 3; retry++) {
    const rewardResp = await addIntegral({ token, liveToken });
    const msg = rewardResp.msg || "";
    // 上限优先: 上限消息含"芳华币"字样, 必须在芳华币判断之前拦截, 否则会误判为获奖而永不停止
    if (msg.includes("上限") || msg.includes("已达") || msg.includes("今日") || msg.includes("已完成")) {
      return { earned: false, stop: true, msg: "今日上限已满" };
    }
    if (msg.includes("芳华币")) {
      return { earned: true, msg };
    }
    if (msg.includes("过于频繁")) {
      const wait = Math.min(5000 * (retry + 1), 15000);
      await sleep(wait);
      continue;
    }
    return { earned: false, msg };
  }
  return { earned: false, msg: "重试3次后仍过于频繁" };
}

/**
 * 观看一个短视频（含重试）
 */
async function watchShortVideo({ token, liveToken, video }) {
  const watchTime = randInt(12, 15);
  await trackVideo({ token, liveToken, videoId: video.id, event: "PLAY" });
  await trackVideo({ token, liveToken, videoId: video.id, event: "PLAY_3S" });
  await sleep(watchTime * 1000);
  if (Math.random() < 0.2) {
    await doLike({ token, liveToken, videoId: video.id });
  }
  await trackVideo({ token, liveToken, videoId: video.id, event: "COMPLETE" });
  // 重试最多 3 次获取奖励
  for (let retry = 0; retry < 3; retry++) {
    const rewardResp = await addIntegral({ token, liveToken });
    const msg = rewardResp.msg || "";
    // 上限优先: 上限消息含"芳华币"字样, 必须在芳华币判断之前拦截, 否则会误判为获奖而永不停止
    if (msg.includes("上限") || msg.includes("已达") || msg.includes("今日") || msg.includes("已完成")) {
      return { earned: false, stop: true, msg: "今日上限已满" };
    }
    if (msg.includes("芳华币")) {
      return { earned: true, msg };
    }
    if (msg.includes("过于频繁")) {
      const wait = Math.min(5000 * (retry + 1), 15000);
      await sleep(wait);
      continue;
    }
    return { earned: false, msg };
  }
  return { earned: false, msg: "重试3次后仍过于频繁" };
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────
async function processAccount(phone, pwd, cache) {
  log(phone, "开始执行");

  try {
    const { token, liveToken, userId, nickName } = await getToken(phone, pwd, cache);
    logSuccess(phone, `登录成功 ${nickName || phone} (ID: ${userId})`);

    // 1. 签到
    const signResult = await sign({ token, liveToken });
    logInfo(phone, signResult.msg);

    // 1.5 其他日常任务 (APK 逆向发现的额外赚分任务)
    logInfo(phone, "--- 其他日常任务 ---");
    const otherTaskDefs = [
      { name: "领取签到奖励", fn: () => claimSignReward({ token, liveToken }) },
      { name: "新人转盘", fn: () => sendTurntableReward({ token, liveToken }) },
      { name: "领取福袋", fn: () => receiveLuckyBag({ token, liveToken }) },
    ];
    let otherTasks = 0;
    for (const def of otherTaskDefs) {
      try {
        const r = await def.fn();
        if (r && r.code === 200) {
          otherTasks++;
          logSuccess(phone, `🎁 ${def.name}: ${r.msg || "成功"}`);
        } else {
          logInfo(phone, `◽ ${def.name}: ${r?.msg || JSON.stringify(r)}`);
        }
      } catch (err) {
        logWarn(phone, `${def.name} 出错: ${err.message}`);
      }
      await sleep(randInt(2000, 4000));
    }

    // 1.5.5 分享健康 (循环刷: 只要有奖励就继续, 直到服务端上限信号/防呆硬顶才停)
    logInfo(phone, "--- 分享健康 ---");
    // FHWL_SHARE_MAX: 可选软上限(设为数字则多刷到该次数停); 不设=无限循环直到服务端上限信号
    const shareMax = parseInt(process.env.FHWL_SHARE_MAX || "0", 10); // 0 = 不设软上限
    const SHARE_HARD_CAP = 1000; // 防呆硬顶: 实测服务端无每日上限, 防止进程永不退出
    let shareCount = 0;
    while (true) {
      try {
        const r = await shareHealth({ token, liveToken });
        const msg = (r && r.msg) || "";
        if (r && r.code === 200) {
          shareCount++;
          const quota = shareMax > 0 ? ` (${shareCount}/${shareMax})` : ` (#${shareCount})`;
          logSuccess(phone, `🔗 分享健康${quota}: +5币`);
          if (shareMax > 0 && shareCount >= shareMax) {
            logInfo(phone, `分享健康达到每日上限(${shareMax})`);
            break;
          }
        } else if (msg.includes("上限") || msg.includes("已达") || msg.includes("今日") || msg.includes("已完成")) {
          logWarn(phone, `分享健康停止: ${msg}`);
          break;
        } else {
          logInfo(phone, `分享健康停止: ${msg}`);
          break;
        }
      } catch (err) {
        logWarn(phone, `分享健康出错: ${err.message}`);
        break;
      }
      if (shareCount >= SHARE_HARD_CAP) {
        logWarn(phone, `分享健康达到防呆硬顶(${SHARE_HARD_CAP}), 停止`);
        break;
      }
      await sleep(randInt(2000, 4000));
    }
    if (shareCount > 0) {
      otherTasks += shareCount;
      logInfo(phone, `分享健康完成 ${shareCount} 次`);
    }

    // 1.6 新增任务 (评论 / 学习科普 / 阅读资讯 / 直播奖励)
    logInfo(phone, "--- 新增任务 ---");
    const newTaskDefs = [
      { name: "评论任务", fn: () => commentTask({ token, liveToken }) },
      { name: "学习科普", fn: () => studyKepuTask({ token, liveToken }) },
      { name: "阅读资讯", fn: () => readNewsTask({ token, liveToken }) },
      { name: "直播奖励", fn: () => liveRewardsTask({ liveToken }) },
      { name: "课程奖励", fn: async () => {
        const roundId = process.env.FHWL_COURSE_ROUND;
        const goodsId = process.env.FHWL_COURSE_GOODS;
        if (!roundId || !goodsId) {
          return [{ name: "课程奖励", code: -1, msg: "未配置 FHWL_COURSE_ROUND/GOODS (活动未开启)" }];
        }
        const r = await claimCourseReward({ token, liveToken, roundId, goodsId });
        return [{ name: "课程奖励", code: r.code, msg: r.msg }];
      } },
    ];
    for (const def of newTaskDefs) {
      try {
        const sub = await def.fn();
        const arr = Array.isArray(sub) ? sub : [sub];
        for (const r of arr) {
          if (r && r.code === 200) {
            otherTasks++;
            logSuccess(phone, `🎁 ${def.name} / ${r.name || ""}: ${r.msg || "成功"}`);
          } else {
            logInfo(phone, `◽ ${def.name} / ${r?.name || ""}: ${r?.msg || JSON.stringify(r)}`);
          }
        }
      } catch (err) {
        logWarn(phone, `${def.name} 出错: ${err.message}`);
      }
      await sleep(randInt(2000, 4000));
    }

    // 2. 获取当前积分
    const initialBalance = await getWallet({ token, liveToken, userId });
    let currentBalance = initialBalance;
    logInfo(phone, `当前积分: ${currentBalance}`);

    let courseVideos = 0;
    let shortVideos = 0;
    let totalEarned = 0;
    let stopReason = "";

    // ============ 3. 课程视频 ============
    logInfo(phone, "--- 课程视频 ---");
    const courses = await getCourseList({ token, liveToken });
    logInfo(phone, `可积分课程: ${courses.length} 个`);

    for (const course of courses) {
      const videos = await getCourseVideoList({ token, liveToken, courseId: course.courseId });
      if (videos.length === 0) continue;

      const video = videos[0];
      try {
        logInfo(phone, `📺 课程视频 (课程${course.courseId} / 视频${video.videoId})`);
        const result = await watchCourseVideo({
          token, liveToken, courseId: course.courseId, videoId: video.videoId,
        });
        courseVideos++;

        if (result.stop) {
          logWarn(phone, `停止: ${result.msg}`);
          stopReason = result.msg;
          break;
        }
        if (result.earned) {
          logSuccess(phone, `获得奖励: ${result.msg}`);
        } else {
          logWarn(phone, `未获得奖励: ${result.msg}`);
        }
      } catch (err) {
        logError(phone, `课程视频出错: ${err.message}`);
      }

      if (stopReason) break;
      // 检查余额 (仅当余额下降时停止，相同余额继续尝试)
      const newBalance = await getWallet({ token, liveToken, userId });
      if (newBalance !== null && currentBalance !== null && newBalance < currentBalance) {
        logWarn(phone, `余额不升反降 (${currentBalance} → ${newBalance}), 停止课程视频`);
        stopReason = "课程视频余额下降";
        break;
      }
      currentBalance = newBalance;
      await sleep(randInt(5000, 10000));
    }

    // ============ 4. 刷短视频 ============
    logInfo(phone, "--- 刷短视频 ---");
    let consecutiveNoReward = 0;
    let pageNum = 1;
    let lastVideoId = "";

    while (true) {
      if (consecutiveNoReward >= 5) {
        stopReason = "连续5次未获得奖励";
        break;
      }

      let videos = await getVideoList({ token, liveToken, pageNum, lastVideoId });
      if (videos.length === 0) {
        logWarn(phone, "暂无视频，翻到下一页...");
        pageNum++;
        if (pageNum > 20) {
          logWarn(phone, "翻页过多，停止刷视频");
          stopReason = "视频已刷完";
          break;
        }
        await sleep(randInt(10000, 20000));
        continue;
      }

      // 随机选一个
      const video = videos[randInt(0, videos.length - 1)];
      try {
        logInfo(phone, `📺 短视频 (ID: ${video.id}) ${video.username || ""}`);
        const result = await watchShortVideo({ token, liveToken, video });
        shortVideos++;

        if (result.stop) {
          logWarn(phone, `停止: ${result.msg}`);
          stopReason = result.msg;
          break;
        }
        if (result.earned) {
          consecutiveNoReward = 0;
          logSuccess(phone, `获得奖励: ${result.msg}`);
        } else {
          consecutiveNoReward++;
          logWarn(phone, `未获得奖励 (${consecutiveNoReward}/5): ${result.msg}`);
        }
      } catch (err) {
        logError(phone, `短视频出错: ${err.message}`);
        consecutiveNoReward++;
      }

      lastVideoId = video.id;

      // 间隔
      await sleep(randInt(3000, 6000));
    }

    // 5. 最终积分
    const finalBalance = await getWallet({ token, liveToken, userId });
    const earned = finalBalance && initialBalance ? finalBalance - initialBalance : 0;

    log(phone, `积分 ${initialBalance} → ${finalBalance} (+${earned})`);
    logInfo(phone, `课程视频: ${courseVideos} 个 | 短视频: ${shortVideos} 个 | 其他任务: ${otherTasks} 个 | 停止: ${stopReason || "全部完成"}`);

    return {
      phone,
      nickName,
      courseVideos,
      shortVideos,
      otherTasks,
      initialBalance,
      finalBalance,
      earned,
      stopReason: stopReason || "全部完成",
    };
  } catch (err) {
    logError(phone, `执行失败: ${err.message}`);
    return { phone, error: err.message };
  }
}

// ─────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────
async function main() {
  const fhwl = process.env.FHWL || "";

  if (!fhwl) {
    console.error("\n❌ 请设置环境变量: FHWL");
    console.error("   格式: 账号1@密码1&账号2@密码2\n");
    process.exit(1);
  }

  printBanner();

  // 解析 FHWL
  const accounts = fhwl.split("&").map((pair) => {
    const trimmed = pair.trim();
    if (!trimmed.includes("@")) return null;
    const [phone, password] = trimmed.split("@").map((s) => s.trim());
    return phone && password ? { phone, pwd: password } : null;
  }).filter(Boolean);

  if (accounts.length === 0) {
    console.error("❌ 未解析到有效账号\n");
    process.exit(1);
  }

  const cache = loadCache();
  console.log(`   账号数量: ${accounts.length}`);
  console.log(`   开始并发执行...\n`);
  const results = await Promise.all(accounts.map((acc) => processAccount(acc.phone, acc.pwd, cache)));

  // 汇总
  console.log("");
  console.log("  ╔═══════════════════════════════════╗");
  console.log("  ║           📊   执 行 汇 总         ║");
  console.log("  ╠═══════════════════════════════════╣");
  let totalEarned = 0;
  let totalCourse = 0;
  let totalShort = 0;
  let totalOther = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ❌ [${r.phone}] 失败: ${r.error}`);
    } else {
      totalEarned += r.earned || 0;
      totalCourse += r.courseVideos || 0;
      totalShort += r.shortVideos || 0;
      totalOther += r.otherTasks || 0;
      console.log(`  ✅ [${r.phone}] 课程${r.courseVideos} 短视频${r.shortVideos} 其他${r.otherTasks || 0}  ${r.initialBalance} → ${r.finalBalance} (+${r.earned})`);
      if (r.stopReason && r.stopReason !== "全部完成") console.log(`     └─ ${r.stopReason}`);
    }
  }
  console.log("  ╠═══════════════════════════════════╣");
  console.log(`  📺 课程视频: ${totalCourse} 个`);
  console.log(`  🎬 短视频: ${totalShort} 个`);
  console.log(`  🎁 其他任务: ${totalOther} 个`);
  console.log(`  💰 总新增积分: ${totalEarned} 芳华币`);
  console.log("  ╚═══════════════════════════════════╝");
  console.log("");
  await sendToPushPlus("芳华未来", notifyLines.join("\n"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
