/**
 * 绿地酒店会员(GIHG) 积分签到
 * ---------------------------------------------------------------------------
 * 小程序 appid : wx17d27ce1cca04bd7   (会员登录用)
 * H5   appid   : wx4a359c7b9ddf878b   (签到 / 网页授权用，注意与登录 appid 不同!)
 * 第三方平台   : wxe715bd146a4e468b   (componentAppid，绿云 ihotel 开放平台)
 * 网关         : https://api.wx.gcihotel.net
 * 集团         : hotelGroupCode=GIHG (绿地尊享会 G-CARD)
 *
 * 【逆向结论 · 2026-08-09 抓包 + 容器实测】
 *  1) 登录: GET /guardian/api/member/memberLoginOpen.json
 *       ?hotelCode=0&hotelGroupCode=GIHG&hotelGroupId=1
 *       &openid=<openid>&appid=<appid>&componentAppid=<COMP_APPID>
 *     → retVal.{memberId, memberToken, name, pointBalance, mobile}
 *     ★ 只需 openid，不需要 code；memberToken 每次登录自动换发
 *     ★ 查不到会员时返回 result=0 msg="会员信息不存在"（该微信号尚未注册会员）
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
 * 【openid 自动发现（本脚本核心）】
 *  gcihotel 服务端【没有】小程序 code→openid 接口（实测 30+ 路径全 404，
 *  oauthForMember 传小程序 code 返回 invalid code —— 它只走公众号网页授权）。
 *  但公众号 H5 侧可以自动拿到 openid：
 *    ① WCS POST /wx/oauth {openid, appid:H5_APPID, redirect_uri, scope, state}
 *       → data.full_url（带微信登录态 uin/key 的授权 URL）
 *    ② ★该公众号由第三方平台代管，授权 URL 必须补 &component_appid=<COMP_APPID>，
 *       否则微信直接返回 "redirect_uri 错误" 页（这是最大的坑）
 *    ③ 跟随 301 链：/connect/oauth2/authorize → authorize_reply → 业务回调?code=xxx
 *    ④ GET /wechat/platform/user/oauthForMember.json?appid=H5&code=<code>
 *       → retVal.openid（公众号 openid）
 *
 * 【两种 openid 的区别 —— 重要】
 *  · 公众号 openid(oRbd-…)：可由上述链路【全自动】获得
 *  · 小程序 openid(oPV0…)：只能抓包获得
 *  会员绑定在【注册时所用的那个 openid】上。若你是在小程序里注册的会员，
 *  公众号 openid 会返回"会员信息不存在"，此时需把抓包得到的小程序 openid
 *  按位置填进 gcihotel_openid 覆盖。
 *
 * 【环境变量】
 *  wx_opinion       : ★账号来源(项目统一约定)，WCS openid，多账号 & 分隔
 *  wx_server_url    : WCS 地址 (默认 http://host.docker.internal:18788)
 *  wx_auth          : WCS 认证 key
 *  gcihotel_openid  : 可选。小程序 openid 覆盖，& 分隔，【按位置对应 wx_opinion】，
 *                     留空的位置自动走 oauth 发现。例: "oPV0xxx&&"
 *
 * cron: 20 8 * * *
 */

const axios = require("axios");

// ============================== 常量 ==============================
const API = "https://api.wx.gcihotel.net";
const MINI_APPID = "wx17d27ce1cca04bd7"; // 小程序 appid
const H5_APPID = "wx4a359c7b9ddf878b";   // H5 公众号 appid（签到 / 网页授权）
const COMP_APPID = "wxe715bd146a4e468b"; // 第三方平台 appid
const GROUP_CODE = "GIHG";
const SIGN_CODE = "LDJFQD";
const NAME = "绿地酒店会员";
const REDIRECT = `https://${H5_APPID}.wx.gcihotel.net/wechat/?/`;

const UA = "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 " +
  "XWEB/1500047 MMWEBSDK/20260502 MMWEBID/38 MicroMessenger/8.0.76.3141(0x28004C3C) " +
  "WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64";

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
    "Referer": REDIRECT,
    "X-Requested-With": "com.tencent.mm",
    "Accept": "application/json, text/plain, */*",
  }, extra || {});
}

/** 统一请求：网络层退避重试（网关偶发 ECONNRESET / RemoteDisconnected） */
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
      if (a < retry) {
        L.warn(`请求失败(${e.code || e.message})，${a}/${retry} 重试`);
        await sleep(2000 * a);
      }
    }
  }
  throw lastErr;
}

// ============================== WCS ==============================
const WCS = {
  base: (process.env.wx_server_url || process.env.wxcodeurl || "http://host.docker.internal:18788")
    .replace(/\/+$/, ""),
  auth: process.env.wx_auth || process.env.WXAPIKEY || process.env.WX_SERVER_APIKEY || "",

  /** 取网页授权 URL（含微信登录态） */
  async oauthUrl(wcsOpenid) {
    let lastErr;
    for (let a = 1; a <= 3; a++) {
      try {
        const { data } = await axios.post(`${this.base}/wx/oauth`, {
          openid: wcsOpenid,
          appid: H5_APPID,
          redirect_uri: REDIRECT,
          scope: "snsapi_base",
          state: "apiauthorize",
        }, { headers: { auth: this.auth, "Content-Type": "application/json" }, timeout: 60000 });

        const full = data && data.data && data.data.full_url;
        if (full) return full;
        const msg = JSON.stringify(data).slice(0, 160);
        if (/account not found|账号不存在/i.test(msg)) throw new Error("WCS 账号不存在");
        throw new Error(msg);
      } catch (e) {
        lastErr = e;
        if (/账号不存在/.test(e.message)) throw e;
        if (a < 3) await sleep(2000 * a);
      }
    }
    throw lastErr;
  },
};

/**
 * 跟随微信授权重定向链，取业务回调里的 code
 * ★ 关键：第三方平台代管公众号，必须补 component_appid
 */
async function fetchOauthCode(fullUrl) {
  let url = fullUrl.includes("#")
    ? fullUrl.split("#")[0] + `&component_appid=${COMP_APPID}#` + fullUrl.split("#")[1]
    : fullUrl + `&component_appid=${COMP_APPID}#wechat_redirect`;

  let cookie = "";
  for (let hop = 1; hop <= 6; hop++) {
    const target = url.split("#")[0];
    let resp;
    let ok = false;
    for (let a = 1; a <= 3; a++) {
      try {
        resp = await axios.get(target, {
          headers: Object.assign({ "User-Agent": UA }, cookie ? { Cookie: cookie } : {}),
          maxRedirects: 0,
          timeout: 30000,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        ok = true;
        break;
      } catch (e) {
        if (e.response && e.response.status >= 300 && e.response.status < 400) {
          resp = e.response;
          ok = true;
          break;
        }
        if (a < 3) await sleep(1500 * a);
      }
    }
    if (!ok || !resp) return null;

    const sc = resp.headers["set-cookie"];
    if (sc && sc.length) {
      cookie = sc.map((c) => c.split(";")[0]).join("; ");
    }

    const loc = resp.headers.location || "";
    const body = typeof resp.data === "string" ? resp.data : "";
    const m = /[?&]code=([A-Za-z0-9_-]+)/.exec(loc) || /[?&]code=([A-Za-z0-9_-]+)/.exec(body);

    // code 出现在【非微信授权中间页】的跳转里 → 即业务回调
    if (m && !/\/connect\/oauth2\/authorize/.test(loc)) return m[1];
    if (!loc) return m ? m[1] : null;

    url = new URL(loc, target).toString();
  }
  return null;
}

// ============================== 账号 ==============================
class Account {
  constructor(wcsOpenid, override, index) {
    this.wcsOpenid = wcsOpenid;
    this.override = override || "";   // 手工指定的小程序 openid
    this.index = index;
    this.openid = "";                 // 实际用于登录的 openid
    this.source = "";
    this.member = null;
    this.remark = `账号${index + 1}(${wcsOpenid.slice(-4)})`;
    this.result = { name: this.remark, ok: false, detail: "" };
  }

  tag(msg) { return `[${this.remark}] ${msg}`; }

  /** 解析出可用于登录的 gcihotel openid */
  async resolveOpenid() {
    if (this.override) {
      this.openid = this.override;
      this.source = "手工配置(小程序)";
      L.info(this.tag(`使用配置 openid ${this.openid.slice(0, 10)}… (${this.source})`));
      return;
    }
    const full = await WCS.oauthUrl(this.wcsOpenid);
    const code = await fetchOauthCode(full);
    if (!code) throw new Error("网页授权未取到 code");

    const data = await req("GET",
      `${API}/guardian/api/wechat/platform/user/oauthForMember.json` +
      `?appid=${H5_APPID}&componentAppid=${COMP_APPID}&code=${code}` +
      `&hotelGroupCode=${GROUP_CODE}&hotelGroupId=1&hotelCode=0`);

    const rv = (data && data.retVal) || {};
    if (!rv.openid) throw new Error(`换取 openid 失败: ${rv.resultMsg || (data && data.msg) || "未知"}`);
    this.openid = rv.openid;
    this.source = "自动授权(公众号)";
    L.ok(this.tag(`自动获取 openid ${this.openid.slice(0, 10)}… (${this.source})`));
  }

  /** 登录：纯 openid 换 memberId + memberToken */
  async login(silent) {
    const appid = this.source.includes("小程序") ? MINI_APPID : H5_APPID;
    const url = `${API}/guardian/api/member/memberLoginOpen.json` +
      `?hotelCode=0&hotelGroupCode=${GROUP_CODE}&hotelGroupId=1` +
      `&openid=${encodeURIComponent(this.openid)}` +
      `&appid=${appid}&componentAppid=${COMP_APPID}`;

    const data = await req("GET", url);
    const rv = data && data.retVal;
    if (!data || data.result !== 1 || !rv || !rv.memberToken) {
      const msg = (data && data.msg) || JSON.stringify(data).slice(0, 160);
      const err = new Error(msg);
      if (/会员信息不存在/.test(msg)) err.notMember = true;
      throw err;
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
    if (this.member.mobile) {
      this.remark = `尾号${this.member.mobile.slice(-4)}`;
      this.result.name = this.remark;
    }
    if (!silent) {
      const mask = this.member.mobile
        ? this.member.mobile.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
        : "-";
      L.ok(this.tag(`登录成功 ${this.member.memberName} (${mask}) ${this.member.level} 积分 ${this.member.point}`));
    }
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
        appid: H5_APPID,          // 注意：签到固定用 H5 appid
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
    if (/已签到|重复/.test(msg)) return { ok: true, already: true, msg: msg || "今日已签到" };
    return { ok: false, msg: msg || JSON.stringify(data).slice(0, 160) };
  }

  async run() {
    L.step(`${this.remark} 开始`);
    _setName(this.index + 1, this.remark);
    await this.resolveOpenid();
    await sleep(jitter(900, 300));

    try {
      await this.login();
    } catch (e) {
      if (e.notMember) {
        this.result.ok = false;
        this.result.detail = this.override
          ? "会员信息不存在(配置的 openid 未注册会员)"
          : "该微信号未注册绿地酒店会员，请先在小程序内注册；若已在小程序注册，请抓包取小程序 openid 填入 gcihotel_openid 对应位置";
        L.warn(this.tag(this.result.detail));
        _setSign(this.index + 1, "未注册会员");
        return this.result;
      }
      throw e;
    }

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
      _setSign(this.index + 1, "今日已签到", "", String(this.member.point));
      _setStreak(this.index + 1, st.ladderDays);
      return this.result;
    }

    await sleep(jitter(1500, 500));
    const r = await this.doSign();

    if (r.ok && r.already) {
      this.result.ok = true;
      this.result.detail = `今日已签到 · 积分${this.member.point}`;
      L.ok(this.tag(r.msg));
      _setSign(this.index + 1, "今日已签到", "", String(this.member.point));
      return this.result;
    }
    if (!r.ok) {
      this.result.ok = false;
      this.result.detail = `签到失败: ${r.msg}`;
      L.fail(this.tag(this.result.detail));
      _setSign(this.index + 1, "签到失败");
      return this.result;
    }

    // 成功：回查最新积分
    let latest = this.member.point;
    try {
      await sleep(jitter(1200, 300));
      const again = await this.login(true);
      latest = again.point;
    } catch (_) { /* 回查失败不影响结论 */ }

    this.result.ok = true;
    this.result.detail = `签到成功 +${r.points} 积分 · 连签${r.ladder}天 · 当前积分${latest}`;
    L.ok(this.tag(this.result.detail));
    _setSign(this.index + 1, "签到成功", r.points > 0 ? `+${r.points}积分` : "", String(latest));
    _setStreak(this.index + 1, r.ladder);
    return this.result;
  }
}

// ============================== 推送(std_report 双引擎, 钉钉 markdown) ==============================
const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = NAME + "签到";
function _rpGet(idx) {
  if (!_rpRows[idx]) _rpRows[idx] = { idx: idx, name: "", sign: "", earned: "", total: "", streak: "", tasks: [], lottery: "", taskEarned: "" };
  return _rpRows[idx];
}
function _setName(idx, name) { if (name != null) _rpGet(idx).name = String(name); }
function _setSign(idx, sign, earned, total) {
  const r = _rpGet(idx);
  if (sign != null) r.sign = String(sign);
  if (earned != null && earned !== "") r.earned = String(earned);
  if (total != null && total !== "") r.total = String(total);
}
function _setStreak(idx, n) { if (n != null && n !== "") _rpGet(idx).streak = String(n); }
function _setTaskEarned(idx, text) { if (text != null && text !== "") _rpGet(idx).taskEarned = String(text); }
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
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

// ============================== 主流程 ==============================
(async () => {
  console.log(`\n🏨 ${NAME} 积分签到  ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  console.log("=".repeat(56));

  // ★ 账号来源统一走 wx_opinion（项目约定）
  const accounts = (process.env.wx_opinion || process.env.WECHAT_ACCOUNTS || "")
    .split(/[&\n]/).map((s) => s.trim()).filter(Boolean);

  if (!accounts.length) {
    L.fail("未配置 wx_opinion，退出");
    process.exit(1);
  }
  if (!WCS.auth) L.warn("未配置 wx_auth，WCS 授权可能失败");

  // 可选：小程序 openid 覆盖，按位置对应 wx_opinion
  const overrides = (process.env.gcihotel_openid || process.env.GCIHOTEL_OPENID || "")
    .split(/[&\n]/).map((s) => s.trim());

  L.info(`共 ${accounts.length} 个账号 · WCS ${WCS.base}`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = new Account(accounts[i], overrides[i], i);
    try {
      results.push(await acc.run());
    } catch (e) {
      // 账号级隔离：单账号异常不影响后续账号
      L.fail(acc.tag(`执行异常: ${e.message}`));
      results.push({ name: acc.remark, ok: false, detail: `异常: ${e.message}` });
      _setSign(i + 1, "执行异常: " + e.message);
    }
    if (i < accounts.length - 1) await sleep(jitter(4000, 1500));
  }

  console.log("\n" + "=".repeat(56));
  const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  lines.forEach((l) => console.log(l));

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n📊 成功 ${okCount}/${results.length}`);

  await flushLogPoints(_rpApp);

  process.exit(okCount > 0 ? 0 : 1);
})();
