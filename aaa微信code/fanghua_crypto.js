/**
 * fanghua_crypto.js — 芳华未来 App「apiSecurity」插件签名/解密的纯 Node 复刻（无 frida 依赖）
 *
 * 逆向自运行期 hook com.plugin.apisecurity.CryptoUtils / ApiSecurityModule（2026-07-29）。
 *
 * 请求签名：
 *   AES-128-CBC(key = iv = 随机 16 位 aesKey, PKCS7) 加密 JSON body  → aesData
 *   RSA-2048/PKCS1(服务器公钥) 加密 "timestamp=<ts>&aesKey=<key>"      → X-Api-Sign
 *   请求头：X-Api-Timestamp / X-Api-Nonce / X-Api-DeviceId / X-Api-Sign，Content-Type: text/plain
 *
 * 响应解密：
 *   RSA-2048/PKCS1(App 私钥) 解 encryptedKey → responseAesKey
 *   AES-128-CBC(key = iv = responseAesKey) 解 encryptedData
 *
 * ★ 本文件是**精简独立版**：不依赖 _universal_push / std_report / 任何推送模块，
 *   可单独拷进任意目录使用。
 */

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function pem(tag, b64) {
  return `-----BEGIN ${tag}-----\n${b64}\n-----END ${tag}-----\n`;
}

const PUB_B64  = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwVjN8e7S9Ygg2jzc+laQEYD1YxSRppwUl1fEjfpV8CF/KvQ5IgTcyUYDe3O7/41+i7HjX2ZuwDXPOhhoVy6oD2e/NS/+XmUYLt9aEzo+erbq2+uxjwK93t0akM5C9xZDa4Ji0M5ICfZMx8pt56fTIIi5m8C3s7fhh8RSVUp78XK054ZweW25Xe3tQICF6UuuqMAESfTGfhP591hEikbJTxUhXfRywjarlwziZyP9waZYu8D0QA7Z84xaDPU1h3kgxb6Gt5DUAdCOg0dMxuiC24glnUET9yzHa3bIglZMMxpBiGI+B9jDYjKa03IF1NfsQn8eN1n+JlHyeMXtITrgqQIDAQAB";
const PRIV_B64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBWM3x7tL1iCDaPNz6VpARgPVjFJGmnBSXV8SN+lXwIX8q9DkiBNzJRgN7c7v/jX6LseNfZm7ANc86GGhXLqgPZ781L/5eZRgu31oTOj56turb67GPAr3e3RqQzkL3FkNrgmLQzkgJ9kzHym3np9MgiLmbwLezt+GHxFJVSnvxcrTnhnB5bbld7e1AgIXpS66owARJ9MZ+E/n3WESKRslPFSFd9HLCNquXDOJnI/3Bpli7wPRADtnzjFoM9TWHeSDFvoa3kNQB0I6DR0zG6ILbiCWdQRP3LMdrdsiCVkwzGkGIYj4H2MNiMprTcgXU1+xCfx43Wf4mUfJ4xe0hOuCpAgMBAAECggEAdMfOnHJDuUmfjjF0xz/BhND/ZfjmgFuFlGPOtHKftYqF5MveNk35jRhcwhQFWTV9WaL4UobsHexiXhSf8QidObDQLK/wU9N759O/9B0Z38Tb1jll5ZsiU5n4kb4DdHpd/nGifbwahundNk9uUp1rSBtNAGZGjqZh8j8B+8IhWpOA1090lPiqcbnCMueSVF3VghNPAYBYE/VpS1zQnkx54FiS/ojvhZNmW9rSnXtci3fiQkLOg2GHI5ZTIxbFzOVb1F+TTGxtHcwOddOXz6DuaQmysXEmavcw7PrmeibWhc/JggBiBBcYLEUbnDdYIwnPmP+ymaQfxYUv+wQ/fjvgAQKBgQDqBGY8/pMTngWRnipAS0ciI2to17oor1ovutAjMEEHXmHFeKVCh3NFkd0xscUF4wqqkZm8VdRz9QEANlfRgy/CRSPTHGxZcBwjwdgr0f946XL5E2RGfNChWjECTSCxxHKktfuIrjDR1bkDIWwYgpGUncnAL8crn+Iosqlo4YeTSQKBgQDTgl+olhYL6rg3VeiNqbWi30w3+Xn8QOBNBnpKXBxdsUD/CBqIFyYJnvG3y2yqbNv0JwQijxC7o7VsF72eJYij3zYSufrsU6nIfilMMFpBIy5zJARiGEev3ugbIQyE09BIeizxVmOsZ6exJFhej4UipTr7xTOqulmBVtjg8omCYQKBgEcDBL83hQvr5Ma2Vx3heflrBBnxdIUKCPT43FYBO4pv4n1YydUxYxJWW+fLiPzrU35E5oDXDrwNObuFwgpKo8Bw2JkkQ+Cz+2YCWYWamMppFMFuV/xnvatowfxvyR8IfL1sl6J3MUtLbnP7vWCGpoSRiPovxWGAh9FPvcacwVY5AoGAOjvfEo+gKk/JwJKKoNZlCB7q4U5y450JJKvv56FMvg8bkhwtEeMtueBlNPFxTcsDFEnZvZoeRUthnA09S9mRsWy3ephyGbc/O9BglnWJo/2HwHPeMRP2SNnalf2XcMrQwePBlADxGHrBlOgo3IAva8aKYt98xjjgg9fhhq3AZoECgYEA14vIL+vdzsvgIMT1mNRqpDOTNEh9STOFPI2qD+UR0GMcPyoqsMb6ySkgPw+Evrx3W+SZASAFDxTFcIWQ2Ok3ZKzq9nZMNbSerd+lQ7KUmunBORVGatuE1etOWIeXl63G05Rz31ElZBxi03g9/FdPp5ImE+NFdpN3pOvjTddv7KM=";

const RSA_PUB_KEY = pem('PUBLIC KEY', PUB_B64);
const RSA_APP_PRIV_KEY = pem('PRIVATE KEY', PRIV_B64);

function genAesKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function encryptAES(plaintext, aesKey) {
  const key = Buffer.from(aesKey, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

function encryptRSA(plaintext, pubKey) {
  return crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, 'utf8')
  ).toString('base64');
}

function buildSign(dataObj, opts = {}) {
  const ts = (opts.ts || Date.now()).toString();
  const aesKey = opts.aesKey || genAesKey();
  const aesData = encryptAES(JSON.stringify(dataObj), aesKey);
  const rsaPlain = `timestamp=${ts}&aesKey=${aesKey}`;
  const rsaSign = encryptRSA(rsaPlain, RSA_PUB_KEY);
  return { ts, aesKey, aesData, rsaSign };
}

// Node 20+ 默认禁用 RSA PKCS1 私钥解密 (CVE-2023-46809)。
// 当 crypto.privateDecrypt 抛错时回退到 openssl CLI（容器/主机通常都自带 openssl 3.x）。
function opensslPrivDecrypt(b64) {
  const kf = path.join(os.tmpdir(), `fh_priv_${process.pid}.pem`);
  const inf = path.join(os.tmpdir(), `fh_enc_${process.pid}.bin`);
  fs.writeFileSync(kf, RSA_APP_PRIV_KEY);
  fs.writeFileSync(inf, Buffer.from(b64, 'base64'));
  try {
    const out = execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', kf, '-pkeyopt', 'rsa_padding_mode:pkcs1', '-in', inf]);
    return out.toString('utf8');
  } finally {
    try { fs.unlinkSync(kf); } catch (e) {}
    try { fs.unlinkSync(inf); } catch (e) {}
  }
}

function decryptResponse(encryptedKey, encryptedData) {
  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      { key: RSA_APP_PRIV_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(encryptedKey, 'base64')
    ).toString('utf8');
  } catch (e) {
    aesKey = opensslPrivDecrypt(encryptedKey);
  }
  const key = Buffer.from(aesKey, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encryptedData, 'base64'), decipher.final()]).toString('utf8');
}

module.exports = { RSA_PUB_KEY, RSA_APP_PRIV_KEY, genAesKey, encryptAES, encryptRSA, buildSign, decryptResponse };
