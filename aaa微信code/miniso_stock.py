"""
名创优品积分商城 - 库存更新提醒
监控兑换实物商品库存，有补货时 PushPlus 推送提醒
通过 WCS 自动获取登录态，无需手动抓包

环境变量：
  wx_server_url / wx_auth - WCS 服务配置
  wx_opinion / WECHAT_ACCOUNTS - WCS openid
  PLUSPLUS_TOKEN - PushPlus 推送 token
  MINISO_INTERVAL - 检查间隔秒数（默认 1200，即 20 分钟）
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
WCS_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WCS_AUTH = os.getenv("wx_auth", "976dc5b3977cd2cbb8c61ddd32e9f885")
MINISO_APPID = "wx2a212470bade49bf"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, "miniso_stock_cache.json")
USER_CACHE_FILE = os.path.join(SCRIPT_DIR, "miniso_user_cache.json")
INTERVAL = int(os.getenv("MINISO_INTERVAL", "1200"))
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
              "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF "
              "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841")

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


# ========== 推送 ==========
def push(title, content):
    token = os.getenv("PLUSPLUS_TOKEN", "")
    if not token:
        log("未配置 PLUSPLUS_TOKEN，跳过推送")
        return
    try:
        body = json.dumps({
            "token": token, "title": title,
            "content": content, "template": "txt"
        }).encode()
        req = urllib.request.Request("http://www.pushplus.plus/send", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req, timeout=15, context=CTX)
        r = json.loads(resp.read())
        if r.get("code") == 200:
            log("PushPlus 推送成功")
        else:
            log(f"PushPlus 推送失败: {r.get('msg', '')}")
    except Exception as e:
        log(f"推送异常: {e}")


# ========== 用户信息 ==========
def get_user_info():
    """通过 WCS 获取 MINISO 用户信息，自动缓存"""
    # 先检查缓存（1小时内有效）
    try:
        if os.path.exists(USER_CACHE_FILE):
            with open(USER_CACHE_FILE, "r") as f:
                cached = json.load(f)
            if cached.get("uid") and cached.get("ts", 0) > time.time() - 3600:
                return cached
    except:
        pass

    # 通过 WCS 获取 code
    openids_raw = os.getenv("wx_opinion", "")
    if not openids_raw:
        openids_raw = os.getenv("WECHAT_ACCOUNTS", "")
    openids = [x.strip() for x in openids_raw.replace("\n", "&").replace("&", "\n").split("\n") if x.strip()]
    if not openids:
        raise Exception("未配置 wx_opinion 或 WECHAT_ACCOUNTS")

    openid = openids[0]
    try:
        body = json.dumps({"appid": MINISO_APPID, "openid": openid}).encode()
        req = urllib.request.Request(f"{WCS_URL}/wx/code", data=body, method="POST")
        req.add_header("AUTH", WCS_AUTH)
        req.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req, timeout=15, context=CTX)
        result = json.loads(resp.read())
        code = result.get("data", {}).get("code", "")
        if not code:
            raise Exception(f"WCS 返回: {result}")
        log(f"获取微信 code 成功")
    except Exception as e:
        raise Exception(f"WCS 请求失败: {e}")

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
        resp = urllib.request.urlopen(req, timeout=15, context=CTX)
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

    resp = urllib.request.urlopen(req, timeout=15, context=CTX)
    data = json.loads(resp.read())

    if not data.get("success"):
        raise Exception(f"API 返回失败: {data.get('message', '')}")

    return data.get("data", {}).get("exchanges", []), data.get("data", {}).get("hasNextPage", False)


def fetch_all_stock(user_info):
    """获取所有实物商品"""
    all_items = []
    page = 0
    while True:
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
        push("名创优品补货提醒", msg)

    if new_items:
        msg = "名创优品新增兑换商品（有货）\n\n" + "\n".join(new_items)
        msg += chr(10) + chr(10) + "点击进入兑换页面:" + chr(10) + "https://mp.miniso.com/pages-v2/member/pointsMall/index"
        log(f"发现有货新品: {len(new_items)} 个，推送通知")
        push("名创优品新商品上架", msg)

    if silent_new_items:
        log(f"静默记录 {len(silent_new_items)} 个无货新品（不推送）: {', '.join(silent_new_items[:5])}{'...' if len(silent_new_items) > 5 else ''}")


def main():
    log("===== 名创优品库存监控 =====")

    # 检查 WCS 配置
    if not os.getenv("wx_server_url"):
        log("未配置 wx_server_url，无法获取微信 code")
        sys.exit(1)

    # 单次运行模式
    if len(sys.argv) > 1 and sys.argv[1] == "--once":
        check_once()
        return

    # 持续监控模式
    log(f"监控间隔: {INTERVAL} 秒")
    while True:
        try:
            check_once()
        except Exception as e:
            log(f"检查异常: {e}")
        log(f"等待 {INTERVAL} 秒后下次检查...")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
