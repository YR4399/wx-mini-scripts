// 本地签名服务 - 替代 api.120399.xyz/qdreader/sign
// 用法: node qdreader_sign_server.js [port]
// 破解的 SDKSign 算法（qdapi 3DES-CBC）
const http = require('http');
const crypto = require('crypto');

// ===== 从 HAR 提取的固定参数 =====
// 这些值来自用户抓包 oth.eve.mdt.qq.com_2026_08_22_12_23_45.har
const CONFIG = {
  uid: "417394727",
  guid: "120360531697",
  qimei: "0e4e98033cf409b9a47146d4100010419c08",
  qimei36: "0e4e98033cf409b9a47146d4100010419c08",
  appver: "7.9.472",
  // ibex 固定复用抓包值（测试验证可复用）
  ibex: "m_u1ZHcuK7c5zm1R28Vf8ueiAemFDjayzUF4yKlbWrR6AZGXpD53ALSsFbu-tE_jJRO7kNK_tuKG1g_4LYONnR4JQlgcBUInZQlcAct7tnKz1ZBAFa4WK_y-rxKBRaJZDtQyVUolW7BWFAoKlv14I2tOcNmWG5jjH1vEY1XLIawkf7cnmXgG4-FdDp6uwqBOFIY3BnG_gfOVqb66wob06i_Ti8uRGE_2c7M85tc3n_01-5vqQ_IuGZMYvtuRhej3dQU3c0zHLGWoNsv9zV0USv1y5bGnQFq6X59hr3ioJEVBl_pZ6MRD0Zeq5fIdS7-FeOPXIrp2EdhV42Jr8y9HMkuhuOjD4bSEZBC34jrb03Fct6zSrjbFy1yzltxPzTonnr4Sbd3wBp6Bc71OyzGTxisZs3MCehhiJiSF77G10xJKqEnz0bncrE7safP37Ov0SciS0xEzRKBBzdRPGpIXNptBZug690rSvc-auQli_GcUl46GLfdcwikTQZKXhWvcxlCTa1xjWiC3C1EVsILrJBSQ2dMUaAWFMG2jRUhAl85YdClu0xJc3CWUNHZakA1cllzTcJr5pKNhMmRmN2FkZmUzNjdmNjQ1NThjMWU1YmE2M2VjZTBkMg==",
  // SDKSign 密钥
  SDKSignPass: "8YV#U2Butm,VutR2B_W[*}6t",
  SDKSignIV: "01234567",
  // 固定 hash(Signatures)
  hashSignatures: "f189adc92b816b3e9da29ea304d4a7e4",
};

// ===== 3DES-CBC 加密 =====
function encrypt3DES(plaintext, keyStr, ivStr) {
  // 兼容 Node 的 DES-EDE3-CBC
  const key = Buffer.from(keyStr, 'utf8');
  const iv = Buffer.from(ivStr, 'utf8');
  // PKCS7 padding
  const blockSize = 8;
  const padding = blockSize - (plaintext.length % blockSize);
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.alloc(padding, padding)]);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString('base64');
}

// ===== normParams（URL 参数规范化 + md5）=====
function normParams(urlStr) {
  const idx = urlStr.indexOf('?');
  if (idx === -1) return '';
  const queryParts = urlStr.substring(idx + 1);
  if (!queryParts) return '';
  const parts = queryParts.split('&');
  const queries = [];
  for (const part of parts) {
    const pos = part.indexOf('=');
    if (pos === -1) {
      queries.push(part.toLowerCase() + '=');
    } else {
      const key = part.substring(0, pos).toLowerCase();
      const value = encodeURIComponent(part.substring(pos + 1));
      queries.push(key + '=' + value);
    }
  }
  queries.sort();
  return queries.join('&');
}

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

// ===== 生成 SDKSign =====
function genSDKSign(url, timestamp) {
  const urlHash = md5(normParams(url));
  const sign = [
    "qYJ]Q9FYhq?",           // 标志符号
    String(timestamp),        // 时间戳
    CONFIG.uid,               // 用户token
    CONFIG.qimei,             // QIMEI
    "1",
    CONFIG.appver,            // App版本号
    "0",
    urlHash,                  // Hash(URL)
    CONFIG.hashSignatures,    // hash(Signatures)
  ].join('|');
  
  const encrypted = encrypt3DES(sign, CONFIG.SDKSignPass, CONFIG.SDKSignIV);
  // 每 60 字符分段
  const chunks = [];
  for (let i = 0; i < encrypted.length; i += 60) {
    chunks.push(encrypted.substring(i, i + 60));
  }
  return chunks.join(' ');
}

// ===== 随机 borgus =====
function randomBorgus() {
  return crypto.randomBytes(16).toString('hex');
}

// ===== HTTP 服务 =====
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/qdreader/sign')) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({code: 404, message: 'not found'}));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      let url = params.url || '';
      const method = params.method || 'get';
      const data = params.data || {};
      const timestamp = Date.now();

      // ===== magev6 域名特殊处理 =====
      // 脚本调用签名服务时 magev6 URL 丢失 query 参数（bug），
      // 导致 url_hash 为空 md5，服务端返回"签名错误"
      // 这里补上真实请求使用的默认 query 参数
      if (url.includes('magev6.if.qidian.com') && !url.includes('?')) {
        if (url.includes('/api/v2/message/pullmessage')) {
          url += '?appappend=1NUsIq&categoryIds=0&pg=1&pz=10';
        }
        console.log(`[${new Date().toISOString()}] magev6 URL 已补全 query: ${url.substring(0, 90)}`);
      }

      const sdkSign = genSDKSign(url, timestamp);
      const borgus = randomBorgus();

      const result = {
        code: 200,
        data: {
          SDKSign: sdkSign,
          borgus: borgus,
          tstamp: String(timestamp),
          helios: "1",
          ibex: CONFIG.ibex,
        },
        message: "success",
      };
      console.log(`[${new Date().toISOString()}] sign OK: ${url.split('?')[0].slice(-40)} SDKSign=${sdkSign.substring(0, 20)}...`);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('Error:', e.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({code: 500, message: e.message}));
    }
  });
});

const port = parseInt(process.argv[2] || '12039', 10);
server.listen(port, '127.0.0.1', () => {
  console.log(`QDReader 本地签名服务已启动: http://127.0.0.1:${port}/qdreader/sign`);
  console.log(`SDKSign 算法已本地破解，无需远程签名服务`);
});
