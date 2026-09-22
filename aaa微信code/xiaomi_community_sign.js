const { report, send_push } = require("./std_report");
/*
@Description: 小米社区(MIUI VIP)签到 双模式
  - 模式A(推荐): 直接给社区 cookie(XIAOMI_COOKIES, 需含 miui_vip_serviceToken)
  - 模式B: 给护照级 cookie(XIAOMI_PASSPORT_COOKIE)自动走 SSO 换 miui_vip_serviceToken
cron: 20 14 * * *
*/
require("https").globalAgent.options.rejectUnauthorized = false;
["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"].forEach(k => process.env[k] = "");

const axios = require("axios");
const UA = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119";
const API_BASE = "https://api.vip.miui.com";
const CK_PARAMS = "ref=vipAccountShortcut&pathname=%2Fmio%2FcheckIn&version=dev.241119&device=alioth";

function log(m){ console.log(m); }
function parseCookies(raw){ const c={}; (raw||"").split(/;\s*/).forEach(p=>{const i=p.indexOf('=');if(i>0)c[p.slice(0,i).trim()]=p.slice(i+1).trim();}); return c; }
function cookiesToStr(c){ return Object.entries(c).map(([k,v])=>`${k}=${v}`).join('; '); }
function jarFromResp(resp){ const sc=resp.headers["set-cookie"]; const jar={}; if(!sc)return jar; (Array.isArray(sc)?sc:[sc]).forEach(c=>{const i=c.indexOf("="); if(i>0){const k=c.slice(0,i).trim(); jar[k]=c.slice(i+1,c.indexOf(";",i)).trim();}}); return jar; }

// ==================== 护照 cookie -> miui_vip SSO ====================
async function ssoExchange(passportCookie){
  const baseHeaders = { "User-Agent": UA, "Referer":"https://web.vip.miui.com/", "Accept-Language":"zh-CN,zh;q=0.9,en;q=0.8", "Cache-Control":"no-cache", "Pragma":"no-cache" };
  try {
    const t = Date.now();
    const r1 = await axios.get(`${API_BASE}/page/login?destUrl=${encodeURIComponent("https://web.vip.miui.com/page/info/mio/mio/checkIn?app_version=dev.230904")}&time=${t}`, { headers:{...baseHeaders, Cookie:passportCookie}, maxRedirects:0, validateStatus:()=>true });
    const loc1 = r1.headers.location;
    if(!loc1) return null;
    const r2 = await axios.get(loc1, { headers:{...baseHeaders, Cookie:passportCookie}, maxRedirects:0, validateStatus:()=>true });
    const loc2 = r2.headers.location;
    if(!loc2) return null;
    let cur=loc2, jar={}, hop=0;
    while(cur && hop<8){
      hop++;
      const rc = await axios.get(cur, { headers:{...baseHeaders, Cookie:passportCookie}, maxRedirects:0, validateStatus:()=>true });
      Object.assign(jar, jarFromResp(rc));
      const nl = rc.headers.location;
      if(!nl){ break; }
      cur = nl.startsWith("http")?nl:(nl.startsWith("/")?"https://account.xiaomi.com"+nl:"https://api.vip.miui.com"+nl);
    }
    if(jar.miui_vip_serviceToken){
      const combined = Object.assign({}, parseCookies(passportCookie), jar);
      return cookiesToStr(combined);
    }
    return null;
  } catch(e){ log(`[SSO] 异常: ${e.message}`); return null; }
}

// ==================== 社区 API ====================
async function apiGET(endpoint, cookies){
  try {
    const resp = await axios.get(API_BASE+endpoint, { headers:{ Cookie:cookiesToStr(cookies), "User-Agent":UA, Origin:"https://web.vip.miui.com", Referer:"https://web.vip.miui.com/" }, timeout:15000 });
    const d = resp.data;
    if(d.message==="success" && d.status===200) return { code:200, data:d.entity };
    return { code:d.status||500, message:d.message||"err" };
  } catch(e){ return { code:-1, message:e.message }; }
}
function randomStr(len){ return Math.random().toString(36).slice(2,2+len); }
async function doCheckin(cookies){
  const ph = encodeURIComponent(cookies.miui_vip_ph||'');
  const url = `${API_BASE}/mtop/planet/vip/user/checkinV2?${CK_PARAMS}&miui_vip_ph=${ph}`;
  const boundary = "----XB"+randomStr(8);
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n\r\n--${boundary}--\r\n`;
  try {
    const resp = await axios.post(url, body, { headers:{ Cookie:cookiesToStr(cookies), "User-Agent":"Mozilla/5.0 (Linux; Android 16; M2012K11AC) AppleWebKit/537.36 XiaoMi/HybridView/ app/vipaccount/dev.241119", "Content-Type":`multipart/form-data; boundary=${boundary}`, Origin:"https://web.vip.miui.com", "X-Requested-With":"com.xiaomi.vipaccount" }, timeout:15000 });
    const d = resp.data;
    if(d.status===200) return { code:200, data:d.entity, message:d.message };
    return { code:d.status||500, message:d.message||"err" };
  } catch(e){ return { code:-1, message:e.message }; }
}


// ===== 统一积分日志/推送 (自动注入 v2: 末次汇总推送1次) =====
let _lpRows = [];
let _lpApp = '';
let _lpFlushed = false;
function digPoints(obj) {
  if (obj == null) return null;
  const keys = ['point','points','score','scores','integral','growth','coin','beans','bean','balance','addScore','getScore','addPoint','todayScore','signScore','awardScore','awardAmount','awardVipcoinTotal','vipGrow','VipGrow','currentIntegral','changeIntegeral','totalPoint','totalPoints','credit','credits','exp','growthValue','keepScore','signScore'];
  let found = null;
  const walk = (o, depth) => {
    if (found != null || depth > 4 || !o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const lk = k.toLowerCase();
      if (keys.includes(lk) && (typeof o[k] === 'number' || (typeof o[k] === 'string' && o[k] !== '' && !isNaN(Number(o[k]))))) { found = Number(o[k]); return; }
      if (typeof o[k] === 'object') walk(o[k], depth + 1);
      if (found != null) return;
    }
  };
  walk(obj, 0);
  return found;
}
function logPoints(todayPoints, totalPoints, app, idx, status) {
  const tp = Number(todayPoints) || 0;
  const tot = Number(totalPoints) || 0;
  _lpApp = app || _lpApp;
  if (!_lpFlushed) _lpRows.push({
    idx: idx,
    name: app,
    sign: status || "签到完成",
    earned: tp > 0 ? '今日+' + tp + '积分' : null,
    total: tot > 0 ? '累计' + tot + '积分' : null,
  });
}
async function flushLogPoints(app) {
  if (_lpFlushed) return;
  _lpFlushed = true;
  if (!_lpRows.length) return;
  await report(app || _lpApp || '签到', _lpRows);
}
// 进程退出前/退出时汇总推送1次
{
  const _lpOE = process.exit.bind(process);
  process.exit = function (code) {
    const p = flushLogPoints(_lpApp);
    if (p && typeof p.then === 'function') { p.then(() => _lpOE(code)).catch(() => _lpOE(code)); }
    else { _lpOE(code); }
  };
}
process.on('beforeExit', () => { flushLogPoints(_lpApp); });


// ==================== 主流程 ====================
async function run(){
  let cookies = null;
  let mode = "";
  const directCookie = process.env.XIAOMI_COOKIES || "";
  const passportCookie = process.env.XIAOMI_PASSPORT_COOKIE || "";

  if(directCookie){
    const c = parseCookies(directCookie);
    if(c.miui_vip_serviceToken){ cookies = c; mode = "A(社区cookie直登)"; }
    else log("[模式A] XIAOMI_COOKIES 缺少 miui_vip_serviceToken, 跳过");
  }
  if(!cookies && passportCookie){
    mode = "B(护照cookie SSO)";
    log("[模式B] 用护照 cookie 走 SSO 换 miui_vip_serviceToken ...");
    const derived = await ssoExchange(passportCookie);
    if(derived){ cookies = parseCookies(derived); log("[模式B] SSO 成功, 已获得 miui_vip_serviceToken"); }
    else log("[模式B] SSO 失败: 护照会话被小米拒绝(通常 passToken 过期或绑定设备). 请在 web.vip.miui.com 登录后复制含 miui_vip_serviceToken 的 cookie 填入 XIAOMI_COOKIES");
  }
  if(!cookies){
    log("\n[未配置] 需要以下之一:");
    log("  1) XIAOMI_COOKIES = 在 web.vip.miui.com 登录后复制的 cookie(需含 miui_vip_serviceToken)");
    log("  2) XIAOMI_PASSPORT_COOKIE = account.xiaomi.com 护照 cookie(需会话有效)");
    return;
  }

  const uid = cookies.cUserId || cookies.userId || "";
  log(`\n[账号] cUserId: ${(uid).slice(0,12)}...  模式: ${mode}`);

  log("\n[查询] 签到状态...");
    if (typeof logPoints === 'function') logPoints(null, null, "xiaomicommunity", 1, "签到成功") // local accumulation needed;
  const info = await apiGET(`/mtop/planet/vip/user/getUserCheckinInfoV2?${CK_PARAMS}`, cookies);
  if(info.code!==200 || !info.data){ log(`[查询] 失败: ${info.message||info.code}`); if((info.message||"").includes("cookie")) log("[提示] cookie 失效, 请更新"); return; }
  log(`[查询] ${info.data.hasCheckIn ? '今日已签到' : '今日未签到'} | 连续 ${info.data.continueCheckInDays||0} 天` + (info.data.growScore!==undefined?` | 成长值 ${info.data.growScore}`:""));

  if(info.data.hasCheckIn){ log("\n[签到] 今日已签, 跳过"); }
  else {
    log("\n[签到] 执行中...");
    const r = await doCheckin(cookies);
    if(r.code===200) log(`[签到] 成功! 返回: ${JSON.stringify(r.data).slice(0,120)}`);
    else { log(`[签到] 失败: ${r.message}`); if((r.message||"").includes("cookie")) log("[提示] cookie 失效, 请更新"); }
  }
  log("\n======== 完成 ========");
}
run().catch(e=>{ log("[致命] "+e.message); log(e.stack); }).finally(()=>process.exit(0));
