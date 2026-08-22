// QDReader 任务包装脚本 v4：hook fetch 重定向签名 URL + 本地签名服务 + 同进程运行
// 关键：hook 必须在加载 qdreader.js 之前设置，且必须在同一进程内 require
// 用法: node qdreader_run.js
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');

const BASE_DIR = __dirname;
const SIGN_SERVER = path.join(BASE_DIR, 'qdreader_sign_server.js');
const MAIN_SCRIPT = path.join(BASE_DIR, 'qdreader.js');
const PORT = 12039;
const REMOTE_SIGN_HOST = 'https://api.120399.xyz';
const LOCAL_SIGN_HOST = `http://127.0.0.1:${PORT}`;

function portAlive() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT, timeout: 1500 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  try {
    execSync(`pkill -f "qdreader_sign_server.js ${PORT}" || true`, { stdio: 'ignore' });
  } catch (e) {}
  await new Promise(r => setTimeout(r, 500));
  if (await portAlive()) {
    console.log('本地签名服务已在运行');
    return;
  }
  console.log('启动本地签名服务...');
  const server = spawn('node', [SIGN_SERVER, String(PORT)], {
    stdio: 'ignore',
    detached: true,
  });
  server.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await portAlive()) {
      console.log('本地签名服务就绪');
      return;
    }
  }
  console.error('本地签名服务启动失败');
  process.exit(1);
}

async function main() {
  await ensureServer();

  // ===== hook fetch：重定向远程签名 URL 到本地 =====
  // 必须在 require qdreader.js 之前设置（同一进程）
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url) || '';
    if (urlStr.includes('api.120399.xyz')) {
      const newUrl = urlStr.replace(REMOTE_SIGN_HOST, LOCAL_SIGN_HOST);
      console.log('[签名] 重定向到本地:', newUrl.substring(0, 70) + '...');
      input = newUrl;
    }
    return origFetch(input, init);
  };

  console.log('开始运行 QDReader 签到...');
  try {
    require(MAIN_SCRIPT);
  } catch (e) {
    console.error('脚本执行异常:', e.message);
    process.exit(1);
  }
}

main();
