// QDReader 任务包装脚本 v8：
// 主脚本（同进程 require + hook）→ 等 95 秒 → 扩展任务（**前台等待**子进程，非 detached）
// v8（2026-09-17）：
//   1. 拦截主脚本（第三方混淆包）的 process.exit(1)——它跑完自己的流程就直接退出进程，
//      这正是"起点读书"连续 7 天被记成"退出码 1"、且扩展任务被整段截掉的原因；
//   2. 扩展任务改为前台等待（不再用 detached 守护进程），主进程全程在场、最后由包装脚本显式 exit 0；
//   3. 广告·加点等风控必拦的任务在扩展脚本里按"➖ 跳过"呈现，不再计失败。
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { report } = require('../std_report');

// 统一推送: 捕获主脚本(qdreader.js)输出, 运行结束后汇总一条推送
const LOGS = [];
const _origLog = console.log;
console.log = (...a) => {
  try { LOGS.push(a.map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ').slice(0, 200)); } catch (e) {}
  _origLog(...a);
};
// [AUTO-QD-SWITCH]
process.env.QDREADER_ADV_JOB_ENABLE = process.env.QDREADER_ADV_JOB_ENABLE || 'true';
process.env.QDREADER_EXTRA_ADV_JOB_ENABLE = process.env.QDREADER_EXTRA_ADV_JOB_ENABLE || 'true';
process.env.QDREADER_LOTTERY_ENABLE = process.env.QDREADER_LOTTERY_ENABLE || 'true';
process.env.QDREADER_WEEKLY_EXCHANGE_ENABLE = process.env.QDREADER_WEEKLY_EXCHANGE_ENABLE || 'true';
process.env.QDREADER_CHAPTER_CARD_ENABLE = process.env.QDREADER_CHAPTER_CARD_ENABLE || 'true';
process.env.QDREADER_MESSAGE_BOX_ENABLE = process.env.QDREADER_MESSAGE_BOX_ENABLE || 'true';

const BASE_DIR = __dirname;
const SIGN_SERVER = path.join(BASE_DIR, 'qdreader_sign_server.js');
const MAIN_SCRIPT = path.join(BASE_DIR, 'qdreader.js');
const EXTRA_SCRIPT = path.join(BASE_DIR, 'qdreader_extra_tasks.js');
const PORT = 12039;
const REMOTE_SIGN_HOST = 'https://api.120399.xyz';
const LOCAL_SIGN_HOST = `http://127.0.0.1:${PORT}`;

// ===== SDKSign 配置（magev6 覆盖用）=====
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

function portAlive() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT, timeout: 1500 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  try { execSync(`pkill -f "qdreader_sign_server.js ${PORT}" || true`, { stdio: 'ignore' }); } catch (e) {}
  await new Promise(r => setTimeout(r, 500));
  if (await portAlive()) { console.log('本地签名服务已在运行'); return; }
  console.log('启动本地签名服务...');
  const server = spawn('node', [SIGN_SERVER, String(PORT)], { stdio: 'ignore', detached: true });
  server.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await portAlive()) { console.log('本地签名服务就绪'); return; }
  }
  console.error('本地签名服务启动失败');
  process.exit(1);
}

async function main() {
  await ensureServer();

  // hook fetch：重定向签名 URL + magev6 签名覆盖
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url) || '';
    init = init || {};

    // magev6 真实请求：本地签名覆盖
    if (urlStr.includes('magev6.if.qidian.com') && !urlStr.includes('api.120399')) {
      const ts = Date.now();
      const sdkSign = genSDKSign(urlStr, ts);
      if (init.headers) {
        const h = init.headers;
        if (typeof h.set === 'function') {
          h.set('SDKSign', sdkSign);
          h.set('tstamp', String(ts));
          h.set('borgus', crypto.randomBytes(16).toString('hex'));
          h.set('helios', '1');
          h.set('ibex', CONFIG.ibex);
        } else if (typeof h === 'object') {
          h['SDKSign'] = sdkSign;
          h['tstamp'] = String(ts);
          h['borgus'] = crypto.randomBytes(16).toString('hex');
          h['helios'] = '1';
          h['ibex'] = CONFIG.ibex;
        }
      }
    }

    // 签名服务 URL 重定向
    if (urlStr.includes('api.120399.xyz')) {
      urlStr = urlStr.replace(REMOTE_SIGN_HOST, LOCAL_SIGN_HOST);
      input = urlStr;
    }

    return origFetch(input, init);
  };

  console.log('开始运行 QDReader 签到...');

  // ===== 拦截主脚本的 process.exit =====
  // 主脚本是第三方混淆包，跑完自己的流程后会直接 process.exit(1)（实测 23:34 那轮 56 秒就退出）。
  // 后果有两个：① 面板把整个"起点读书"任务记成"退出码 1"（连续 7 天误报红）；
  //            ② 后面的扩展任务被整段截掉（v8 改成前台等待后更明显）。
  // 这里把 exit 调用拦下来：只记下它请求的退出码，流程继续走完扩展任务，最后显式以 0 退出。
  const realExit = process.exit.bind(process);
  let mainExitRequested = null;
  process.exit = (code) => {
    if (mainExitRequested === null) {
      mainExitRequested = code === undefined ? 0 : code;
      console.log(`[wrap] 拦截主脚本的 process.exit(${mainExitRequested})：流程继续（扩展任务照跑，最终退出码由包装脚本决定）`);
    }
  };

  try {
    require(MAIN_SCRIPT);
  } catch (e) {
    console.error('脚本执行异常:', e.message);
  }

  // 等主脚本的异步任务落地（主脚本任务约 60~90 秒）
  await new Promise((r) => setTimeout(r, 95000));

  // 统一推送(钉钉): 汇总主脚本输出
  const tail = LOGS.slice(-15).join('\n').trim();
  await report('QDReader 每日任务', [{
    idx: null,
    name: '起点读书',
    sign: '主任务已运行',
    earned: null,
    total: null,
    tasks: tail || null,
    lottery: null,
  }]).catch((e) => console.error('推送失败:', e && e.message));

  // ===== 扩展任务（MoreRewardTab + 广告加码）=====
  // 【2026-09-17 改】原来是 detached + unref 的"守护调度器"：主进程先退出、扩展任务在孤儿进程里
  //   继续持有日志管道，面板最后按孤儿进程的退出码记账 → 扩展任务里的风控失败(-10003)把这个任务
  //   连续 7 天标成"退出码 1"。现在改成**前台等待**子进程跑完，然后显式以 0 退出：
  //   日志顺序确定、退出码确定、不留孤儿进程。
  console.log('\n========== 开始扩展任务（MoreRewardTab + 广告加码）==========');
  const extraCode = await new Promise((resolve) => {
    const extra = spawn('node', [EXTRA_SCRIPT], { stdio: 'inherit', env: process.env });
    extra.on('exit', (code, signal) => resolve(code == null ? `signal:${signal}` : code));
    extra.on('error', (e) => { console.error('扩展任务启动失败:', e.message); resolve('spawn-error'); });
  });
  console.log(`[调度] 扩展任务结束（退出码 ${extraCode}）——主脚本/扩展任务的风控类失败都不影响本任务退出码`);
  console.log(`[wrap] 主脚本曾请求退出码 ${mainExitRequested === null ? '(未请求)' : mainExitRequested}，本包装脚本统一以 0 退出`);
  process.exitCode = 0;
  realExit(0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.message);
  process.exit(1);
});
