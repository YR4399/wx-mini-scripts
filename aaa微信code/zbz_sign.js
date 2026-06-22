/*
cron: 15 8 * * *
new Env('珍宝珠-签到抽奖');
脚本位置: aaa微信code/zbz_sign.js

珍宝珠酸条"珍能乐不停"小程序自动化脚本
appid: wx0798de09d045cc71 | API: zbz.truekey.mobi

功能：
  1. 任务进度查询
  2. 已完成任务领取抽奖次数
  3. 自动抽奖（奖池1: 现金红包）
  4. 抽奖记录查询

【环境变量】
  zbz_token = Authori-zation token（从抓包 headers 中获取）

【任务说明】
  每日登录 ✅ 打开小程序即完成
  观看视频 ✅ 可脚本完成  
  扫一扫   ❌ 需扫码，不可脚本化
  邀请好友 ❌ 需微信分享，不可脚本化
  全部完成 ❌ 需全部任务完成
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '珍宝珠'; }
  log(msg) { console.log(`📌 [${this.ts()}] ${msg}`); }
  ok(msg) { console.log(`✅ [${this.ts()}] ${msg}`); }
  err(msg) { console.log(`❌ [${this.ts()}] ${msg}`); }
  info(msg) { console.log(`🔧 [${this.ts()}] ${msg}`); }
  warn(msg) { console.log(`⚠️ [${this.ts()}] ${msg}`); }
  ts() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env();

// ==================== 配置 ====================
const CFG = {
  TOKENS: parseTokens(),
  APPID: 'wx0798de09d045cc71',
  HOST: 'zbz.truekey.mobi',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
  VERSION: '3',
};

function parseTokens() {
  const raw = process.env.zbz_token || '';
  return raw.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
}

// ==================== HTTP ====================
function api(method, path, body, token) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: CFG.HOST, path, method, rejectUnauthorized: false,
      headers: {
        'Authori-zation': token,
        'Referer': `https://servicewechat.com/${CFG.APPID}/${CFG.VERSION}/page-frame.html`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': CFG.UA,
      },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ==================== API 封装 ====================

/** 用户中心（含 token 有效性校验） */
async function getUserCenter(token) {
  return api('GET', '/prod/api/front/user/center', null, token);
}

/** 每日任务进度 */
async function getTaskProgress(token) {
  return api('GET', '/prod/api/front/prize/daily-tasks/progress', null, token);
}

/** 领取任务抽奖次数 */
async function claimTaskLottery(token, taskCode) {
  return api('POST', '/prod/api/front/prize/daily-tasks/claim-lottery', { taskCode }, token);
}

/** 抽奖 */
async function doDraw(token, poolType = 1) {
  return api('POST', '/prod/api/front/prize/draw', { poolType }, token);
}

/** 抽奖记录 */
async function getPrizeRecords(token, page = 1) {
  return api('GET', `/prod/api/front/prize/records?limit=20&page=${page}`, null, token);
}

/** 奖品列表 */
async function getPrizeList(token, poolType = 1) {
  return api('GET', `/prod/api/front/prize/list?poolType=${poolType}`, null, token);
}

// ==================== 不可脚本化的任务 ====================
const UNSKIPPABLE_TASKS = [
  'win_prize_daily_scan_count',   // 需要扫码
  'win_prize_daily_share_count',  // 需要微信分享
  'win_prize_daily_all_task_count', // 需要全部完成
];

// ==================== 任务完成 ====================
/** 尝试完成"观看视频"任务 */
async function completeVideoTask(token) {
  $.info('尝试完成"观看视频"任务...');
  // 视频任务通过 claim-lottery 接口触发（如果未完成，claim 也可能触发完成）
  const r = await claimTaskLottery(token, 'win_prize_daily_video_count');
  if (r.data && r.data.code === 200) {
    $.ok(`视频任务抽奖次数领取成功! +${r.data.data?.grantedLottery || 0} 次`);
    return r.data.data;
  }
  if (r.data && r.data.code === 500) {
    $.log('视频任务已完成或已领取');
  }
  return null;
}

// ==================== 单账号处理 ====================
async function processAccount(token, index) {
  $.info(`\n======== 账号 #${index + 1} ========`);
  const summary = { valid: false, tasks: 0, draws: 0, prizes: [], points: 0 };

  // Step 1: 验证 token
  const user = await getUserCenter(token);
  if (!user.data || user.data.code !== 200) {
    $.err(`Token 无效: ${JSON.stringify(user.data)}`);
    return summary;
  }
  summary.valid = true;
  $.info(`用户: ${user.data.data?.phone || '未知'} | 昵称: ${user.data.data?.nickname || '未知'}`);

  // Step 2: 获取任务进度
  const tasksResp = await getTaskProgress(token);
  if (!tasksResp.data || tasksResp.data.code !== 200) {
    $.err(`获取任务失败: ${JSON.stringify(tasksResp.data)}`);
    return summary;
  }

  const tasks = tasksResp.data.data?.tasks || [];
  const completed = tasks.filter(t => t.completed);
  const incomplete = tasks.filter(t => !t.completed);
  $.info(`任务: ${completed.length} 已完成 / ${tasks.length} 总计`);
  incomplete.forEach(t => $.log(`  未完成: ${t.taskLabel} (${t.currentCount}/${t.totalRequired})`));

  // Step 3: 领取已完成任务的抽奖次数（跳过不可脚本化的）
  let totalGranted = 0;
  for (const task of completed) {
    if (UNSKIPPABLE_TASKS.includes(task.taskCode)) continue;
    const cl = await claimTaskLottery(token, task.taskCode);
    if (cl.data && cl.data.code === 200) {
      const granted = cl.data.data?.grantedLottery || 0;
      $.ok(`${task.taskLabel}: +${granted} 次抽奖`);
      totalGranted += granted;
    } else if (cl.data && cl.data.code === 500) {
      $.log(`${task.taskLabel}: 已领取过`);
    } else {
      $.warn(`${task.taskLabel}: ${cl.data?.message || '未知错误'}`);
    }
    await $.wait(500);
  }

  // Step 4: 获取最新抽奖次数
  const user2 = await getUserCenter(token);
  const draws = user2.data?.data?.luckyDrawCount || 0;
  $.info(`当前抽奖次数: ${draws}`);

  // Step 5: 抽奖
  if (draws > 0) {
    $.info(`开始抽奖 (${draws} 次)...`);
    for (let i = 0; i < draws; i++) {
      const dr = await doDraw(token, 1);
      if (dr.data && dr.data.code === 200) {
        const prize = dr.data.data;
        $.ok(`🎉 抽中: ${prize.prizeName}${prize.amount ? ' ' + prize.amount + '元' : ''}`);
        summary.prizes.push(prize);
        summary.draws++;
      } else {
        $.err(`抽奖失败: ${dr.data?.message || 'unknown'}`);
      }
      await $.wait(1000);
    }
  } else {
    $.log('无可用抽奖次数');
  }

  // Step 6: 抽奖记录
  const records = await getPrizeRecords(token);
  if (records.data && records.data.code === 200) {
    const today = new Date().toISOString().substring(0, 10);
    const todayRecords = (records.data.data?.list || []).filter(r => (r.winTime || '').startsWith(today));
    if (todayRecords.length > 0) {
      $.info(`今日中奖记录 (${todayRecords.length} 条):`);
      todayRecords.forEach(r => {
        const status = r.status === 0 ? '待领取' : '已领取';
        $.log(`  ${r.prizeName} | ${r.winTime} | ${status}`);
      });
    }
  }

  summary.tasks = totalGranted;
  summary.points = user2.data?.data?.signNum || 0;
  $.ok(`账号 #${index + 1} 完成! 抽奖:${summary.draws} 次`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【珍宝珠·签到抽奖】 ${t}`);

  if (CFG.TOKENS.length === 0) { $.err('未配置 zbz_token'); return; }

  $.info(`共 ${CFG.TOKENS.length} 个账号`);

  let totalDraws = 0, totalPrizes = 0;
  for (let i = 0; i < CFG.TOKENS.length; i++) {
    const r = await processAccount(CFG.TOKENS[i], i);
    if (r.valid) {
      totalDraws += r.draws;
      totalPrizes += r.prizes.length;
    }
    if (i < CFG.TOKENS.length - 1) await $.wait(2000);
  }

  console.log(`\n========================================`);
  console.log(`📊 汇总: 账号 ${CFG.TOKENS.length} | 抽奖 ${totalDraws} 次 | 中奖 ${totalPrizes} 个`);
  $.ok('所有任务执行完毕！');
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
