/**
 * 绿地酒店会员(GIHG) 积分签到
 * ---------------------------------------------------------------------------
 * 小程序 appid : wx17d27ce1cca04bd7   (登录用)
 * H5   appid   : wx4a359c7b9ddf878b   (签到用，注意与登录 appid 不同!)
 * 第三方平台   : wxe715bd146a4e468b   (componentAppid)
 * 网关         : https://api.wx.gcihotel.net
 * 集团         : hotelGroupCode=GIHG (绿地尊享会 G-CARD)
 *
 * 【逆向结论 · 2026-08-09 抓包实测】
 *  1) 登录: GET /guardian/api/member/memberLoginOpen.json
 *       ?hotelCode=0&hotelGroupCode=GIHG&hotelGroupId=1
 *       &openid=<小程序openid>&appid=<MINI_APPID>&componentAppid=<COMP_APPID>
 *     → retVal.{memberId, memberToken, name, pointBalance, mobile}
 *     ★ 只需 openid，不需要 code / 不需要 WCS，memberToken 每次登录自动换发
 *  2) 状态: GET /guardian/api/wechat/platform/sign/wechatSignRecord.json
 *     → retVal.{hasSignedToday(T/F), signLadderDays, totalSignedOfMonth,
 *               hasUnReceivedAward, awardList, signConfig}
 *  3) 签到: POST /guardian/api/wechat/platform/sign/wechatSign.json
 *     body {signCode, openid, memberId, memberName, appid(H5!), componentAppid,
 *           hotelGroupCode, memberToken}   header 另带 memberToken
 *     → result=1 成功 retVal.points; result=0 失败(如 msg="今日已签到~")
 *  4) 验证码: sysOptions signCaptchaVerify 返回 [] → 签到【无需验证码】
 *  5) 规则: 每周前六天连签各 +5 分，第七天 +15 分(三倍)，每周重置
 *
 * 【openid 从哪来】
 *  WCS /wx/code 只返回 code，拿不到小程序 openid；gcihotel 也没有
 *  code→openid 的小程序接口(H5 是靠 URL 参数 miniProgramOpenid 拿到的)。
 *  openid 永久不变，抓包一次即可长期使用 → 走环境变量 gcihotel_openid。
 *
 * 【环境变量】
 *  gcihotel_openid  : 小程序 openid，多账号用 & 分隔 (必需，缺省用抓包值)
 *  gcihotel_remark  : 账号备注名，& 分隔，与 openid 一一对应 (可选)
 *  PUSH_PLUS_TOKEN  : PushPlus 推送 token (可选，兼容 PLUSPLUS_TOKEN)
 *
 * cron: 20 8 * * *
 */

const axios = require("axios");

// ============================== 常量 ==============================
const API = "https://api.wx.gcihotel.net";
const MINI_APPID = "wx17d27ce1cca04bd7"; // 小程序 appid（登录）
const H5_APPID = "wx4a359c7b9ddf878b";   // H5 公众号 appid（签到）
const COMP_APPID = "wxe715bd146a4e468b"; // 第三方平台 appid
const GROUP_CODE = "GIHG";
const SIGN_CODE = "LDJFQD";
const NAME = "绿地酒店会员";

// 抓包获得的默认 openid（用户 19315012646），可被环境变量覆盖
const DEFAULT_OPENID = "oPV0A7R2wM2vq1Bcx26ERqOPxYkU";

const UA = "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 " +
  "XWEB/1500047 MMWEBSDK/20260502 MMWEBID/38 MicroMessenger/8.0.76.3141(0x28004C3C) " +
  "WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64 miniProgram/" + MINI_APPID;

// ============================== 工具 ==============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 高斯抖动延时，模拟真人操作节奏 */
function jitter(base, spread) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(200, Math.round(base + g * spread));
}

const L = {
  info: (m) => console.log(`ℹ️  ${m}`),
  ok: (m) => console.log(`✅ ${m}`),
  warn: (m) => console.log(`⚠️  ${m}`),
  fail: (m) => console.log(`❌ ${m}`),
  step: (m) => console.log(`\n🔸 ${m}`),
};

function headers(extra) {
  return Object.assign({
    "User-Agent": UA,
    "Content-Type": "application/json",
    "Referer": `https://${H5_APPID}.wx.gcihotel.net/wechat/?/`,
    "X-Requested-With": "com.tencent.mm",
    "Accept": "application/json, text/plain, */*",
  }, extra || {});
}

/** 统一请求：网络层退避重试（网关偶发 ECONNRESET/超时） */
async function req(method, url, body, extraHeaders, retry = 3) {
  let lastErr;
  for (let a = 1; a <= retry; a++) {
    try {
      const cfg = {
        method, url,
        headers: headers(extraHeaders),
        timeout: 30000,
        validateStatus: () => true,
      };
      if (body !== undefined && body !== null) cfg.data = body;
      const r = await axios(cfg);
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return r.data;
    } catch (e) {
      lastErr = e;
      const tag = e.code || e.message;
      if (a < retry) {
        L.warn(`请求失败(${tag})，${a}/${retry} 重试`);
        await sleep(2000 * a);
      }
    }
  }
  throw lastErr;
}

// ============================== 账号 ==============================
class Account {
  constructor(openid, remark, index) {
    this.openid = openid;
    this.remark = remark || `账号${index + 1}`;
    this.index = index;
    this.member = null;
    this.result = { name: this.remark, ok: false, detail: "" };
  }

  tag(msg) { return `[${this.remark}] ${msg}`; }

  /** 登录：纯 openid 换 memberId + memberToken */
  async login() {
    const url = `${API}/guardian/api/member/memberLoginOpen.json` +
      `?hotelCode=0&hotelGroupCode=${GROUP_CODE}&hotelGroupId=1` +
      `&openid=${encodeURIComponent(this.openid)}` +
      `&appid=${MINI_APPID}&componentAppid=${COMP_APPID}`;

    const data = await req("GET", url);
    const rv = data && data.retVal;
    if (!data || data.result !== 1 || !rv || !rv.memberToken) {
      throw new Error(`登录失败: ${(data && data.msg) || JSON.stringify(data).slice(0, 160)}`);
    }
    this.member = {
      memberId: rv.memberId,
      memberToken: rv.memberToken,
      memberName: rv.name || rv.nickname || "微信用户",
      point: rv.pointBalance,
      mobile: rv.mobile || "",
      level: rv.cardLevelDescript || "",
      cardNo: rv.cardNo || "",
    };
    const mask = this.member.mobile
      ? this.member.mobile.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
      : "-";
    L.ok(this.tag(`登录成功 ${this.member.memberName} (${mask}) ${this.member.level} 积分 ${this.member.point}`));
    return this.member;
  }

  /** 查询签到状态 */
  async status() {
    const m = this.member;
    const url = `${API}/guardian/api/wechat/platform/sign/wechatSignRecord.json` +
      `?signCode=${SIGN_CODE}&appid=${H5_APPID}&componentAppid=${COMP_APPID}` +
      `&memberId=${m.memberId}&openid=${encodeURIComponent(this.openid)}` +
      `&memberToken=${encodeURIComponent(m.memberToken)}`;

    const data = await req("GET", url, null, { memberToken: m.memberToken });
    const rv = (data && data.retVal) || {};
    return {
      signed: rv.hasSignedToday === "T",
      ladderDays: rv.signLadderDays || 0,
      monthTotal: rv.totalSignedOfMonth || 0,
      unReceived: rv.hasUnReceivedAward === "T",
    };
  }

  /** 执行签到 */
  async doSign() {
    const m = this.member;
    const data = await req(
      "POST",
      `${API}/guardian/api/wechat/platform/sign/wechatSign.json`,
      {
        signCode: SIGN_CODE,
        openid: this.openid,
        memberId: m.memberId,
        memberName: m.memberName,
        appid: H5_APPID,          // 注意：签到用 H5 appid
        componentAppid: COMP_APPID,
        hotelGroupCode: GROUP_CODE,
        memberToken: m.memberToken,
      },
      {
        memberToken: m.memberToken,
        "Content-Type": "application/json;charset=utf-8",
        "Origin": `https://${H5_APPID}.wx.gcihotel.net`,
      }
    );

    const msg = (data && data.msg) || "";
    if (data && data.result === 1) {
      const rv = data.retVal || {};
      return { ok: true, points: rv.points || 0, ladder: rv.signLadderDays || 0, msg: "签到成功" };
    }
    // result=0：今日已签 / 其它业务失败
    if (/已签到|重复/.test(msg)) return { ok: true, already: true, msg: msg || "今日已签到" };
    return { ok: false, msg: msg || JSON.stringify(data).slice(0, 160) };
  }

  async run() {
    L.step(`${this.remark} 开始`);
    await this.login();
    await sleep(jitter(1200, 400));

    let st = null;
    try {
      st = await this.status();
      L.info(this.tag(`连签 ${st.ladderDays} 天 · 本月已签 ${st.monthTotal} 天 · 今日${st.signed ? "已签" : "未签"}`));
      if (st.unReceived) L.warn(this.tag("检测到有未领取的连续签到奖励(7/14/21天)，需在小程序内手动领取"));
    } catch (e) {
      L.warn(this.tag(`状态查询失败(${e.message})，仍尝试签到`));
    }

    if (st && st.signed) {
      this.result.ok = true;
      this.result.detail = `今日已签到 · 连签${st.ladderDays}天 · 积分${this.member.point}`;
      L.ok(this.tag("今日已签到，跳过"));
      return this.result;
    }

    await sleep(jitter(1500, 500));
    const r = await this.doSign();

    if (r.ok && r.already) {
      this.result.ok = true;
      this.result.detail = `今日已签到 · 积分${this.member.point}`;
      L.ok(this.tag(r.msg));
      return this.result;
    }
    if (!r.ok) {
      this.result.ok = false;
      this.result.detail = `签到失败: ${r.msg}`;
      L.fail(this.tag(this.result.detail));
      return this.result;
    }

    // 成功：回查最新积分
    let latest = this.member.point;
    try {
      await sleep(jitter(1200, 300));
      const again = await this.login();
      latest = again.point;
    } catch (_) { /* 回查失败不影响结论 */ }

    this.result.ok = true;
    this.result.detail = `签到成功 +${r.points} 积分 · 连签${r.ladder}天 · 当前积分${latest}`;
    L.ok(this.tag(this.result.detail));
    return this.result;
  }
}

// ============================== 推送 ==============================
async function push(title, content) {
  const token = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN;
  if (!token) return;
  try {
    await axios.post("http://www.pushplus.plus/send", {
      token, title, content: content.replace(/\n/g, "<br/>"), template: "html",
    }, { timeout: 15000 });
    L.info("PushPlus 推送完成");
  } catch (e) {
    L.warn(`推送失败: ${e.code || e.message}`);
  }
}

// ============================== 主流程 ==============================
(async () => {
  console.log(`\n🏨 ${NAME} 积分签到  ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  console.log("=".repeat(56));

  const raw = process.env.gcihotel_openid || process.env.GCIHOTEL_OPENID || DEFAULT_OPENID;
  const openids = raw.split(/[&\n]/).map((s) => s.trim()).filter(Boolean);
  const remarks = (process.env.gcihotel_remark || process.env.GCIHOTEL_REMARK || "")
    .split(/[&\n]/).map((s) => s.trim());

  if (!openids.length) {
    L.fail("未配置 gcihotel_openid，退出");
    process.exit(1);
  }
  L.info(`共 ${openids.length} 个账号`);

  const results = [];
  for (let i = 0; i < openids.length; i++) {
    const acc = new Account(openids[i], remarks[i], i);
    try {
      results.push(await acc.run());
    } catch (e) {
      // 账号级隔离：单账号异常不影响后续账号
      L.fail(acc.tag(`执行异常: ${e.message}`));
      results.push({ name: acc.remark, ok: false, detail: `异常: ${e.message}` });
    }
    if (i < openids.length - 1) await sleep(jitter(4000, 1500));
  }

  console.log("\n" + "=".repeat(56));
  const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  lines.forEach((l) => console.log(l));

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n📊 成功 ${okCount}/${results.length}`);

  await push(`${NAME}签到`, lines.join("\n"));

  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
