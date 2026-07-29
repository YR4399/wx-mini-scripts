# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========

#by:哆啦A梦
#入口:http://mx.qrurl.net/h5/wxa/link?sid=26407uif5Oq
#wx_opinion变量填写wx_server里的openid/账号标识，多账号换行分割
#需要配置wx_server_url、wx_auth，用于获取wx.login code
#账号变量名:wx_opinion
#new Env("wx_opinion")
#cron 8 9,10,11 * * *


import requests
import json
import os
import sys
import time
from pathlib import Path
import random

# ========== 推送通知 ==========
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _push_helper import push_notify, send_push_notify
    from _push_helper import send_push_notify  # 自动采集日志并推送

except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MINI_APP_ID = "wx61457400e4212cec"
WX_SERVER_URL = os.getenv("wx_server_url", "http://host.docker.internal:18788").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")
TOKEN_CACHE_PATH = Path(__file__).with_name("wx_opinion_token_cache.json")
LOGIN_BASE = "https://breoplus.breo.cn/app/minic"
APP_BASE = "https://breoplus.breo.cn/breo-app"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"

session = requests.Session()
session.verify = False

def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")

def mask_token(token):
    if not token:
        return ""
    return f"{token[:6]}***{token[-6:]}"

def is_success(result):
    return result.get("success") is True or str(result.get("code")) in ("0000", "200", "200.0")

def is_token_error(message):
    text = str(message)
    return any(key in text for key in ["40101", "40102", "token", "登录", "授权", "过期", "失效"])

def wx_headers():
    return {
        "auth": WX_AUTH,
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
    }

def app_headers(token=None):
    headers = {
        "User-Agent": DEFAULT_UA,
        "content-Type": "application/json",
        "Content-Type": "application/json",
        "deviceInfo": "{}",
        "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
    }
    if token:
        headers["token"] = token
    return headers

def breo_task_headers(token):
    return {
        "token": token,
        "device-type": "Xiaomi",
        "device-version": "10",
        "channel": "Breo",
        "version_code": "30201",
        "version": "3.2.1",
        "encrypt": "1",
        "Content-Type": "application/json; charset=UTF-8",
        "Referer": "https://servicewechat.com/wx61457400e4212cec/390/page-frame.html",
        "User-Agent": DEFAULT_UA,
    }

def get_wx_code(account_id):
    if not WX_AUTH:
        raise RuntimeError("缺少wx_auth，无法从wx_server获取code")
    resp = session.post(
        f"{WX_SERVER_URL}/wx/code",
        json={"appid": MINI_APP_ID, "openid": account_id},
        headers=wx_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    code = data.get("code") or (data.get("data") or {}).get("code")
    if not code:
        raise RuntimeError(f"wx_server未返回code: {data}")
    return code

def login_with_code(account_id):
    code = get_wx_code(account_id)
    login_resp = session.get(
        f"{LOGIN_BASE}/login/{code}",
        headers=app_headers(),
        timeout=30,
    )
    login_resp.raise_for_status()
    login_data = login_resp.json()
    if str(login_data.get("code")) != "200" or not login_data.get("data"):
        raise RuntimeError(f"code登录失败: {login_data}")
    user_info = login_data["data"]
    uid = user_info.get("uid")
    open_id = user_info.get("openId")
    union_id = user_info.get("unionId")
    if not uid:
        raise RuntimeError(f"登录响应缺少uid: {login_data}")

    token_resp = session.post(
        f"{APP_BASE}/customer/loginByUid",
        json={"uid": uid, "openId": open_id, "unionId": union_id},
        headers=app_headers(),
        timeout=30,
    )
    token_resp.raise_for_status()
    token_data = token_resp.json()
    if not is_success(token_data) or not (token_data.get("result") or {}).get("token"):
        raise RuntimeError(f"业务token登录失败: {token_data}")
    return {
        "token": token_data["result"]["token"],
        "uid": uid,
        "openId": open_id,
        "unionId": union_id,
        "userInfo": user_info,
        "customer": token_data.get("result", {}),
        "updatedAt": int(time.time()),
    }

def get_cached_token(account_id):
    return read_token_cache().get(account_id)

def save_cached_token(account_id, auth_info):
    cache = read_token_cache()
    cache[account_id] = auth_info
    write_token_cache(cache)

def remove_cached_token(account_id):
    cache = read_token_cache()
    if account_id in cache:
        del cache[account_id]
        write_token_cache(cache)

def validate_token(token):
    try:
        resp = session.post(
            f"{APP_BASE}/getUserLevelInfoByUid",
            headers=app_headers(token),
            timeout=15,
        )
        if resp.status_code != 200:
            return False
        data = resp.json()
        if is_success(data):
            return True
        return not is_token_error(data)
    except Exception:
        return False

def get_token_for_account(account_id, index):
    cached = get_cached_token(account_id)
    if cached and cached.get("token"):
        print(f"账号 {index} 使用缓存token: {mask_token(cached['token'])}")
        if validate_token(cached["token"]):
            return cached["token"]
        print(f"账号 {index} 缓存token失效，重新登录")
        remove_cached_token(account_id)

    auth_info = login_with_code(account_id)
    save_cached_token(account_id, auth_info)
    user_info = auth_info.get("userInfo") or {}
    print(f"账号 {index} code登录成功: {user_info.get('nickname') or user_info.get('telephone') or auth_info.get('uid')}")
    return auth_info["token"]

COMMENT_TEMPLATES = [
    "不错不错，支持一下",
    "感谢分享",
    "写的很好，学习了",
    "很有帮助，谢谢",
    "赞",
    "不错",
    "支持",
    "好",
    "收藏了",
    "有用",
    "感谢",
    "棒",
    "不错不错",
    "学到了",
    "实用",
]

AI_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
AI_API_KEY = "sk-033fb36a9a304b8e9f40e141439d55de"
AI_MODEL = "deepseek-r1-distill-qwen-7b"

def get_random_one_word():
    try:
        resp = requests.post(AI_API_URL,
            headers={"Authorization": f"Bearer {AI_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": AI_MODEL,
                "messages": [{"role": "user", "content": "用一句简短自然的话夸一下倍轻松按摩器，10字以内，不要引号不要标点"}],
                "max_tokens": 1000
            }, timeout=10, verify=False)
        if resp.status_code == 200:
            msg = resp.json()["choices"][0]["message"]
            text = (msg.get("content") or "").strip()
            if text:
                return text
    except Exception:
        pass
    return random.choice(COMMENT_TEMPLATES)

def get_proclamation():
    primary_url = "https://github.com/3288588344/toulu/raw/refs/heads/main/tl.txt"
    backup_url = "https://tfapi.cn/TL/tl.json"
    try:
        response = requests.get(primary_url, timeout=10, verify=False)
        if response.status_code == 200:
            print("\n" + "=" * 50)
            print("📢 公告信息")
            print("=" * 35)
            print(response.text)
            print("=" * 35 + "\n")
            print("公告获取成功，开始执行任务...\n")
            return
    except requests.exceptions.RequestException as e:
        print(f"获取公告时发生错误: {e}, 尝试备用链接...")

    try:
        response = requests.get(backup_url, timeout=10, verify=False)
        if response.status_code == 200:
            print("\n" + "=" * 50)
            print("📢 公告信息")
            print("=" * 35)
            print(response.text)
            print("=" * 35 + "\n")
            print("公告获取成功，开始执行任务...\n")
        else:
            print(f"⚠️ 获取公告失败，状态码: {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"⚠️ 获取公告时发生错误: {e}, 可能是网络问题或链接无效。")

def post_to_breo(token, content, title):
    url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/releasePost"
    headers = breo_task_headers(token)
    data = {
        "anonymoused": 1,
        "content": content,
        "expressText": "",
        "images": [],
        "subTitle": "",
        "title": title,
        "topicText": ""
    }
    try:
        response = requests.post(url, headers=headers, data=json.dumps(data))
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 发帖成功！")
                print(f"帖子 ID: {result['result']['id']}")
                print(f"帖子标题: {result['result']['title']}")
                return result["result"]["id"]
            else:
                print(f"❌ 发帖失败，错误信息：{result.get('message', '未知错误')}")
                return None
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
            return None
    except Exception as e:
        print(f"❌ 请求错误: {e}")
        return None

def collect_post(token, post_id):
    url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/collect"
    headers = breo_task_headers(token)
    data = {
        "postId": post_id
    }
    try:
        response = requests.post(url, headers=headers, data=json.dumps(data))
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 收藏成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 收藏失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

def comment_post(token, post_id):
    for _ in range(2):  # 评论2次
        comment_content = get_random_one_word()  # 使用随机一言作为评论内容
        url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/comment"
        headers = breo_task_headers(token)
        data = {
            "anonymoused": 0,
            "commentText": comment_content,
            "postId": post_id
        }
        try:
            response = requests.post(url, headers=headers, data=json.dumps(data), verify=False)
            if response.status_code == 200:
                result = response.json()
                if result.get("success", False):
                    print("✅ 评论成功！")
                    reward = result.get("result") or {}
                    root = reward.get("rootOutVO") or {}
                    print(f"评论内容: {root.get('commentText', comment_content)}")
                    print(f"获得点数: {reward.get('point', 0)}")
                    print(f"成长值: {reward.get('grow', 0)}")
                else:
                    print(f"❌ 评论失败，错误信息：{result.get('message', '未知错误')}")
            else:
                print(f"❌ 请求失败，状态码：{response.status_code}")
        except Exception as e:
            print(f"❌ 请求错误: {e}")
        time.sleep(1)  # 避免频繁请求

def browse_mall(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/mall"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers, verify=False)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 浏览商城成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 浏览商城失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

def punch_in(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/punch"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers, verify=False)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                print("✅ 签到成功！")
                reward = result.get("result") or {}
                print(f"获得点数: {reward.get('point', 0)}")
                print(f"成长值: {reward.get('grow', 0)}")
            else:
                print(f"❌ 签到失败，错误信息：{result.get('message', '未知错误')}")
        else:
            print(f"❌ 请求失败，状态码：{response.status_code}")
    except Exception as e:
        print(f"❌ 请求错误: {e}")

# ==================== 轻松灵田 (lzgame.breo.com 农场小游戏) ====================
# 基于 2026-07-23 抓包逆向：登录用 JWT（Bearer），POST /game/farm/user/login 可续期90天
# 所有业务接口为 GET + query 参数；请求头需固定 authorization/ticket/tenant + 动态 cloud-time + JWT
LZGAME_BASE = "https://lzgame.breo.com"
LINGTIAN_AUTH_BASIC = "Basic bHpfd3hfbWE6MzZlNWVkNDJjYjliZjJlNjhlM2Y2NDJjNjY2NmNkN2I="
LINGTIAN_TICKET = "a8296a63c8224ed58b4216237bc04b92"
LINGTIAN_TENANT = "bHo="
LINGTIAN_ORIGIN = "https://game.oauth.i-lz.cn"
LINGTIAN_REFERER = "https://game.oauth.i-lz.cn/"
LINGTIAN_UA = ("Mozilla/5.0 (Linux; Android 16; 25113PN0EC Build/BP2A.250605.031.A3; wv) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
               "Mobile Safari/537.36 XWEB/1460243 MMWEBSDK/20260502 MMWEBID/38 "
               "MicroMessenger/8.0.76.3141(0x28004C36) WeChat/arm64 Weixin NetType/WIFI "
               "Language/zh_CN ABI/arm64 miniProgram/wx61457400e4212cec")
LINGTIAN_TOKEN_CACHE = Path(__file__).with_name("wx_opinion_lt_token_cache.json")

def lt_headers(token):
    return {
        "authorization": LINGTIAN_AUTH_BASIC,
        "cloud-token": f"Bearer {token}",
        "token": f"Bearer {token}",
        "ticket": LINGTIAN_TICKET,
        "tenant": LINGTIAN_TENANT,
        "cloud-time": str(int(time.time() * 1000)),
        "origin": LINGTIAN_ORIGIN,
        "referer": LINGTIAN_REFERER,
        "user-agent": LINGTIAN_UA,
        "accept": "application/json, text/plain, */*",
        "x-requested-with": "com.tencent.mm",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    }

def lt_get(token, path, params=None):
    try:
        r = session.get(f"{LZGAME_BASE}{path}", headers=lt_headers(token), params=params, timeout=20, verify=False)
        return r.json()
    except Exception as e:
        return {"code": -1, "msg": str(e)}

def lt_read_token_cache():
    try:
        return json.loads(LINGTIAN_TOKEN_CACHE.read_text(encoding="utf-8")) if LINGTIAN_TOKEN_CACHE.exists() else {}
    except Exception:
        return {}

def lt_write_token_cache(cache):
    try:
        LINGTIAN_TOKEN_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 灵田token缓存写入失败: {e}")

def get_farm_token(account_index):
    """获取灵田游戏 JWT（按账号缓存，user/login 自动续期90天）"""
    cache = lt_read_token_cache()
    key = str(account_index)
    tok = cache.get(key)
    if not tok:
        toks = os.getenv("BREO_FARM_TOKENS", os.getenv("BREO_FARM_TOKEN", ""))
        parts = [t.strip() for t in toks.split("&") if t.strip()]
        if account_index - 1 < len(parts):
            tok = parts[account_index - 1]
        else:
            return None  # 该账号未配置灵田 token，跳过
    # 用旧 token 调 user/login 续期（延长90天）
    try:
        r = session.post(f"{LZGAME_BASE}/game/farm/user/login", headers=lt_headers(tok), json={}, timeout=20, verify=False)
        d = r.json()
        if d.get("code") == 200 and (d.get("data") or {}).get("token"):
            tok = d["data"]["token"]
            cache[key] = tok
            lt_write_token_cache(cache)
            print(f"🌱 灵田登录续期成功 (expire={d['data'].get('expiration')})")
        else:
            print(f"⚠️ 灵田登录续期返回异常: {d.get('msg')} (沿用旧token)")
    except Exception as e:
        print(f"⚠️ 灵田登录续期失败: {e} (沿用旧token)")
    return tok

def _parse_dt(s):
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return time.mktime(time.strptime(s, fmt))
        except Exception:
            continue
    return 0

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
        st = str(t.get("state", "0"))
        if st in ("0",):  # 跳过进行中
            continue
        r2 = lt_get(token, "/game/farm/task/getTaskReward", {"keyId": t.get("keyId")})
        if r2.get("code") == 200:
            done += 1
            print(f"✅ 灵田任务领奖: {t.get('name')}")
        else:
            print(f"⚠️ 灵田任务[{t.get('name')}]领奖: {r2.get('msg')}")
    if done == 0:
        print("📋 灵田暂无可领任务奖励")

def farm_run(token):
    """灵田主流程：收获成熟 → 开地种植空地 → 浇水。

    土地状态机（基于 land/list，实测逆向）：
      state=0 → 未开垦（需游戏内花金币开地解锁，farmCrop 报"田还未开垦"）
      state=1 → 已解锁未开垦
      state=2 → 已开垦空地（可 farmCrop 种植）
      state=3 → 已种作物（可浇水；成熟可收获）
    农场循环：3(已种) → 收获 → 2(空地) → farmCrop → 3(已种)
    注：farmSeq>=2 的地需金币解锁（sysUserLandList.price），属付费"开地"动作，
        抓包无对应免费接口，脚本只对已开垦(state=2)空地种植。
    """
    sys_crops = lt_get(token, "/game/farm/crop/sysCropList").get("data") or []
    # 选第一个有库存的种子（优先低等级作物如艾草）
    seed = next((c for c in sys_crops if int(c.get("inventory", 0)) > 0), sys_crops[0]) if sys_crops else None

    props = lt_get(token, "/game/farm/prop/list").get("data") or []
    water = next((p for p in props if str(p.get("type")) == "1" and int(p.get("propNum", 0)) > 0), None)
    water_uid = None        # 背包内水源实例 uid（消耗品）
    water_key = None        # 水源 sysProp keyId（回退）
    if water:
        pl = water.get("propList") or []
        if pl:
            water_uid = pl[0].get("uid")
        water_key = water.get("keyId")

    now = time.time()

    # 1) 收获成熟作物（cropId 有值 且 planTime 已过）
    lands = lt_get(token, "/game/farm/land/list").get("data") or []
    for land in lands:
        if not land.get("cropId"):
            continue
        crop = land.get("crop") or {}
        plan = crop.get("planTime") or land.get("planTime")
        if not plan:
            continue
        if now >= _parse_dt(plan) - 120:  # planTime 为预计成熟时间
            hr = lt_get(token, "/game/farm/land/harvestCrop", {"landUid": land.get("uid")})
            if hr.get("code") == 200:
                print(f"✅ 灵田收获 landUid={land.get('uid')[:8]} 奖励={hr.get('data')}")
            else:
                m = hr.get("msg", "")
                if "未成熟" not in m and "不能" not in m:
                    print(f"⚠️ 灵田收获失败: {m}")

    # 2) 开地种植（仅对已开垦空地 state==2 且 cropId 为空；重新拉列表取收获后最新状态）
    if seed:
        lands2 = lt_get(token, "/game/farm/land/list").get("data") or []
        unopened = 0
        for land in lands2:
            if land.get("cropId") or str(land.get("state")) != "2":
                continue  # 只处理已开垦空地
            fr = lt_get(token, "/game/farm/land/farmCrop",
                        {"seedUid": seed.get("keyId"), "landUid": land.get("uid")})
            if fr.get("code") == 200:
                print(f"✅ 灵田开地种植 landUid={land.get('uid')[:8]} 种子={seed.get('name')}")
                _farm_water(token, land.get("uid"), water_uid, water_key)
            else:
                m = fr.get("msg", "")
                if "未开垦" in m or "未解锁" in m or "不能" in m:
                    unopened += 1
                else:
                    print(f"⚠️ 灵田种植失败: {m}")
        if unopened:
            print(f"📋 灵田有 {unopened} 块地未开垦(需游戏内花金币开地解锁)，已跳过")

    # 3) 浇水（对每块已种作物的地各浇一次）
    if water_uid or water_key:
        lands3 = lt_get(token, "/game/farm/land/list").get("data") or []
        for land in lands3:
            if land.get("cropId"):
                _farm_water(token, land.get("uid"), water_uid, water_key)

def _farm_water(token, land_uid, water_uid, water_key):
    """浇水：优先用背包实例 uid，失败回退 sysProp keyId"""
    if water_uid:
        wr = lt_get(token, "/game/farm/land/waterLand",
                    {"landUid": land_uid, "propUid": water_uid})
        if wr.get("code") == 200:
            print(f"✅ 灵田浇水 landUid={str(land_uid)[:8]}")
            return
    if water_key:
        wr = lt_get(token, "/game/farm/land/waterLand",
                    {"landUid": land_uid, "propUid": water_key})
        if wr.get("code") == 200:
            print(f"✅ 灵田浇水 landUid={str(land_uid)[:8]} (用keyId)")
        else:
            print(f"⚠️ 灵田浇水失败: {wr.get('msg')}")

if __name__ == "__main__":
    # 获取公告
    #get_proclamation()

    # 从环境变量读取 wx_server 账号标识/openid
    accounts = [item.strip() for item in os.getenv("wx_opinion", "").replace("&", "\n").splitlines() if item.strip()]

    if not accounts:
        print("❌ 未检测到 账号信息，退出脚本。")
    else:
        skip_community = os.getenv("wx_opinion_SKIP_COMMUNITY", "").lower() in ("1", "true", "yes")
        print("=============== 开始执行任务 ===============")
        for i, account in enumerate(accounts, 1):
            print(f"\n-------------- 账号 {i} 开始 --------------")
            try:
                token = get_token_for_account(account, i)
            except Exception as e:
                print(f"❌ 账号 {i} 登录失败: {e}")
                continue

            try:
                print("🚀 正在签到...")
                punch_in(token)

                if skip_community:
                    print("\n📝 已跳过发帖/收藏/评论任务")
                else:
                    print("\n📝 正在发布帖子...")
                    post_id = post_to_breo(token, "这是一个自动发布的帖子", "自动化测试")
                    if post_id:
                        print("\n⭐ 正在收藏帖子...")
                        collect_post(token, post_id)

                        print("\n💬 正在评论帖子...")
                        comment_post(token, post_id)
                    else:
                        print("❌ 发帖失败，跳过后续操作。")

                print("\n🛒 正在浏览商城...")
                lt_tok = get_farm_token(i)
                if os.getenv("BREO_SKIP_FARM", "0") == "1":
                    print("\n⏭️ 跳过灵田（由独立脚本处理）")
                    lt_tok = None
                else:
                    browse_mall(token)
                if lt_tok:
                    try:
                        farm_sign_in(lt_tok)
                        farm_do_tasks(lt_tok)
                        farm_run(lt_tok)
                    except Exception as e:
                        print(f"❌ 灵田任务异常: {e}")
                else:
                    print("\n🌱 轻松灵田: 未配置灵田token(BREO_FARM_TOKENS)，跳过")
            except Exception as e:
                print(f"❌ 账号 {i} 执行异常: {e}")

            print(f"-------------- 账号 {i} 结束 --------------")

        print("\n=============== 所有任务执行完毕 ===============")

# ========== PushPlus 推送 ==========
send_push_notify("倍轻松签到")
