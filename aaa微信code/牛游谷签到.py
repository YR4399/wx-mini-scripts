"""
@Description: 牛游谷签到
cron: 15 8 * * *
"""

# ==================== 推送 ====================
import sys, json, time, os, requests, urllib3
from std_report import report

urllib3.disable_warnings()

APPID = "wxfa2a1ee65e3c9122"
BASE = "https://app.niuyougu.com.cn"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF"
)
wx_server_url = os.getenv("wx_server_url", "http://host.docker.internal:18788")
wx_auth = os.getenv("wx_auth", "")
WX_OPINION = os.getenv("wx_opinion", "")


CACHE_FILE = "牛游谷签到_token.json"
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
        r = requests.post(f"{wx_server_url}/wx/code", json={"appid": APPID, "openid": openid},
                          headers={"auth": wx_auth}, timeout=60, proxies={"http": None, "https": None})
        return (r.json().get("data", {}).get("code") or r.json().get("code"))
    except Exception as e:
        print(f"[WCS] {e}")
        return None


def login(code):
    try:
        h = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "xweb_xhr": "1",
             "Referer": f"https://servicewechat.com/{APPID}/13/page-frame.html"}
        r = requests.post(f"{BASE}/api/user/wxlogin", data=f"token=&code={code}&channelId=0",
                          headers=h, timeout=20, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        if d.get("code") == 0:
            return d["data"].get("token"), d["data"].get("uid", "")
        print(f"[登录] {d}")
        return None, None
    except Exception as e:
        print(f"[登录] {e}")
        return None, None


def sign(token):
    try:
        ts = str(int(time.time() * 1000))
        h = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "xweb_xhr": "1",
             "Referer": f"https://servicewechat.com/{APPID}/13/page-frame.html"}
        r = requests.post(f"{BASE}/api/user/sign", data=f"token={token}&eid=1&_t={ts}",
                          headers=h, timeout=20, proxies={"http": None, "https": None}, verify=False)
        d = r.json()
        if d.get("code") == 0:
            print("✅ 签到成功")
            return "签到成功"
        if "已签到" in str(d):
            print("今日已签到")
            return "今日已签到"
        print(f"[签到] {d.get('msg', d)}")
        return None
    except Exception as e:
        print(f"[签到] {e}")
        return None


def mask(s, n=4):
    s = str(s)
    return s[:n] + "***" + s[-n:] if len(s) > n * 2 else s


def run(raw):
    if '#' in raw:
        openid, remark = raw.split('#', 1)
    else:
        openid, remark = raw, ''
    _name = remark.strip() if remark and remark.strip() else mask(openid)
    print(f"\n{'='*40}\n账号: {_name}")
    _sign = None

    cached = _read_cache(openid)
    if cached:
        print("[缓存] 尝试使用缓存token")
        st = sign(cached)
        if st:
            _sign = st
            return {'name': _name, 'sign': _sign, 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}
        print("[缓存] 无效，重新登录")

    code = get_code(openid)
    if not code:
        print("❌ code")
        return {'name': _name, 'sign': '获取code失败', 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}
    token, uid = login(code)
    if not token:
        print("❌ 登录")
        return {'name': _name, 'sign': '登录失败', 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}
    print(f"[登录] uid={uid}")
    _write_cache(openid, token)
    st = sign(token)
    if st:
        _sign = st
    return {'name': _name, 'sign': _sign, 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}


if __name__ == "__main__":
    print("=== 牛游谷 ===\n")
    accts = [a.strip() for a in (WX_OPINION or "").replace("\n", "&").split("&") if a.strip()]
    if not accts:
        print("未配置 wx_opinion")
        exit()
    _rows = []
    for i, a in enumerate(accts):
        if i: time.sleep(3 + i * 3)
        _rows.append(run(a))
    try:
        if report:
            report('牛游谷签到', _rows)
    except:
        pass