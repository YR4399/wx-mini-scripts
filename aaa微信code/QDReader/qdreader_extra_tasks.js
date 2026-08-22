// QDReader 扩展任务模块：MoreRewardTab（更多奖励）+ 广告加码任务
// 在主脚本 qdreader.js 跑完后由 run.js 调用
// 覆盖：
//   - MoreRewardTab: 阅读5分钟(230)、每日好书分享(240)、惊喜礼包(0)、玩游戏10分钟(104)、添加小组件(250)
//   - VideoRewardTab: 完成3个广告任务(Type 3)、完成1个广告任务
//   - 广告·加点(Type 300, 需真实阅读前置，尝试跳过)
const crypto = require('crypto');

// ===== 从环境变量读取 Cookie =====
function getCookieMap() {
  try {
    return JSON.parse(process.env.QDREADER_COOKIE || '{}');
  } catch (e) {
    return {};
  }
}

// ===== SDKSign 配置（与签名服务一致）=====
const CONFIG = {
  uid: "417394727",
  guid: "120360531697",
  qimei: "0e4e98033cf409b9a47146d4100010419c08",
  qimei36: "0e4e98033cf409b9a47146d4100010419c08",
  appver: "7.9.472",
  ibex: "m_u1ZHcuK7c5zm1R28Vf8ueiAemFDjayzUF4yKlbWrR6AZGXpD53ALSsFbu-tE_jJRO7kNK_tuKG1g_4LYONnR4JQlgcBUInZQlcAct7tnKz1ZBAFa4WK_y-rxKBRaJZDtQyVUolW7BWFAoKlv14I2tOcNmWG5jjH1vEY1XLIawkf7cnmXgG4-FdDp6uwqBOFIY3BnG_gfOVqb66wob06i_Ti8uRGE_2c7M85tc3n_01-5vqQ_IuGZMYvtuRhej3dQU3c0zHLGWoNsv9zV0USv1y5bGnQFq6X59hr3ioJEVBl_pZ6MRD0Zeq5fIdS7-FeOPXIrp2EdhV42Jr8y9HMkuhuOjD4bSEZBC34jrb03Fct6zSrjbFy1yzltxPzTonnr4Sbd3wBp6Bc71OyzGTxisZs3MCehhiJiSF77G10xJKqEnz0bncrE7safP37Ov0SciS0xEzRKBBzdRPGpIXNptBZug690rSvc-auQli_GcUl46GLfdcwikTQZKXhWvcxlCTa1xjWiC3C1EVsILrJBSQ2dMUaAWFMG2jRUhAl85YdClu0xJc3CWUNHZakA1cllzTcJr5pKNhMmRmN2FkZmUzNjdmNjQ1NThjMWU1YmE2M2VjZTBkMg==",
  SDKSignPass: "8YV#U2Butm,VutR2B_W[*}6t",
  SDKSignIV: "01234567",
  hashSignatures: "f189adc92b816b3e9da29ea304d4a7e4",
};

function encrypt3DES(plaintext, keyStr, ivStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const iv = Buffer.from(ivStr, 'utf8');
  const blockSize = 8;
  const padding = blockSize - (plaintext.length % blockSize);
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.alloc(padding, padding)]);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function normParams(urlStr) {
  const idx = urlStr.indexOf('?');
  if (idx === -1) return '';
  const parts = urlStr.substring(idx + 1).split('&');
  const queries = [];
  for (const part of parts) {
    const pos = part.indexOf('=');
    if (pos === -1) {
      queries.push(part.toLowerCase() + '=');
    } else {
      queries.push(part.substring(0, pos).toLowerCase() + '=' + encodeURIComponent(part.substring(pos + 1)));
    }
  }
  queries.sort();
  return queries.join('&');
}

function genSDKSign(url, timestamp) {
  const urlHash = crypto.createHash('md5').update(normParams(url)).digest('hex');
  const sign = ["qYJ]Q9FYhq?", String(timestamp), CONFIG.uid, CONFIG.qimei, "1", CONFIG.appver, "0", urlHash, CONFIG.hashSignatures].join('|');
  const encrypted = encrypt3DES(sign, CONFIG.SDKSignPass, CONFIG.SDKSignIV);
  const chunks = [];
  for (let i = 0; i < encrypted.length; i += 60) chunks.push(encrypted.substring(i, i + 60));
  return chunks.join(' ');
}

// ===== 请求封装 =====
const cookieMap = getCookieMap();
const cookie = Object.values(cookieMap)[0] || '';

async function apiRequest(url, method = 'get', body = null) {
  const ts = Date.now();
  const sdkSign = genSDKSign(url, ts);
  const headers = {
    'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/QDReaderiOS/5.9.456/728/QDReaderAppstore',
    'Connection': 'keep-alive',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://h5.if.qidian.com/new/welfareCenter/?_viewmode=0',
    'SDKSign': sdkSign,
    'borgus': crypto.randomBytes(16).toString('hex'),
    'tstamp': String(ts),
    'helios': '1',
    'ibex': CONFIG.ibex,
    'Cookie': cookie,
  };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const init = { method: method.toUpperCase(), headers };
  if (body) init.body = body;
  if (method === 'post' && !body) init.body = '';
  
  try {
    const resp = await fetch(url, init);
    const text = await resp.text();
    try { return JSON.parse(text); } catch (e) { return { raw: text, status: resp.status }; }
  } catch (e) {
    return { error: e.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 游戏心跳 =====
async function gameHeartBeat(count) {
  const gameIds = ["201743","201744","201745","201746","201747"];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/QDReaderiOS/5.9.456/728/QDReaderAppstore',
    'Cookie': cookie,
    'Referer': 'https://h5.if.qidian.com/',
  };
  let successCount = 0, filteredCount = 0;
  // 动态间隔：首次15秒，连续过滤超过3次则退到45秒
  for (let i = 0; i < count * 3 && successCount < count; i++) {
    try {
      const gid = gameIds[i % gameIds.length];
      const url = 'https://lygame.qidian.com/home/log/heartbeat?gameId=' + gid + '&platformId=1&t=' + Date.now();
      const resp = await fetch(url, { headers });
      const text = await resp.text();
      let hd;
      try { hd = JSON.parse(text); } catch (e) { hd = { raw: text }; }
      if (hd.code === 0) {
        successCount++;
        filteredCount = 0;
        console.log("[游戏] 心跳 " + (i + 1) + " 成功: data=" + hd.data + " (进度" + successCount + "/" + count + ")");
        await sleep(15000);
      } else {
        filteredCount++;
        const delay = filteredCount > 3 ? 45000 : 15000;
        console.log("[游戏] 心跳 " + (i + 1) + " 被过滤(" + filteredCount + "): " + (hd.msg || text.substring(0, 30)) + " 等待" + delay / 1000 + "秒");
        await sleep(delay);
      }
    } catch (e) {
      console.log("[游戏] 心跳失败: " + e.message);
      await sleep(15000);
    }
  }
  console.log("[游戏] 心跳完成: 成功" + successCount + "次, 共" + count + "次");
}

// ===== 完成单个任务 =====
async function finishTask(taskId, title) {
  const params = `taskId=${taskId}&BanId=0&BanMessage=&CaptchaAId=&CaptchaType=0&CaptchaURL=&Challenge=&Gt=&NewCaptcha=0&Offline=0&PhoneNumber=&SessionKey=`;
  const url = `https://h5.if.qidian.com/argus/api/v1/video/adv/finishWatch?${params}`;
  const r = await apiRequest(url, 'post', '');
  const ok = r.Result === 0 || r.Message === '' || (r.Data && r.Data.RewardList);
  console.log(`[任务] ${title}: ${ok ? '✅' : '❌'} ${JSON.stringify(r).substring(0, 120)}`);
  return ok;
}

// ===== 领取任务奖励 =====
async function receiveReward(taskId, title) {
  const url = `https://h5.if.qidian.com/argus/api/v1/video/adv/receiveTaskReward?taskId=${taskId}`;
  const r = await apiRequest(url, 'post', '');
  const ok = r.Result === 0 || r.Message === '';
  console.log(`[领取] ${title}: ${ok ? '✅' : '❌'} ${JSON.stringify(r).substring(0, 120)}`);
  return ok;
}

// ===== 主流程 =====
async function run() {
  console.log('\n===== QDReader 扩展任务（MoreRewardTab + 广告加码）=====');
  if (!cookie) {
    console.log('❌ 未配置 Cookie，跳过扩展任务');
    return;
  }

  // 1. 获取 mainPage 任务列表
  const mainPageUrl = 'https://h5.if.qidian.com/argus/api/v2/video/adv/mainPage';
  const mp = await apiRequest(mainPageUrl);
  if (!mp.Data) {
    console.log('❌ mainPage 获取失败:', JSON.stringify(mp).substring(0, 100));
    return;
  }
  const data = mp.Data;
  console.log('✅ mainPage 获取成功');

  // 2. MoreRewardTab 更多奖励
  const moreTasks = data.MoreRewardTab?.TaskList || [];
  console.log(`\n[更多奖励] 共 ${moreTasks.length} 个任务`);
  const MORE_PROCESSABLE = [0, 230, 231, 240, 250, 104];
  for (const t of moreTasks) {
    if (t.IsFinished || t.IsReceived) {
      console.log(`[更多奖励] ${t.Title || t.TaskId} 已完成，跳过`);
      continue;
    }
    if (t.TaskType === 103) { // 充值，不支持
      console.log(`[更多奖励] ${t.Title || t.TaskId} 充值任务，跳过`);
      continue;
    }
    if (t.TaskType === 104) { // 玩游戏
      console.log(`[更多奖励] ${t.Title || t.TaskId}: 模拟游戏心跳...`);
      const need = (t.Total - t.Process) || 1;
      await gameHeartBeat(need);
      await sleep(2000);
      await receiveReward(t.TaskId, t.Title || t.TaskId);
      continue;
    }
    if (!MORE_PROCESSABLE.includes(t.TaskType)) {
      console.log(`[更多奖励] ${t.Title || t.TaskId} 类型${t.TaskType}，跳过`);
      continue;
    }
    await finishTask(t.TaskId, t.Title || `更多任务${t.TaskType}`);
    await sleep(2000);
    if (t.HasSecondReward) {
      await receiveReward(t.TaskId, t.Title || t.TaskId);
      await sleep(1000);
    }
  }

  // 3. VideoRewardTab 广告加码
  const videoTasks = data.VideoRewardTab?.TaskList || [];
  console.log(`\n[广告加码] 共 ${videoTasks.length} 个任务`);
  for (const t of videoTasks) {
    if (t.IsFinished || t.IsReceived) {
      console.log(`[广告加码] ${t.Title || t.TaskId} 已完成，跳过`);
      continue;
    }
    if (t.TaskType === 3) { // 完成N个广告任务
      const times = t.Total - t.Process;
      console.log(`[广告加码] ${t.Title || t.TaskId}: 执行 ${times} 次`);
      let allOk = true;
      for (let i = 0; i < times && i < 5; i++) {
        const ok = await finishTask(t.TaskId, `${t.Title || '广告任务'} (${i + 1}/${times})`);
        if (!ok) { allOk = false; break; }
        await sleep(2000);
      }
      if (allOk) await receiveReward(t.TaskId, t.Title || t.TaskId);
      continue;
    }
    await finishTask(t.TaskId, t.Title || `广告任务${t.TaskType}`);
    await sleep(2000);
  }

  // 4. ReadingPageTaskModule 广告·加点（Type 300，需阅读前置，尝试但不强求）
  const readingTasks = data.ReadingPageTaskModule?.TaskList || [];
  const advPlus = readingTasks.filter(t => t.TaskType === 300 && !t.IsFinished);
  if (advPlus.length > 0) {
    console.log(`\n[广告·加点] ${advPlus.length} 个任务（需阅读前置，尝试）`);
    for (const t of advPlus) {
      await finishTask(t.SubTaskId || t.TaskId, t.Title || '广告加点');
      await sleep(2000);
    }
  }

  console.log('\n===== 扩展任务执行完毕 =====');
}

run().catch(e => console.error('扩展任务异常:', e.message));
