"""
@Description: 袋鼠环保签到
cron: 20 8 * * *
"""

# ==================== 推送 ====================
import sys, json, time, os, requests, urllib3
from std_report import report

urllib3.disable_warnings()

APPID = "wxef20c241ccc93155"
BASE = "https://www.lvdhb.com/MiniProgramApiCore"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"
wx_server_url = os.getenv("wx_server_url", "http://host.docker.internal:18788")
wx_auth = os.getenv("wx_auth", "")
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
        r = requests.post(f"{wx_server_url}/wx/code", json={"appid": APPID, "openid": openid},
                          headers={"auth": wx_auth}, timeout=60, proxies={"http": None, "https": None})
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



# ---------- 本地累计积分（接口无总积分字段，本机向前累计每日获得）----------
import datetime as _dt
_POINTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "daishu_points_cache.json")
def _read_points():
    try:
        if not os.path.exists(_POINTS_FILE): return {}
        with open(_POINTS_FILE, encoding="utf-8") as f: return json.load(f) or {}
    except Exception: return {}
def _write_points(c):
    try:
        with open(_POINTS_FILE, "w", encoding="utf-8") as f: json.dump(c, f, ensure_ascii=False, indent=2)
    except Exception as e: print(f"写入积分缓存失败: {e}")
def _today():
    return _dt.date.today().isoformat()
def _roll_day(key, cache):
    rec = cache.setdefault(key, {"hist": 0, "gain": 0, "date": _today()})
    if rec.get("date") != _today():
        rec["hist"] = (rec.get("hist") or 0) + (rec.get("gain") or 0); rec["gain"] = 0; rec["date"] = _today()
    return rec
def _add_gain(key, pts, cache):
    rec = _roll_day(key, cache)
    rec["gain"] = (rec.get("gain") or 0) + (pts or 0)
def _cur_total(key, cache):
    rec = cache.get(key) or {"hist": 0, "gain": 0}
    return (rec.get("hist") or 0) + (rec.get("gain") or 0)

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
            try:
                _m = re.search(r"-?\d+", str(data))
                if _m: globals()["_LAST_GAIN"] = int(_m.group(0))
            except Exception:
                pass
            return "签到成功"
        if "已签" in str(d):
            print("今日已签到")
            return "今日已签到"
        print(f"[签到] {d}")
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
            _gain = globals().pop("_LAST_GAIN", None)
            _pc = _read_points(); _roll_day(openid, _pc)
            if _sign == "签到成功" and _gain: _add_gain(openid, _gain, _pc)
            _lt = _cur_total(openid, _pc); _write_points(_pc)
            return {'name': _name, 'sign': _sign, 'earned': (f"今日+{_gain}" if _gain else None), 'total': str(_lt), 'totalLabel': '累计环保金', 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}
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
    _gain = globals().pop("_LAST_GAIN", None)
    _pc = _read_points(); _roll_day(openid, _pc)
    if _sign == "签到成功" and _gain: _add_gain(openid, _gain, _pc)
    _lt = _cur_total(openid, _pc); _write_points(_pc)
    return {'name': _name, 'sign': _sign, 'earned': (f"今日+{_gain}" if _gain else None), 'total': str(_lt), 'totalLabel': '累计环保金', 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}


if __name__ == "__main__":
    print("=== 袋鼠环保 ===\n")
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
            report('袋鼠环保签到', _rows)
    except:
        pass