#!/usr/bin/env python3
# 用法: 青龙添加任务 task xiaoxishi.py  或  xxs_openid='oId1&oId2' python3 xiaoxishi.py
#
# 配置 (青龙环境变量):
#   xxs_openid  可选(兜底)  手动填写业务 openid; 多账号用 & 或换行分隔。
#   wx_server_url / wx_auth - WCS 服务配置（自动获取 wx.login code）
#   wx_opinion / WECHAT_ACCOUNTS - WCS openid（用于 /wx/code）
#   xxs_greedy  可选  =1 顶满每日上限; 不设则默认佛系。
#   xxs_fast    可选  =1 极速顶满(仅测试)。
#   PLUSPLUS_TOKEN 可选  PushPlus 推送 token。
#
# WCS 适配说明:
#   脚本通过 WCS /wx/code 获取 wx.login code，
#   再调用 shortvideo.yjypjy.top/api/user/getOpenid 换取业务 openid。
#   业务 openid 缓存在 xxs_user_cache.json，失效后自动刷新。
#   如 WCS 不可用，回退到手动 xxs_openid 环境变量。

import os
import sys
import time
import json
import random
import hashlib
import ssl
import urllib.request
import urllib.parse
from datetime import datetime

# ========== WCS 配置 ==========
WCS_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WCS_AUTH = os.getenv("wx_auth", "976dc5b3977cd2cbb8c61ddd32e9f885")
XXS_APPID = "wx79afcb5f28a0feb8"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
USER_CACHE_FILE = os.path.join(SCRIPT_DIR, "xxs_user_cache.json")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

VIDEOAIP = "https://videoaip.wentuyun.com"
WEBURL = "https://shortvideo.wentuyun.com"
LOGIN_URL = "https://shortvideo.yjypjy.top/api/user/getOpenid"

# 开关
SIGN_ENABLE = True
VIDEO_ENABLE = True
AD_ENABLE = True
CHECKIN_ENABLE = True
EXCHANGE_ENABLE = True

# 安全上限
VIDEO_DAILY_CAP = 30000
VIDEO_MAX_ROUNDS = 90
AD_MAX_ROUNDS = 30
AD_FAST_GAP = (6, 12)
AD_COOLDOWN_FALLBACK = 180

# 运行模式
FAST = os.environ.get("xxs_fast") == "1"
GREEDY = os.environ.get("xxs_greedy") == "1"
HUMANIZE = not FAST
CASUAL = not FAST and not GREEDY
START_JITTER = (5, 180)
VIDEO_WAIT = (10, 45)
AD_WATCH = (8, 30)
TASK_GAP = (20, 75)
ACCOUNT_GAP = (30, 120)
DAY_DELAY_MAX = 2400
SKIP_DAY_CHANCE = 0.18
SKIP_TASK_CHANCE = 0.15
VIDEO_TARGET_RATIO = (0.4, 0.75)
AD_TARGET_COUNT = (3, 9)

UA_POOL = [
    "Mozilla/5.0 (Linux; Android 13; PFEM10 Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5075 MMWEBSDK/20230701 MMWEBID/8888 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.211019.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 Mobile Safari/537.36 XWEB/4317 MMWEBSDK/20221011 MMWEBID/3456 MicroMessenger/8.0.30.2244(0x28001E34) WeChat/arm64 Weixin NetType/4G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2f) NetType/WIFI Language/zh_CN miniProgram/wx79afcb5f28a0feb8",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.34(0x18002234) NetType/4G Language/zh_CN miniProgram/wx79afcb5f28a0feb8",
]


def mask(s):
    return s[:6] + "****" + s[-4:] if len(s) > 10 else "****"


def pick_ua(openid):
    h = int(hashlib.md5(openid.encode()).hexdigest(), 16)
    return UA_POOL[h % len(UA_POOL)]


def log(m):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {m}", flush=True)


def req(method, url, openid, body=None):
    headers = {
        "User-Agent": pick_ua(openid),
        "content-type": "application/json",
        "xweb_xhr": "1",
        "referer": "https://servicewechat.com/%s/page-frame.html" % XXS_APPID,
        "accept": "*/*",
    }
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=20, context=CTX) as resp:
        return json.loads(resp.read().decode())


def get(path, openid, base=VIDEOAIP, **params):
    params["openid"] = openid
    return req("GET", base + path + "?" + urllib.parse.urlencode(params), openid)


def post(path, openid, **body):
    body["openid"] = openid
    return req("POST", VIDEOAIP + path, openid, body)


# ========== 推送 ==========
def push(title, content):
    token = os.getenv("PLUSPLUS_TOKEN", "")
    if not token:
        return
    try:
        body = json.dumps({
            "token": token, "title": title,
            "content": content, "template": "txt"
        }).encode()
        req_push = urllib.request.Request("http://www.pushplus.plus/send", data=body, method="POST")
        req_push.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req_push, timeout=15, context=CTX)
        r = json.loads(resp.read())
        if r.get("code") == 200:
            log("PushPlus 推送成功")
        else:
            log(f"PushPlus 推送失败: {r.get('msg', '')}")
    except Exception as e:
        log(f"推送异常: {e}")


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
    """通过 WCS 获取 wx.login code"""
    body = json.dumps({"appid": XXS_APPID, "openid": wcs_openid}).encode()
    req_wcs = urllib.request.Request(f"{WCS_URL}/wx/code", data=body, method="POST")
    req_wcs.add_header("AUTH", WCS_AUTH)
    req_wcs.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(req_wcs, timeout=15, context=CTX)
    result = json.loads(resp.read())
    code = result.get("data", {}).get("code", "")
    if not code:
        raise Exception(f"WCS 未返回 code: {result}")
    return code


def get_business_openid(wx_code):
    """用 wx.login code 换取业务 openid"""
    req_login = urllib.request.Request(f"{LOGIN_URL}?code={wx_code}&pid=0")
    req_login.add_header("User-Agent", UA_POOL[0])
    resp = urllib.request.urlopen(req_login, timeout=15, context=CTX)
    result = json.loads(resp.read())
    if result.get("code") != 1:
        raise Exception(f"getOpenid 失败: {result.get('msg', '')}")
    data = result.get("data", {})
    biz_openid = data.get("openid", "")
    if not biz_openid:
        raise Exception(f"未返回 openid: {result}")
    return biz_openid, data


def refresh_business_openid(wcs_openid):
    """通过 WCS 刷新业务 openid 并缓存"""
    log(f"通过 WCS 获取 wx.login code...")
    code = get_wx_code(wcs_openid)
    log(f"用 code 换取业务 openid...")
    biz_openid, data = get_business_openid(code)
    cache = read_user_cache()
    cache[wcs_openid] = {
        "biz_openid": biz_openid,
        "uid": data.get("userinfo", {}).get("id"),
        "ts": time.time(),
    }
    write_user_cache(cache)
    log(f"业务 openid 已缓存: {mask(biz_openid)}")
    return biz_openid


def load_openids():
    """加载业务 openid 列表：优先缓存，缓存失效走 WCS，WCS 不可用回退手动"""
    # 1. 读取 WCS openid 列表
    wcs_openids_raw = os.getenv("wx_opinion", "")
    if not wcs_openids_raw:
        wcs_openids_raw = os.getenv("WECHAT_ACCOUNTS", "")
    wcs_openids = [x.strip() for x in wcs_openids_raw.replace("\n", "&").split("&") if x.strip()]

    cache = read_user_cache()
    result = []
    wcs_ok = bool(os.getenv("wx_server_url"))

    for wcs_oid in wcs_openids:
        cached = cache.get(wcs_oid, {})
        biz_oid = cached.get("biz_openid", "")
        ts = cached.get("ts", 0)
        # 缓存 24 小时有效
        if biz_oid and time.time() - ts < 86400:
            log(f"使用缓存业务 openid: {mask(biz_oid)}")
            result.append(biz_oid)
            continue
        if wcs_ok:
            try:
                biz_oid = refresh_business_openid(wcs_oid)
                result.append(biz_oid)
            except Exception as e:
                log(f"WCS 刷新失败 ({mask(wcs_oid)}): {e}")
        else:
            log(f"WCS 未配置，跳过 {mask(wcs_oid)}")

    # 2. 如果 WCS 没有结果，回退到手动 xxs_openid
    if not result:
        manual_raw = os.getenv("xxs_openid", "").strip()
        if manual_raw:
            manual_ids = [x.strip() for x in manual_raw.replace("\n", "&").split("&") if x.strip()]
            log(f"使用手动 xxs_openid: {len(manual_ids)} 个账号")
            result.extend(manual_ids)

    if not result:
        log("无可用账号（WCS 和 xxs_openid 均未配置）")
        sys.exit(1)

    return result


def get_user(openid):
    u = get("/api/Newvideo/findUerByOpenid", openid, base=WEBURL)
    return u.get("id"), u.get("coins", "?")


def task_sign(openid):
    if not SIGN_ENABLE:
        return
    j = get("/api/SignTask/signBefore", openid)
    if j.get("data", {}).get("daySignStatus"):
        log("  [签到] 今日已签到")
        return
    j = get("/api/SignTask/signOn", openid)
    if j.get("code") == 1:
        coin = j.get("data", {}).get("data", {}).get("coin", "?")
        log("  [签到] 签到成功 +%s 金币" % coin)
    else:
        log("  [签到] 失败: %s" % j.get("msg"))


def video_cap(openid):
    try:
        j = get("/api/video/everyDayVideoCoins", openid)
        return j.get("data", {}).get("allCoinsDay") or VIDEO_DAILY_CAP
    except Exception:
        return VIDEO_DAILY_CAP


def task_video(openid):
    if not VIDEO_ENABLE:
        return
    cap = video_cap(openid)
    target = int(cap * random.uniform(*VIDEO_TARGET_RATIO)) if CASUAL else cap
    j = post("/api/video/getCoinData", openid)
    if j.get("code") != 1:
        log("  [视频] 获取配置失败: %s" % j.get("msg"))
        return
    task = j["data"]["task"]
    cfg = j["data"]["videoCoins"]
    got = 0
    seen = set()
    for _ in range(VIDEO_MAX_ROUNDS):
        item = cfg.get(str(task))
        if not item:
            log("  [视频] 所有档位已完成")
            break
        if task in seen:
            break
        seen.add(task)
        if HUMANIZE:
            time.sleep(min(item.get("time", 0), random.uniform(*VIDEO_WAIT)))
            if random.random() < 0.12:
                time.sleep(random.uniform(20, 90))
        r = post("/api/video/videoCoinsEnd", openid, task=task, coins=item["coins"])
        if r.get("code") != 1:
            log("  [视频] 第%s档停止: %s" % (task, r.get("msg")))
            break
        d = r["data"]
        got += d.get("coins", item["coins"])
        nt = d.get("next_task")
        if got >= target:
            log(
                "  [视频] 今日已领 %s(目标 %s/上限 %s)" % (got, target, cap)
                if CASUAL
                else "  [视频] 已达每日上限 %s" % cap
            )
            break
        if not nt or nt == task:
            log("  [视频] 无下一档,完成")
            break
        task = nt
        if not HUMANIZE:
            time.sleep(random.uniform(0.8, 2.2))
    log("  [视频] 本次共领 %s 金币" % got)


def task_ad(openid):
    if not AD_ENABLE:
        return
    pre = (get("/api/ad/adLookBefore", openid).get("data") or {}).get("data") or [0, 0, 0]
    cooldown = pre[0] or AD_COOLDOWN_FALLBACK
    if pre[0] == 0:
        log("  [广告] 暂无广告(可能已达每日上限)")
        return
    ad_target = random.randint(*AD_TARGET_COUNT) if CASUAL else AD_MAX_ROUNDS
    got = 0
    rounds = 0
    slow = False
    while rounds < ad_target:
        if HUMANIZE:
            time.sleep(random.uniform(*AD_WATCH))
        r = get("/api/ad/adSuccess", openid)
        inner = r.get("data") if isinstance(r.get("data"), dict) else {}
        if r.get("code") == 1 and inner.get("code") == 1:
            d = inner.get("data") or [cooldown, 0, 0]
            coins = d[1] if len(d) > 1 else 0
            got += coins
            rounds += 1
            log("  [广告] 第%d次 +%s 金币(累计 %s)" % (rounds, coins, got))
            if not d or d[0] == 0:
                log("  [广告] 服务端无更多广告,完成")
                break
            cd = d[0] or cooldown
            if HUMANIZE:
                time.sleep(cd + random.uniform(1, 8))
            else:
                time.sleep(
                    (cooldown if slow else random.uniform(*AD_FAST_GAP))
                    + random.uniform(1, 4)
                )
        else:
            m = inner.get("msg") or r.get("msg")
            if not slow:
                log("  [广告] 被限制(%s),切到 %ds 冷却节奏重试" % (m, cooldown))
                slow = True
                time.sleep(cooldown + random.uniform(1, 5))
                continue
            log("  [广告] 第%d次后停止: %s(可能达每日上限)" % (rounds, m))
            break
    log("  [广告] 本次共领 %s 金币(%d 次)" % (got, rounds))


def task_checkin(openid, uid):
    if not CHECKIN_ENABLE:
        return
    j = get("/api/Activity/signActivityConfig", openid)
    d1 = j.get("data") or {}
    cfg = d1.get("data") if isinstance(d1.get("data"), dict) else d1
    aid = cfg.get("activityId") or 0
    state = cfg.get("activityState")
    if not aid:
        log(
            "  [打卡] 未发现进行中活动(state=%s)。若你已选过礼品,把下面这行发我即可修正:" % state
        )
        log("  [打卡][诊断] %s" % json.dumps(j, ensure_ascii=False)[:400])
        return
    r = post("/api/activity/activityOn", openid, id=str(aid))
    if r.get("code") != 1:
        log("  [打卡] 活动%s 获取任务失败: %s" % (aid, r.get("msg")))
        return
    tasks = r.get("data", {}).get("activityDayTask") or []
    if not tasks:
        log("  [打卡] 活动%s 今日无待打卡任务(可能已完成)" % aid)
        return
    done = 0
    skipped = 0
    for t in tasks:
        if t.get("state") != 0:
            continue
        if t.get("type") != "sign":
            skipped += 1
            continue
        e = post(
            "/api/activity/taskEnd",
            openid,
            id=t["id"],
            user_id=t.get("user_id", uid),
            type=t["type"],
            createday=t["createday"],
            activity_id=t["activity_id"],
        )
        if e.get("code") == 1:
            done += 1
    extra = (",另有 %d 个需看广告的子任务未做" % skipped) if skipped else ""
    log(
        "  [打卡] 活动%s 完成 %d 个打卡%s" % (aid, done, extra)
        if done
        else "  [打卡] 活动%s 今日已打卡或无可打卡任务%s" % (aid, extra)
    )


def task_exchange(openid):
    if not EXCHANGE_ENABLE:
        return
    _, coins = get_user(openid)
    try:
        c = int(coins)
    except (TypeError, ValueError):
        log("  [兑换] 余额无法解析(%s),跳过" % coins)
        return
    if c < 100:
        log("  [兑换] 余额 %s < 100,不兑换" % c)
        return
    r = post("/api/record/exchange", openid, coin=str(c))
    inner = r.get("data") if isinstance(r.get("data"), dict) else {}
    if r.get("code") == 1 and inner.get("code") == 1:
        d = inner.get("data") or {}
        log(
            "  [兑换] 兑出 %s 金币 -> +%s 元,余 %s 金币,账户余额 %s 元"
            % (d.get("coin_change"), d.get("pay_money_increase"), d.get("coins_after"), d.get("money_after"))
        )
    else:
        log("  [兑换] 失败: %s" % (inner.get("msg") or r.get("msg")))


def run_account(openid):
    tag = mask(openid)
    try:
        uid, coins = get_user(openid)
    except Exception as e:
        log("[%s] 获取用户失败,跳过: %s" % (tag, e))
        return
    if not uid:
        log("[%s] openid 无效(查不到用户),跳过" % tag)
        return
    log("[%s] uid=%s 当前金币=%s" % (tag, uid, coins))
    if CASUAL and random.random() < SKIP_DAY_CHANCE:
        log("  [佛系] 今日随机跳过该账号")
        return
    if HUMANIZE:
        jit = random.uniform(*START_JITTER)
        log("  [拟人化] 延迟 %.0fs 后开始" % jit)
        time.sleep(jit)
    earn = [
        (lambda: task_video(openid), "视频"),
        (lambda: task_ad(openid), "广告"),
        (lambda: task_checkin(openid, uid), "打卡"),
    ]
    random.shuffle(earn)
    seq = (
        [(lambda: task_sign(openid), "签到")]
        + earn
        + [(lambda: task_exchange(openid), "兑换")]
    )
    for i, (fn, name) in enumerate(seq):
        if (
            CASUAL
            and name in ("视频", "广告", "打卡")
            and random.random() < SKIP_TASK_CHANCE
        ):
            log("  [佛系] 今日跳过「%s」" % name)
            continue
        try:
            fn()
        except Exception as e:
            log("  [%s] 异常跳过: %s" % (name, e))
        if HUMANIZE and i < len(seq) - 1:
            time.sleep(random.uniform(*TASK_GAP))


def main():
    if FAST:
        mode = "极速顶满(xxs_fast=1,仅测试,会被审计)"
    elif GREEDY:
        mode = "拟人顶满(xxs_greedy=1,单账号约 1 小时+,顶满有画像风险)"
    else:
        mode = "佛系(随机少拿/漏天/随机时段,机器画像最低)"

    openids = load_openids()
    log("小喜柿任务开始,共 %d 个账号,模式: %s" % (len(openids), mode))

    if CASUAL and DAY_DELAY_MAX > 0:
        dd = random.uniform(0, DAY_DELAY_MAX)
        log("[佛系] 本次整体延迟 %.1f 分钟后开始(打散执行时段)" % (dd / 60))
        time.sleep(dd)

    results = []
    for idx, openid in enumerate(openids):
        log("=" * 32)
        log("账号 %d/%d" % (idx + 1, len(openids)))
        tag = mask(openid)
        try:
            run_account(openid)
            results.append(f"  {tag}: 执行完成")
        except Exception as e:
            log(f"[{tag}] 执行异常: {e}")
            results.append(f"  {tag}: 异常 - {e}")
        if idx < len(openids) - 1:
            time.sleep(
                random.uniform(*ACCOUNT_GAP) if HUMANIZE else random.uniform(5, 15)
            )

    log("=" * 32)
    log("全部账号执行完毕")

    # 推送结果
    if os.getenv("PLUSPLUS_TOKEN"):
        msg = f"小喜柿任务执行完毕\n模式: {mode}\n账号数: {len(openids)}\n\n" + "\n".join(results)
        push("小喜柿任务", msg)


if __name__ == "__main__":
    main()
