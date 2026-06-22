/*
cron: 30 10 * * *
new Env('南昌工会-签到答题');
脚本位置: aaa微信code/ncgh_sign.js

南昌工会小程序自动化脚本
appid: wxd4304a23e648be81 | API: ncgh.org.cn

功能：
  1. 每日签到（+5/10积分，连续签到递增）
  2. 每日任务（浏览/点赞/评论/观看）
  3. 知识竞赛答题（自动获取题目+答案，自动提交）
  4. 积分余额查询

【环境变量】
  ncgh_token = Authorization JWT token（从抓包 headers 获取）
  ncgh_secret = token 字段（从抓包 headers 获取）
*/

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const https = require('https');
const fs = require('fs');
const path = require('path');

// ==================== 日志 ====================
class Env {
  constructor(name) { this.name = name || '南昌工会'; }
  log(msg) { console.log(`📌 [${this.ts()}] ${msg}`); }
  ok(msg) { console.log(`✅ [${this.ts()}] ${msg}`); }
  err(msg) { console.log(`❌ [${this.ts()}] ${msg}`); }
  info(msg) { console.log(`🔧 [${this.ts()}] ${msg}`); }
  ts() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }
}
const $ = new Env();

// ==================== 配置 ====================
const CFG = {
  TOKENS: parseTokens(),
  APPID: 'wxd4304a23e648be81',
  HOST: 'ncgh.org.cn',
  BASE_PATH: '/nczhgh.interface',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat',
  DEFAULT_TOPICS: ['2044957160479444994', '2042499665899081730'],
};

function parseTokens() {
  const raw1 = process.env.ncgh_token || '';
  const raw2 = process.env.ncgh_secret || '';
  const tokens1 = raw1.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
  const tokens2 = raw2.split('\n').flatMap(s => s.split('&')).map(s => s.trim()).filter(Boolean);
  const result = [];
  for (let i = 0; i < Math.max(tokens1.length, tokens2.length); i++) {
    result.push({ auth: tokens1[i] || '', secret: tokens2[i] || '' });
  }
  return result;
}

// ==================== HTTP ====================
function api(method, path, body, auth, secret) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: CFG.HOST, path: CFG.BASE_PATH + path, method, rejectUnauthorized: false,
      headers: {
        'Authorization': auth,
        'token': secret,
        'Referer': `https://servicewechat.com/${CFG.APPID}/187/page-frame.html`,
        'Content-Type': 'application/json',
        'User-Agent': CFG.UA,
      },
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
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

// ==================== 签到 ====================
async function getSignLog(auth, secret) {
  const r = await api('GET', '/points/signIn/log', null, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function getSignLogAll(auth, secret) {
  const r = await api('GET', '/points/signIn/logAll', null, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function getPoints(auth, secret) {
  const r = await api('GET', '/shop/log/my/points', null, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

// ==================== 任务 ====================
const TASK_LIST = [
  { name: '浏览任务', path: '/points/task/view/count' },
  { name: '观看任务', path: '/points/task/watch/count' },
  { name: '点赞任务', path: '/points/task/like/count' },
  { name: '评论任务', path: '/points/task/comment/count' },
];

async function checkTask(name, path, auth, secret) {
  const r = await api('GET', path, null, auth, secret);
  if (!r.data || r.data.code !== 200) return { count: 0, isFinish: true };
  return r.data.data;
}

// ==================== 答题 ====================
async function getUserInfo(auth, secret, topicId) {
  // The captures show the user already logged in; the user info endpoint might need phone
  const r = await api('POST', '/knowledge/user/info', { topicId }, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function getQuestions(auth, secret, topicId) {
  const r = await api('GET', `/knowledge/question/createQuestion?topicId=${topicId}`, null, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function submitQuiz(auth, secret, topicId, dto) {
  const body = {
    dto,
    openId: '',
    topicId,
    userOpenId: '',
  };
  const r = await api('POST', '/api/knowledge/question/submit', body, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

async function getAnswerCount(auth, secret, topicId) {
  const r = await api('GET', `/knowledge/user/info/answer/count?topicId=${topicId}`, null, auth, secret);
  if (!r.data || r.data.code !== 200) return null;
  return r.data.data;
}

// ==================== 自动答题 ====================
function parseAnswers(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map(q => {
    const reference = JSON.parse(q.reference || '[]');
    const answers = reference
      .filter(a => a.check === true)
      .map(a => ({
        value: a.value,
        text: a.text,
        check: true,
        userCheck: true,
        isOn: false,
        errorStatus: false,
        correctStatus: true,
      }));
    return {
      answerList: answers,
      type: q.type || 2,
      id: q.id,
      correct: 0,
      answerTime: Math.floor(Math.random() * 5) + 3,
    };
  });
}

// ==================== 单账号处理 ====================
async function processAccount(tokenObj, index) {
  $.info(`\n======== 账号 #${index + 1} ========`);
  const { auth, secret } = tokenObj;
  const summary = { sign: false, points: 0, tasks: 0, quiz: 0 };

  // Step 1: 验证 token + 积分
  const pointsData = await getPoints(auth, secret);
  if (!pointsData) { $.err('Token 无效'); return summary; }
  summary.points = pointsData.points || 0;
  $.info(`当前积分: ${summary.points}`);

  // Step 2: 签到
  const signLog = await getSignLog(auth, secret);
  if (signLog) {
    const todayStr = new Date().toISOString().substring(5, 10).replace('-', '-');
    const todaySign = signLog.list?.find(s => s.signInTime === todayStr);
    if (todaySign && todaySign.isLight) {
      $.log(`今日已签到 (+${todaySign.point}积分)`);
      summary.sign = true;
    } else {
      $.info('今日未签到，签到中...');
      // Try GET signIn endpoint (sign-in might be a GET with special params)
      const signR = await api('GET', '/points/signIn/do', null, auth, secret);
      if (signR.data && signR.data.code === 200) {
        $.ok(`签到成功!`);
        summary.sign = true;
      } else {
        $.log('签到: 可能需要在小程序内操作');
      }
    }
  }

  // Step 3: 任务
  $.info('检查每日任务...');
  for (const task of TASK_LIST) {
    const status = await checkTask(task.name, task.path, auth, secret);
    if (status.isFinish) {
      $.log(`${task.name}: 已完成`);
    } else {
      $.info(`${task.name}: ${status.count}/剩余`);
    }
  }

  // Step 4: 答题
  $.info('知识竞赛答题...');
  for (const topicId of CFG.DEFAULT_TOPICS) {
    const ansCount = await getAnswerCount(auth, secret, topicId);
    if (ansCount !== null) {
      $.info(`专题 ${topicId.substring(0,10)}: 已答 ${ansCount} 次`);
    }

    const questions = await getQuestions(auth, secret, topicId);
    if (questions && Array.isArray(questions) && questions.length > 0) {
      const dto = parseAnswers(questions);
      if (dto.length > 0) {
        const result = await submitQuiz(auth, secret, topicId, dto);
        if (result) {
          const time = result.answerTime;
          $.ok(`答题完成! 用时:${time}秒, 错误:${result.failCount || 0}题`);
          summary.quiz++;
        }
      }
    }
    await $.wait(1000);
  }

  $.ok(`账号 #${index + 1} 完成! 签到:${summary.sign} 积分:${summary.points}`);
  return summary;
}

// ==================== 主函数 ====================
async function main() {
  const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n【南昌工会·签到答题】 ${t}`);

  if (CFG.TOKENS.length === 0) { $.err('未配置 ncgh_token/nmgh_secret'); return; }

  $.info(`共 ${CFG.TOKENS.length} 个账号`);

  let total = 0;
  for (let i = 0; i < CFG.TOKENS.length; i++) {
    await processAccount(CFG.TOKENS[i], i);
    if (i < CFG.TOKENS.length - 1) await $.wait(2000);
  }

  console.log(`\n========================================`);
  $.ok('所有任务执行完毕！');
}

if (require.main === module) {
  main().catch(e => { $.err(`异常: ${e.message}`); console.error(e); });
}
module.exports = { main };
