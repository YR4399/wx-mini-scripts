const http = require("http");

const WCS_URL = process.env.WECHAT_WX_SERVER_URL || "http://localhost:18788";
const WCS_AUTH = process.env.WECHAT_AUTH || "976dc5b3977cd2cbb8c61ddd32e9f885";

// Try URL parameter
const url = `${WCS_URL}/wx/code?wx_auth=${WCS_AUTH}`;
const body = JSON.stringify({ openid: "oLvh-0ydiGAnlYBAVXbouPVAxXN4", appid: "wx52fe44d9b00ed631" });

const req = http.request(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
}, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Body: ${data}`);
  });
});
req.on("error", (e) => console.log(`Error: ${e.message}`));
req.write(body);
req.end();