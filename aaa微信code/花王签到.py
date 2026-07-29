"""
@Description: 花王签到
cron: 35 8 * * *
"""
import sys, json, time, os, requests, urllib3
from _push_helper import send_push_notify  # 自动采集日志并推送

urllib3.disable_warnings()

APPID = "wxcaa47f040261f278"
BASE = "https://kaoshop.kao.com.cn"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"
WX_SERVER_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WX_AUTH = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")


CACHE_FILE = "花王签到_token.json"
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
        r = requests.post(f"{WX_SERVER_URL}/wx/code", json={"appid": APPID, "openid": openid},
                          headers={"auth": WX_AUTH}, timeout=60, proxies={"http": None, "https": None})
        return (r.json().get("data", {}).get("code") or r.json().get("code"))
    except Exception as e:
        print(f"[WCS] {e}")
        return None


def login(code):
    try:
        h = {"Content-Type": "application/json", "User-Agent": UA, "xweb_xhr": "1",
             "Referer": f"https://servicewechat.com/{APPID}/483/page-frame.html"}
        body = {"code": code, "qyCode": "", "authAppId": APPID, "channel": 6, "scene": 1145,
                "latitude": "31.20561", "longitude": "121.51361"}
        r = requests.post(f"{BASE}/kaoshop/user/app/user/login", json=body, headers=h,
                          timeout=20, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        if d.get("code") == "SUCCESS":
            return d["data"].get("token")
        print(f"[登录] {d}")
        return None
    except Exception as e:
        print(f"[登录] {e}")
        return None


def sign(token):
    try:
        h = {"User-Agent": UA, "xweb_xhr": "1",
             "Referer": f"https://servicewechat.com/{APPID}/483/page-frame.html",
             "token": token}
        # 检查是否已签到
        r = requests.get(f"{BASE}/kaoshop/user/app/sign/getLatestSign", headers=h,
                         timeout=15, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        sign_data = d.get("data")
        if sign_data and d.get("code") == "SUCCESS":
            days = sign_data.get("contiDays", 0)
            print(f"今日已签到 (连续{days}天)")
            return True
        # 签到
        body = {}
        r2 = requests.post(f"{BASE}/kaoshop/user/app/sign/sign", json=body, headers=h,
                          timeout=15, proxies={"http": None, "https": None}, verify=False)
        d2 = r2.json()
        if d2.get("code") == "SUCCESS":
            print("✅ 签到成功")
            return True
        print(f"[签到] {d2.get('message', d2)}")
        return False
    except Exception as e:
        print(f"[签到] {e}")
        return False


def mask(s, n=4):
    s = str(s)
    return s[:n] + "***" + s[-n:] if len(s) > n * 2 else s


def run(openid):
    print(f"\n{'='*40}\n账号: {mask(openid)}")

    cached = _read_cache(openid)
    if cached:
        print("[缓存] 尝试使用缓存token")
        if sign(cached):
            return
        print("[缓存] 无效，重新登录")

    code = get_code(openid)
    if not code: return print("❌ code")
    token = login(code)
    if not token: return print("❌ 登录")
    print("[登录] 成功")
    _write_cache(openid, token)
    sign(token)


if __name__ == "__main__":
    print("=== 花王 ===\n")
    accts = [a.strip() for a in (WX_OPINION or "").replace("\n", "&").split("&") if a.strip()]
    if not accts: print("未配置 wx_opinion"); exit()
    for i, a in enumerate(accts):
        if i: time.sleep(3 + i * 3)
        run(a)
