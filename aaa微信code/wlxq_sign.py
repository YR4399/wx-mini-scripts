#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
玩星矿 (wlxq.kangbaide.com) 签到脚本
- 环境变量: WLXQ_TOKEN (JWT token, 多账号用 & 分隔)
- 流程: details(查收益) -> signIninfo(签到信息) -> signIn(签到) -> machaoprice(查价) -> lingqu(领取)
- JWT 有效期约 1 年, 无需短信登录; token 失效才需重新抓包
- cron: 30 9 * * *
new Env('玩星矿签到')
"""
import os, sys, json, time, re
from datetime import datetime
import urllib.request, urllib.error, ssl

BASE = "https://wlxq.kangbaide.com/api"
UA = "Dart/3.10 (dart:io)"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

def push(title, content):
    token = os.getenv("PLUSPLUS_TOKEN") or os.getenv("PUSH_PLUS_TOKEN")
    if not token:
        log(f"[Push] {title}: {content[:100]}")
        return
    try:
        data = json.dumps({"token": token, "title": title, "content": content}).encode()
        req = urllib.request.Request("https://www.pushplus.plus/send", data=data,
                                     headers={"Content-Type": "application/json"}, method="POST")
        resp = urllib.request.urlopen(req, timeout=15)
        log(f"[Push] 发送: {resp.status}")
    except Exception as e:
        log(f"[Push] 失败: {e}")

def api_call(method, path, token, payload=None, retries=3):
    """调用接口, 网络错误退避重试 3 次"""
    url = f"{BASE}{path}"
    if method == "GET":
        url = f"{url}?denseStatus=0" if "?" not in url else f"{url}&denseStatus=0"
    headers = {
        "User-Agent": UA,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    last = None
    for i in range(retries):
        try:
            data = json.dumps(payload or {"denseStatus": "0"}).encode() if payload is not None else None
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            resp = urllib.request.urlopen(req, timeout=20, context=CTX)
            return json.loads(resp.read().decode())
        except Exception as e:
            last = e
            if i < retries - 1:
                log(f"  [retry] {path} 网络异常({e.__class__.__name__}), {i+1}s 后重试 {i+1}/{retries}")
                time.sleep(i + 1)
    return {"code": -1, "msg": str(last), "data": None}

def mask_phone(phone):
    return phone[:3] + "****" + phone[-4:] if len(phone) >= 7 else phone

def run_account(token, idx, total):
    log(f"\n========== 账号 [{idx}/{total}] ==========")
    # 1. 用户详情
    d = api_call("GET", "/user/details", token)
    if d.get("code") != 200 or not d.get("data"):
        log(f"[失败] details: {d.get('msg')}")
        return False
    u = d["data"]
    phone = str(u.get("phone", ""))
    log(f"👤 {mask_phone(phone)} | {u.get('dengji','')} | 总收益: {u.get('shouyizong','0')} | 余额: {u.get('shouyi2','0')}")
    time.sleep(1)

    # 2. 签到/看广告信息
    si = api_call("POST", "/user/signIninfo", token)
    jindu = "0/5"
    if si.get("code") == 200 and si.get("data"):
        data = si["data"]
        jindu = str(data.get("jindu", "0/5"))
        log(f"📊 看广告进度: {jindu} | {data.get('mark','')} | 幸运星: {data.get('xingkuang')}")
    else:
        log(f"[签到信息] {si.get('msg')}")
    time.sleep(1)

    # 3. 看广告(签到): signIn 每次成功 = 广告+1, 间隔约20s(服务端"请先看完广告"限制)
    #    满 5/5 后 mark 变"每晚12点后结算收益"
    total = int(jindu.split("/")[-1]) if "/" in jindu else 5
    watched = int(jindu.split("/")[0]) if "/" in jindu else 0
    if watched >= total:
        log("✅ 今日看广告已满 5/5")
    else:
        log(f"▶️ 开始看广告 ({watched}/{total} -> {total}/{total})...")
        ok = 0
        time_locked = False  # 00:30 前不可看广告
        for i in range(total * 2):
            s = api_call("POST", "/user/signIn", token)
            if s.get("code") == 200:
                ok += 1
                log(f"  [广告 {watched + ok}/{total}] ✅ 观看成功")
                if watched + ok >= total:
                    break
            else:
                msg = str(s.get("msg", ""))
                log(f"  [广告] ⏳ {msg}")
                if "00:30" in msg or "00:30" in msg or "才可以看广告" in msg:
                    time_locked = True
                    log("⚠️ 今日看广告时间未到（00:30 后开放），跳过剩余")
                    break
            time.sleep(20)  # 服务端广告时长窗口
        log(f"📊 看广告完成: {ok} 次" + ("（时间未到跳过）" if time_locked else ""))
    time.sleep(1)

    # 4. 查价格
    mp = api_call("POST", "/user/machaoprice", token)
    if mp.get("code") == 200 and mp.get("data"):
        m = mp["data"]
        log(f"💹 价格: {m.get('jiage1')}({m.get('baifenbi1')}) / {m.get('jiage2')}({m.get('baifenbi2')})")
    else:
        log(f"[查价] {mp.get('msg')}")
    time.sleep(1)

    # 5. 领取
    lq = api_call("POST", "/user/lingqu", token)
    if lq.get("code") == 200:
        log(f"🎁 领取成功")
    else:
        log(f"[领取] {lq.get('msg')}")

    return True

def main():
    log("=" * 48)
    log("玩星矿 - 每日签到")
    tokens_raw = os.getenv("WLXQ_TOKEN", "").strip()
    if not tokens_raw:
        log("[错误] 未配置 WLXQ_TOKEN (JWT token, 多账号 & 分隔)")
        sys.exit(1)
    tokens = [t.strip() for t in re.split(r"[&\n]", tokens_raw) if t.strip()]
    log(f"共 {len(tokens)} 个账号\n")

    results = []
    for i, token in enumerate(tokens, 1):
        try:
            ok = run_account(token, i, len(tokens))
            results.append(("✅" if ok else "❌"))
        except Exception as e:
            log(f"[账号{i} 异常] {e}")
            results.append("❌")
        time.sleep(2)

    log("\n" + "=" * 48)
    log(f"完成: {' '.join(results)} ({sum(1 for r in results if '✅' in r)}/{len(results)} 成功)")
    push("玩星矿签到", f"账号 {len(results)} 个\n{' '.join(results)}\n成功 {sum(1 for r in results if '✅' in r)}/{len(results)}")

if __name__ == "__main__":
    main()
