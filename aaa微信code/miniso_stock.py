"""
名创优品积分商城 - 库存更新提醒
监控兑换实物商品库存，有补货时 std_report(钉钉) 推送提醒
通过 WCS 自动获取登录态，无需手动抓包
支持 code 缓存，code 失效时自动刷新

【2026-09-17 改】默认**单次运行**（查一轮即退出），由面板 cron 每 20 分钟拉起一次
（cron 已改为 5,25,45 8-22 * * *）。旧版默认 while True 常驻，叠加面板 timeout=0
（永不超时）会永久占用并发槽位：实测 9/15 08:45 起连续占用 57.5 小时，直到容器重启
才被清理，期间把后面的任务全部堵在队列里。

环境变量：
  wx_server_url / wx_auth - WCS 服务配置
  wx_opinion / wx_opinion - WCS openid
  MINISO_INTERVAL - 持续监控模式的检查间隔秒数（默认 1200，即 20 分钟）
  MINISO_LOOP    - 置 true 或命令行加 --loop，才进入持续监控模式（仅供前台调试）
  MINISO_MAX_SECONDS - 持续监控模式最长运行秒数（默认 3600，兜底防挂死）
  （推送经 std_report 双引擎，无需配置推送 token）
"""
import os
import sys
import json
import time
import hashlib
import random
import string
import urllib.request
import urllib.error
import ssl
from datetime import datetime

# ========== 配置 ==========
API_URL = "https://api-saas.miniso.com/task-manage-platform/api/virtualCoin/exchangeConfig/pageV2"
REG_URL = "https://cdn-storeexpress.miniso.com/wechat/miniapp/registrationStatus"
WCS_URL = os.getenv("wx_server_url", "http://host.docker.internal:18788")
WCS_AUTH = os.getenv("wx_auth", "976dc5b3977cd2cbb8c61ddd32e9f885")
MINISO_APPID = "wx2a212470bade49bf"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, "miniso_stock_cache.json")
USER_CACHE_FILE = os.path.join(SCRIPT_DIR, "miniso_user_cache.json")
CODE_CACHE_FILE = os.path.join(SCRIPT_DIR, "miniso_code_cache.json")
INTERVAL = int(os.getenv("MINISO_INTERVAL", "1200"))
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
              "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF "
              "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841")

# code 缓存有效期：2 小时（微信小程序 code 有效期通常 5 分钟，但 WCS 生成的 code 可复用更久）
CODE_CACHE_TTL = int(os.getenv("MINISO_CODE_TTL", "7200"))

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def rand_str(n=32):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def open_with_retry(req, timeout=15, retries=2):
    """urllib 请求带退避重试。

    容器→名创接口的 TLS 握手偶发抖动（handshake operation timed out /
    Name or service not known / 连接被重置）在日志里表现为单次失败，
    重试一次基本都能通，避免把瞬时故障记成"检查失败"。
    """
    last = None
    for i in range(retries + 1):
        try:
            return urllib.request.urlopen(req, timeout=timeout, context=CTX)
        except Exception as e:
            last = e
            if i >= retries:
                break
            wait = (i + 1) * 2
            log(f"请求异常({e})，{wait}s 后重试 {i + 1}/{retries}")
            time.sleep(wait)
    raise last


# ========== 推送 ==========
from std_report import send_push


# ========== Code 缓存 ==========
def read_code_cache():
    """读取 code 缓存"""
    try:
        if os.path.exists(CODE_CACHE_FILE):
            with open(CODE_CACHE_FILE, "r") as f:
                return json.load(f)
    except:
        pass
    return None


def write_code_cache(code, openid, appid):
    """写入 code 缓存"""
    try:
        cache = {
            "code": code,
            "openid": openid,
            "appid": appid,
            "ts": time.time(),
        }
        with open(CODE_CACHE_FILE, "w") as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        log(f"code 缓存写入失败: {e}")


def get_cached_code():
    """尝试从缓存获取有效 code"""
    cache = read_code_cache()
    if not cache or not cache.get("code"):
        return None
    if time.time() - cache.get("ts", 0) > CODE_CACHE_TTL:
        log(f"code 缓存已过期（{CODE_CACHE_TTL}s），将重新获取")
        return None
    log(f"使用缓存 code（缓存 {int(time.time() - cache.get('ts', 0))}s 前）")
    return cache["code"]


def fetch_code_from_wcs():
    """从 WCS 获取新的微信 code"""
    openids_raw = os.getenv("wx_opinion", "")
    if not openids_raw:
        openids_raw = os.getenv("wx_opinion", "")
    openids = [x.strip() for x in openids_raw.replace("\n", "&").replace("&", "\n").split("\n") if x.strip()]
    if not openids:
        raise Exception("未配置 wx_opinion 或 wx_opinion")

    openid = openids[0]
    try:
        body = json.dumps({"appid": MINISO_APPID, "openid": openid}).encode()
        req = urllib.request.Request(f"{WCS_URL}/wx/code", data=body, method="POST")
        req.add_header("AUTH", WCS_AUTH)
        req.add_header("Content-Type", "application/json")
        resp = open_with_retry(req, 15)
        result = json.loads(resp.read())
        code = result.get("data", {}).get("code", "")
        if not code:
            raise Exception(f"WCS 返回: {result}")
        # 缓存 code
        write_code_cache(code, openid, MINISO_APPID)
        log("获取微信 code 成功并缓存")
        return code
    except Exception as e:
        raise Exception(f"WCS 请求失败: {e}")


# ========== 用户信息 ==========
def get_user_info():
    """通过 WCS 获取 MINISO 用户信息，自动缓存"""
    # 先检查用户信息缓存（1小时内有效）
    try:
        if os.path.exists(USER_CACHE_FILE):
            with open(USER_CACHE_FILE, "r") as f:
                cached = json.load(f)
            if cached.get("uid") and cached.get("ts", 0) > time.time() - 3600:
                return cached
    except:
        pass

    # 获取 code：优先用缓存，失效再去 WCS 拉
    code = get_cached_code() or fetch_code_from_wcs()

    # 用 code 换取 MINISO 用户信息
    try:
        nonce = rand_str()
        ts = str(int(time.time() * 1000))
        req = urllib.request.Request(f"{REG_URL}?jsCode={code}")
        req.add_header("X-Mi-Version", "5.1.71")
        req.add_header("tenant-code", "MINISO")
        req.add_header("version", "storeexpress1.0")
        req.add_header("x-client-source", "MINISO_WX_MINI")
        req.add_header("User-Agent", USER_AGENT)
        req.add_header("nonce", nonce)
        req.add_header("signature", md5(nonce + ts))
        req.add_header("time", ts)
        resp = open_with_retry(req, 15)
        result = json.loads(resp.read())
        data = result.get("data", {})
        if not data.get("uid"):
            raise Exception(f"MINISO 返回: {result}")

        user_info = {
            "uid": data["uid"],
            "openId": data.get("openId", ""),
            "unionId": data.get("unionId", ""),
            "ts": time.time(),
        }
        with open(USER_CACHE_FILE, "w") as f:
            json.dump(user_info, f, indent=2)
        log(f"获取用户信息成功: uid={user_info['uid']}")
        return user_info
    except Exception as e:
        # code 失效/超时（401/403/invalid/1001 获取用户异常/timed out 等），清除缓存后重试一次
        msg = str(e)
        msg_lower = msg.lower()
        if ("error" in msg_lower or "invalid" in msg_lower or "401" in msg
                or "403" in msg or "1001" in msg or "获取用户" in msg
                or "timed out" in msg_lower or "timeout" in msg_lower
                or "handshake" in msg_lower or "ssl" in msg_lower):
            log("code 失效或超时（" + str(e)[:80] + "），清除缓存后重新获取...")
            try:
                os.remove(CODE_CACHE_FILE)
            except:
                pass
            code = fetch_code_from_wcs()
            try:
                nonce = rand_str()
                ts = str(int(time.time() * 1000))
                req = urllib.request.Request(f"{REG_URL}?jsCode={code}")
                req.add_header("X-Mi-Version", "5.1.71")
                req.add_header("tenant-code", "MINISO")
                req.add_header("version", "storeexpress1.0")
                req.add_header("x-client-source", "MINISO_WX_MINI")
                req.add_header("User-Agent", USER_AGENT)
                req.add_header("nonce", nonce)
                req.add_header("signature", md5(nonce + ts))
                req.add_header("time", ts)
                resp = open_with_retry(req, 15)
                result = json.loads(resp.read())
                data = result.get("data", {})
                if not data.get("uid"):
                    raise Exception(f"MINISO 返回: {result}")
                user_info = {
                    "uid": data["uid"],
                    "openId": data.get("openId", ""),
                    "unionId": data.get("unionId", ""),
                    "ts": time.time(),
                }
                with open(USER_CACHE_FILE, "w") as f:
                    json.dump(user_info, f, indent=2)
                log(f"刷新 code 后获取用户信息成功: uid={user_info['uid']}")
                return user_info
            except Exception as e2:
                raise Exception(f"刷新 code 后 MINISO 登录仍失败: {e2}")
        raise Exception(f"MINISO 登录失败: {e}")


def get_headers(uid, openid, unionid):
    nonce = rand_str()
    ts = str(int(time.time() * 1000))
    return {
        "Host": "api-saas.miniso.com",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "Referer": f"https://servicewechat.com/{MINISO_APPID}/1093/page-frame.html",
        "tenant": "MINISO",
        "tenant-code": "MINISO",
        "x-client-source": "MINISO_WX_MINI",
        "version": "storeexpress1.0",
        "X-Mi-Version": "5.1.71",
        "X-Mi-Store-Id": "ZCMX",
        "X-Mi-City": "",
        "can-flash-send": "true",
        "content-uid": str(uid),
        "content-openid": openid,
        "content-unionid": unionid,
        "content-appcode": "51",
        "content-weappcode": "52",
        "content-sceneid": "1145",
        "content-pageName": "%E9%A2%86%E5%88%B8%E6%A8%A1%E6%9D%BF",
        "content-pageType": "%E9%A2%86%E5%88%B8%E6%A8%A1%E6%9D%BF",
        "nonce": nonce,
        "signature": md5(nonce + ts),
        "time": ts,
    }


# ========== 缓存 ==========
def read_cache():
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except:
        pass
    return {}


def write_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


# ========== API ==========
def fetch_stock(user_info, page=0, page_size=12):
    """获取 type=3（实物兑换）商品列表"""
    body = json.dumps({
        "type": 3,
        "pageSize": page_size,
        "offset": page * page_size,
        "sapCode": "ZCMX",
        "memberId": user_info["uid"]
    }).encode()

    req = urllib.request.Request(API_URL, data=body, method="POST")
    for k, v in get_headers(user_info["uid"], user_info["openId"], user_info["unionId"]).items():
        req.add_header(k, v)

    resp = open_with_retry(req, 15)
    data = json.loads(resp.read())

    if not data.get("success"):
        raise Exception(f"API 返回失败: {data.get('message', '')}")

    return data.get("data", {}).get("exchanges", []), data.get("data", {}).get("hasNextPage", False)


def fetch_all_stock(user_info, max_pages=20):
    """获取所有实物商品（分页上限兜底，防止服务端 hasNextPage 恒真导致死循环）"""
    all_items = []
    page = 0
    while page < max_pages:
        items, has_next = fetch_stock(user_info, page)
        all_items.extend(items)
        if not has_next:
            break
        page += 1
        time.sleep(1)
    return all_items


# ========== 主逻辑 ==========
def check_once():
    """单次检查库存变化"""
    log("正在查询库存...")

    try:
        user_info = get_user_info()
        items = fetch_all_stock(user_info)
    except Exception as e:
        log(f"查询失败: {e}")
        return

    if not items:
        log("未获取到商品列表")
        return

    cache = read_cache()
    old_stock = cache.get("stock", {})

    new_stock = {}
    restocked = []
    new_items = []
    silent_new_items = []

    for item in items:
        item_id = str(item.get("id", ""))
        name = item.get("exchangeName", "未知")
        stock = item.get("stock", 0)
        warehouse = item.get("warehouseStock", 0)
        all_stock = item.get("allStock", 0)
        quantity = item.get("quantity", 0)

        new_stock[item_id] = {
            "name": name,
            "stock": stock,
            "warehouseStock": warehouse,
            "allStock": all_stock,
            "quantity": quantity,
        }

        # 判断是否有补货：已有商品从无货变为有货才推送；首次出现的商品交给新增逻辑，避免重复推送
        old = old_stock.get(item_id, {})
        old_all = old.get("allStock", -999)
        if item_id in old_stock and all_stock > 0 and old_all <= 0:
            restocked.append(f"  {name}: 库存 {all_stock} | 积分 {quantity}")

        # 新增商品：只有 allStock > 0 才推送；无货新品只静默记录缓存，避免频繁打扰
        if item_id not in old_stock:
            if all_stock > 0:
                new_items.append(f"  {name}: 库存 {all_stock} | 积分 {quantity}")
            else:
                silent_new_items.append(name)

    # 更新缓存
    cache["stock"] = new_stock
    cache["last_check"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    write_cache(cache)

    # 输出状态
    in_stock = [v["name"] for v in new_stock.values() if v["allStock"] > 0]
    log(f"共 {len(items)} 个商品，有货: {len(in_stock)}，无货: {len(items) - len(in_stock)}")

    # 推送通知
    if restocked:
        exchange_url = "https://mp.miniso.com/pages-v2/member/pointsMall/index"
        msg = "名创优品积分商城补货提醒\n\n" + "\n".join(restocked)
        msg += chr(10) + chr(10) + "点击进入兑换页面:" + chr(10) + exchange_url
        log(f"发现补货: {len(restocked)} 个商品")
        send_push("名创优品补货提醒", msg)

    if new_items:
        msg = "名创优品新增兑换商品（有货）\n\n" + "\n".join(new_items)
        msg += chr(10) + chr(10) + "点击进入兑换页面:" + chr(10) + "https://mp.miniso.com/pages-v2/member/pointsMall/index"
        log(f"发现有货新品: {len(new_items)} 个，推送通知")
        send_push("名创优品新商品上架", msg)

    if silent_new_items:
        log(f"静默记录 {len(silent_new_items)} 个无货新品（不推送）: {', '.join(silent_new_items[:5])}{'...' if len(silent_new_items) > 5 else ''}")


def main():
    log("===== 名创优品库存监控 =====")

    # 检查 WCS 配置
    if not os.getenv("wx_server_url"):
        log("未配置 wx_server_url，无法获取微信 code")
        sys.exit(1)

    # 2026-09-17 改：默认单次运行（查一轮即退出），由面板 cron 每 20 分钟拉起
    loop = ("--loop" in sys.argv) or os.getenv("MINISO_LOOP", "").lower() == "true"
    if not loop:
        log("单次运行模式（面板 cron 每 20 分钟拉起一次；持续监控请加 --loop）")
        check_once()
        return

    # 持续监控模式（仅供手工前台调试，带最长运行时间兜底，避免霸占面板槽位）
    max_seconds = int(os.getenv("MINISO_MAX_SECONDS", "3600"))
    log(f"持续监控模式: 间隔 {INTERVAL} 秒，最长运行 {max_seconds} 秒")
    t0 = time.time()
    while time.time() - t0 < max_seconds:
        try:
            check_once()
        except Exception as e:
            log(f"检查异常: {e}")
        if time.time() - t0 + INTERVAL >= max_seconds:
            break
        log(f"等待 {INTERVAL} 秒后下次检查...")
        time.sleep(INTERVAL)
    log(f"已达最长运行 {max_seconds} 秒，退出（避免长期占用面板并发槽位）")


if __name__ == "__main__":
    main()
