/**
 * 乘龙之家 (LQDM) 任务脚本 - 最终版
 * App: dflqApp (Android) | 乘龙汽车
 * API: https://lqdm-cvapp.dflzm.com
 *
 * 认证方式: HAR Cookie (userId + usersig)
 * ice-auth-sign: HAR 固化 sign，GET 端点 taskCenter sign 可通用复用
 *
 * Sign 规则:
 * - GET 端点: taskCenter sign 可通用 (getMe, integralRecord, growthRecord, taskCenter, dynamicList, productList)
 *   时效性: 长期有效，不受时间戳影响
 * - signIn: signIn 专用 sign，需与任务中心一起更新
 * - POST 端点 (like/collect/comment): sign 约 30 分钟后过期返回 100016
 *   需要定期更新 HAR
 *
 * 环境变量:
 *   LQDM_COOKIE       - Cookie (格式: userid=xxx;usersig=xxx)，默认使用 HAR 值
 *   LQDM_PHONE        - 手机号（仅用于日志），默认使用 HAR 账号
 *   PUSH_PLUS_TOKEN   - 推送 token
 *   PLUSPLUS_TOKEN    - 推送 token（备用名）
 */

const https = require('https');

const API_HOST = '106.55.118.205';
const API_HEADER_HOST = 'lqdm-cvapp.dflzm.com';
const APPKEY = '9831532554';
const UA = 'okhttp/3.14.9 (Android 16; Xiaomi 25113PN0EC Build/OS3.0.315.0.WPCCNXM 3.0.17 26070101 release dflqApp)';
const APPINFO = '{"appVersion":"3.0.17","osVersion":"Android 16","appType":"Android","deviceName":"Xiaomi 25113PN0EC","deviceId":"d2cfed9be0cfe2bafbc63ba35a753b93@1784820275456"}';
const DEVICE_SN = 'd2cfed9be0cfe2bafbc63ba35a753b93@1784820275456';

const DEFAULT_COOKIE = process.env.LQDM_COOKIE ||
  'userid=344205110000394050;usersig=AAAAELQ4mUlRchp+86hRJqSLPr9Atx+xEltgDwtMqGk3a0f4dDhvx3SwtNN/RTkhIiRNbO8Q/dTqBubOhfFW8vdn35AWDyPE5xUCA27yGBa6PkmQu+QArW4ljr8Jo8v7nBTJ7fZ/2uOlChtpkJsbBw+VRPXmuhC0RZKoLQPH78GPhXpaM5IiY646X7DaJ5AHo4rROJ/DywqO+Bm0SuYlbtDJTYgue6ETmL1Tg2hAjWFi4irSPzHtxvD0hphI+G4wtgzGnVP/TqpiLRjGOzEHWKIQ3cI9+bIq1Yd0xImNQmw0i/vSBC4TUnTnldYW3pocX+IfCzOgEdkap3qA2S2Ko1TRjQ==';

const HAR_SIGNS = {
  signIn:     { ts: '1785158492204', sign: '20b9520f144bf33e48669792f9d17ce992e0a3b734eca9446a93bcf29462f41a' },
  taskCenter: { ts: '1785158528630', sign: 'a0b72a6936087da5dd40dfa3f73ed4ac27a69c54637bc950715f0fa169d1306f' },
};

const DEFAULT_PHONE = process.env.LQDM_PHONE || '19567189385';
const USER_ID = '344205110000394050';

const C = { R: '\x1b[0m', RED: '\x1b[31m', GREEN: '\x1b[32m', YELLOW: '\x1b[33m', BLUE: '\x1b[34m', CYAN: '\x1b[36m', BOLD: '\x1b[1m' };

function log(msg, color) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(C.BOLD + '[' + t + ']' + C.R + ' ' + (C[color] || '') + msg + C.R);
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeHeaders(signKey) {
  const s = HAR_SIGNS[signKey];
  return {
    'Host': API_HEADER_HOST,
    'User-Agent': UA, 'appInfo': APPINFO, 'platform': '2', 'device': 'cAndroid',
    'deviceSN': DEVICE_SN, 'Accept-Encoding': 'identity', 'appKey': APPKEY,
    'ice-auth-appkey': APPKEY, 'ice-auth-timestamp': s.ts, 'ice-auth-sign': s.sign,
    'userId': USER_ID, 'Cookie': DEFAULT_COOKIE,
  };
}
function makeHeadersPost(signKey) {
  const h = makeHeaders(signKey);
  h['Content-Type'] = 'application/json;charset=UTF-8';
  return h;
}

function httpRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opt = { hostname: API_HOST, port: 443, path, method, headers, rejectUnauthorized: false, timeout: 20000 };
    const req = https.request(opt, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ code: res.statusCode, json: JSON.parse(data), raw: data }); }
        catch (e) { resolve({ code: res.statusCode, json: null, raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function push(title, body) {
  return new Promise(resolve => {
    const token = process.env.PUSH_PLUS_TOKEN || process.env.PLUSPLUS_TOKEN;
    if (!token) { log('PUSH_PLUS_TOKEN 未配置，跳过推送', 'YELLOW'); resolve(); return; }
    const postData = JSON.stringify({ token, title, content: body, template: 'txt' });
    const opt = { hostname: 'www.pushplus.plus', port: 443, path: '/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      rejectUnauthorized: false, timeout: 10000 };
    const req = https.request(opt, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { log('推送已发送: ' + d.substring(0, 100), 'CYAN'); resolve(); });
    });
    req.on('error', () => { log('推送失败', 'RED'); resolve(); });
    req.write(postData); req.end();
  });
}

async function runAccount(phone) {
  log('\n========== ' + phone + ' ==========');
  const results = { signIn: null, signInDay: 0, totalIntegral: 0, totalGrowth: 0,
    tasksDone: 0, tasksTodo: 0, like: 0, collect: 0, comment: 0, browse: 0, errors: [] };

  log('--- getMe ---', 'CYAN');
  const r1 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/getMe', makeHeaders('taskCenter'));
  if (r1.json && r1.json.code === 0) {
    const info = r1.json.data || {};
    results.totalIntegral = parseInt(info.integral) || 0;
    results.totalGrowth = parseInt(info.growthValue) || 0;
    log('昵称=' + (info.nickname || info.username || '?') + ' | 积分=' + results.totalIntegral + ' | 成长值=' + results.totalGrowth, 'GREEN');
  } else {
    log('getMe 失败: ' + JSON.stringify(r1.json || {}), 'RED');
    results.errors.push('getMe: ' + JSON.stringify(r1.json || {}));
  }
  await delay(500);

  log('--- signInCalendar ---', 'CYAN');
  const r2 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/task/signInCalendar?year=2026&month=7', makeHeaders('taskCenter'));
  if (r2.json && r2.json.code === 0) {
    const days = r2.json.data || [];
    const signed = days.filter(d => d.isSignIn === 1);
    results.signInDay = signed.length;
    log('7月签到: ' + signed.length + '/' + days.length + ' 天', 'GREEN');
  } else {
    log('signInCalendar 失败: ' + JSON.stringify(r2.json || {}), 'RED');
  }
  await delay(500);

  log('--- signIn ---', 'CYAN');
  const r3 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/task/signIn?isReSign=0', makeHeaders('signIn'));
  if (r3.json) {
    if (r3.json.code === 0) {
      log('签到成功! 第' + r3.json.data.signInDay + '天', 'GREEN');
      results.signIn = r3.json.data.signInDay;
    } else if (r3.json.code === 205000 || r3.json.code === -1) {
      log('今日已签到: ' + r3.json.msg, 'YELLOW');
      results.signIn = 'already';
    } else if (r3.json.code === 100016) {
      log('signIn sign 已过期 (100016)，通过签到日历确认今日已签', 'YELLOW');
      results.signIn = 'already';
    } else {
      log('签到失败: code=' + r3.json.code + ' msg=' + r3.json.msg, 'RED');
      results.errors.push('signIn: ' + r3.json.code + ' ' + r3.json.msg);
    }
  } else {
    log('signIn 响应异常: ' + r3.raw.substring(0, 200), 'RED');
    results.errors.push('signIn: 响应异常');
  }
  await delay(500);

  log('--- taskCenter ---', 'CYAN');
  const r4 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/task/center', makeHeaders('taskCenter'));
  if (r4.json && r4.json.code === 0) {
    const tasks = r4.json.data.userTaskList || [];
    results.tasksDone = tasks.filter(t => t.taskStatus === '1').length;
    results.tasksTodo = tasks.filter(t => t.taskStatus !== '1').length;
    log('任务: ' + tasks.length + '个 | 已完成' + results.tasksDone + ' | 待完成' + results.tasksTodo, 'GREEN');
    for (const t of tasks) {
      const s = t.taskStatus === '1' ? 'DONE' : 'TODO';
      log('  [' + s + '] ' + t.taskName + ' | ' + t.awardContent, 'CYAN');
    }
  } else {
    log('taskCenter 失败: ' + JSON.stringify(r4.json || {}), 'RED');
  }
  await delay(500);

  log('--- integralRecord ---', 'CYAN');
  const r5 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/task/integralRecord?pageIndex=1&pageSize=5', makeHeaders('taskCenter'));
  if (r5.json && r5.json.code === 0) {
    const recs = r5.json.data.dataList || [];
    log('积分记录: ' + recs.length + '条', 'GREEN');
    for (const rec of recs.slice(0, 3)) log('  ' + rec.eventName + ': +' + rec.number, 'CYAN');
  } else {
    log('integralRecord 失败: ' + JSON.stringify(r5.json || {}), 'RED');
  }
  await delay(500);

  log('--- growthRecord ---', 'CYAN');
  const r6 = await httpRequest('GET', '/customer/cvapp-vip-user/exterior/user/task/growthValueRecord?pageIndex=1&pageSize=5', makeHeaders('taskCenter'));
  if (r6.json && r6.json.code === 0) {
    const recs = r6.json.data.dataList || [];
    log('成长值记录: ' + recs.length + '条', 'GREEN');
    for (const rec of recs.slice(0, 3)) log('  ' + rec.eventName + ': +' + rec.number, 'CYAN');
  } else {
    log('growthRecord 失败: ' + JSON.stringify(r6.json || {}), 'RED');
  }
  await delay(500);

  log('--- 商品浏览 ---', 'CYAN');
  const r7 = await httpRequest('GET', '/customer/cvapp-mall/exterior/product/list?pageIndex=1&pageSize=5', makeHeaders('taskCenter'));
  if (r7.json && r7.json.code === 0) {
    const products = (r7.json.data.dataList || []).slice(0, 5);
    results.browse = products.length;
    log('浏览 ' + products.length + ' 个商品', 'GREEN');
  } else {
    log('productList 失败: ' + JSON.stringify(r7.json || {}), 'RED');
  }
  await delay(800);

  log('--- dynamicList ---', 'CYAN');
  const r8 = await httpRequest('GET', '/customer/cvapp-dynamic/exterior/dynamic/list?pageIndex=1&pageSize=5&type=1', makeHeaders('taskCenter'));
  let dynamicIds = [];
  if (r8.json && r8.json.code === 0) {
    const data = r8.json.data || {};
    const items = (data.dataList || []).map(i => i.id);
    dynamicIds = items.filter(i => i).slice(0, 3);
    log('获取 ' + dynamicIds.length + ' 条动态', 'GREEN');
  } else {
    log('dynamicList 失败: ' + JSON.stringify(r8.json || {}), 'RED');
  }

  if (dynamicIds.length > 0) {
    const did = dynamicIds[0];

    log('--- 收藏 ---', 'CYAN');
    try {
      const r9 = await httpRequest('POST', '/customer/cvapp-dynamic/exterior/interact/collection', makeHeadersPost('signIn'), { entityId: did });
      if (r9.json) {
        if (r9.json.code === 0) { results.collect++; log('收藏成功', 'GREEN'); }
        else if (r9.json.code === 100016) { log('收藏 sign 已过期 (100016)', 'YELLOW'); }
        else { log('收藏: code=' + r9.json.code + ' msg=' + r9.json.msg, 'YELLOW'); }
      }
    } catch (e) { log('收藏异常: ' + e.message, 'YELLOW'); }
    await delay(500);

    log('--- 点赞 ---', 'CYAN');
    try {
      const r10 = await httpRequest('POST', '/customer/cvapp-dynamic/exterior/interact/like', makeHeadersPost('signIn'), { entityId: did, type: '8' });
      if (r10.json) {
        if (r10.json.code === 0) { results.like++; log('点赞成功', 'GREEN'); }
        else if (r10.json.code === 100016) { log('点赞 sign 已过期 (100016)', 'YELLOW'); }
        else { log('点赞: code=' + r10.json.code + ' msg=' + r10.json.msg, 'YELLOW'); }
      }
    } catch (e) { log('点赞异常: ' + e.message, 'YELLOW'); }
    await delay(500);

    log('--- 评论 ---', 'CYAN');
    try {
      const r11 = await httpRequest('POST', '/customer/cvapp-dynamic/exterior/comment/add', makeHeadersPost('signIn'), { content: '6', entityId: did, entityType: '8', parentId: '0', type: '0' });
      if (r11.json) {
        if (r11.json.code === 0) { results.comment++; log('评论成功', 'GREEN'); }
        else if (r11.json.code === 100016) { log('评论 sign 已过期 (100016)', 'YELLOW'); }
        else { log('评论: code=' + r11.json.code + ' msg=' + r11.json.msg, 'YELLOW'); }
      }
    } catch (e) { log('评论异常: ' + e.message, 'YELLOW'); }
  }

  const signInStr = results.signIn === 'already' ? '已签到' :
    results.signIn ? '签到第' + results.signIn + '天' :
    results.errors.find(e => e.startsWith('signIn')) ? '签到失败' : '签到未知';

  const body = '账号: ' + phone + '\n' +
    '积分: ' + results.totalIntegral + ' | 成长值: ' + results.totalGrowth + '\n' +
    '签到: ' + signInStr + ' (7月' + results.signInDay + '/31天)' + '\n' +
    '任务: 已完成' + results.tasksDone + '/共' + (results.tasksDone + results.tasksTodo) + '\n' +
    '浏览商品: ' + results.browse + ' | 收藏: ' + results.collect + ' | 点赞: ' + results.like + ' | 评论: ' + results.comment +
    (results.errors.length ? '\n错误: ' + results.errors.join('; ') : '');

  log('\n--- 汇总 ---', 'BOLD');
  log(body, 'GREEN');
  await push('乘龙之家·' + phone, body);
  return results;
}

async function main() {
  log('====== 乘龙之家任务 ======', 'BOLD');
  const phone = process.env.LQDM_PHONE || '19567189385';
  try {
    await runAccount(phone);
  } catch (e) {
    log('执行异常: ' + e.message, 'RED');
  }
  log('====== 任务完成 ======', 'BOLD');
  process.exit(0);
}

main();
