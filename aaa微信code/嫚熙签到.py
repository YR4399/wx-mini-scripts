"""
@Description: 嫚熙签到（有赞平台）
cron: 10 8 * * *
"""
import sys
import json
import time
import os
import uuid
import requests
import urllib3

urllib3.disable_warnings()

APPID = "wx1386ec22011eac38"
KDT_ID = "90834483"
CHECKIN_ID = "21989"

WX_SERVER_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WX_AUTH = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF"
)


CACHE_FILE = "嫚熙签到_token.json"
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
            with open(p) as f: c = json.load(f)
        except: pass
        c[openid] = token
        with open(p, "w") as f: json.dump(c, f)
    except: pass


def get_code(openid):
    try:
        resp = requests.post(
            f"{WX_SERVER_URL}/wx/code",
            json={"appid": APPID, "openid": openid},
            headers={"auth": WX_AUTH},
            timeout=60, proxies={"http": None, "https": None}, verify=False,
        )
        data = resp.json()
        return data.get("data", {}).get("code") or data.get("code")
    except Exception as e:
        print(f"[WCS] code异常: {e}")
        return None


def login(code):
    try:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": f"https://servicewechat.com/{APPID}/74/page-frame.html",
            "Extra-Data": json.dumps({
                "sid": "",
                "version": "2.237.7.101",
                "clientType": "weapp-miniprogram",
                "client": "weapp",
                "bizEnv": "",
                "uuid": str(uuid.uuid4()).replace("-", "")[:24],
                "ftime": int(time.time() * 1000),
            }),
        }
        payload = {
            "appId": APPID,
            "code": code,
            "platformName": "weapp",
            "signature": "windows",
            "clientBiz": "weapp_wsc",
            "inWsc": True,
            "kdtId": KDT_ID,
            "extraBizData": {
                "enterOptions": {
                    "extKdtId": int(KDT_ID),
                    "path": "pages/home/dashboard/index",
                    "query": {},
                    "scene": 1005,
                    "referrerInfo": {},
                    "apiCategory": "default",
                },
                "guideBizDataMap": {"from_params": ""},
                "sceneData": {},
            },
        }
        resp = requests.post(
            f"https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APPID}",
            json=payload, headers=headers, timeout=20,
            proxies={"http": None, "https": None}, verify=False,
        )
        data = resp.json()
        if data.get("code") == 0:
            d = data["data"]
            return d.get("accessToken"), d.get("sessionId", "")
        print(f"[登录] 失败: {data.get('msg', data)}")
        return None, None
    except Exception as e:
        print(f"[登录] 异常: {e}")
        return None, None


def checkin(access_token, session_id):
    try:
        headers = {
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Referer": f"https://servicewechat.com/{APPID}/74/page-frame.html",
            "Extra-Data": json.dumps({
                "is_weapp": 1,
                "sid": session_id,
                "version": "2.237.7.101",
                "client": "weapp",
                "bizEnv": "wsc",
                "uuid": str(uuid.uuid4()).replace("-", "")[:24],
                "ftime": int(time.time() * 1000),
            }),
        }
        resp = requests.get(
            "https://h5.youzan.com/wscump/checkin/checkinV2.json",
            params={
                "checkinId": CHECKIN_ID,
                "app_id": APPID,
                "kdt_id": KDT_ID,
                "access_token": access_token,
            },
            headers=headers, timeout=20,
            proxies={"http": None, "https": None}, verify=False,
        )
        data = resp.json()
        if data.get("code") == 0 and data.get("data", {}).get("success"):
            awards = data["data"].get("list", [])
            a_str = ", ".join(a.get("infos", {}).get("title", "") for a in awards)
            print(f"✅ 签到成功: {a_str}")
            return True
        if "已达上限" in str(data) or "已签到" in str(data):
            print("今日已签到")
            return True
        print(f"[签到] {data.get('msg', data)}")
        return False
    except Exception as e:
        print(f"[签到] 异常: {e}")
        return False


def mask(s, n=4):
    s = str(s)
    return s[:n] + "***" + s[-n:] if len(s) > n * 2 else s


def run(openid):
    print(f"\n{'='*40}\n账号: {mask(openid)}")

    cached = _read_cache(openid)
    if cached:
        print("[缓存] 尝试使用缓存token")
        if checkin(cached.get("token"), cached.get("sid")):
            return
        print("[缓存] 无效，重新登录")

    code = get_code(openid)
    if not code:
        print("❌ code获取失败")
        return

    token, sid = login(code)
    if not token:
        print("❌ 登录失败")
        return
    print("[登录] 成功")

    _write_cache(openid, {"token": token, "sid": sid})

    checkin(token, sid)


def main():
    print("=== 嫚熙签到 ===\n")
    raw = WX_OPINION or ""
    accounts = [a.strip() for a in raw.replace("\n", "&").split("&") if a.strip()]
    if not accounts:
        print("未配置 wx_opinion")
        return
    for i, oid in enumerate(accounts):
        if i > 0:
            time.sleep(3 + i * 3)
        run(oid.strip())


if __name__ == "__main__":
    main()
