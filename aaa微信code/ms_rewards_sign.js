#!/usr/bin/env node
/**
 * Microsoft Rewards 自动化脚本 (中国版 cn.bing.com)
 * ------------------------------------------------------------
 * 架构:
 *   1. PC 搜索积分   - 纯 Node HTTP POST reportActivity ✅ 已验证可计分 +1/次
 *   2. 移动搜索积分  - Playwright 移动端仿真导航至搜索页 (纯 Node ❌ 不计分)
 *   3. 连续打卡状态  - Playwright 驱动系统 Edge 读取真实进度
 *   4. 升级任务(PunchCard) - Playwright 点击当日首个未完成子任务打卡
 *   5. 每日活动(尽力) - Playwright 完成每日任务集，喂饱连续打卡活动进度
 *
 * 环境变量:
 *   MS_COOKIES      必填  Bing/Rewards Cookie
 *   MS_PC_SEARCH    可选  PC 搜索次数 (默认 30，日上限 60)
 *   MS_MB_SEARCH    可选  移动搜索次数 (默认 20，需浏览器，日上限 ~30)
 *   MS_SKIP_BROWSER 可选  设为 1 跳过浏览器(搜索/打卡/升级)
 *     * 容器定时任务: 容器无浏览器 → 设 MS_SKIP_BROWSER=1 → 仅 PC 搜索
 *     * 宿主机执行:  不设 → PC 搜索(Node) + 移动搜索/打卡/升级(Playwright+Edge)
 */

'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { push } = require('./_push_helper');

// ============================ 配置 ============================
const COOKIE = process.env.MS_COOKIES || '';
const PC_SEARCH = parseInt(process.env.MS_PC_SEARCH || '30', 10);
const MB_SEARCH = parseInt(process.env.MS_MB_SEARCH || '20', 10);
const SKIP_BROWSER = process.env.MS_SKIP_BROWSER === '1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 EdgA/150.0.0.0';

const GS_LCRP = 'EgRlZGdlKgYIARAAGEAyBggAEEUYOTIGCAEQABhAMgYIAhAAGEAyBggDEAAYQDIGCAQQABhAMgYIBRAAGEAyBggGEAAYQDIGCAcQABhAMgYICBAAGEDSAQgyOTgzajBqN6gCALACAA';

const KEYWORDS = [
  '人工智能最新进展', '量子计算原理', '新能源汽车销量', '直播带货趋势', '元宇宙应用场景',
  '碳中和目标', '半导体产业链', '乡村振兴政策', '数字经济规模', '脑机接口技术',
  '可控核聚变', '低空经济发展', '人工智能绘画', '大模型训练', '智能驾驶落地',
  '基因编辑技术', '光伏发电效率', '氢能产业布局', '商业航天进展', '6G通信标准',
  '网络安全防护', '云计算市场规模', '区块链应用', '数字货币试点', '智慧城市建设',
  '医疗AI诊断', '机器人产业', '虚拟现实教育', '自动驾驶法规', '半导体设备国产化',
  '新能源汽车补贴', '光伏组件出口', '锂电池回收', '人工智能芯片', '数据中心节能',
];

// ============================ UI 辅助 ============================
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgBlue: '\x1b[44m', bgGreen: '\x1b[42m',
};
const sym = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️', star: '⭐', fire: '🔥' };

function box(title, color = C.cyan) {
  const line = '─'.repeat(48);
  console.log(`${color}${C.bold}╭${line}╮${C.reset}`);
  console.log(`${color}${C.bold}│${C.reset} ${color}${C.bold}${title}${C.reset}`);
  console.log(`${color}${C.bold}╰${line}╯${C.reset}`);
}
function progress(done, total, width = 20) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const filled = Math.round((done / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${C.green}${bar}${C.reset}] ${done}/${total} ${C.cyan}${pct}%${C.reset}`;
}
function card(lines, color = C.blue) {
  const w = Math.max(...lines.map(l => l.length)) + 2;
  console.log(`${color}┌${'─'.repeat(w)}┐${C.reset}`);
  for (const l of lines) {
    console.log(`${color}│${C.reset} ${l}${' '.repeat(w - l.length - 1)} ${color}│${C.reset}`);
  }
  console.log(`${color}└${'─'.repeat(w)}┘${C.reset}`);
}

// ============================ HTTP 工具 ============================
function req(method, urlStr, body, headers, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? Buffer.from(body) : null;
    const h = Object.assign({
      'User-Agent': UA_DESKTOP,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cookie': COOKIE,
      'Host': u.host,
    }, headers || {});
    if (data) h['Content-Length'] = data.length;
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: h, timeout,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}
function extract(html, re) { const m = html.match(re); return m ? m[1] : null; }
function extractBalance(html) { const m = html.match(/"Balance":(\d+)/); return m ? parseInt(m[1], 10) : null; }
function extractEarned(html) { const m = html.match(/"DailySearchPointsEarned":(\d+)/); return m ? parseInt(m[1], 10) : null; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================ PC 搜索计分 (纯 Node) ============================
async function doSearchPc(keyword, idx) {
  const host = 'cn.bing.com';
  const kwEnc = encodeURIComponent(keyword);
  const pq = encodeURIComponent(keyword.slice(0, Math.min(4, keyword.length)));
  const sc = `${keyword.length}-${keyword.split(/\s+/).length}`;

  // Step 1: 搜索页拿 IG / cvid
  const sp = await req('GET', `https://${host}/search?q=${kwEnc}&form=QBLH&pq=${pq}&sc=${sc}&cvid=7e373672ca744f1db546db5d6c3eb1f3`, null, {
    'Accept': 'text/html,application/xhtml+xml',
    'User-Agent': UA_DESKTOP,
  });
  if (sp.status !== 200) return { ok: false, err: `search HTTP ${sp.status}` };
  const ig = extract(sp.body, /["']IG["']?\s*[:=]\s*["']([A-F0-9]{32})["']/i) || '9AFE527C9FBC4E349A7B736F19E3F0B1';
  const cvid = extract(sp.body, /["']cvid["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i) || '7e373672ca744f1db546db5d6c3eb1f3';

  // Step 2: reportActivity 计分
  const searchUrl = `https://${host}/search?qs=FT&pq=${pq}&sk=CSYN1&sc=${sc}&pglt=163&q=${kwEnc}&cvid=${cvid}&gs_lcrp=${GS_LCRP}&FORM=ANNTA1&ucpdpc=UCPD&PC=UCPDDB`;
  const reportUrl = `https://${host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.${6000 + idx}&qs=FT&pq=${pq}&sk=CSYN1&sc=${sc}&pglt=163&q=${kwEnc}&cvid=${cvid}&gs_lcrp=${GS_LCRP}&FORM=ANNTA1&ucpdpc=UCPD&PC=UCPDDB&ajaxreq=1`;
  const body = `url=${encodeURIComponent(searchUrl)}&V=web`;
  const rr = await req('POST', reportUrl, body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': '*/*',
    'Origin': `https://${host}`,
    'Referer': `https://${host}/search?q=${kwEnc}`,
    'User-Agent': UA_DESKTOP,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  });
  if (rr.status !== 200) return { ok: false, err: `report HTTP ${rr.status}` };
  const bal = extractBalance(rr.body);
  const earned = extractEarned(rr.body);
  return { ok: true, balance: bal, earned };
}

async function runSearchesPc(count, label) {
  console.log(`\n${sym.info} ${label} (${count} 次)`);
  let ok = 0;
  let lastBalance = null;
  for (let i = 0; i < count; i++) {
    const kw = randItem(KEYWORDS);
    process.stdout.write(`\r  ${progress(i, count)} 搜索: ${kw.slice(0, 12)}...`);
    try {
      const r = await doSearchPc(kw, i);
      if (r.ok) { ok++; lastBalance = r.balance; }
    } catch (e) { /* ignore single failure */ }
    if (i < count - 1) await sleep(2000);
  }
  process.stdout.write(`\r  ${progress(count, count)} ${label} 完成\n`);
  console.log(`  ${sym.ok} ${label}: ${ok}/${count} 成功` + (lastBalance !== null ? ` | 余额: ${C.yellow}${lastBalance}${C.reset}` : ''));
  return { ok, count, lastBalance };
}

// ============================ Playwright 移动搜索 ============================
async function runMobileViaBrowser(browser, count, label) {
  console.log(`\n${sym.info} ${label} (${count} 次)`);
  const ctx = await browser.newContext({
    userAgent: UA_MOBILE,
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });
  const cookies = parseCookiesForPlaywright(COOKIE);
  await ctx.addCookies(cookies).catch(() => {});
  const page = await ctx.newPage();

  let ok = 0;
  for (let i = 0; i < count; i++) {
    const kw = randItem(KEYWORDS);
    process.stdout.write(`\r  ${progress(i, count)} 移动搜索: ${kw.slice(0, 12)}...`);
    try {
      await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(kw)}&form=QBLH`, { waitUntil: 'networkidle', timeout: 25000 });
      await sleep(2000); // 等待 reportActivity 异步完成
      ok++;
    } catch (e) { /* ignore single failure */ }
    if (i < count - 1) await sleep(1500);
  }
  await ctx.close();
  process.stdout.write(`\r  ${progress(count, count)} ${label} 完成\n`);
  console.log(`  ${sym.ok} ${label}: ${ok}/${count} 成功`);
  return { ok, count };
}

// ============================ Playwright 打卡/升级 ============================
function parseCookiesForPlaywright(cookieStr) {
  const out = [];
  for (const pair of cookieStr.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: '.bing.com', path: '/' });
  }
  return out;
}

// 读取连续打卡三路真实进度 (支持繁/简体中文)
async function getStreakStatus(page) {
  await page.goto('https://rewards.bing.com/earn?section=streaks', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  const txt = await page.evaluate(() => document.body ? document.body.innerText : '');
  function grab(re) { const m = txt.match(re); return m ? `${m[1]}/${m[2]}` : '?'; }
  return {
    search: grab(/(?:搜[寻尋索]|Search)[\s\S]*?[搜寻尋索][寻索尋]?:\s*(\d+)\s*\/\s*(\d+)/),
    activity: grab(/(?:每日[设設定]定?|活[动動])[\s\S]*?活[动動]:\s*(\d+)\s*\/\s*(\d+)/),
    app: grab(/[签簽]到:\s*(\d+)\s*\/\s*(\d+)/),
  };
}

// 升级任务 (PunchCard): 找到当月活动，点击当日首个未完成子任务打卡
async function doPunchcard(page) {
  // 1) 从 /earn 找到真实 punchcard URL (排除 onboarding)
  await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  const punchUrl = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/earn/quest/"]')];
    const p = links.find(a => /punchcard/.test(a.getAttribute('href') || '') && !/onboarding/.test(a.getAttribute('href') || ''));
    return p ? 'https://rewards.bing.com' + p.getAttribute('href') : null;
  });
  if (!punchUrl) return { ok: false, reason: '未找到当月 PunchCard 活动', before: null, after: null, clicked: null };

  await page.goto(punchUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  const before = await page.evaluate(() => { const m = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/); return m ? `${m[1]}/${m[2]}` : '?'; });

  // 2) 点击首个未完成的子任务链接。
  //    子任务链接特征: href 指向 bing.com/search，卡片文本含 "点击完成" (aria-label 在 RSC 下不稳定，故用可见文本判定)
  //    注意: 改版后 PunchCard 限制每 24h 仅可打 1 枚印章，其余子任务当日锁定。
  let clicked = null;
  try {
    await page.waitForFunction(() => {
      const t = (a) => (a.textContent || '');
      return [...document.querySelectorAll('a')].some(a =>
        (a.getAttribute('href') || '').includes('bing.com/search') &&
        (t(a).includes('点击完成') || t(a).includes('點擊完成')));
    }, { timeout: 15000 });
    clicked = await page.evaluate(() => {
      const t = (a) => (a.textContent || '');
      const links = [...document.querySelectorAll('a')].filter(a =>
        (a.getAttribute('href') || '').includes('bing.com/search') &&
        (t(a).includes('点击完成') || t(a).includes('點擊完成')));
      if (links.length) {
        const t = (links[0].innerText || '').trim().split('\n')[0] || '子任务';
        links[0].click();
        return t;
      }
      return null;
    });
  } catch (e) {
    clicked = null; // 超时未出现，可能当日已全部打卡/锁定或渲染延迟
  }
  if (!clicked) {
    const m = (before || '').match(/(\d+)\s*\/\s*(\d+)/);
    const locked = m && parseInt(m[1], 10) > 0;
    return { ok: false, reason: locked ? '今日印章已打或子任务已锁定(24h)' : '未找到可点击子任务链接', before, after: before, clicked: null };
  }

  // 3) 子任务页停留一会儿 (让必应搜索执行并打卡)，再返回查看印章进度
  await sleep(8000);
  try { await page.mouse.wheel(0, 400); } catch (e) {}
  await sleep(2000);
  await page.goto(punchUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  const afterInfo = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    let m = txt.match(/(\d+)\s*\/\s*(\d+)\s*(?:个任务|個任務|工作)/);
    if (!m) m = txt.match(/(\d+)\s*\/\s*(\d+)/);
    return { status: m ? `${m[1]}/${m[2]}` : '?', raw: (txt || '').replace(/\s+/g, ' ').slice(0, 200) };
  });
  const after = afterInfo.status;

  return { ok: true, reason: '', before, after, clicked, raw: afterInfo.raw };
}

// 每日活动: 找到页面上的所有奖励 offer（搜索/拼图/问答），依次导航完成
async function doDailySet(page) {
  await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  // 滚动到底部触发 RSC 惰性加载
  try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(2000); } catch (e) {}
  try { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(1000); } catch (e) {}

  // 收集所有可点击的 offer 链接：
  //   - 排除导航/兑换/奖励 等无关链接
  //   - 排除 punchcard/onboarding
  //   - 必须有积分标记 (+5 +15 +30 +50 +95 +100)
  const offers = await page.evaluate(() => {
    // 排除已知的非 offer 元素（导航、连续打卡、升级任务等）
    const exclude = /連續達標|深入了解|獎勵|戳記|到期|工作|全新仪表板|Bing\s*搜尋|每日設定|Edge|應用程式|產品|合作夥伴|訂購|常見|最佳|促銷|網站地圖|意見|Microsoft|Xbox|公司|隱私|使用條款|提供|連續|簽到|活動[:：]|搜尋[:：]/;
    // 页面上的 offer 链接: bing.com 的链接，包含积分数字
    const links = [...document.querySelectorAll('a[href*="bing.com"]')];
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const txt = (a.innerText || '').trim();
      const pointMatch = txt.match(/[+](\d+)/);
      if (!pointMatch) continue;
      const points = parseInt(pointMatch[1], 10);
      if (points < 5 || points > 500) continue; // 积分范围过滤
      if (/punchcard|onboarding/.test(href)) continue;
      if (exclude.test(txt)) continue;
      if (!txt || txt.length < 10) continue;
      const key = href.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ href, text: txt.split('\n')[0].slice(0, 30), points });
    }
    return out;
  });

  if (offers.length === 0) return { ok: false, reason: '未发现可自动化的每日活动(可能已完成或由RSC动态加载)', completed: 0 };

  let completed = 0;
  const detail = [];
  for (const o of offers) {
    try {
      await page.goto(o.href, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await sleep(5000); // 等待自动计分
      completed++;
      detail.push(o.text + '(已访问)');
    } catch (e) { detail.push(o.text + '(失败:' + e.message.slice(0, 20) + ')'); }
  }
  return { ok: true, completed, detail };
}

// ============================ 超时辅助 ============================
function runWithTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`[${label}] 超时 ${ms}ms`)), ms)),
  ]);
}

// ============================ 浏览器任务总入口 ============================
async function runBrowserTasks() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log(`  ${sym.warn} 未安装 playwright，跳过浏览器搜索/打卡/升级任务`); return null; }

  console.log(`\n${sym.fire} 启动 Edge 浏览器完成移动搜索 + 打卡 / 升级任务...`);
  let browser;
  try {
    browser = await runWithTimeout(
      playwright.chromium.launch(Object.assign(
        { headless: true },
        process.platform === 'win32' ? { channel: 'msedge' } : {},
      )),
      30000, '浏览器启动',
    );
  } catch (e) {
    console.log(`  ${sym.err} 无法启动 Edge: ${e.message}`);
    return null;
  }

  const result = { mobileSearch: null, streak: null, punchcard: null, dailySet: null };
  const browserTimeout = setTimeout(() => {
    console.log(`  ${sym.warn} 浏览器任务总超时，强制关闭...`);
    browser.close().catch(() => {});
  }, 240000); // 4 分钟硬超时保护

  try {
    // === 阶段 1: 移动搜索 (Playwright 移动端仿真) ===
    if (MB_SEARCH > 0) {
      result.mobileSearch = await runMobileViaBrowser(browser, MB_SEARCH, '📱  移动搜索');
    }

    // === 阶段 2: 桌面端打卡/升级任务 ===
    const context = await browser.newContext({ userAgent: UA_DESKTOP });
    try {
      const cookies = parseCookiesForPlaywright(COOKIE);
      await context.addCookies(cookies);
    } catch (e) { /* ignore */ }
    const page = await context.newPage();

    // 2a) 连续打卡状态
    console.log(`\n${sym.info} 读取连续打卡状态...`);
    try { result.streak = await getStreakStatus(page); console.log(`  ${sym.ok} 连续打卡: 搜索 ${result.streak.search} | 活动 ${result.streak.activity} | 应用 ${result.streak.app}`); }
    catch (e) { console.log(`  ${sym.err} 读取连续打卡失败: ${e.message}`); }

    // 2b) 升级任务 (PunchCard)
    console.log(`\n${sym.info} 执行升级任务(PunchCard)...`);
    try {
      result.punchcard = await doPunchcard(page);
      const pc = result.punchcard;
      if (pc.ok && pc.clicked) {
        if (pc.after && pc.before && pc.after !== pc.before)
          console.log(`  ${sym.ok} 升级任务: 点击「${pc.clicked}」 印章 ${pc.before} → ${pc.after}`);
        else
          console.log(`  ${sym.warn} 升级任务: 已点击「${pc.clicked}」但印章未变化(${pc.before||'?'}) — 可能已达每日上限或子任务锁定 24h`);
      } else {
        console.log(`  ${sym.warn} 升级任务: ${pc.reason || '未完成'}${pc.before ? ' (当前 ' + pc.before + ')' : ''}`);
      }
    } catch (e) { console.log(`  ${sym.err} 升级任务出错: ${e.message}`); }

    // 2c) 每日活动 (尽力)
    console.log(`\n${sym.info} 尝试每日活动(连续打卡-活动进度)...`);
    try {
      result.dailySet = await doDailySet(page);
      if (result.dailySet.ok) console.log(`  ${sym.ok} 每日活动: 完成 ${result.dailySet.completed} 项 ${result.dailySet.detail ? '(' + result.dailySet.detail.join(', ') + ')' : ''}`);
      else console.log(`  ${sym.warn} 每日活动: ${result.dailySet.reason}`);
    } catch (e) { console.log(`  ${sym.err} 每日活动出错: ${e.message}`); }

    await context.close();
  } catch (e) {
    console.log(`  ${sym.err} 浏览器任务总出错: ${e.message}`);
  } finally {
    clearTimeout(browserTimeout);
    await browser.close().catch(() => {});
  }
  return result;
}

// ============================ 主流程 ============================
async function main() {
  box('Microsoft Rewards 自动化 (cn.bing.com)', C.magenta);
  if (!COOKIE) {
    console.log(`${sym.err} 未设置 MS_COOKIES 环境变量，无法运行`);
    process.exit(1);
  }
  console.log(`${sym.info} 账号 Cookie 长度: ${COOKIE.length}`);
  console.log(`${sym.info} 计划: PC ${PC_SEARCH} 次${SKIP_BROWSER ? ' (跳过浏览器)' : ' / 移动 ' + MB_SEARCH + ' 次(需浏览器)'}`);

  // 1. PC 搜索 (纯 Node，已验证)
  const pc = await runSearchesPc(PC_SEARCH, '🖥️  PC 搜索');

  // 2. 浏览器任务 (移动搜索 + 打卡/升级)
  let browserResult = null;
  if (!SKIP_BROWSER) {
    browserResult = await runBrowserTasks();
  }

  // 汇总
  console.log('');
  box('运行汇总', C.green);
  const lines = [
    `🖥️  PC 搜索:    ${pc.ok}/${pc.count} ${pc.ok === pc.count ? sym.ok : sym.warn}`,
  ];

  if (browserResult) {
    // 移动搜索结果
    if (browserResult.mobileSearch) {
      lines.push(`📱  移动搜索:  ${browserResult.mobileSearch.ok}/${browserResult.mobileSearch.count} ${browserResult.mobileSearch.ok === browserResult.mobileSearch.count ? sym.ok : sym.warn}`);
    } else {
      lines.push(`📱  移动搜索:  ${sym.warn} 未执行`);
    }
    // 连续打卡
    if (browserResult.streak) {
      const s = browserResult.streak;
      lines.push(`🔥 连续打卡:  搜索 ${s.search} | 活动 ${s.activity} | 应用 ${s.app}`);
    } else {
      lines.push(`🔥 连续打卡:  ${sym.warn} 读取失败`);
    }
    // 升级任务
    if (browserResult.punchcard && browserResult.punchcard.ok) {
      lines.push(`⭐ 升级任务:  ${browserResult.punchcard.before} → ${browserResult.punchcard.after} (${browserResult.punchcard.clicked})`);
    } else if (browserResult.punchcard) {
      lines.push(`⭐ 升级任务:  ${browserResult.punchcard.reason || sym.warn + ' 未完成'}`);
    } else {
      lines.push(`⭐ 升级任务:  ${sym.warn} 未执行`);
    }
    // 每日活动
    if (browserResult.dailySet) {
      lines.push(`📋 每日活动:  ${browserResult.dailySet.ok ? '完成 ' + browserResult.dailySet.completed + ' 项' : (browserResult.dailySet.reason || '未执行')}`);
    }
  } else {
    lines.push(`📱  移动搜索:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
    lines.push(`🔥 连续打卡:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
    lines.push(`⭐ 升级任务:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
  }

  if (pc.lastBalance !== null) lines.push(`💰 当前积分: ${pc.lastBalance}`);
  card(lines, C.blue);
  console.log(`\n${sym.star} 提示: 搜索积分已通过 cn.bing.com 实时计入，几分钟后到 rewards.bing.com 查看余额`);

  // 推送通知
  const pushContent = lines.map(l => l.replace(/\x1b\[\d+m/g, '')).join('\n');
  push('Microsoft Rewards 签到结果', pushContent).catch(() => {});
}

main().catch(e => {
  console.error(`${sym.err} 致命错误:`, e);
  process.exit(1);
});
