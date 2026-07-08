#!/usr/bin/env node
/**
 * Microsoft Rewards 自动化脚本 (中国版 cn.bing.com)
 * ------------------------------------------------------------
 * 功能:
 *   1. PC 搜索积分   - 纯 Node HTTP，已验证可计分 (cn.bing.com/reportActivity)
 *   2. 移动搜索积分  - 纯 Node HTTP (移动 UA)
 *   3. 连续打卡状态  - Playwright 驱动系统 Edge 读取真实进度
 *   4. 升级任务(PunchCard) - Playwright 点击当日子任务打卡
 *   5. 每日活动(尽力) - Playwright 完成每日任务集，喂饱连续打卡活动进度
 *
 * 重要说明 (2026-07  redesigned 中国版):
 *   - 连续打卡分三路: 必应搜索 / 每日活动 / 必应应用。
 *     搜索路由本脚本的搜索计分自动满足；活动路由"每日活动"满足；
 *     应用路需必应 App 移动端签到，桌面端无法自动化。
 *   - 页面上**没有**"领取/打卡"按钮，只有"了解详细信息"等说明。
 *     因此脚本改为读取真实进度并尽力完成可自动化的部分。
 *   - PunchCard(升级活动) 为每月活动，含若干子任务，每 24h 可打 1 枚印章。
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

// 读取连续打卡三路真实进度
async function getStreakStatus(page) {
  await page.goto('https://rewards.bing.com/earn?section=streaks', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(5000);
  const txt = await page.evaluate(() => document.body ? document.body.innerText : '');
  function grab(re) { const m = txt.match(re); return m ? `${m[1]}/${m[2]}` : '?'; }
  return {
    search: grab(/必应搜索连续打卡[\s\S]*?搜索:\s*(\d+)\s*\/\s*(\d+)/),
    activity: grab(/每日连续打卡活动[\s\S]*?活动:\s*(\d+)\s*\/\s*(\d+)/),
    app: grab(/必应应用连续打卡[\s\S]*?签到:\s*(\d+)\s*\/\s*(\d+)/),
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
  const before = await page.evaluate(() => { const m = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)\s*个任务/); return m ? `${m[1]}/${m[2]}` : '?'; });

  // 2) 点击首个未完成的子任务链接。
  //    子任务链接特征: href 指向 bing.com/search，卡片文本含 "点击完成" (aria-label 在 RSC 下不稳定，故用可见文本判定)
  //    注意: 改版后 PunchCard 限制每 24h 仅可打 1 枚印章，其余子任务当日锁定。
  let clicked = null;
  try {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('a')].some(a =>
        (a.getAttribute('href') || '').includes('bing.com/search') &&
        (a.textContent || '').includes('点击完成'));
    }, { timeout: 15000 });
    clicked = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')].filter(a =>
        (a.getAttribute('href') || '').includes('bing.com/search') &&
        (a.textContent || '').includes('点击完成'));
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
    let m = txt.match(/(\d+)\s*\/\s*(\d+)\s*个任务/);
    if (!m) m = txt.match(/(\d+)\s*\/\s*(\d+)/);
    return { status: m ? `${m[1]}/${m[2]}` : '?', raw: txt.replace(/\s+/g, ' ').match(/状态[:：]?\s*\d+\s*\/\s*\d+\s*个任务/) || txt.replace(/\s+/g, ' ').slice(0, 200) };
  });
  const after = afterInfo.status;

  return { ok: true, reason: '', before, after, clicked, raw: afterInfo.raw };
}

// 每日活动 (尽力): 完成每日任务集，喂饱"连续打卡-活动"进度
async function doDailySet(page) {
  await page.goto('https://rewards.bing.com/earn', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  // 展开"显示更多"
  try {
    const more = page.locator('button, [role="button"]').filter({ hasText: '显示更多' });
    if (await more.count() > 0) { await more.first().click({ timeout: 4000 }); await sleep(3000); }
  } catch (e) {}
  // 收集所有 /earn/quest/ 非 punchcard/onboarding 的 offer 链接
  const offers = await page.evaluate(() => {
    const nav = /首页|兑换|关于|邀请|更多活动|在 X|订单|常见|最佳|兑换促销|网站|必应\b|Xbox|关于 Microsoft|公司|隐私|使用条款|简体|反馈|关注积分/;
    const links = [...document.querySelectorAll('a[href*="/earn/quest/"]')];
    const out = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const t = (a.innerText || '').trim();
      if (/punchcard|onboarding/.test(href)) continue;
      if (nav.test(t)) continue;
      if (t && t.length < 40) out.push({ href: 'https://rewards.bing.com' + href, text: t });
    }
    return out.slice(0, 6);
  });
  if (offers.length === 0) return { ok: false, reason: '未发现可自动化的每日活动(可能已完成或由RSC动态加载)', completed: 0 };

  let completed = 0;
  const detail = [];
  for (const o of offers) {
    try {
      await page.goto(o.href, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      // 通用完成: 选择题点第一个选项并提交；投票点第一个选项；浏览则停留
      const did = await page.evaluate(() => {
        // 单选/多选
        const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
        if (radios.length) { try { radios[0].click(); } catch (e) {} }
        // 提交按钮
        const btns = [...document.querySelectorAll('button, [role="button"]')];
        const submit = btns.find(b => /提交|完成|确认|下一|开始|继续|参与|领取/.test(b.innerText || ''));
        if (submit) { try { submit.click(); return true; } catch (e) {} }
        return radios.length > 0 || btns.length > 0;
      });
      await sleep(2000);
      completed++;
      detail.push(o.text + (did ? '(已尝试)' : '(无交互)'));
    } catch (e) { detail.push(o.text + '(失败:' + e.message.slice(0, 20) + ')'); }
  }
  return { ok: true, completed, detail };
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
  const result = { streak: null, punchcard: null, dailySet: null };

  try {
    // 1) 连续打卡状态
    console.log(`  ${sym.info} 读取连续打卡状态...`);
    try { result.streak = await getStreakStatus(page); console.log(`  ${sym.ok} 连续打卡: 搜索 ${result.streak.search} | 活动 ${result.streak.activity} | 应用 ${result.streak.app}`); }
    catch (e) { console.log(`  ${sym.err} 读取连续打卡失败: ${e.message}`); }

    // 2) 升级任务 (PunchCard)
    console.log(`  ${sym.info} 执行升级任务(PunchCard)...`);
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

    // 3) 每日活动 (尽力)
    console.log(`  ${sym.info} 尝试每日活动(连续打卡-活动进度)...`);
    try {
      result.dailySet = await doDailySet(page);
      if (result.dailySet.ok) console.log(`  ${sym.ok} 每日活动: 完成 ${result.dailySet.completed} 项 ${result.dailySet.detail ? '(' + result.dailySet.detail.join(', ') + ')' : ''}`);
      else console.log(`  ${sym.warn} 每日活动: ${result.dailySet.reason}`);
    } catch (e) { console.log(`  ${sym.err} 每日活动出错: ${e.message}`); }
  } catch (e) {
    console.log(`  ${sym.err} 浏览器任务总出错: ${e.message}`);
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
    if (browserResult.streak) {
      const s = browserResult.streak;
      lines.push(`🔥 连续打卡:  搜索 ${s.search} | 活动 ${s.activity} | 应用 ${s.app}`);
    } else {
      lines.push(`🔥 连续打卡:  ${sym.warn} 读取失败`);
    }
    if (browserResult.punchcard && browserResult.punchcard.ok) {
      lines.push(`⭐ 升级任务:  ${browserResult.punchcard.before} → ${browserResult.punchcard.after} (${browserResult.punchcard.clicked})`);
    } else if (browserResult.punchcard) {
      lines.push(`⭐ 升级任务:  ${browserResult.punchcard.reason || sym.warn + ' 未完成'}`);
    } else {
      lines.push(`⭐ 升级任务:  ${sym.warn} 未执行`);
    }
    if (browserResult.dailySet) {
      lines.push(`📋 每日活动:  ${browserResult.dailySet.ok ? '完成 ' + browserResult.dailySet.completed + ' 项' : (browserResult.dailySet.reason || '未执行')}`);
    }
  } else {
    lines.push(`🔥 连续打卡:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
    lines.push(`⭐ 升级任务:  ${SKIP_BROWSER ? '已跳过' : sym.warn + ' 浏览器不可用'}`);
  }
  if (pc.lastBalance !== null) lines.push(`💰 当前积分: ${pc.lastBalance}`);
  card(lines, C.blue);
  console.log(`\n${sym.star} 提示: 搜索积分已通过 cn.bing.com 实时计入，几分钟后到 rewards.bing.com 查看余额`);
}

main().catch(e => {
  console.error(`${sym.err} 致命错误:`, e);
  process.exit(1);
});
