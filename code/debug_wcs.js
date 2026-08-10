const http = require("http");

const WCS_URL = process.env.WECHAT_WX_SERVER_URL || "http://localhost:18788";
const WCS_AUTH = process.env.WECHAT_AUTH || "976dc5b3977cd2cbb8c61ddd32e9f885";
const openid = process.env.wx_opinion || "oLvh-0ydiGAnlYBAVXbouPVAxXN4";

async function tryAuth(label, headers) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ openid, appid: "wx52fe44d9b00ed631" });
    const req = http.request(
      `${WCS_URL}/wx/code`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            console.log(`  [${label}] status=${res.statusCode} msg="${j.message}" code="${j?.data?.data?.code || j?.data?.code || 'N/A'}"`);
          } catch {
            console.log(`  [${label}] status=${res.statusCode} raw="${data.slice(0, 200)}"`);
          }
          resolve();
        });
      }
    );
    req.on("error", (e) => { console.log(`  [${label}] error: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  await tryAuth("header=auth", { auth: WCS_AUTH });
  await tryAuth("header=AUTH", { AUTH: WCS_AUTH });
  await tryAuth("header=Auth", { Auth: WCS_AUTH });
  await tryAuth("header=Authorization", { Authorization: WCS_AUTH });
  await tryAuth("header=Bearer", { Authorization: `Bearer ${WCS_AUTH}` });
  await tryAuth("header=wx-auth", { "wx-auth": WCS_AUTH });
})();