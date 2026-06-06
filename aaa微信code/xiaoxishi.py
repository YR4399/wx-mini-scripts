#!/usr/bin/env python3
# @Description: 小喜柿 签到/视频/广告/打卡/兑换
# cron: 30 6 * * *
#
# 配置 (环境变量):
#   wx_server_url / wx_auth - WCS 服务配置（自动获取业务 openid）
#   wx_opinion / WECHAT_ACCOUNTS - WCS openid
#   xxs_openid  可选(兜底)  手动填写业务 openid; 多账号用 & 或换行分隔。
#
# WCS 适配:
#   WCS /wx/code → shortvideo.yjypjy.top/api/user/getOpenid → 业务 openid
#   业务 openid 缓存在 xxs_user_cache.json，24h 失效后自动刷新。
#
# 并发: 多账号通过 ThreadPoolExecutor 并行执行，max_workers=3。

import os
import sys
import time
import json
import random
import hashlib
import urllib.request
import urllib.parse
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed

# ========== WCS 配置 ==========
WCS_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WCS_AUTH = os.getenv("wx_auth", "976dc5b3977cd2cbb8c61ddd32e9f885")
XXS_APPID = "wx79afcb5f28a0feb8"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
USER_CACHE_FILE = os.path.join(SCRIPT_DIR, "xxs_user_cache.json")
LOGIN_URL = "https://shortvideo.yjypjy.top/api/user/getOpenid"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

VIDEOAIP = "https://videoaip.wentuyun.com"
WEBURL = "https://shortvideo.wentuyun.com"

VIDEO_MAX_ROUNDS = 53
AD_MAX_ROUNDS = 35

UA_POOL = [
    "Mozilla/5.0 (Linux; Android 13; PFEM10 Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5075 MMWEBSDK/20230701 MMWEBID/8888 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.211019.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 Mobile Safari/537.36 XWEB/4317 MMWEBSDK/20221011 MMWEBID/3456 MicroMessenger/8.0.30.2244(0x28001E34) WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2f) NetType/WIFI Language/zh_CN",
]


def mask(s):
    return s[:6] + "****" + s[-4:] if len(s) > 10 else "****"


def pick_ua(openid):
    return UA_POOL[int(hashlib.md5(openid.encode()).hexdigest(), 16) % len(UA_POOL)]


def req(method, url, openid, body=None):
    headers = {"User-Agent": pick_ua(openid)}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=20) as resp:
        return json.loads(resp.read().decode())


def get(path, openid, base=VIDEOAIP, **params):
    params["openid"] = openid
    return req("GET", base + path + "?" + urllib.parse.urlencode(params), openid)


def post(path, openid, **body):
    body["openid"] = openid
    return req("POST", VIDEOAIP + path, openid, body)


def log(m):
    print(m, flush=True)


def err(m):
    print(m, file=sys.stderr, flush=True)


# ========== WCS 业务 openid 获取 ==========
def read_user_cache():
    try:
        if os.path.exists(USER_CACHE_FILE):
            with open(USER_CACHE_FILE, "r") as f:
                return json.load(f)
    except:
        pass
    return {}


def write_user_cache(cache):
    with open(USER_CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def get_wx_code(wcs_openid):
    body = json.dumps({"appid": XXS_APPID, "openid": wcs_openid}).encode()
    r = urllib.request.Request(f"{WCS_URL}/wx/code", data=body, method="POST")
    r.add_header("AUTH", WCS_AUTH)
    r.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(r, timeout=15, context=CTX)
    result = json.loads(resp.read())
    code = result.get("data", {}).get("code", "")
    if not code:
        raise Exception(f"WCS 未返回 code: {result}")
    return code


def get_business_openid(wx_code):
    r = urllib.request.Request(f"{LOGIN_URL}?code={wx_code}&pid=0")
    r.add_header("User-Agent", UA_POOL[0])
    resp = urllib.request.urlopen(r, timeout=15, context=CTX)
    result = json.loads(resp.read())
    if result.get("code") != 1:
        raise Exception(f"getOpenid 失败: {result.get('msg', '')}")
    biz_openid = result.get("data", {}).get("openid", "")
    if not biz_openid:
        raise Exception(f"未返回 openid: {result}")
    return biz_openid


def refresh_business_openid(wcs_openid):
    log(f"  WCS 获取 wx.login code...")
    code = get_wx_code(wcs_openid)
    log(f"  用 code 换取业务 openid...")
    biz_openid = get_business_openid(code)
    cache = read_user_cache()
    cache[wcs_openid] = {"biz_openid": biz_openid, "ts": time.time()}
    write_user_cache(cache)
    log(f"  业务 openid 已缓存: {mask(biz_openid)}")
    return biz_openid


def load_openids():
    wcs_raw = os.getenv("wx_opinion", "")
    if not wcs_raw:
        wcs_raw = os.getenv("WECHAT_ACCOUNTS", "")
    wcs_ids = [x.strip() for x in wcs_raw.replace("\n", "&").split("&") if x.strip()]

    cache = read_user_cache()
    wcs_ok = bool(os.getenv("wx_server_url"))
    result = []

    for wcs_oid in wcs_ids:
        cached = cache.get(wcs_oid, {})
        biz = cached.get("biz_openid", "")
        ts = cached.get("ts", 0)
        if biz and time.time() - ts < 86400:
            log(f"[WCS] 使用缓存: {mask(biz)}")
            result.append(biz)
            continue
        if wcs_ok:
            try:
                biz = refresh_business_openid(wcs_oid)
                result.append(biz)
            except Exception as e:
                log(f"[WCS] 刷新失败 ({mask(wcs_oid)}): {e}")
        else:
            log(f"[WCS] 未配置 wx_server_url,跳过 {mask(wcs_oid)}")

    if not result:
        manual = os.getenv("xxs_openid", "").strip()
        if manual:
            result = [x.strip() for x in manual.replace("\n", "&").split("&") if x.strip()]
            log(f"[兜底] 使用手动 xxs_openid: {len(result)} 个")

    if not result:
        err("无可用账号（WCS 和 xxs_openid 均未配置）")
        sys.exit(1)

    return result


# ========== 业务逻辑 ==========
def get_user(openid):
    u = get("/api/Newvideo/findUerByOpenid", openid, base=WEBURL)
    return u.get("id"), u.get("coins", 0)


def task_sign(openid):
    j = get("/api/SignTask/signBefore", openid)
    if j["data"].get("daySignStatus"):
        log("  [签到] 今日已签到")
        return
    r = get("/api/SignTask/signOn", openid)
    if r.get("code") == 1 and r["data"].get("code") == 1:
        log("  [签到] +%s 金币" % r["data"]["data"].get("coin"))
    else:
        log("  [签到] 失败: %s" % (r["data"].get("msg") or r.get("msg")))


def task_video(openid):
    cap = (
        get("/api/video/everyDayVideoCoins", openid)["data"].get("allCoinsDay") or 30000
    )
    j = post("/api/video/getCoinData", openid)
    if j.get("code") != 1:
        log("  [视频] 获取配置失败: %s" % j.get("msg"))
        return
    task = j["data"]["task"]
    cfg = j["data"]["videoCoins"]
    got = 0
    for _ in range(VIDEO_MAX_ROUNDS):
        item = cfg.get(str(task))
        if not item:
            log("  [视频] 所有档位已完成")
            break
        log("  [视频] 第%s档 看%ss..." % (task, item["time"]))
        time.sleep(item["time"])
        r = post("/api/video/videoCoinsEnd", openid, task=task, coins=item["coins"])
        if r.get("code") != 1:
            log("  [视频] 第%s档停止: %s" % (task, r.get("msg")))
            break
        d = r["data"]
        got += d.get("coins", item["coins"])
        cfg = d.get("coinsConfig", cfg)
        nt = d.get("next_task")
        log("  [视频] 第%s档 +%s(累计 %s)" % (task, d.get("coins", item["coins"]), got))
        if got >= cap:
            log("  [视频] 已达每日上限 %s" % cap)
            break
        if not nt or nt == task:
            log("  [视频] 无下一档,完成")
            break
        task = nt
    log("  [视频] 本次共领 %s 金币" % got)


def task_ad(openid):
    pre = (get("/api/ad/adLookBefore", openid).get("data") or {}).get("data") or [
        0, 0, 0,
    ]
    if pre[0] == 0:
        log("  [广告] 暂无广告")
        return
    got = 0
    rounds = 0
    for _ in range(AD_MAX_ROUNDS):
        r = get("/api/ad/adSuccess", openid)
        inner = r.get("data") if isinstance(r.get("data"), dict) else {}
        if not (r.get("code") == 1 and inner.get("code") == 1):
            log("  [广告] 第%d次后停止: %s" % (rounds, inner.get("msg") or r.get("msg")))
            break
        d = inner.get("data") or [0, 0, 0]
        got += d[1] if len(d) > 1 else 0
        rounds += 1
        log("  [广告] 第%d次 +%s(累计 %s)" % (rounds, d[1] if len(d) > 1 else 0, got))
        if d[0] == 0:
            log("  [广告] 服务端无更多广告,完成")
            break
        time.sleep(d[0])
    log("  [广告] 本次共领 %s 金币(%d 次)" % (got, rounds))


def task_checkin(openid, uid):
    j = get("/api/Activity/signActivityConfig", openid)
    cfg = j["data"].get("data") or {}
    aid = cfg.get("activityId")
    if not aid:
        log("  [打卡] 未发现进行中活动,需先在小程序选过礼品。诊断已发 stderr")
        err("  [打卡][诊断] %s" % json.dumps(j, ensure_ascii=False)[:400])
        return
    r = post("/api/activity/activityOn", openid, id=str(aid))
    if r.get("code") != 1:
        log("  [打卡] 活动%s 获取任务失败: %s" % (aid, r.get("msg")))
        return
    data = r["data"]
    if data.get("buttState", {}).get("buttState") in (2, 3):
        log("  [打卡] 活动%s 今日已完成" % aid)
        return
    done = 0
    skipped = 0
    for t in data.get("activityDayTask") or []:
        if t.get("state") != 0:
            continue
        if t.get("type") != "sign":
            skipped += 1
            continue
        e = post(
            "/api/activity/taskEnd", openid,
            id=t["id"], user_id=t.get("user_id", uid),
            type=t["type"], createday=t["createday"], activity_id=t["activity_id"],
        )
        if e.get("code") == 1:
            done += 1
    extra = ",另有 %d 个需看广告的子任务未做" % skipped if skipped else ""
    log("  [打卡] 活动%s 完成 %d 个打卡%s" % (aid, done, extra))


def task_exchange(openid):
    _, coins = get_user(openid)
    c = int(coins)
    if c < 100:
        log("  [兑换] 余额 %s < 100,不兑换" % c)
        return
    r = post("/api/record/exchange", openid, coin=str(c))
    inner = r.get("data") if isinstance(r.get("data"), dict) else {}
    if r.get("code") == 1 and inner.get("code") == 1:
        d = inner.get("data") or {}
        log("  [兑换] 兑出 %s 金币 -> +%s 元,余 %s 金币,账户 %s 元"
            % (d.get("coin_change"), d.get("pay_money_increase"), d.get("coins_after"), d.get("money_after")))
    else:
        log("  [兑换] 失败: %s" % (inner.get("msg") or r.get("msg")))


def run_account(openid, idx, total):
    tag = mask(openid)
    delay = random.uniform(20, 35)
    log("账号 %d/%d [%s] 延迟 %.0fs 后启动" % (idx + 1, total, tag, delay))
    time.sleep(delay)
    log("=" * 32)
    log("账号 %d/%d [%s] 开始执行" % (idx + 1, total, tag))
    try:
        uid, coins = get_user(openid)
        if not uid:
            log("[%s] openid 无效(查不到用户),跳过" % tag)
            return tag, "失败", "openid无效"
        log("[%s] uid=%s 当前金币=%s" % (tag, uid, coins))
        task_sign(openid)
        task_video(openid)
        task_ad(openid)
        task_checkin(openid, uid)
        task_exchange(openid)
        return tag, "成功", "金币=%s" % coins
    except Exception as e:
        err("[%s] 异常: %s" % (tag, e))
        return tag, "异常", str(e)


def main():
    openids = load_openids()
    log("小喜柿任务开始,共 %d 个账号,并发执行" % len(openids))

    results = []
    max_workers = min(len(openids), 3)
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(run_account, oid, idx, len(openids)): oid
            for idx, oid in enumerate(openids)
        }
        for future in as_completed(futures):
            tag, status, info = future.result()
            results.append((tag, status, info))

    log("=" * 32)
    log("全部账号执行完毕")
    for tag, status, info in results:
        log("  %s: %s (%s)" % (tag, status, info))


if __name__ == "__main__":
    main()
