"""
@Description: 袋鼠环保签到
cron: 20 8 * * *
"""
import sys, json, time, os, requests, urllib3
from _push_helper import send_push_notify  # 自动采集日志并推送

urllib3.disable_warnings()

APPID = "wxef20c241ccc93155"
BASE = "https://www.lvdhb.com/MiniProgramApiCore"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"
WX_SERVER_URL = os.getenv("wx_server_url", "http://172.17.0.3:8787")
WX_AUTH = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")


CACHE_FILE = "袋鼠环保签到_token.json"
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
             "Referer": f"https://servicewechat.com/{APPID}/331/page-frame.html"}
        r = requests.put(f"{BASE}/api/v3/login/auth",
                         json={"Source": "jywhs", "Code": code},
                         headers=h, timeout=20, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        token = d.get("token")
        if token:
            return token, d.get("i", "")
        print(f"[登录] {d}")
        return None, None
    except Exception as e:
        print(f"[登录] {e}")
        return None, None


def sign(token):
    try:
        h = {"Content-Type": "application/json", "User-Agent": UA, "xweb_xhr": "1",
             "Referer": f"https://servicewechat.com/{APPID}/331/page-frame.html",
             "token": token}
        r = requests.post(f"{BASE}/api/v3/Login/Sign", json={},
                          headers=h, timeout=20, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        if d.get("Success") or d.get("Code") == 0:
            data = d.get("Data", "")
            print(f"✅ 签到成功: {data}")
            return True
        if "已签" in str(d):
            print("今日已签到")
            return True
        print(f"[签到] {d}")
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
    token, uid = login(code)
    if not token: return print("❌ 登录")
    print(f"[登录] uid={uid}")
    _write_cache(openid, token)
    sign(token)


if __name__ == "__main__":
    print("=== 袋鼠环保 ===\n")
    accts = [a.strip() for a in (WX_OPINION or "").replace("\n", "&").split("&") if a.strip()]
    if not accts: print("未配置 wx_opinion"); exit()
    for i, a in enumerate(accts):
        if i: time.sleep(3 + i * 3)
        run(a)
