"""
@Description: 嫚熙签到（有赞平台）
cron: 10 8 * * *
"""

from std_report import report, extract_points

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

wx_server_url = os.getenv("wx_server_url", "http://host.docker.internal:18788")
wx_auth = os.getenv("wx_auth", "")
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
            f"{wx_server_url}/wx/code",
            json={"appid": APPID, "openid": openid},
            headers={"auth": wx_auth},
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


def _h5_headers(session_id):
    return {
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


def get_checkin_id(access_token, session_id):
    """动态获取签到活动ID（活动ID可能轮换，失败回落到 CHECKIN_ID）"""
    params = {"app_id": APPID, "kdt_id": KDT_ID, "access_token": access_token}
    endpoints = (
        ("wscump/checkin/show_checkin_page_v2.json", ("checkinId",)),
        ("wscump/checkin/check-in-info.json", ("checkInId", "checkinId", "check_in_id")),
    )
    for path, keys in endpoints:
        try:
            resp = requests.get(
                f"https://h5.youzan.com/{path}",
                params=params, headers=_h5_headers(session_id), timeout=20,
                proxies={"http": None, "https": None}, verify=False,
            )
            d = resp.json().get("data") or {}
            for k in keys:
                if d.get(k):
                    print(f"[活动] 动态 checkinId={d[k]} ({path})")
                    return str(d[k])
        except Exception as e:
            print(f"[活动] {path} 取ID异常: {e}")
    print(f"[活动] 动态取ID失败，回落到 {CHECKIN_ID}")
    return CHECKIN_ID


def checkin(access_token, session_id, checkin_id=CHECKIN_ID):
    try:
        headers = _h5_headers(session_id)
        resp = requests.get(
            "https://h5.youzan.com/wscump/checkin/checkinV2.json",
            params={
                "checkinId": checkin_id,
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
            return '签到成功', (a_str or None), (extract_points(data).get('streak') or None)
        _raw = str(data)
        if any(k in _raw for k in (
                "已达上限", "已签到", "已达最大参与次数", "无法参与", "重复",
                "最大参与次数", "已参与")):
            print("今日已签到")
            return '今日已签到', None, None
        print(f"[签到] {data.get('msg', data)}")
        return '签到失败', None, None
    except Exception as e:
        print(f"[签到] 异常: {e}")
        return '异常', None, None


def mask(s, n=4):
    s = str(s)
    return s[:n] + "***" + s[-n:] if len(s) > n * 2 else s


def run(openid):
    _name = mask(openid)
    _row = {'name': _name, 'sign': '未知', 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'taskEarned': None, 'lottery': None}
    print(f"\n{'='*40}\n账号: {_name}")

    cached = _read_cache(openid)
    if cached:
        print("[缓存] 尝试使用缓存token")
        _cid = get_checkin_id(cached.get("token"), cached.get("sid"))
        _st, _earn, _streak = checkin(cached.get("token"), cached.get("sid"), _cid)
        _row['sign'] = _st
        if _earn:
            _row['earned'] = _earn
        if _streak:
            _row['streak'] = _streak
        return _row
    print("[缓存] 无效，重新登录")

    code = get_code(openid)
    if not code:
        print("❌ code获取失败")
        _row['sign'] = 'code获取失败'
        return _row

    token, sid = login(code)
    if not token:
        print("❌ 登录失败")
        _row['sign'] = '登录失败'
        return _row
    print("[登录] 成功")

    _write_cache(openid, {"token": token, "sid": sid})

    _cid = get_checkin_id(token, sid)
    _st, _earn, _streak = checkin(token, sid, _cid)
    _row['sign'] = _st
    if _earn:
        _row['earned'] = _earn
    if _streak:
        _row['streak'] = _streak
    return _row


def main():
    print("=== 嫚熙签到 ===\n")
    raw = WX_OPINION or ""
    accounts = [a.strip() for a in raw.replace("\n", "&").split("&") if a.strip()]
    if not accounts:
        print("未配置 wx_opinion")
        return
    _rows = []
    for i, oid in enumerate(accounts):
        if i > 0:
            time.sleep(3 + i * 3)
        _rows.append(run(oid.strip()))

    try:
        report('嫚熙签到', _rows)
    except Exception as e:
        print('report 失败:', e)

if __name__ == "__main__":
    main()
