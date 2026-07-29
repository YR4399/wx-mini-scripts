/**
 * 共享装饰元素模块 — 供所有签到脚本统一使用
 * 使用: const {ICON, L, sectionLine, humanDelay, buildFingerprint, APP_NAME} = require("_decor.js");
 *
 * ICON     - emoji 装饰对象
 * L        - 格式化日志 (ok/fail/warn/info/act/line)
 * sectionLine(title, sub) - 分割线
 * humanDelay(kind) - 高斯抖动延迟
 * buildFingerprint() - 随机设备指纹
 */

// ============= 装饰元素 =============
const ICON = {
  app:    "📱",
  acc:    "👤",
  login:  "🔑",
  ok:     "✅",
  warn:   "⚠️",
  fail:   "❌",
  skip:   "⏭️",
  task:   "📋",
  post:   "📝",
  comment:"💬",
  like:   "👍",
  share:  "📤",
  sign:   "🗓️",
  coin:   "💰",
  device: "📱",
  delay:  "⏱",
  done:   "🏁",
  lottery:"🎰",
  prize:  "🎁",
  line:   "━".repeat(48),
  net:    "🌐",
  info:   "ℹ️",
  gift:   "🎁",
  trophy: "🏆",
  shield: "🛡️",
  car:    "🚗",
  moto:   "🏍️",
  milk:   "🥛",
  drink:  "🥤",
  tea:    "🍵",
  food:   "🍜",
  clothes:"👗",
  home:   "🏠",
  health: "💊",
  beauty: "💄",
  pet:    "🐕",
  car0:   "🚙",
  star:   "⭐",
  clock:  "🕐",
};

const L = {
  ok:    (m) => console.log("  " + ICON.ok + " " + m),
  fail:  (m) => console.log("  " + ICON.fail + " " + m),
  info:  (m) => console.log("  " + ICON.info + "  " + m),
  warn:  (m) => console.log("  " + ICON.warn + " " + m),
  act:   (m) => console.log("  🌐 " + m),
  line:  ()  => console.log(ICON.line),
};

// ============= 分割线 =============
function sectionLine(title, sub) {
  const pad = Math.max(0, 46 - (title.length || 0) - (sub ? sub.length + 3 : 0));
  console.log(ICON.line);
  console.log(ICON.app + " " + title + (sub ? "｜" + sub : "") + "·".repeat(Math.max(1, pad)));
  console.log(ICON.line);
}

// ============= 设备指纹池 =============
const DEVICE_POOL = [
  { brand: "Xiaomi",  model: "2201123C", market: "MI 12",         android: "13", build: "TKQ1.220829.002" },
  { brand: "Xiaomi",  model: "2304FPN6DC", market: "MI 13",        android: "14", build: "UKQ1.230804.001" },
  { brand: "Xiaomi",  model: "23116PN5BC", market: "MI 14",        android: "15", build: "AQ3A.240912.001" },
  { brand: "Redmi",   model: "23113RKC6C", market: "Redmi K70",    android: "14", build: "UKQ1.230917.001" },
  { brand: "Redmi",   model: "22101316C",  market: "Redmi Note 12",android: "13", build: "TKQ1.221114.001" },
  { brand: "HUAWEI",  model: "ALN-AL00",   market: "Mate 60",      android: "12", build: "HUAWEIALN-AL00" },
  { brand: "HUAWEI",  model: "BRA-AL00",   market: "P60",          android: "12", build: "HUAWEIBRA-AL00" },
  { brand: "OPPO",    model: "PGFM10",     market: "Find X6",      android: "14", build: "UKQ1.230924.001" },
  { brand: "vivo",    model: "V2309A",     market: "X100",         android: "14", build: "UP1A.231005.007" },
  { brand: "vivo",    model: "V2324A",     market: "X100 Pro",     android: "15", build: "AP3A.240905.015" },
  { brand: "samsung", model: "SM-S9180",   market: "Galaxy S23 Ultra", android: "14", build: "UP1A.231005.007" },
  { brand: "OnePlus", model: "PJE110",     market: "OnePlus 12",   android: "14", build: "UKQ1.230924.001" },
  { brand: "HONOR",   model: "REA-AN00",   market: "Magic6",       android: "14", build: "HONORREA-AN00" },
  { brand: "realme",  model: "RMX3888",    market: "GT5 Pro",      android: "14", build: "UKQ1.230924.001" },
];
const WECHAT_VERSIONS = [
  { ver: "8.0.49.2600", hex: "2800313A", sdk: "20240102" },
  { ver: "8.0.50.2701", hex: "2800321D", sdk: "20240206" },
  { ver: "8.0.51.2720", hex: "28003310", sdk: "20240305" },
  { ver: "8.0.52.2740", hex: "28003414", sdk: "20240402" },
  { ver: "8.0.53.2760", hex: "28003518", sdk: "20240507" },
  { ver: "8.0.54.2780", hex: "2800361C", sdk: "20240604" },
];
const CHROME_VERSIONS = ["108.0.5359.156","114.0.5735.196","119.0.6045.193",
  "120.0.6099.210","121.0.6167.178","122.0.6261.119"];

function buildFingerprint() {
  const dev = DEVICE_POOL[Math.floor(Math.random() * DEVICE_POOL.length)];
  const wc  = WECHAT_VERSIONS[Math.floor(Math.random() * WECHAT_VERSIONS.length)];
  const cr  = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  const net = ["WIFI","WIFI","5G","4G"][Math.floor(Math.random() * 4)];
  const lang= ["zh_CN","zh_CN","zh_TW"][Math.floor(Math.random() * 3)];
  const xweb = String(11700 + Math.floor(Math.random() * 1250));
  const mmw  = String(1800 + Math.floor(Math.random() * 8200));
  const ua = "Mozilla/5.0 (Linux; Android " + dev.android + "; " + dev.market + " Build/" + dev.build + "; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/" + cr + " Mobile Safari/537.36 XWEB/" + xweb + " MMWEBSDK/" + wc.sdk + " MMWEBID/" + mmw + " MicroMessenger/" + wc.ver + "(" + wc.hex + ") WeChat/arm64 Weixin NetType/" + net + " Language/" + lang + " ABI/arm64 MiniProgramEnv/android WMPF/1.2.0";
  return { ua, brand: dev.brand, model: dev.market, android: dev.android, wechat: wc.ver };
}

// ============= 高斯抖动延迟 =============
const DELAY_PROFILE = {
  query:   [400, 1200],
  action:  [800, 2400],
  heavy:   [1000, 2800],
  think:   [700, 2000],
  account: [3000, 8000],
  default: [500, 1500],
};

function gaussDelay(mean, std, minv, maxv) {
  let u = 0; while (u === 0) u = Math.random();
  let v = 0; while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(minv, Math.min(maxv, mean + z * std));
}

function humanDelay(kind) {
  const [minv, maxv] = DELAY_PROFILE[kind] || DELAY_PROFILE.default;
  const mean = (minv + maxv) / 2;
  const std  = (maxv - minv) / 4;
  const ms = Math.round(gaussDelay(mean, std, minv, maxv));
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { ICON, L, sectionLine, humanDelay, buildFingerprint, DEVICE_POOL };
