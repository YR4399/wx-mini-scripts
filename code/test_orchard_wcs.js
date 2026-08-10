/**
 * 测试：WCS 小程序 code 能否调用淘宝闪购果园 API
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URLSearchParams } = require("url");

// WCS 配置
const WCS_URL = process.env.WECHAT_WX_SERVER_URL || "http://localhost:18788";
const WCS_AUTH = process.env.WECHAT_AUTH || process.env.WXAPIKEY || "976dc5b3977cd2cbb8c61ddd32e9f885";

// mtop 配置
const MTOP_HOST = "acs.m.taobao.com";
const APP_KEY = "24895413";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 从 WCS 获取 code（JSON body + auth header）
async function getWxCode(openid) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ openid, appid: "wx52fe44d9b00ed631" }); // 香蕉 AppID（随便一个）
    const req = http.request(
      `${WCS_URL}/wx/code`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          auth: WCS_AUTH,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve(j?.data?.data?.code || j?.data?.code || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", (e) => resolve(null));
    req.write(body);
    req.end();
  });
}

// mtop 签名
function mtopSign(timestamp, sessionKey) {
  return crypto.createHash("md5").update((sessionKey || "") + timestamp).digest("hex");
}

// 发送 mtop 请求（使用 GET 参数风格）
async function mtopGet(opts) {
  const { api, data, sessionKey } = opts;
  const t = Date.now();
  const sign = mtopSign(t, sessionKey || "");
  const params = new URLSearchParams({
    api,
    v: "1.0",
    appKey: APP_KEY,
    t,
    sign,
    dataType: "json",
    type: "originaljson",
  });
  if (data) params.append("data", JSON.stringify(data));

  return new Promise((resolve) => {
    const req = https.request(
      `https://${MTOP_HOST}/gw/${api}/*?${params}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(params.toString()),
          "User-Agent": "Mozilla/5.0",
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
        });
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(params.toString());
    req.end();
  });
}

// 测试
async function run() {
  const openid = process.env.wx_opinion || "oLvh-0ydiGAnlYBAVXbouPVAxXN4";
  console.log(`openid: ${openid}`);
  console.log(`WCS: ${WCS_URL}`);
  console.log("");

  // 1. 获取 WCS code
  console.log("[1] 获取 WCS code...");
  const code = await getWxCode(openid);
  if (!code) {
    console.log("❌ 获取 code 失败");
    return;
  }
  console.log(`✅ code: ${code}`);

  // 2. 用 code 作为 sessionKey 调用果园 API
  console.log("\n[2] 用 code 作 sessionKey 查询果园...");
  let r = await mtopGet({
    api: "mtop.alsc.playgame.orchard.base.info.query",
    data: { bizScene: "shuangou" },
    sessionKey: code,
  });
  console.log("ret:", r.ret);
  if (r.ret && r.ret[0] && !r.ret[0].startsWith("SUCCESS")) {
    console.log("msg:", r.ret[0]);
  }
  if (r.data) {
    console.log("data:", JSON.stringify(r.data, null, 2));
  }

  // 3. 用 code 签名但不做 sessionKey
  console.log("\n[3] 用 code 签名，无 sessionKey...");
  r = await mtopGet({
    api: "mtop.alsc.playgame.orchard.base.info.query",
    data: { bizScene: "shuangou" },
    sessionKey: code,
  });
  console.log("ret:", r.ret);
  if (r.ret && r.ret[0] && !r.ret[0].startsWith("SUCCESS")) {
    console.log("msg:", r.ret[0]);
  }

  // 4. 用 code 直接做 mtop 签名（无 sessionKey 前缀）
  console.log("\n[4] code 直接签 md5(code+timestamp)...");
  const t = Date.now();
  const sign = crypto.createHash("md5").update(code + t).digest("hex");
  const params = new URLSearchParams({
    api: "mtop.alsc.playgame.orchard.base.info.query",
    v: "1.0",
    appKey: APP_KEY,
    t,
    sign,
    dataType: "json",
    type: "originaljson",
    data: JSON.stringify({ bizScene: "shuangou" }),
  });
  const r4 = await new Promise((resolve) => {
    const req = https.request(
      `https://${MTOP_HOST}/gw/mtop.alsc.playgame.orchard.base.info.query/*?${params}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(params.toString()),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
        });
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(params.toString());
    req.end();
  });
  console.log("ret:", r4.ret);
  if (r4.ret && r4.ret[0] && !r4.ret[0].startsWith("SUCCESS")) {
    console.log("msg:", r4.ret[0]);
  }

  // 5. 尝试带 cookie 请求 Ele.me resource API（验证 cookie 模式）
  console.log("\n[5] 不带 cookie 请求 Ele.me resource API...");
  const r5 = await new Promise((resolve) => {
    const req = https.request(
      "https://alsc-fingerprint.ele.me/gw/mtop.alsc.mobile.resource.batch.query/1.0/?data=%7B%22load_way%22%3A1%2C%22rsc_type%22%3A1%7D&type=originaljson",
      { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ raw: d.slice(0, 300) }); }
        });
      }
    );
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
  console.log("ret:", r5.ret);
  if (r5.ret && r5.ret[0]) console.log("msg:", r5.ret[0]);

  console.log("\n====== 总结 ======");
  console.log("WCS code:", code);
  console.log("mtop ret:", r.ret ? r.ret[0] : "N/A");
}

run();