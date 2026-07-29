#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STKJ (SenseTime) Sign-in Script
API:  POST /index/index/index  {username, password} -> token
      POST /index/member/qiandao {token}              -> check status
      POST /index/member/qiandao {qiandao:1, token}   -> execute sign-in
      POST /index/member/token_overview {token}       -> account overview
"""
import os, sys, json, math, time, uuid, random, requests, urllib3
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'
urllib3.disable_warnings()

BASE = 'https://stkj.stkj2026ai.com'
HOST = 'stkj.sense26year.com'
ACCOUNTS = [('19567189385', 'yr123123', '195****9385')]
LINE = '=' * 50

# ============================================================
#           防风控：设备指纹池（含 build、density）
# ============================================================
DEVICE_POOL = [
    {"brand": "samsung", "model": "SM-S928B", "android": "14", "build": "UP1A.231005.007", "density": "4.5"},
    {"brand": "samsung", "model": "SM-A546B", "android": "13", "build": "TP1A.220624.014", "density": "4.0"},
    {"brand": "samsung", "model": "SM-G991B", "android": "12", "build": "SP1A.210812.016", "density": "4.5"},
    {"brand": "Xiaomi", "model": "2304FPN6DC", "android": "14", "build": "UKQ1.230804.001", "density": "3.5"},
    {"brand": "Xiaomi", "model": "22081212C", "android": "13", "build": "TKQ1.220829.002", "density": "3.0"},
    {"brand": "vivo", "model": "V2318A", "android": "14", "build": "UP1A.231005.007", "density": "4.0"},
    {"brand": "OPPO", "model": "PGFM10", "android": "14", "build": "UKQ1.230924.001", "density": "4.5"},
    {"brand": "HUAWEI", "model": "ALN-AL00", "android": "12", "build": "HUAWEIALN-AL00", "density": "4.0"},
]
CHROME_VERSIONS = ["124.0.6367.118", "125.0.6422.165", "126.0.6478.114", "123.0.6312.122", "122.0.6261.105"]
WECHAT_VERSIONS = [
    {"ver": "8.0.49.2600", "hex": "2800313A"},
    {"ver": "8.0.50.2701", "hex": "2800321D"},
    {"ver": "8.0.52.2740", "hex": "28003414"},
    {"ver": "8.0.53.2760", "hex": "28003518"},
    {"ver": "8.0.54.2780", "hex": "2800361C"},
]

# ============================================================
#           防风控：分档人工延迟（Box-Muller + 截断）
# ============================================================
HUMAN_DELAY = {
    "query":   (450,  1400),
    "action":  (900,  2600),
    "heavy":   (1200, 3200),
    "browse":  (2500, 6500),
    "think":   (800,  2200),
    "account": (3500, 9000),
    "default": (600,  1800),
}

def _rand_hex(n):
    return os.urandom(n).hex()

def box_muller(mean, minv, maxv):
    """Box-Muller 变换生成高斯随机，带上下界截断"""
    while True:
        u = random.random()
        v = random.random()
        if u > 0:
            break
    z = math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)
    std = (maxv - minv) / 4.0
    val = mean + z * std
    return max(minv, min(maxv, val))

def human_delay(kind="default"):
    minv, maxv = HUMAN_DELAY.get(kind, HUMAN_DELAY["default"])
    mean = (minv + maxv) / 2.0
    ms = box_muller(mean, minv, maxv)
    time.sleep(ms / 1000.0)

# ============================================================
#           会话级指纹（一次运行内对同一账号稳定）
# ============================================================
class STKJSession:
    def __init__(self):
        self._dev = random.choice(DEVICE_POOL)
        self._wc = random.choice(WECHAT_VERSIONS)
        self._chrome = random.choice(CHROME_VERSIONS)
        self._net = random.choice(["WIFI", "5G", "4G"])
        self._mmwebid = str(random.randint(1800, 9999))
        self._xweb = str(random.randint(11700, 12950))
        self._client_id = f"{_rand_hex(8)}-{_rand_hex(4)}-{_rand_hex(4)}-{_rand_hex(4)}-{_rand_hex(12)}"
        self._sid = f"{_rand_hex(8)}-{_rand_hex(8)}"
        self._uid = "0"

    def ua(self):
        ver = random.choice(["3.4", "3.5", "3.6"])
        return "Dart/" + ver + " (dart:io)"

    def headers(self, token="", method="POST"):
        d = self._dev
        h = {
            "user-agent": self.ua(),
            "sid": self._sid,
            "uid": self._uid,
            "host": HOST,
            "content-type": "application/json",
            "token": token,
            "accept-encoding": "gzip, deflate",
            "x-requested-with": "xmlhttprequest",
            "brand": d["brand"],
            "platform": d["brand"],
            "model": d["model"],
            "density": d["density"],
            "client_id": self._client_id,
            "accept-language": random.choice(["zh-CN,zh;q=0.9", "zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"]),
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
        }
        if method == "GET":
            h["sec-fetch-dest"] = "document"
            h["sec-fetch-mode"] = "navigate"
            h["sec-fetch-user"] = "?1"
        return h

# ============================================================
#           API 请求
# ============================================================
def login(s, username, password):
    h = s.headers(token="")
    human_delay("think")
    try:
        r = requests.post(f'{BASE}/index/index/index',
                          json={'username': username, 'password': password},
                          headers=h, timeout=30, verify=False)
        human_delay("query")
        resp = r.json()
        if resp.get('code') == 200 and resp.get('data', {}).get('token'):
            return resp['data']['token'], None
        return None, resp.get('message', 'unknown')
    except Exception as e:
        return None, str(e)

def check_sign(s, token):
    human_delay("query")
    try:
        h = s.headers(token=token)
        r = requests.post(f'{BASE}/index/member/qiandao', json={'token': token},
                          headers=h, timeout=30, verify=False)
        human_delay("query")
        resp = r.json()
        if resp.get('code') != 200:
            return None, resp
        data = resp.get('data', {})
        if isinstance(data, dict):
            member = data.get('member', data)
            qtime = member.get('qiandao_time', 0)
            if qtime and qtime > int(time.time()) - 86400:
                return True, resp
        return False, resp
    except Exception as e:
        return None, {'_error': str(e)}

def do_sign(s, token):
    human_delay("action")
    try:
        h = s.headers(token=token)
        r = requests.post(f'{BASE}/index/member/qiandao',
                          json={'qiandao': 1, 'token': token},
                          headers=h, timeout=30, verify=False)
        human_delay("query")
        resp = r.json()
        data = resp.get('data', {})
        msg = resp.get('message', '')
        if isinstance(data, str):
            if '成功' in data or '签到' in data:
                return True, data, 0, data
            elif '已签到' in data or '明天' in data:
                return None, data, 0, data
            elif '出错' in data or '重试' in data:
                return False, data, 0, data
            return False, data, 0, data
        if resp.get('code') == 200:
            token_give = data.get('token_give', 0) if isinstance(data, dict) else 0
            balance = data.get('balance', '') if isinstance(data, dict) else ''
            return True, balance, token_give, msg
        return False, '', 0, msg
    except Exception as e:
        return False, '', 0, str(e)

def get_overview(s, token):
    human_delay("query")
    try:
        h = s.headers(token=token)
        r = requests.post(f'{BASE}/index/member/token_overview', json={'token': token},
                          headers=h, timeout=30, verify=False)
        resp = r.json()
        if resp.get('code') == 200:
            return resp.get('data', {})
    except:
        pass
    return None

# ============================================================
#           流程
# ============================================================
def process(username, password, display_name, max_retry=3):
    print(f'\n{LINE}')
    print(f'  STKJ Sign-in - {display_name} ({username})')
    print(f'{LINE}')
    s = STKJSession()
    print(f'  Device: {s._dev["brand"]} {s._dev["model"]} Android {s._dev["android"]} Build {s._dev["build"]}')
    print(f'  ClientID: {s._client_id[:16]}...')
    print(f'  UA: {s.ua()[:80]}...')

    token = login_msg = None
    for attempt in range(max_retry):
        human_delay("account")
        token, login_msg = login(s, username, password)
        if token:
            break
        if attempt < max_retry - 1:
            print(f'  Retry login ({attempt+1}/{max_retry})...')
            human_delay("account")
    if not token:
        print(f'  FAIL login: {login_msg}')
        return f'FAIL {display_name}: login - {login_msg}'
    print('  OK login success')

    human_delay("think")
    is_signed, status_resp = check_sign(s, token)
    if is_signed:
        print('  Already signed today')
        ov = get_overview(s, token)
        if ov:
            print(f'  Token balance: {ov.get("token_balance", 0)}')
        return f'OK {display_name}: already signed'
    elif is_signed is None:
        print(f'  FAIL check sign-in: {status_resp.get("_error", "unknown")}')
        return f'FAIL {display_name}: check - {status_resp.get("_error", "unknown")}'

    print('  Not signed yet, executing...')
    human_delay("action")
    ok, balance, token_give, msg = do_sign(s, token)
    if ok:
        print(f'  Sign-in: {msg}')
        ov = get_overview(s, token)
        if ov:
            print(f'  Token balance: {ov.get("token_balance", 0)}')
        return f'OK {display_name}: signed, reward={token_give}'
    elif ok is None:
        print(f'  Already signed (do_sign): {msg}')
        ov = get_overview(s, token)
        if ov:
            print(f'  Token balance: {ov.get("token_balance", 0)}')
        return f'OK {display_name}: already signed'
    else:
        print(f'  FAIL sign-in: {msg}')
        return f'FAIL {display_name}: sign-in - {msg}'

def main():
    print(f'\n  STKJ Sign-in Script - Starting\n')
    random.seed(time.time())
    results = []
    for username, password, display_name in ACCOUNTS:
        try:
            result = process(username, password, display_name)
            results.append(result)
        except Exception as e:
            print(f'\n  Exception: {display_name}: {e}')
            results.append(f'FAIL {display_name}: exception - {str(e)}')
        human_delay("account")
    print(f'\n{LINE}')
    print('  Done - Summary')
    print(f'{LINE}')
    summary = '\n'.join(results)
    for r in results:
        print(f'  {r}')
    print(f'\n  Summary:\n{summary}')
    try:
        os.chdir(os.path.dirname(os.path.abspath(__file__)))
        from _push_helper import push_notify
        push_notify(title='STKJ Sign-in Result', content=summary)
    except:
        pass

if __name__ == '__main__':
    main()
