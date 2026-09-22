/**
 * 乘龙之家 (LQDM) 任务脚本 - 动态签名版 v3 (全任务自动版)
 * App: dflqApp (Android) | 乘龙汽车 | API: https://lqdm-cvapp.dflzm.com
 *
 * 核心: ice-auth-sign 已完全逆向(每次实时生成), 行为类任务「自动到账、无需领取」。
 *   sign = SHA256( JavaURLEncoder.encode( method + path + "ice-auth-appkey:"+appkey
 *          + "ice-auth-timestamp:"+ts + paramStr + secret ) )
 *
 * 已验证可自动化任务(组内每日上限5币):
 *   签到(+1币) | 帖子点赞(+1币,自动) | 商品浏览(+1币) | 功能使用(+1币)
 *   帖子评论(成长值+2,自动) | 帖子收藏(成长值,自动) | 帖子分享(自动) | 商品分享(自动)
 *   领机油优惠券(限时,窗口外 205000,best-effort) | 完善资料(默认跳过,会覆盖真实资料)
 *
 * 环境变量(登录来源, 多账号均&分隔):
 *   LQDM_LOGIN_PLAIN : phoneB64|明文密码  (推荐! password 运行时用 getPublicKey 公钥 RSA 加密, 只改 env 明文即可, 不必重抓 HAR)
 *   LQDM_LOGIN_BLOB  : phoneB64|pwdB64    (password 也是密文, 整段来自 HAR)
 *   LQDM_COOKIE      : 直连 cookie(过期会 401, 仅兜底)
 *           LQDM_APPKEY / LQDM_SECRET / LQDM_DO_PROFILE(=1 启用资料完善)  | 推送: std_report 双引擎(钉钉 DING_WEBHOOK/DING_SECRET)
 * 账密登录说明: phone/password 经 app 加密(phone 为对称加密, 密钥在 360 加密 dex 中), 故采用 HAR 中
 *   加密好的密文块复用方案——每次运行调用 logon/password 换发全新 usersig, 彻底规避 90min 过期, 无需手动抓 cookie。
 *
 * v4: 并入 Python 版(乘龙之家_fixed.py)全部可自动化任务, 成为唯一全任务源(不再拆到青龙)。
 */
'use strict';
const https = require('https');
const crypto = require('crypto');

const APP_KEY = process.env.LQDM_APPKEY || '9831532554';
const SECRET  = process.env.LQDM_SECRET || '3b8379a44daa6ab982c886d8bcdcc82a';
const API_HOST = process.env.LQDM_DIRECT_IP || '106.55.118.205';
const HEADER_HOST = 'lqdm-cvapp.dflzm.com';
const UA = 'okhttp/3.14.9 (Android 16; Xiaomi 25113PN0EC Build/OS3.0.315.0.WPCCNXM 3.0.17 26070101 release dflqApp)';
const APPINFO = '{"appVersion":"3.0.17","osVersion":"Android 16","appType":"Android","deviceName":"Xiaomi 25113PN0EC","deviceId":"d2cfed9be0cfe2bafbc63ba35a753b93@1784820275456"}';
const DEVICE_SN = 'd2cfed9be0cfe2bafbc63ba35a753b93@1784820275456';
const P_USER = '/customer/cvapp-vip-user/exterior';
const P_DYN  = '/customer/cvapp-dynamic/exterior';
const P_MALL = '/customer/cvapp-mall/exterior';
const P_ACT  = '/customer/cvapp-activity/exterior';
const P_ACC  = '/customer/cvapp-vip-user/exterior/account';
const P_SVC  = '/customer/cvapp-service/exterior';
const COUPON_ID = '2c90ed549f566abc019f6321d04c717d';
const APP_HASH = 'a62f6cc49b9044d443cdca0d9ba4e09d69bae602cd466d47b4c61daa24ed556a';

function javaURLEncode(s){let o='';for(const b of Buffer.from(s,'utf-8')){const c=String.fromCharCode(b);if((c>='0'&&c<='9')||(c>='A'&&c<='Z')||(c>='a'&&c<='z')||c==='.'||c==='-'||c==='*'||c==='_')o+=c;else if(c===' ')o+='+';else o+='%'+b.toString(16).toUpperCase().padStart(2,'0');}return o;}
function getParamStr(s){const tm={};if(s)for(const pair of s.split('&')){const a=pair.split('=');const k=a[0];if(!(k in tm))tm[k]=a.length===1?'':a[1];}return Object.keys(tm).sort().map(k=>k.toLowerCase()+'='+tm[k].replace(/ /g,'')).join('');}
function genSign(method,path,query,body,ts){const mp='ice-auth-appkey:'+APP_KEY+'ice-auth-timestamp:'+ts;let ps;if(body&&body.length){if(body.startsWith('{'))ps='json='+body.replace(/ /g,'');else if(body.includes('multipart'))ps=getParamStr(query);else ps=getParamStr(body);}else ps=query?getParamStr(query):'';const raw=method+path+mp+ps+SECRET;return crypto.createHash('sha256').update(Buffer.from(javaURLEncode(raw),'utf-8')).digest('hex');}

const C = { R:'\x1b[0m', RED:'\x1b[31m', GREEN:'\x1b[32m', YELLOW:'\x1b[33m', CYAN:'\x1b[36m', BOLD:'\x1b[1m' };
function log(msg,color){const t=new Date().toLocaleTimeString('zh-CN',{hour12:false});console.log(C.BOLD+'['+t+']'+C.R+' '+(C[color]||'')+msg+C.R);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function rawRequest(method,path,query,cookie,userId,body){
  return new Promise((resolve,reject)=>{
    const ts=String(Date.now());
    const sign=genSign(method,path,query||'',body||'',ts);
    const fullPath=query?path+'?'+query:path;
    const headers={'Host':HEADER_HOST,'User-Agent':UA,'appInfo':APPINFO,'platform':'2','device':'cAndroid','deviceSN':DEVICE_SN,'Accept-Encoding':'identity','appKey':APP_KEY,'ice-auth-appkey':APP_KEY,'ice-auth-timestamp':ts,'ice-auth-sign':sign,'userId':userId,'Cookie':cookie};
    if(body)headers['Content-Type']='application/json;charset=UTF-8';
    const opt={hostname:API_HOST,port:443,path:fullPath,method,headers,rejectUnauthorized:false,timeout:20000};
    const req=https.request(opt,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve({code:res.statusCode,json:JSON.parse(d),raw:d,setCookie:res.headers['set-cookie']||[]});}catch(e){resolve({code:res.statusCode,json:null,raw:d,setCookie:res.headers['set-cookie']||[]});}});});
    req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
    if(body)req.write(body);req.end();
  });
}
async function request(method,path,query,cookie,userId,bodyObj){
  const body=bodyObj?JSON.stringify(bodyObj):'';
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const r=await rawRequest(method,path,query,cookie,userId,body);
      if(r.code===400&&/TencentWAF|Bad Request/i.test(r.raw||'')){log(`WAF 400，退避重试 ${attempt}/3`,'YELLOW');await delay(1500*attempt);continue;}
      return r;
    }catch(e){log(`请求异常(${attempt}/3): ${e.message}`,'YELLOW');await delay(1000*attempt);}
  }
  return {code:0,json:null,raw:'request failed',setCookie:[]};
}
function parseAccounts(){
  const raw=process.env.LQDM_COOKIE||'';
  return raw.split(/[\n&]/).map(s=>s.trim()).filter(s=>s&&/usersig=/.test(s)).map(cookie=>{
    const uid=(cookie.match(/userid=(\d+)/i)||[])[1]||'';
    const us=(cookie.match(/usersig=([^;]+)/i)||[])[1]||'';
    return {userId:uid,cookie:`userid=${uid};usersig=${us}`};
  }).filter(a=>a.userId&&a.cookie.includes('usersig='));
}

// 从 Set-Cookie 数组解析 userid / usersig
function parseSetCookie(arr){
  let userid='',usersig='';
  for(const sc of (arr||[])){
    const pair=String(sc).split(';')[0];
    const eq=pair.indexOf('=');
    const k=pair.slice(0,eq), v=pair.slice(eq+1);
    if(k==='userid')userid=v;
    if(k==='usersig')usersig=v;
  }
  return {userid,usersig};
}
// 账密登录: 复用 HAR 中加密好的 phone+password 密文块(确定性加密, 每次调用换发全新 usersig)
// 绕开 phone 对称密钥(在 360 加密 dex 中)——直接用已加密块, 服务端照常解密校验
// 登录凭证两种来源(多账号用 & 分隔):
//   LQDM_LOGIN_BLOB  : phoneB64|pwdB64     —— password 也是密文(整段来自 HAR)
//   LQDM_LOGIN_PLAIN : phoneB64|plainPwd   —— password 明文, 运行时用 getPublicKey 公钥 RSA 加密
// 注: phone 为对称加密密文(密钥在加密dex, 无法由明文生成), 故 phone 始终以密文形式提供。
async function getPublicKeyPem(){
  const r=await request('POST',P_ACC+'/getPublicKey','', '', '', {});
  if(r.json&&r.json.code===0&&r.json.data&&r.json.data.publicKey) return r.json.data.publicKey;
  throw new Error('获取RSA公钥失败: '+(r.raw||'').slice(0,120));
}
function rsaEncryptPwd(plain,pem){
  return crypto.publicEncrypt({key:pem,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(plain,'utf-8')).toString('base64');
}
async function doLogin(phoneB64,pwdInput,isPlain){
  let pwdB64=pwdInput;
  if(isPlain){const pem=await getPublicKeyPem();pwdB64=rsaEncryptPwd(pwdInput,pem);}
  // 可选: 包哈希校验(同 app 版本恒定, 失败不阻断登录)
  await request('POST',P_SVC+'/appPackageHash/validate','', '', '', {appVersion:'3.0.17',packageType:'ANDROID',hashValue:APP_HASH});
  const body=JSON.stringify({password:pwdB64,phone:phoneB64,nation:'86'});
  const r=await rawRequest('POST',P_ACC+'/logon/password','', ';;;', '', body);
  if(r.setCookie&&r.setCookie.length){
    const {userid,usersig}=parseSetCookie(r.setCookie);
    if(userid&&usersig) return {userId:userid,cookie:`userid=${userid};usersig=${usersig}`};
  }
  const msg=(r.json&&r.json.msg)||'';
  throw new Error('登录失败 code='+(r.code)+' '+(msg||(r.raw||'').slice(0,120)));
}
async function loginWithBlob(blob){const p=blob.split('|');if(p.length<2)throw new Error('blob 格式应为 phoneB64|pwdB64');return doLogin(p[0],p[1],false);}
async function loginWithPlain(blob){const p=blob.split('|');if(p.length<2)throw new Error('plain 格式应为 phoneB64|plainPwd');return doLogin(p[0],p[1],true);}

async function runAccount(acc,idx){
  _setName(idx, acc.userId);
  const tag=`账号${idx} (${acc.userId})`;
  log(`\n========== ${tag} ==========`,'BOLD');
  const res={userId:acc.userId,nick:'',integral:0,growth:0,level:'',signIn:'未知',signedDays:0,liked:0,commented:'—',collected:'—',shared:'—',browsed:'—',shareProduct:'—',coupon:'—',profile:'—',errors:[]};
  if(!acc.cookie){log('⚠️ 该账号登录失败，跳过: '+(acc.error||'未知'),'RED');res.signIn='登录失败';res.errors.push(acc.error||'登录失败');_setSign(idx,'登录失败');return res;}

  const me=await request('GET',P_USER+'/user/getMe','',acc.cookie,acc.userId);
  if(me.code===401||(me.json&&me.json.code===401)){log('❌ 401 usersig 已失效，请重新抓 HAR 更新该账号 cookie','RED');res.errors.push('cookie 失效(401)');res.signIn='cookie失效';_setSign(idx,'cookie失效');return res;}
  if(me.json&&me.json.code===0){const d=me.json.data||{};res.nick=d.nickname||d.nickName||d.username||'';log(`👤 ${res.nick||acc.userId}`,'GREEN');}else{log('getMe 异常: '+(me.raw||'').slice(0,150),'YELLOW');res.errors.push('getMe:'+((me.json&&me.json.code)||me.code));}
  await delay(600);

  const tc=await request('GET',P_USER+'/user/task/center','',acc.cookie,acc.userId);
  let alreadySigned=false;
  if(tc.json&&tc.json.code===0){
    const d=tc.json.data||{};res.integral=parseInt(d.integral)||0;res.growth=parseInt(d.growthValue)||0;res.level=d.userLevel||'';
    alreadySigned=d.isSignIn===1||d.isSignIn==='1';
    log(`💰 乘龙币=${res.integral} | 成长值=${res.growth} | ${res.level} | 今日${alreadySigned?'已签到':'未签到'}`,'GREEN');
    _setName(idx, res.nick || acc.userId);
  }else{log('task/center 异常: '+(tc.raw||'').slice(0,150),'YELLOW');res.errors.push('center:'+((tc.json&&tc.json.code)||tc.code));}
  await delay(600);

  // 1. 签到
  if(alreadySigned){res.signIn='今日已签到';_setSign(idx,'今日已签到');log('✅ 今日已签到，跳过','CYAN');}
  else{
    const si=await request('GET',P_USER+'/user/task/signIn','isReSign=0',acc.cookie,acc.userId);
    if(si.json){if(si.json.code===0){const day=(si.json.data&&(si.json.data.signInDay||si.json.data.signNum))||'';res.signIn='签到成功'+(day?`(第${day}天)`:'');res.integral+=1;_setSign(idx,'签到成功','今日+1币');if(day)_setStreak(idx,day);log('🎉 '+res.signIn,'GREEN');}
      else if(si.json.code===205000||si.json.code===-1||/已签/.test(si.json.msg||'')){res.signIn='今日已签到';_setSign(idx,'今日已签到');log('✅ 今日已签到','CYAN');}
      else{res.signIn='签到失败('+si.json.code+')';_setSign(idx,res.signIn);log('❌ 签到失败: code='+si.json.code+' msg='+si.json.msg,'RED');res.errors.push('signIn:'+si.json.code);}}
    else{res.signIn='签到无响应';_setSign(idx,res.signIn);log('❌ 签到无响应','RED');res.errors.push('signIn:无响应');}
  }
  await delay(600);

  // 2. 行为任务 (自动到账，无领取)
  const dyn=await request('GET',P_DYN+'/dynamic/list','type=1&page=1&pageSize=10',acc.cookie,acc.userId);
  const dl=dyn.json&&dyn.json.data;
  let posts=[];
  if(dl&&Array.isArray(dl.dataList))posts=dl.dataList;
  else if(Array.isArray(dl))posts=dl;
  const ids=posts.map(x=>x.id).filter(Boolean);
  log(`📋 取到动态 ${ids.length} 条`,'CYAN');
  // 点赞: 只赞未点赞帖(liked=0), 最多3帖; type='8'(字符串) 动态类型 —— 关键! type:2 会"已经点赞"假成功不计入
  const likeTargets=posts.filter(x=>x.liked==0).slice(0,3);
  if(likeTargets.length===0)log('⚠️ 无未点赞帖(今日或已点赞)','YELLOW');
  for(const p of likeTargets){
    const id=p.id;
    const r=await request('POST',P_DYN+'/interact/like','',acc.cookie,acc.userId,{entityId:id,type:'8'});
    if(r.json&&r.json.code===0){res.liked++;log(`👍 点赞 ${id.slice(0,8)} 成功`,'GREEN');}
    else log(`👍 点赞 ${id.slice(0,8)} -> ${r.json&&r.json.msg||r.code}`,'YELLOW');
    await delay(600);
  }
  // 评论: 完整参数(entityType='8' 动态类型), 成长值+2 到账
  if(ids[0]){
    const cm=await request('POST',P_DYN+'/comment/add','',acc.cookie,acc.userId,{entityId:ids[0],content:'支持一下',entityType:'8',parentId:'0',type:'0'});
    res.commented=(cm.json&&cm.json.code===0)?'成功':(cm.json&&cm.json.msg||'失败');
    log(`💬 评论 -> ${res.commented}`,'CYAN');
    await delay(600);
    // 收藏: 选未收藏帖(collection=0), body 只传 entityId(无 type)
    const colTarget=posts.find(x=>x.collection==0)||posts[0];
    const col=await request('POST',P_DYN+'/interact/collection','',acc.cookie,acc.userId,{entityId:colTarget.id});
    res.collected=(col.json&&col.json.code===0)?'成功':(col.json&&col.json.msg||'失败');
    log(`⭐ 收藏 -> ${res.collected}`,'CYAN');
    await delay(600);
  }
  // 商品浏览 (best-effort; exposure 接口返回成功但服务端按 App 埋点结算, 纯 API 可能不计入)
  const mall=await request('GET',P_MALL+'/product/list','page=1&pageSize=5',acc.cookie,acc.userId);
  const ml=mall.json&&mall.json.data;
  let pids=[];
  if(ml&&Array.isArray(ml.dataList))pids=ml.dataList.map(x=>x.productId||x.id).filter(Boolean);
  else if(Array.isArray(ml))pids=ml.map(x=>x.productId||x.id).filter(Boolean);
  if(pids[0]){
    const det=await request('GET',P_MALL+'/activity/products/exposure','productId='+pids[0],acc.cookie,acc.userId);
    res.browsed=(det.json&&det.json.code===0)?'成功(可能未计入)':(det.json&&det.json.msg||'失败');
    log(`🛒 商品浏览 -> ${res.browsed}`,'CYAN');
  }
  await delay(600);

  // 4. 帖子分享 (API 返回成功, 但需微信分享回调才计入 —— 纯 API 无法真正完成)
  if(ids[0]){
    const sh=await request('POST',P_DYN+'/interact/share','',acc.cookie,acc.userId,{entityId:ids[0]});
    res.shared=(sh.json&&sh.json.code===0)?'API成功(需微信回调)':(sh.json&&sh.json.msg||'失败');
    log(`🔁 帖子分享 -> ${res.shared}`,'YELLOW');
    await delay(600);
  }
  // 5. 商品分享 (同上, 需微信回调)
  {
    const sp=await request('GET',P_ACT+'/exclusiveActivityRecord/sendReward/shareProduct','',acc.cookie,acc.userId);
    res.shareProduct=(sp.json&&sp.json.code===0)?'API成功(需微信回调)':(sp.json&&sp.json.msg||'失败');
    log(`📦 商品分享 -> ${res.shareProduct}`,'YELLOW');
    await delay(600);
  }
  // 6. 领机油优惠券 (限时, 窗口外 205000, best-effort)
  {
    const cp=await request('GET',P_USER+'/coupon/receive','vin=&couponId='+COUPON_ID,acc.cookie,acc.userId);
    if(cp.json&&cp.json.code===0){res.coupon='领券成功';log('🎫 领券成功','GREEN');}
    else{res.coupon=(cp.json&&(cp.json.code+' '+(cp.json.msg||'')))||'窗口外/已领';log('🎫 领券: '+(cp.json&&cp.json.msg||'窗口外/已领'),'YELLOW');}
    await delay(600);
  }
  // 7. 完善资料 (默认跳过, 会覆盖真实资料; LQDM_DO_PROFILE=1 启用)
  if(process.env.LQDM_DO_PROFILE==='1'){
    const pf=await request('POST',P_USER+'/user/personalInformation/update','',acc.cookie,acc.userId,{fullName:'自动任务',birthday:'1997-05-27',gender:1,province:'北京',city:'北京市',area:'东城区',address:'自动化',purpose:35});
    res.profile=(pf.json&&pf.json.code===0)?'成功':(pf.json&&pf.json.msg||'失败');
    log(`📝 完善资料 -> ${res.profile}`,'CYAN');
    await delay(600);
  }

  // 3. 签到日历
  const now=new Date();
  const cal=await request('GET',P_USER+'/user/task/signInCalendar',`year=${now.getFullYear()}&month=${now.getMonth()+1}`,acc.cookie,acc.userId);
  if(cal.json&&cal.json.code===0){const days=Array.isArray(cal.json.data)?cal.json.data:(cal.json.data&&cal.json.data.dataList)||[];res.signedDays=days.filter(d=>d.isSignIn===1||d.isSignIn==='1').length;log(`📅 本月已签 ${res.signedDays} 天`,'CYAN');}
  _rpGet(idx).total = String(res.integral);
  return res;
}


const { report: _stdReport } = require("./std_report");
let _rpRows = [];
let _rpApp = '乘龙之家';
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
function _setStreak(idx, v) { if (v != null && v !== "") _rpGet(idx).streak = String(v); }
function _addTask(idx, name, status) { _rpGet(idx).tasks.push({ name: String(name), status: String(status) }); }
function _setLottery(idx, text) { if (text != null && text !== "") _rpGet(idx).lottery = String(text); }
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

async function main(){
  log('====== 乘龙之家·全任务自动版 v4 ======','BOLD');
  let accounts=[];
  const cookieEnv=(process.env.LQDM_COOKIE||'').trim();
  const blobEnv=(process.env.LQDM_LOGIN_BLOB||'').trim();
  const plainEnv=(process.env.LQDM_LOGIN_PLAIN||'').trim();
  if(cookieEnv){
    const ca=parseAccounts();
    if(ca.length) log('LQDM_COOKIE 账号 '+ca.length+' 个(直连 cookie, 过期会 401)','CYAN');
    accounts=accounts.concat(ca);
  }
  if(blobEnv){
    log('账密登录(LQDM_LOGIN_BLOB)','CYAN');
    const blobs=blobEnv.split('&').map(s=>s.trim()).filter(Boolean);
    for(const b of blobs){
      try{
        const a=await loginWithBlob(b);
        log('🔑 登录成功 userId='+a.userId,'GREEN');
        accounts.push(a);
      }catch(e){
        log('❌ 登录失败: '+e.message,'RED');
        accounts.push({userId:'(登录失败)',cookie:'',error:e.message});
      }
    }
  }
  if(plainEnv){
    log('账密登录(LQDM_LOGIN_PLAIN, 明文密码动态RSA)','CYAN');
    const blobs=plainEnv.split('&').map(s=>s.trim()).filter(Boolean);
    for(const b of blobs){
      try{
        const a=await loginWithPlain(b);
        log('🔑 登录成功 userId='+a.userId,'GREEN');
        accounts.push(a);
      }catch(e){
        log('❌ 登录失败: '+e.message,'RED');
        accounts.push({userId:'(登录失败)',cookie:'',error:e.message});
      }
    }
  }
  if(!accounts.length){log('未配置 LQDM_COOKIE / LQDM_LOGIN_BLOB / LQDM_LOGIN_PLAIN','RED');process.exit(0);}
  log(`共 ${accounts.length} 个账号`,'CYAN');
  const results=[];
  for(let i=0;i<accounts.length;i++){
    try{results.push(await runAccount(accounts[i],i+1));}
    catch(e){log('账号执行异常: '+e.message,'RED');results.push({userId:accounts[i].userId,signIn:'执行异常',errors:[e.message]});}
    if(i<accounts.length-1)await delay(1200);
  }
  const lines=results.map((r,i)=>{
    let s=`【账号${i+1}】${r.nick||r.userId}\n`;
    s+=`签到: ${r.signIn}`;
    if(r.signedDays)s+=` | 本月${r.signedDays}天`;
    s+=`\n乘龙币: ${r.integral} | 成长值: ${r.growth}${r.level?' | '+r.level:''}`;
    s+=`\n互动: 点赞${r.liked} 评论${r.commented} 收藏${r.collected} 分享${r.shared} 商品浏览${r.browsed} 商品分享${r.shareProduct}`;
    if(r.coupon!=='—')s+=`\n优惠券: ${r.coupon}`;
    if(r.profile!=='—')s+=`\n资料: ${r.profile}`;
    if(r.errors&&r.errors.length)s+=`\n⚠️ ${r.errors.join('; ')}`;
    return s;
  });
  const body=lines.join('\n\n');
  log('\n====== 汇总 ======','BOLD');console.log(body);
  log('====== 完成 ======','BOLD');
  process.exit(0);
}
main();
