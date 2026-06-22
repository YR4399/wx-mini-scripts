"""
@Description: 美的会员 签到
cron: 30 7 * * *
"""
import sys
import json
import time
import os
import requests

APPID = "wx49a622805968d156"
BASE = "https://mcsp.midea.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF"
)

WX_SERVER_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WX_AUTH = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")

API_KEY = "b6db9d5cf2d449538d3a0dd5d77b2e35"
APP_ID_HEADER = "ee07f27990db48109efcccd322d3a873"
APP_SECRET = "2646746f07bb46199aff49002e6dce81"


def get_code(openid):
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
        return (data.get("data", {}).get("code") or data.get("code"))
    except Exception as e:
        print(f"[WCS] code异常: {e}")
        return None


def get_operatedata(openid):
    try:
        resp = requests.post(
            f"{WX_SERVER_URL}/wx/operatedata",
            json={"appid": APPID, "openid": openid},
            headers={"auth": WX_AUTH},
            timeout=120,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("status"):
            return data.get("data", {})
        return None
    except Exception as e:
        print(f"[WCS] operatedata异常: {e}")
        return None


def login(openid):
    code = get_code(openid)
    if not code:
        return None

    op = get_operatedata(openid)
    if not op:
        print("[登录] operatedata获取失败")
        return None

    encrypted_data = op.get("encryptedData", "")
    iv_str = op.get("iv", "")

    try:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": f"https://servicewechat.com/{APPID}/555/page-frame.html",
            "apikey": API_KEY,
            "appId": APP_ID_HEADER,
            "appsecret": APP_SECRET,
            "miniAppVersion": "3.0.275",
            "userKey": "",
        }
        body = {
            "jsCode": code,
            "channelCode": "1.1.1.6.2.78.1.1",
            "encryptedData": encrypted_data,
            "ivStr": iv_str,
            "loginMode": 2,
            "platformType": "WX_MEIDIDAOJIA_MINI",
        }
        resp = requests.post(
            f"{BASE}/api/cms_bff/mcsp-uc-mvip-bff/app/login/wx/mini/getLoginInfo.do",
            json=body,
            headers=headers,
            timeout=30,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == "000000":
            d = data["data"]
            return d.get("ucAccessToken"), d.get("openId", "")
        print(f"[登录] 失败: {data.get('msg', data)}")
        return None, None
    except Exception as e:
        print(f"[登录] 异常: {e}")
        return None, None


def _make_headers(token):
    return {
        "Content-Type": "application/json",
        "User-Agent": UA,
        "xweb_xhr": "1",
        "Referer": f"https://servicewechat.com/{APPID}/555/page-frame.html",
        "apikey": API_KEY,
        "appId": APP_ID_HEADER,
        "appsecret": APP_SECRET,
        "ucAccessToken": token,
    }


def get_member_info(token):
    try:
        h = _make_headers(token)
        resp = requests.post(
            f"{BASE}/api/cms_bff/mcsp-uc-mvip-bff/member/getMfansInfoV2.do",
            json={},
            headers=h,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        if data.get("code") == "000000":
            return data.get("data", {})
        return None
    except Exception as e:
        print(f"[会员] 异常: {e}")
        return None


def sign_in(token):
    """签到 - mvip域名"""
    try:
        h = _make_headers(token)
        body = {
            "apiKey": "3660663068894a0d9fea574c2673f3c0",
        }
        resp = requests.post(
            "https://mvip.midea.cn/my/score/create_daily_score",
            json=body,
            headers=h,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        code = data.get("code")
        if code == 200 or code == "000000" or code == 0:
            print("✅ 签到成功")
            return True
        if "已签到" in str(data) or "已领取" in str(data) or "already" in str(data).lower():
            print("今日已签到")
            return True
        print(f"[签到] {data.get('msg', data)}")
        return False
    except Exception as e:
        print(f"[签到] 异常: {e}")
        return False


def sign_in2(token):
    """签到2 - 活动中心"""
    try:
        h = _make_headers(token)
        body = {
            "apiKey": "3660663068894a0d9fea574c2673f3c0",
        }
        resp = requests.post(
            "https://mvip.midea.cn/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/im/game/page/sign",
            json=body,
            headers=h,
            timeout=15,
            proxies={"http": None, "https": None},
            verify=False,
        )
        data = resp.json()
        code = data.get("code")
        if code == 200 or code == "000000" or code == 0:
            print("✅ 签到2成功")
            return True
        if "已签到" in str(data) or "已领取" in str(data):
            print("签到2: 已完成")
            return True
        print(f"[签到2] {data.get('msg', data)}")
        return False
    except Exception as e:
        print(f"[签到2] 异常: {e}")
        return False


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

    token, open_id = login(openid)
    if not token:
        print("❌ 登录失败")
        return
    print(f"[登录] 成功 | openId: {mask_str(open_id)}")

    info = get_member_info(token)
    if info:
        u = info.get("userinfo", info)
        print(f"[会员] {u.get('NickName', '')} | {u.get('Mobile', '')} | 积分: {u.get('VipGrow', 0)}")

    time.sleep(2)
    sign_in(token)
    time.sleep(2)
    sign_in2(token)


def main():
    print("=== 美的会员 ===\n")
    accounts = []
    for a in (WX_OPINION or "").replace("\n", "&").split("&"):
        a = a.strip()
        if a:
            accounts.append(a)
    if not accounts:
        print("未配置 wx_opinion")
        return
    for i, oid in enumerate(accounts):
        if i > 0:
            time.sleep(3 + i * 3)
        run_account(oid.strip())


if __name__ == "__main__":
    main()
