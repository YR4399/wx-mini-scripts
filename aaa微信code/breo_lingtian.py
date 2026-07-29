# ========== 倍轻松·轻松灵田 ==========
# 独立脚本：签到 + 领奖 + 收获 + 种植 + 浇水
# 环境变量：wx_opinion (openid，多账号&分隔)
#           wx_server_url, wx_auth (WCS配置)
# 依赖：WCS wx/code → BREO business token → ticket → farm JWT → 灵田任务
# new Env("wx_opinion")
# cron 8 9,10,11 * * *
# ==========

import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''

import requests
import json
import os
import sys
import time
from pathlib import Path

# ========== 推送 ==========
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _push_helper import push_notify, send_push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False

# ========== 基础配置 ==========
MINI_APP_ID = "wx61457400e4212cec"
WX_SERVER_URL = os.getenv("wx_server_url", "http://host.docker.internal:18788").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")
BREO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"

# 灵田游戏配置
LZGAME_BASE = "https://lzgame.breo.com"
LINGTIAN_AUTH_BASIC = "Basic bHpfd3hfbWE6MzZlNWVkNDJjYjliZjJlNjhlM2Y2NDJjNjY2NmNkN2I="
LINGTIAN_TENANT = "bHo="
LINGTIAN_ORIGIN = "https://game.oauth.i-lz.cn"
LINGTIAN_REFERER = "https://game.oauth.i-lz.cn/"
LINGTIAN_UA = ("Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
               "Mobile Safari/537.36 MicroMessenger/8.0.76.3141 WeChat/arm64 Weixin "
               "Language/zh_CN miniProgram/wx61457400e4212cec")

# BREO 后端
BREO_LOGIN_BASE = "https://breoplus.breo.cn/app/minic"
BREO_APP_BASE = "https://breoplus.breo.cn/breo-app"

# 缓存
LT_TOKEN_CACHE = Path(__file__).with_name("breo_lingtian_token_cache.json")

session = requests.Session()
session.verify = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# ========== WCS / BREO 登录 ==========
def wx_headers():
    return {"auth": WX_AUTH, "User-Agent": BREO_UA, "Content-Type": "application/json"}

def app_headers():
    return {
        "User-Agent": BREO_UA, "Content-Type": "application/json",
        "deviceInfo": "{}",
        "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
    }

def get_wx_code(account_id):
    resp = session.post(f"{WX_SERVER_URL}/wx/code",
                        json={"appid": MINI_APP_ID, "openid": account_id},
                        headers=wx_headers(), timeout=30)
    resp.raise_for_status()
    data = resp.json()
    code = data.get("code") or (data.get("data") or {}).get("code")
    if not code:
        raise RuntimeError(f"wx_server未返回code: {data}")
    return code

def get_breo_token(account_id):
    """WCS wx code → BREO business token"""
    code = get_wx_code(account_id)
    login_resp = session.get(f"{BREO_LOGIN_BASE}/login/{code}", headers=app_headers(), timeout=30)
    login_resp.raise_for_status()
    login_data = login_resp.json()
    if str(login_data.get("code")) != "200" or not login_data.get("data"):
        raise RuntimeError(f"BREO主登录失败: {login_data}")
    uid = login_data["data"].get("uid")
    open_id = login_data["data"].get("openId")
    union_id = login_data["data"].get("unionId")
    if not uid:
        raise RuntimeError(f"登录响应缺少uid: {login_data}")

    tok_resp = session.post(f"{BREO_APP_BASE}/customer/loginByUid",
                            json={"uid": uid, "openId": open_id, "unionId": union_id},
                            headers=app_headers(), timeout=30)
    tok_resp.raise_for_status()
    tok_data = tok_resp.json()
    if not (tok_data.get("result") or {}).get("token"):
        raise RuntimeError(f"业务token登录失败: {tok_data}")
    return tok_data["result"]["token"]


# ========== 灵田 JWT 获取 ==========
def lt_headers(token):
    return {
        "authorization": LINGTIAN_AUTH_BASIC,
        "cloud-token": f"Bearer {token}",
        "token": f"Bearer {token}",
        "tenant": LINGTIAN_TENANT,
        "cloud-time": str(int(time.time() * 1000)),
        "origin": LINGTIAN_ORIGIN,
        "referer": LINGTIAN_REFERER,
        "user-agent": LINGTIAN_UA,
    }

def lt_get(token, path, params=None):
    r = session.get(f"{LZGAME_BASE}{path}", headers=lt_headers(token), params=params, timeout=20, verify=False)
    try:
        return r.json()
    except Exception:
        return {"code": -1, "msg": r.text[:200]}

def lt_read_cache():
    try:
        if LT_TOKEN_CACHE.exists():
            return json.loads(LT_TOKEN_CACHE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def lt_write_cache(cache):
    try:
        LT_TOKEN_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 灵田token缓存写入失败: {e}")

def get_farm_token(account_id):
    """获取灵田 JWT：先查缓存，无则 BREO token→ticket→farm JWT"""
    cache = lt_read_cache()
    tok = cache.get(account_id)
    if not tok:
        print(f"⚠️  灵田暂无缓存token，尝试自动获取...")
        tok = _fetch_farm_token(account_id)
        if tok:
            cache[account_id] = tok
            lt_write_cache(cache)
    # 续期
    if tok:
        try:
            r = session.post(f"{LZGAME_BASE}/game/farm/user/login",
                             headers=lt_headers(tok), json={}, timeout=20, verify=False)
            d = r.json()
            if d.get("code") == 200 and (d.get("data") or {}).get("token"):
                tok = d["data"]["token"]
                cache[account_id] = tok
                lt_write_cache(cache)
                print(f"✅ 灵田登录续期成功 (expire={d['data'].get('expiration')})")
            else:
                print(f"⚠️  灵田登录续期返回异常: {d.get('msg')} (沿用旧token)")
        except Exception as e:
            print(f"⚠️  灵田登录续期失败: {e} (沿用旧token)")
    return tok

def _fetch_farm_token(account_id):
    """BREO token → ticket → farm JWT"""
    try:
        breo_tok = get_breo_token(account_id)
        tkt_h = {"User-Agent": BREO_UA, "Content-Type": "application/json",
                 "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
                 "token": breo_tok}
        tkt = session.get(f"{BREO_APP_BASE}/ticket/get", headers=tkt_h, timeout=15).json()
        ticket = tkt.get("result")
        if not ticket:
            print(f"⚠️  灵田自动登录：无法获取ticket")
            return None
        lt_h = {"authorization": LINGTIAN_AUTH_BASIC, "ticket": ticket, "tenant": LINGTIAN_TENANT,
                "cloud-time": str(int(time.time() * 1000)),
                "origin": LINGTIAN_ORIGIN, "referer": LINGTIAN_REFERER, "user-agent": BREO_UA}
        resp = session.post(f"{LZGAME_BASE}/game/farm/user/login", headers=lt_h, json={}, timeout=20, verify=False)
        data = resp.json().get("data", {})
        jwt = data.get("token")
        if jwt:
            print(f"✅ 灵田自动登录成功 (user_id={data.get('user_id')}, expire={data.get('expiration')})")
            return jwt
        print(f"⚠️  灵田自动登录：farm/user/login 返回异常: {resp.json()}")
        return None
    except Exception as e:
        print(f"⚠️  灵田自动登录异常: {e}")
        return None


# ========== 灵田任务 ==========
def farm_sign_in(token):
    info = lt_get(token, "/game/farm/task/signInInfo")
    if (info.get("data") or {}).get("todaySigned"):
        print("✅ 灵田今日已签到")
        return
    r = lt_get(token, "/game/farm/task/signIn")
    if r.get("code") == 200:
        rw = r.get("data") or []
        print(f"✅ 灵田签到成功 (奖励{len(rw)}项)")
    else:
        print(f"❌ 灵田签到失败: {r.get('msg')}")

def farm_do_tasks(token):
    r = lt_get(token, "/game/farm/task/userTasklist", {"scene": "2", "page": "1", "pageSize": "30"})
    tasks = (r.get("data") or {}).get("list") or []
    done = 0
    for t in tasks:
        if str(t.get("state", "0")) in ("0",):
            continue
        r2 = lt_get(token, "/game/farm/task/getTaskReward", {"keyId": t.get("keyId")})
        if r2.get("code") == 200:
            done += 1
            print(f"✅ 灵田任务领奖: {t.get('name')}")
        else:
            print(f"⚠️ 灵田任务[{t.get('name')}]领奖: {r2.get('msg')}")
    if done == 0:
        print("📋 灵田暂无可领任务奖励")

def _parse_dt(s):
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return time.mktime(time.strptime(s, fmt))
        except (ValueError, TypeError):
            pass
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0

def _farm_water(token, land_uid, water_uid, water_key):
    if water_uid:
        wr = lt_get(token, "/game/farm/land/waterLand", {"landUid": land_uid, "propUid": water_uid})
        if wr.get("code") == 200:
            print(f"✅ 灵田浇水 landUid={str(land_uid)[:8]}")
            return
    if water_key:
        wr = lt_get(token, "/game/farm/land/waterLand", {"landUid": land_uid, "propUid": water_key})
        if wr.get("code") == 200:
            print(f"✅ 灵田浇水 landUid={str(land_uid)[:8]} (用keyId)")
        else:
            print(f"⚠️ 灵田浇水失败: {wr.get('msg')}")

def farm_run(token):
    """收获 → 种植 → 浇水"""
    # 选种子
    crops = lt_get(token, "/game/farm/crop/sysCropList").get("data") or []
    seed = next((c for c in crops if int(c.get("inventory", 0)) > 0), crops[0]) if crops else None

    # 找水源
    props = lt_get(token, "/game/farm/prop/list").get("data") or []
    water = next((p for p in props if str(p.get("type")) == "1" and int(p.get("propNum", 0)) > 0), None)
    water_uid = None
    water_key = None
    if water:
        pl = water.get("propList") or []
        if pl:
            water_uid = pl[0].get("uid")
        water_key = water.get("keyId")

    now = time.time()

    # 1) 收获成熟
    lands = lt_get(token, "/game/farm/land/list").get("data") or []
    for land in lands:
        if not land.get("cropId"):
            continue
        crop = land.get("crop") or {}
        plan = crop.get("planTime") or land.get("planTime")
        if not plan:
            continue
        if now >= _parse_dt(plan) - 120:
            hr = lt_get(token, "/game/farm/land/harvestCrop", {"landUid": land.get("uid")})
            if hr.get("code") == 200:
                print(f"✅ 灵田收获 landUid={land.get('uid')[:8]}")
            else:
                m = hr.get("msg", "")
                if "未成熟" not in m and "不能" not in m:
                    print(f"⚠️ 灵田收获失败: {m}")

    # 2) 种植空地
    if seed:
        lands2 = lt_get(token, "/game/farm/land/list").get("data") or []
        unopened = 0
        for land in lands2:
            if land.get("cropId") or str(land.get("state")) != "2":
                continue
            fr = lt_get(token, "/game/farm/land/farmCrop",
                        {"seedUid": seed.get("keyId"), "landUid": land.get("uid")})
            if fr.get("code") == 200:
                print(f"✅ 灵田种植 landUid={land.get('uid')[:8]} 种子={seed.get('name')}")
                _farm_water(token, land.get("uid"), water_uid, water_key)
            else:
                m = fr.get("msg", "")
                if "未开垦" in m or "未解锁" in m or "不能" in m:
                    unopened += 1
                else:
                    print(f"⚠️ 灵田种植失败: {m}")
        if unopened:
            print(f"📋 灵田有 {unopened} 块地未开垦(需游戏内花金币开地解锁)，已跳过")

    # 3) 浇水
    if water_uid or water_key:
        lands3 = lt_get(token, "/game/farm/land/list").get("data") or []
        for land in lands3:
            if land.get("cropId"):
                _farm_water(token, land.get("uid"), water_uid, water_key)


# ========== 主入口 ==========
if __name__ == "__main__":
    accounts = [item.strip() for item in os.getenv("wx_opinion", "").replace("&", "\n").splitlines() if item.strip()]
    if not accounts:
        print("❌ 未检测到 wx_opinion 账号信息，退出。")
        sys.exit(1)

    print("=" * 40)
    print("  倍轻松 · 轻松灵田")
    print("=" * 40)

    for i, account in enumerate(accounts, 1):
        print(f"\n--- 账号 {i} ({account[:12]}...) ---")
        try:
            tok = get_farm_token(account)
        except Exception as e:
            print(f"❌ 账号{i} 登录失败: {e}")
            continue

        if not tok:
            print("❌ 账号{i} 无灵田token，跳过")
            continue

        try:
            print("\n📝 签到...")
            farm_sign_in(tok)
            print("\n📋 领奖...")
            farm_do_tasks(tok)
            print("\n🌱 种地...")
            farm_run(tok)
        except Exception as e:
            print(f"❌ 执行异常: {e}")

    # 推送
    try:
        send_push_notify()
    except Exception:
        pass

    print("\n" + "=" * 40)
    print("  灵田任务完成")
    print("=" * 40)
