/**
 * 果而惊喜会员社 - 每日签到 + 会员权益领取（数云 shuyun 会员小程序）
 * 逆向来源: 42.81.252.154 HAR（ual.shuyun.com）
 * 框架: 数云会员 SaaS（wmc-interact-c），无签名/HMAC，纯 WCS code → x-token
 * AppID(platShopId): wxef9c343826dea891
 * Tenant: w22vah0626wq
 * API: https://ual.shuyun.com/wmc-interact-c/1.3
 * cron: 30 20 * * *
 *
 * 任务范围（选项 C = 全部）:
 *   1) 每日签到 GET /sign/1778 (+2 积分，先查 activity/info/1778 的 typeInfo.signFlag 防重复)
 *      ⚠️ typeInfo.signed 是「连续签到天数计数」(1,2,3...)，NOT「今日是否已签」；
 *         真正的今日标记是 typeInfo.signFlag(1=今日已签,0=未签)。误用 signed===1 会导致跳过签到。
 *   2) 会员权益领取 GET /memberBenefit/getMemberBenefit → 对 INTEGRATE_BENEFIT_COUPON 调 receiveAward
 *      （入会奖励 id=415 +10 积分，一次性；其余为 LINK 页面类权益，非 API 领取，跳过）
 *
 * 环境变量（统一）:
 *   wx_opinion    - OpenID，多账号用 & 分隔
 *   wx_server_url - WCS 服务地址（默认 http://smallcat-client:8787）
 *   wx_auth       - WCS 认证密钥（兜底）
 *   NICK_MAP      - openid:昵称&openid:昵称（可选，日志友好）
 *   PLUSPLUS_TOKEN / PUSH_PLUS_TOKEN - PushPlus 推送（可选）
 */

for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k];

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== 常量 ====================
const wxOpinion = process.env.wx_opinion || "";
const wxServer  = process.env.wx_server_url || "http://smallcat-client:8787";
const wxAuthEnv = process.env.wx_auth || "";
const APPID   = "wxef9c343826dea891";
const TENANT  = "w22vah0626wq";
const BASE    = "https://ual.shuyun.com/wmc-interact-c/1.3";
const ACTIVITY_ID = 1778;
const PAGE_REF = `https://servicewechat.com/${APPID}/20/page-frame.html`;
const UA = "Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 XWEB/1500047 MMWEBSDK/20260502 MMWEBID/38 MicroMessenger/8.0.76.3141(0x28004C3C) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android";
const WCS_AUTH_CACHE = path.join(__dirname, "guoer_wcs_auth.json");
const WCS_USER = "yr1314";
const WCS_PASS = "yr123123";

// ==================== 日志 ====================
const L = {
  ok:   (m) => console.log(`  ✅ ${m}`),
  fail: (m) => console.log(`  ❌ ${m}`),
  info: (m) => console.log(`  ℹ️ ${m}`),
  warn: (m) => console.log(`  ⚠️ ${m}`),
  act:  (m) => console.log(`  🌐 ${m}`),
};

function loadJSON(f){ try { return fs.existsSync(f)? JSON.parse(fs.readFileSync(f,"utf8"))||{} : {}; } catch(e){ return {}; } }
function saveJSON(f,d){ try { fs.writeFileSync(f, JSON.stringify(d,null,2), "utf8"); } catch(e){} }

// ==================== NICK 映射 ====================
function parseNickMap(){
  const raw = process.env.NICK_MAP || "";
  const m = {};
  for (const part of raw.split("&")){
    if(!part) continue;
    const i = part.indexOf(":");
    if(i>0) m[part.slice(0,i).trim()] = part.slice(i+1).trim();
    else { const j = part.indexOf("="); if(j>0) m[part.slice(0,j).trim()] = part.slice(j+1).trim(); }
  }
  return m;
}
const NICK = parseNickMap();
function nick(openid){ return NICK[openid] || (openid.length>8? openid.slice(0,6)+"…" : openid); }

// ==================== WCS 鉴权 ====================
async function getWcsAuth(){
  const cached = loadJSON(WCS_AUTH_CACHE);
  if (cached.auth && cached.expiresAt > Date.now()) return cached.auth;
  try {
    const res = await axios.post(`${wxServer}/api/client/login`, { username: WCS_USER, password: WCS_PASS }, { timeout: 15000, proxy: false });
    if (res.data?.status && res.data?.data?.auth){
      const auth = res.data.data.auth;
      saveJSON(WCS_AUTH_CACHE, { auth, expiresAt: Date.now()+3600000 });
      return auth;
    }
  } catch(e){ /* 回退 wx_auth */ }
  if (wxAuthEnv) return wxAuthEnv;
  L.fail("WCS 登录失败且无 wx_auth 兜底");
  return null;
}

async function getWxCode(openid){
  try {
    const auth = await getWcsAuth();
    if (!auth) return null;
    const res = await axios.post(`${wxServer}/wx/code`, { openid, appid: APPID },
      { headers: { auth }, timeout: 15000, proxy: false });
    if (res.data?.status && res.data?.data?.code) return res.data.data.code;
    L.fail(`WCS code 失败: ${JSON.stringify(res.data).slice(0,120)}`);
    return null;
  } catch(e){ L.fail(`WCS 异常: ${e.message}`); return null; }
}

// ==================== 果而 API ====================
function authHeaders(sess){
  return {
    "x-platshopid": APPID,
    "x-tenant": TENANT,
    "x-token": sess.token,
    "x-tx": String(sess.tx),
    "x-uid": sess.uid,
    "x-unionid": sess.unionId,
    "x-cp": "",
    "content-type": "application/json",
    "charset": "utf-8",
    "referer": PAGE_REF,
    "user-agent": UA,
  };
}

function req(pathOrUrl, opts){
  return axios({ url: pathOrUrl, timeout: 15000, proxy: false, ...opts });
}

async function login(openid){
  const code = await getWxCode(openid);
  if (!code) return null;
  try {
    const res = await req(`${BASE}/index`, { method: "GET", params: { platShopId: APPID, jsCode: code } });
    const d = res.data?.data || {};
    if (res.data?.success && d.token){
      return { token: d.token, tx: d.tx, uid: d.uid, unionId: d.unionId, tenantId: d.tenantId };
    }
    L.fail(`登录失败: ${JSON.stringify(res.data).slice(0,120)}`);
    return null;
  } catch(e){ L.fail(`登录异常: ${e.message}`); return null; }
}

async function getMemberInfo(sess){
  try {
    const res = await req(`${BASE}/member/info`, { method: "GET", headers: authHeaders(sess), params: { sourceAppId: "" } });
    if (res.data?.success) return res.data.data;
  } catch(e){}
  return null;
}

async function getSignStatus(sess){
  try {
    const res = await req(`${BASE}/activity/info/${ACTIVITY_ID}`, { method: "GET", headers: authHeaders(sess) });
    // 注意: typeInfo.signFlag 才是「今日是否已签」(1=已签,0=未签); typeInfo.signed 是连续天数计数, 不可用
    if (res.data?.success) return res.data.data?.typeInfo?.signFlag ?? null;
  } catch(e){}
  return null;
}

async function doSign(sess){
  try {
    const res = await req(`${BASE}/sign/${ACTIVITY_ID}`, { method: "GET", headers: authHeaders(sess) });
    const d = res.data?.data || {};
    if (res.data?.success && d.errorCode === "20001"){
      let qty = 0;
      for (const a of (d.receiveList||[])) qty += (a.quantity||0);
      return { ok: true, qty, already: false };
    }
    // 幂等: 已经签过 (code=-1 / msg 含"今日已签到") —— 视为成功, 不再报错
    if (res.data?.code === "-1" || (res.data?.msg||"").includes("今日已签到")){
      return { ok: true, qty: 0, already: true };
    }
    L.fail(`签到返回异常: ${JSON.stringify(res.data).slice(0,160)}`);
    return { ok: false };
  } catch(e){ L.fail(`签到异常: ${e.message}`); return { ok: false }; }
}

async function claimBenefits(sess){
  const results = [];
  try {
    const res = await req(`${BASE}/memberBenefit/getMemberBenefit`, { method: "GET", headers: authHeaders(sess) });
    const list = (res.data?.data?.list) || [];
    for (const b of list){
      if (b.benefitType !== "INTEGRATE_BENEFIT_COUPON"){
        L.info(`跳过页面类权益: ${b.benefitName}`);
        continue;
      }
      // 查状态，已领取则跳过
      let received = false;
      try {
        const info = await req(`${BASE}/memberBenefit/info/${b.id}`, { method: "GET", headers: authHeaders(sess) });
        for (const a of (info.data?.data?.memberBenefitAward||[])){
          if (a.status === "alreadyReceived") received = true;
        }
      } catch(e){}
      if (received){ L.info(`${b.benefitName} 已领取，跳过`); continue; }
      try {
        const r = await req(`${BASE}/memberBenefit/receiveAward`, {
          method: "POST",
          headers: { ...authHeaders(sess), "content-type": "application/json" },
          data: { id: b.id, benefitAwardType: "INTEGRAL", couponId: "" },
        });
        if (r.data?.success){
          let qty = 0;
          for (const a of (r.data?.data?.receiveList||[])) qty += (a.quantity||0);
          L.ok(`领取会员权益 ${b.benefitName} +${qty}积分`);
          results.push({ name: b.benefitName, qty });
        } else if (r.data?.code === "5003" || (r.data?.msg||"").includes("权益不存在")) {
          L.info(`${b.benefitName} 暂不适用: 该账号尚未完成入会(join)，可在小程序内入会后由脚本自动领取`);
        } else {
          L.warn(`${b.benefitName} 领取返回: ${JSON.stringify(r.data).slice(0,120)}`);
        }
      } catch(e){ L.fail(`${b.benefitName} 领取异常: ${e.message}`); }
    }
  } catch(e){ L.fail(`会员权益列表获取失败: ${e.message}`); }
  return results;
}

// ==================== 推送 ====================
async function push(title, content){
  const token = process.env.PLUSPLUS_TOKEN || process.env.PUSH_PLUS_TOKEN;
  if (!token) return;
  try {
    await axios.post("https://www.pushplus.plus/send", { token, title, content, template: "txt" }, { timeout: 10000, proxy: false });
  } catch(e){}
}

// ==================== 主流程 ====================
async function runAccount(openid){
  console.log(`\n========== 账号[${nick(openid)}] ==========`);
  const sess = await login(openid);
  if (!sess){ L.fail("登录失败，跳过"); return { ok:false }; }
  L.ok(`登录成功 uid=${sess.uid.slice(0,12)}…`);
  const info = await getMemberInfo(sess);
  if (info) L.info(`会员: ${info.gradeCaption||'?'}(V${info.grade}) 积分=${info.point}`);

  // 1) 每日签到  (signFlag: 1=今日已签, 0=未签; 切勿用 signed 连续天数计数)
  let signDone = false;
  const signFlag = await getSignStatus(sess);
  if (signFlag === 1){ L.info("今日已签到"); signDone = true; }
  else {
    const r = await doSign(sess);
    if (r.ok){
      L.ok(r.already ? "今日已签到(幂等确认)" : `签到成功 +${r.qty}积分`);
      signDone = true;
      // 防假阳性: 复查确认服务端 signFlag==1
      const re = await getSignStatus(sess);
      if (re !== 1) L.warn("复查: 服务端 signFlag 仍非1, 签到记录可能未落库(积分奖励 SEND_FAIL 不影响签到日期)");
    } else {
      L.fail("签到未成功");
    }
  }

  // 2) 会员权益领取
  const benefits = await claimBenefits(sess);
  return { ok:true, benefits, signDone };
}

(async () => {
  console.log("🔔 果而惊喜会员社,开始");
  const accounts = wxOpinion.split("&").map(s=>s.trim()).filter(Boolean);
  if (!accounts.length){ console.log("❌ 未配置 wx_opinion"); return; }
  const summary = [];
  for (const openid of accounts){
    try {
      const r = await runAccount(openid);
      if (r.ok) summary.push(`✅ ${nick(openid)}: 签到${r.signDone?"成功":"未完成"}/权益${r.benefits?.length?"已领"+r.benefits.length:"无"}`);
    } catch(e){ L.fail(`账号异常: ${e.message}`); }
  }
  console.log("\n🔔 果而惊喜会员社,结束");
  if (summary.length) await push("果而惊喜会员社", summary.join("\n"));
})();
