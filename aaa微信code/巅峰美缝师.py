"""
@Description: 巅峰美缝师 签到+抽奖
cron: 20 8 * * *
"""
import sys
import json
import time
import os
import requests
from _push_helper import send_push_notify  # 自动采集日志并推送


APPID = "wx444ddc3d46767f9d"
API_BASE = "https://api.dfmeifeng.com/wechat/miniapp"
ACTIVITY_ID = "1914607689511862273"
CACHE_FILE = "巅峰美缝师_token.json"

WX_SERVER_URL = os.getenv("wx_server_url", "http://host.docker.internal:18788")
WX_AUTH = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _read_cache(openid):
    try:
        with open(os.path.join(SCRIPT_DIR, CACHE_FILE)) as f:
            return json.load(f).get(openid)
    except:
        return None


def _write_cache(openid, token):
    try:
        p = os.path.join(SCRIPT_DIR, CACHE_FILE)
        c = {}
        try:
            with open(p) as f:
                c = json.load(f)
        except:
            pass
        c[openid] = token
        with open(p, "w") as f:
            json.dump(c, f)
    except:
        pass

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841"
)


def get_code(openid):
    """从 WCS 获取 wx.login code"""
    try:
        resp = requests.post(
            f"{WX_SERVER_URL}/wx/code",
            json={"appid": APPID, "openid": openid},
            headers={"auth": WX_AUTH},
            timeout=60,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        code = data.get("data", {}).get("code") or data.get("code")
        return code
    except Exception as e:
        print(f"[WCS] 获取code异常: {e}")
        return None


def login(code):
    """code 换 JWT token"""
    try:
        headers = {
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": f"https://servicewechat.com/{APPID}/71/page-frame.html",
        }
        resp = requests.get(
            f"{API_BASE}/wechat/login",
            params={"code": code, "memberId": ""},
            headers=headers,
            timeout=20,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200 and data.get("data"):
            token = data["data"].get("access_token")
            return token
        print(f"[登录] 失败: {data}")
        return None
    except Exception as e:
        print(f"[登录] 异常: {e}")
        return None


def member_info(token):
    """获取会员信息（验证 token 有效性）"""
    try:
        headers = _make_headers(token)
        resp = requests.get(
            f"{API_BASE}/member/getInfo",
            headers=headers,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200:
            d = data["data"]
            return {
                "nickname": d.get("nickName", ""),
                "points": d.get("balancePoints", 0),
                "city": d.get("city", ""),
                "province": d.get("province", ""),
                "area": d.get("region", "") or d.get("city", ""),
            }
        return None
    except Exception as e:
        print(f"[会员信息] 异常: {e}")
        return None


def sign_info(token):
    """获取签到状态"""
    try:
        headers = _make_headers(token)
        resp = requests.get(
            f"{API_BASE}/signin/getSignInfo",
            headers=headers,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200:
            d = data["data"]
            return {
                "today": d.get("todaySignIn", False),
                "continuous": d.get("continuousDay", 0),
                "points": sum(item.get("points", 0) for item in d.get("list", [])),
            }
        return None
    except Exception as e:
        print(f"[签到信息] 异常: {e}")
        return None


def sign_in(token):
    """执行签到"""
    try:
        headers = _make_headers(token)
        resp = requests.post(
            f"{API_BASE}/signin/signIn",
            json={},
            headers=headers,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200:
            print("✅ 签到成功")
            return True
        print(f"[签到] 失败: {data.get('msg', data)}")
        return False
    except Exception as e:
        print(f"[签到] 异常: {e}")
        return False


def lottery_info(token):
    """获取抽奖活动信息"""
    try:
        headers = _make_headers(token)
        resp = requests.get(
            f"{API_BASE}/dayActivity/getInfo",
            headers=headers,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200:
            d = data["data"]
            return {
                "id": d.get("id"),
                "name": d.get("name"),
                "cost": d.get("subIntegral", 0),
                "is_limit": d.get("isLimit") == "1",
            }
        return None
    except Exception as e:
        print(f"[抽奖信息] 异常: {e}")
        return None


def lottery_draw(token, city="", province="", area=""):
    """执行抽奖"""
    try:
        headers = _make_headers(token)
        params = {}
        if city:
            params["city"] = city
        if province:
            params["province"] = province
        if area:
            params["area"] = area
        resp = requests.get(
            f"{API_BASE}/dayActivity/doAwards/{ACTIVITY_ID}",
            params=params,
            headers=headers,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == 200:
            d = data["data"]
            if d.get("matched"):
                score = d.get("score", 0)
                print(f"🎁 抽奖成功: +{score}积分")
            else:
                print(f"抽奖: {d.get('msg', '未中奖')}")
            return True
        if "已达上限" in str(data.get("msg", "")) or "已抽" in str(data.get("msg", "")):
            print("今日已抽奖")
            return True
        print(f"[抽奖] 失败: {data.get('msg', data)}")
        return False
    except Exception as e:
        print(f"[抽奖] 异常: {e}")
        return False


def _make_headers(token):
    return {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "xweb_xhr": "1",
        "Referer": f"https://servicewechat.com/{APPID}/71/page-frame.html",
        "Authorization": f"Bearer {token}" if not token.startswith("Bearer ") else token,
        "t": "d4cbd4f7f49c84d8e2c48afbdddd29dc",
    }


def mask_str(s, show=4):
    if not s:
        return "***"
    s = str(s)
    if len(s) <= show * 2:
        return s
    return s[:show] + "***" + s[-show:]


def run_account(openid):
    print(f"\n{'='*40}")
    print(f"账号: {mask_str(openid)}")

    # 缓存验证
    token = _read_cache(openid)
    if token:
        info = member_info(token)
        if info:
            print("[登录] 缓存有效")
        else:
            token = None

    if not token:
        code = get_code(openid)
        if not code:
            print("❌ 获取code失败")
            return
        token = login(code)
        if not token:
            print("❌ 登录失败")
            return
        _write_cache(openid, token)
        print("[登录] WCS刷新成功")

    # 会员信息
    info = member_info(token)
    if info:
        print(f"[会员] {info['nickname']} | 积分: {info['points']} | {info['province']}{info['city']}")

    # 4. 签到
    si = sign_info(token)
    if si:
        if si["today"]:
            print(f"[签到] 今日已签到 (连续{si['continuous']}天)")
        else:
            sign_in(token)
    else:
        print("⚠️ 无法获取签到状态")

    time.sleep(2)

    # 5. 抽奖
    li = lottery_info(token)
    if li:
        print(f"[抽奖] {li['name']} | 消耗: {li['cost']}积分")
        if info and info["points"] >= li["cost"]:
            lottery_draw(token, info.get("city", ""), info.get("province", ""), info.get("area", ""))
        else:
            print(f"[抽奖] 积分不足 ({info.get('points', 0)} < {li['cost']})")
    else:
        print("⚠️ 无法获取抽奖信息")


def main():
    print("=== 巅峰美缝师 ===\n")
    accounts = []
    raw = WX_OPINION or ""
    for a in raw.replace("\n", "&").split("&"):
        a = a.strip()
        if a:
            accounts.append(a)

    if not accounts:
        print("未配置 wx_opinion 环境变量")
        return

    for i, openid in enumerate(accounts):
        if i > 0:
            time.sleep(3 + i * 3)
        run_account(openid.strip())


if __name__ == "__main__":
    main()
