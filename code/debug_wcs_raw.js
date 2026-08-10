const net = require("net");

const tests = [
  "Authorization: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Authorization: Bearer 976dc5b3977cd2cbb8c61ddd32e9f885",
  "auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "AUTH: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "X-Auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "x-auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "wx-auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "wx_auth: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Api-Key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "api-key: 976dc5b3977cd2cbb8c61ddd32e9f885",
];

const body = JSON.stringify({ openid: "oLvh-0ydiGAnlYBAVXbouPVAxXN4", appid: "wx52fe44d9b00ed631" });

async function tryHeader(headerLine) {
  return new Promise((resolve) => {
    const reqStr = [
      "POST /wx/code HTTP/1.1",
      "Host: localhost:18788",
      "Content-Type: application/json",
      headerLine,
      "Content-Length: " + Buffer.byteLength(body),
      "",
      body
    ].join("\r\n");

    const client = net.connect({ host: "localhost", port: 18788 }, () => {
      client.write(reqStr);
    });
    client.on("data", (data) => {
      const lines = data.toString().split("\r\n");
      const msgLine = lines.find((l) => l.includes("status")) || "";
      resolve(msgLine);
    });
    client.on("error", () => resolve("(error)"));
    setTimeout(() => resolve("(timeout)"), 3000);
  });
}

(async () => {
  for (const h of tests) {
    const r = await tryHeader(h);
    console.log(`  ${h.padEnd(50)} → ${r}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  process.exit(0);
})();