// 通用日志/延迟装饰模块（面板环境最小实现）
// 注意：这是被多个脚本共享的公共模块，日志前缀必须从「调用方脚本名」动态推导，
// 不可写死某个业务名（此前写死为「倚天」，导致所有引用脚本的日志都带上该标记）。
const path = require("path");

const ICON = {
  ok: "✅", info: "ℹ️", warn: "⚠️", error: "❌", star: "🌟",
  cookie: "🍪", gift: "🎁", fight: "⚔️", debug: "🐞",
};

// 推导日志前缀：取真实执行脚本的文件名
function _derivePrefix() {
  try {
    const args = process.argv || [];
    let main = args[1] || "";
    // 面板以 env_loader.js 作为入口，真实脚本位于 argv[2]
    if (path.basename(main) === "env_loader.js") {
      main = args[2] || main;
    }
    const base = path.basename(main || "").replace(/\.(js|mjs|cjs|py|sh)$/i, "");
    return base ? `[${base}]` : "";
  } catch (_) {
    return "";
  }
}

const PREFIX = _derivePrefix();

const L = {
  ok: (...a) => console.log(ICON.ok, PREFIX, ...a),
  info: (...a) => console.log(ICON.info, PREFIX, ...a),
  warn: (...a) => console.log(ICON.warn, PREFIX, ...a),
  error: (...a) => console.log(ICON.error, PREFIX, ...a),
  debug: (...a) => console.log(ICON.debug, PREFIX + "[debug]", ...a),
  fail: (...a) => { console.error(ICON.error, PREFIX, ...a); process.exit(1); },
};

function sectionLine(title = "") {
  const t = String(title || "");
  console.log(`\n========== ${t} ==========`);
}

// 人类化延迟：humanDelay(ms) 固定延迟；humanDelay(min, max) 区间内随机
function humanDelay(min, max) {
  let ms;
  if (max === undefined || max === null) {
    ms = Number(min) || 0;
  } else {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ICON, L, sectionLine, humanDelay };
