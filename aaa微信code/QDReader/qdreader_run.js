// QDReader 任务包装脚本 v7：
// 主脚本（同进程 require + hook）+ 扩展任务（延迟启动）
// 由于主脚本缓存了 console.log 引用无法 hook 输出，改用固定延时方案：
// 主脚本 require 后，等 100 秒（主脚本任务约 60-90 秒）再启动扩展任务
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

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

  // ===== 守护调度器：主进程退出后仍能运行扩展任务 =====
  // 用 unref 的 child_process，独立事件循环，主进程退出不影响它
  const schedulerCode = `
    const { spawn } = require('child_process');
    const path = require('path');
    const EXTRA_SCRIPT = ${JSON.stringify(EXTRA_SCRIPT)};
    setTimeout(() => {
      console.log('\\n========== 开始扩展任务（MoreRewardTab + 广告加码）==========');
      const extra = spawn('node', [EXTRA_SCRIPT], { stdio: 'inherit', env: process.env });
      extra.on('exit', (code) => process.exit(code || 0));
    }, 95000);
  `;
  const scheduler = spawn('node', ['-e', schedulerCode], {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  scheduler.unref();
  console.log('[调度] 守护调度器已启动，主脚本结束后将运行扩展任务');

  try {
    require(MAIN_SCRIPT);
  } catch (e) {
    console.error('脚本执行异常:', e.message);
  }
}

main();
