const net = require("net");

const tests = [
  "token: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Token: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "api_key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "api-key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "ApiKey: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "x-api-key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "secret: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Secret: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Key: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "password: 976dc5b3977cd2cbb8c61ddd32e9f885",
  "Password: 976dc5b3977cd2cbb8c61ddd32e9f885",
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
      const txt = data.toString();
      const match = txt.match(/"message":"([^"]*)"/);
      resolve(match ? match[1] : txt.slice(0, 100));
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