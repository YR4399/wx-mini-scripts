#!/usr/bin/env node
/**
 * Microsoft Rewards 自动化脚本 (中国版 cn.bing.com)
 * ------------------------------------------------------------
 * 功能:
 *   1. PC 搜索积分   - 纯 Node HTTP，已验证可计分
 *   2. 移动搜索积分  - 纯 Node HTTP (移动 UA)
 *   3. 连续打卡      - Playwright 驱动系统 Edge (需 GEC 头)
 *   4. 升级任务      - Playwright 驱动系统 Edge (PunchCard)
 *
 * 环境变量:
 *   MS_COOKIES    必填  Bing/Rewards Cookie
 *   MS_PC_SEARCH  可选  PC 搜索次数 (默认 30)
 *   MS_MB_SEARCH  可选  移动搜索次数 (默认 20)
 *   MS_SKIP_BROWSER 可选  设为 1 跳过浏览器打卡/升级任务
 */

'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

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

// ============================ HTTP ============================
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
function extractBalance(html) {
  const m = html.match(/"Balance":(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function extractEarned(html) {
  const m = html.match(/"DailySearchPointsEarned":(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================ 搜索计分 ============================
async function doSearch(keyword, idx, isMobile) {
  const ua = isMobile ? UA_MOBILE : UA_DESKTOP;
  const host = 'cn.bing.com';
  const kwEnc = encodeURIComponent(keyword);
  const pq = encodeURIComponent(keyword.slice(0, Math.min(4, keyword.length)));
  const sc = `${keyword.length}-${keyword.split(/\s+/).length}`;

  // Step 1: 搜索页拿 IG / cvid
  const sp = await req('GET', `https://${host}/search?q=${kwEnc}&form=QBLH&pq=${pq}&sc=${sc}&cvid=7e373672ca744f1db546db5d6c3eb1f3`, null, {
    'Accept': 'text/html,application/xhtml+xml',
    'User-Agent': ua,
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
    'User-Agent': ua,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  });
  if (rr.status !== 200) return { ok: false, err: `report HTTP ${rr.status}` };
  const bal = extractBalance(rr.body);
  const earned = extractEarned(rr.body);
  return { ok: true, balance: bal, earned };
}

async function runSearches(isMobile, count, label) {
  console.log(`\n${sym.info} ${label} (${count} 次)`);
  let ok = 0;
  let lastBalance = null;
  for (let i = 0; i < count; i++) {
    const kw = randItem(KEYWORDS);
    process.stdout.write(`\r  ${progress(i, count)} 搜索: ${kw.slice(0, 12)}...`);
    try {
      const r = await doSearch(kw, i, isMobile);
      if (r.ok) { ok++; lastBalance = r.balance; }
    } catch (e) { /* ignore single failure */ }
    if (i < count - 1) await sleep(isMobile ? 1500 : 2000);
  }
  process.stdout.write(`\r  ${progress(count, count)} ${label} 完成\n`);
  console.log(`  ${sym.ok} ${label}: ${ok}/${count} 成功` + (lastBalance !== null ? ` | 余额: ${C.yellow}${lastBalance}${C.reset}` : ''));
  return { ok, count, lastBalance };
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

async function runBrowserTasks() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { console.log(`  ${sym.warn} 未安装 playwright，跳过浏览器打卡/升级任务`); return null; }

  console.log(`\n${sym.fire} 启动 Edge 浏览器完成打卡 / 升级任务...`);
  let browser;
  try {
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  } catch (e) {
    console.log(`  ${sym.err} 无法启动 Edge: ${e.message}`);
    return null;
  }
  const context = await browser.newContext({ userAgent: UA_DESKTOP });
  try {
    const cookies = parseCookiesForPlaywright(COOKIE);
    await context.addCookies(cookies);
  } catch (e) { /* ignore */ }
  const page = await context.newPage();
  const result = { checkin: '未知', punchcard: '未知' };
  const shotDir = path.dirname(path.resolve(process.argv[1]));

  // 匹配可点击的任务按钮（含文字的 button / role=button / a）
  async function clickByText(texts, label) {
    for (const t of texts) {
      try {
        const loc = page.locator('button, [role="button"], a').filter({ hasText: t }).first();
        if (await loc.count() > 0 && await loc.isVisible()) {
          await loc.click({ timeout: 6000 });
          await sleep(2000);
          console.log(`  ${sym.ok} ${label}: 点击「${t}」`);
          return true;
        }
      } catch (e) { /* try next */ }
    }
    return false;
  }

  try {
    // ---- 连续打卡 ----
    console.log(`  ${sym.info} 访问连续打卡页面...`);
    await page.goto('https://rewards.bing.com/earn?section=streaks', { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
    await sleep(4000);
    try { await page.screenshot({ path: path.join(shotDir, 'ms_streaks.png'), fullPage: false }); } catch (e) {}
    const checkinTexts = ['领取', '打卡', '签到', 'Claim', 'Check in', '认领', '立即领取', '领取奖励'];
    const ok = await clickByText(checkinTexts, '连续打卡');
    result.checkin = ok ? '已领取连续打卡奖励' : '无待领取项目';

    // ---- 升级任务 (PunchCard) ----
    console.log(`  ${sym.info} 访问赚取页面完成升级任务...`);
    await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
    await sleep(4000);
    try { await page.screenshot({ path: path.join(shotDir, 'ms_earn.png'), fullPage: false }); } catch (e) {}

    // 先尝试直接进 punchcard 任务页完成子任务
    const punchUrl = 'https://rewards.bing.com/earn/quest/WW_pcparent_redesign_existinguser_onboarding_offer_punchcard';
    try {
      await page.goto(punchUrl, { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
      await sleep(3000);
      const done = await clickByText(['完成', '领取', 'Claim', 'Complete', '立即领取'], '升级任务');
      if (done) result.punchcard = '已尝试完成升级任务';
    } catch (e) { /* ignore */ }

    // 再扫描 earn 页所有任务按钮
    if (result.punchcard === '未知') {
      const taskTexts = ['开始', '完成', '领取', 'Start', 'Complete', 'Claim', '去做任务', '参与', '立即参与'];
      let clicked = 0;
      for (const t of taskTexts) {
        try {
          const locs = page.locator('button, [role="button"], a').filter({ hasText: t });
          const n = await locs.count();
          for (let i = 0; i < n; i++) {
            try {
              if (await locs.nth(i).isVisible()) { await locs.nth(i).click({ timeout: 4000 }); clicked++; await sleep(1500); }
            } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      }
      result.punchcard = clicked > 0 ? `已点击 ${clicked} 个任务按钮` : '无可用任务';
    }
  } catch (e) {
    console.log(`  ${sym.err} 浏览器任务出错: ${e.message}`);
  } finally {
    await browser.close();
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
  console.log(`${sym.info} 计划: PC ${PC_SEARCH} 次 / 移动 ${MB_SEARCH} 次`);

  // 1. PC 搜索
  const pc = await runSearches(false, PC_SEARCH, '🖥️  PC 搜索');
  // 2. 移动搜索
  const mb = await runSearches(true, MB_SEARCH, '📱  移动搜索');

  // 3. 浏览器打卡/升级
  let browserResult = null;
  if (!SKIP_BROWSER) {
    browserResult = await runBrowserTasks();
  }

  // 汇总
  console.log('');
  box('运行汇总', C.green);
  const lines = [
    `🖥️  PC 搜索:    ${pc.ok}/${pc.count} ${pc.ok === pc.count ? sym.ok : sym.warn}`,
    `📱  移动搜索:  ${mb.ok}/${mb.count} ${mb.ok === mb.count ? sym.ok : sym.warn}`,
  ];
  if (browserResult) {
    lines.push(`🔥 连续打卡:  ${browserResult.checkin}`);
    lines.push(`⭐ 升级任务:  ${browserResult.punchcard}`);
  } else {
    lines.push(`🔥 连续打卡:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
    lines.push(`⭐ 升级任务:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
  }
  if (pc.lastBalance !== null) lines.push(`💰 当前积分: ${pc.lastBalance}`);
  card(lines, C.blue);
  console.log(`\n${sym.star} 提示: 搜索积分已通过 cn.bing.com 实时计入，几分钟后到 rewards.bing.com 查看`);
}

main().catch(e => {
  console.error(`${sym.err} 致命错误:`, e);
  process.exit(1);
});
