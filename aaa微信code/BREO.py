#by:哆啦A梦
#入口:http://mx.qrurl.net/h5/wxa/link?sid=26407uif5Oq
#wx_opinion变量填写wx_server里的openid/账号标识，多账号&分割
#需要配置wx_server_url、wx_auth，用于获取wx.login code
#账号变量名:wx_opinion
#new Env("BREO")
#cron 8 9,10,11 * * *


import requests
import json
import os
import sys
import time
import random
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MINI_APP_ID = "wx61457400e4212cec"
WX_SERVER_URL = os.getenv("wx_server_url", "http://192.168.31.196:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")
TOKEN_CACHE_PATH = Path(__file__).with_name("BREO_token_cache.json")
LOGIN_BASE = "https://breoplus.breo.cn/app/minic"
APP_BASE = "https://breoplus.breo.cn/breo-app"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"

COMMENT_WORDS = ["今天天气真好，适合出去走走晒太阳", "加油加油，继续努力向前冲", "开心每一天，保持好心情", "努力奋斗，未来可期加油", "生活美好，珍惜当下的时光", "坚持就是胜利，绝不放弃", "未来可期，一起加油努力", "感恩遇见，珍惜美好缘分", "越努力越幸运，一起加油", "每天进步一点点就很好"]

session = requests.Session()


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
        "Content-Type": "application/json",
        "deviceInfo": "{}",
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/390/page-frame.html",
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
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/390/page-frame.html",
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
        print(f"账号[{index}] 使用缓存token: {mask_token(cached['token'])}")
        if validate_token(cached["token"]):
            return cached["token"]
        print(f"账号[{index}] 缓存token失效，重新登录")
        remove_cached_token(account_id)

    auth_info = login_with_code(account_id)
    save_cached_token(account_id, auth_info)
    user_info = auth_info.get("userInfo") or {}
    print(f"账号[{index}] code登录成功: {user_info.get('nickname') or user_info.get('telephone') or auth_info.get('uid')}")
    return auth_info["token"]


def punch_in(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/punch"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers, timeout=30)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                reward = result.get("result") or {}
                print(f"✅ 签到成功! 点数:{reward.get('point', 0)} 成长值:{reward.get('grow', 0)}")
            else:
                print(f"❌ 签到失败: {result.get('message', '未知错误')}")
        else:
            print(f"❌ 签到请求失败，状态码: {response.status_code}")
    except Exception as e:
        print(f"❌ 签到异常: {e}")


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
        response = requests.post(url, headers=headers, data=json.dumps(data), timeout=30)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                post_id = result["result"]["id"]
                print(f"✅ 发帖成功! ID:{post_id}")
                return post_id
            else:
                print(f"❌ 发帖失败: {result.get('message', '未知错误')}")
        else:
            print(f"❌ 发帖请求失败，状态码: {response.status_code}")
    except Exception as e:
        print(f"❌ 发帖异常: {e}")
    return None


def collect_post(token, post_id):
    url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/collect"
    headers = breo_task_headers(token)
    data = {"postId": post_id}
    try:
        response = requests.post(url, headers=headers, data=json.dumps(data), timeout=30)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                reward = result.get("result") or {}
                print(f"✅ 收藏成功! 点数:{reward.get('point', 0)} 成长值:{reward.get('grow', 0)}")
            else:
                print(f"❌ 收藏失败: {result.get('message', '未知错误')}")
        else:
            print(f"❌ 收藏请求失败，状态码: {response.status_code}")
    except Exception as e:
        print(f"❌ 收藏异常: {e}")


def comment_post(token, post_id):
    for i in range(2):
        content = random.choice(COMMENT_WORDS)
        url = "https://breoplus.breo.cn/breo-app/communityBaseInfo/comment"
        headers = breo_task_headers(token)
        data = {
            "anonymoused": 0,
            "commentText": content,
            "postId": post_id
        }
        try:
            response = requests.post(url, headers=headers, data=json.dumps(data), timeout=30)
            if response.status_code == 200:
                result = response.json()
                if result.get("success", False):
                    reward = result.get("result") or {}
                    print(f"✅ 评论{i+1}成功: {content} 点数:{reward.get('point', 0)}")
                else:
                    print(f"❌ 评论{i+1}失败: {result.get('message', '未知错误')}")
            else:
                print(f"❌ 评论{i+1}请求失败，状态码: {response.status_code}")
        except Exception as e:
            print(f"❌ 评论{i+1}异常: {e}")
        time.sleep(1)


def browse_mall(token):
    url = "https://breoplus.breo.cn/breo-app/user/po-task-info/mall"
    headers = breo_task_headers(token)
    try:
        response = requests.post(url, headers=headers, timeout=30)
        if response.status_code == 200:
            result = response.json()
            if result.get("success", False):
                reward = result.get("result") or {}
                print(f"✅ 浏览商城成功! 点数:{reward.get('point', 0)} 成长值:{reward.get('grow', 0)}")
            else:
                print(f"❌ 浏览商城失败: {result.get('message', '未知错误')}")
        else:
            print(f"❌ 浏览商城请求失败，状态码: {response.status_code}")
    except Exception as e:
        print(f"❌ 浏览商城异常: {e}")


if __name__ == "__main__":
    accounts = [item.strip() for item in os.getenv("wx_opinion", "").replace("&", "\n").splitlines() if item.strip()]

    if not accounts:
        print("❌ 未检测到wx_opinion账号信息，退出脚本。")
    else:
        skip_community = os.getenv("BREO_SKIP_COMMUNITY", "").lower() in ("1", "true", "yes")
        print(f"🔔BREO倍轻松,开始! 共{len(accounts)}个账号")

        for i, account in enumerate(accounts, 1):
            print(f"\n--- 账号[{i}] ---")
            try:
                token = get_token_for_account(account, i)
            except Exception as e:
                print(f"❌ 账号[{i}] 登录失败: {e}")
                continue

            print("🚀 签到...")
            punch_in(token)

            if skip_community:
                print("📝 跳过社区任务")
            else:
                print("📝 发帖...")
                post_id = post_to_breo(token, "今天天气真好，出去走走晒晒太阳，心情也变好了", "日常分享")
                if post_id:
                    time.sleep(1)
                    print("⭐ 收藏...")
                    collect_post(token, post_id)
                    time.sleep(1)
                    print("💬 评论...")
                    comment_post(token, post_id)
                else:
                    print("❌ 发帖失败，跳过收藏评论")

            time.sleep(1)
            print("🛒 浏览商城...")
            browse_mall(token)

            print(f"--- 账号[{i}] 完成 ---")

        print(f"\n🔔BREO倍轻松,结束!")
