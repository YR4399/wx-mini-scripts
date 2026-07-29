#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""富牛 (FUNIU) 签到 + 抽奖脚本
登录: GET /login?app=1 -> CSRF + captcha.php
      POST /login?app=1 {csrf_token, action=login, phone, password, captcha}
签到: GET /signin -> CSRF + 状态
      POST /signin {csrf_token, action=signin}
抽奖: GET /lottery -> CSRF + 积分
      POST /lottery {csrf_token, action=lottery, wheel_code=public, ajax=1}
"""
import os, sys, json, re, math, time, tempfile, uuid, random, requests, urllib3

for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'
urllib3.disable_warnings()

BASE = 'https://xn--1ctw83c.ntc5fnbe5j.com'
LINE = '=' * 50

DEVICE_POOL = [
    {"brand": "samsung", "model": "SM-S928B", "market": "Galaxy S23 Ultra",
     "android": "14", "build": "UP1A.231005.007", "density": "4.5",
     "width": 1440, "height": 3200, "dpr": "2.5"},
    {"brand": "samsung", "model": "SM-A546B", "market": "Galaxy A54",
     "android": "13", "build": "TP1A.220624.014", "density": "4.0",
     "width": 1080, "height": 2400, "dpr": "2.25"},
    {"brand": "samsung", "model": "SM-G991B", "market": "Galaxy S21",
     "android": "12", "build": "SP1A.210812.016", "density": "4.5",
     "width": 1440, "height": 3200, "dpr": "3.0"},
    {"brand": "Xiaomi", "model": "2304FPN6DC", "market": "Redmi Note 12T",
     "android": "14", "build": "UKQ1.230804.001", "density": "3.5",
     "width": 1080, "height": 2400, "dpr": "2.75"},
    {"brand": "Xiaomi", "model": "22081212C", "market": "Redmi Note 11T",
     "android": "13", "build": "TKQ1.220829.002", "density": "3.0",
     "width": 1080, "height": 2400, "dpr": "2.75"},
    {"brand": "vivo", "model": "V2318A", "market": "vivo X100",
     "android": "14", "build": "UP1A.231005.007", "density": "4.0",
     "width": 1200, "height": 2600, "dpr": "2.5"},
    {"brand": "OPPO", "model": "PGFM10", "market": "OPPO Find X6",
     "android": "14", "build": "UKQ1.230924.001", "density": "4.5",
     "width": 1440, "height": 3168, "dpr": "2.5"},
    {"brand": "HUAWEI", "model": "ALN-AL00", "market": "Mate 60",
     "android": "12", "build": "HUAWEIALN-AL00", "density": "4.0",
     "width": 1116, "height": 2436, "dpr": "2.25"},
]
CHROME_VERSIONS = ["124.0.6367.118", "125.0.6422.165", "126.0.6478.114", "123.0.6312.122", "122.0.6261.105"]
NET_TYPES = ["WIFI", "5G", "4G"]
LANGS = ["zh-CN", "zh-CN,zh;q=0.9"]

HUMAN_DELAY = {
    "query":   (450,  1400),
    "action":  (900,  2600),
    "heavy":   (1200, 3200),
    "browse":  (2500, 6500),
    "think":   (800,  2200),
    "account": (3500, 9000),
    "captcha": (1500, 5000),
    "default": (600,  1800),
}

def _rand_hex(n):
    return os.urandom(n).hex()

def box_muller(mean, minv, maxv):
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

ACCOUNTS = [('19567189385', 'yr123123', '195****9385')]
if not os.environ.get('TWOCAPTCHA_APIKEY'):
    os.environ['TWOCAPTCHA_APIKEY'] = '56c8245006ed3a5bbd407639dbc7cf8c'

# ============================================================
#  构建 headers（不覆盖 Session.headers，避免 CaseInsensitiveDict 冲突）
# ============================================================
def _build_headers(ua, chrome_ver, android_ver, device_model, build,
                   referer=None, dest='document'):
    h = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": random.choice(LANGS),
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": dest,
        "Sec-Fetch-Mode": "navigate" if dest == "document" else "cors",
        "Sec-Fetch-Site": "same-origin" if referer else "none",
        "Sec-Fetch-User": "?1" if dest == "document" else "",
        "Sec-Ch-Ua": f'Google Chrome";v="{chrome_ver.rsplit(".",1)[0]}", "Chromium";v="{chrome_ver.rsplit(".",1)[0]}", "Not A(Brand";v="24"',
        "Sec-Ch-Ua-Platform": "Android",
        "Sec-Ch-Ua-Mobile": "?1",
        "Upgrade-Insecure-Requests": "1" if dest == "document" else "",
        "Cache-Control": "no-cache",
    }
    h = {k: v for k, v in h.items() if v}
    if referer:
        h["Referer"] = referer
    return h

def extract_csrf(html):
    m = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', html)
    return m.group(1) if m else None

def solve_captcha(s, img_url, headers_func):
    try:
        human_delay("captcha")
        r = s.get(img_url, timeout=10, headers=headers_func(dest="image"))
        human_delay("query")
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        tmp.write(r.content)
        tmp.close()
        api_key = os.environ.get('TWOCAPTCHA_APIKEY', '')
        if not api_key:
            print('  [-] TWOCAPTCHA_APIKEY not set')
            return None
        with open(tmp.name, 'rb') as f:
            files = {'file': ('captcha.png', f, 'image/png')}
            r = requests.post('http://2captcha.com/in.php',
                              data={'key': api_key, 'method': 'post', 'json': '1'},
                              files=files, timeout=30, verify=False)
        result = r.json()
        if result.get('status') != 1:
            print(f'  [-] 2Captcha upload error: {result.get("request")}')
            return None
        captcha_id = result.get('request')
        for _ in range(25):
            human_delay("captcha")
            r = requests.get(f'http://2captcha.com/res.php?key={api_key}&action=get&id={captcha_id}&json=1',
                             timeout=15, verify=False)
            result = r.json()
            if result.get('status') == 1:
                code = result.get('request', '')
                print(f'  [+] 验证码识别: {code}')
                return code
        print('  [-] 2Captcha timeout')
        return None
    except Exception as e:
        print(f'  [-] 验证码处理异常: {e}')
        return None

def do_login(s, phone, password, headers_func):
    try:
        human_delay("think")
        r = s.get(f'{BASE}/login?app=1', timeout=15,
                  headers=headers_func(dest="document"))
        human_delay("query")
        html = r.text
    except Exception as e:
        print(f'  [-] 获取登录页失败: {e}')
        return False

    csrf = extract_csrf(html)
    if not csrf:
        print('  [-] 无法提取 CSRF token')
        return False

    captcha = solve_captcha(s, BASE + '/captcha.php', headers_func)
    if not captcha:
        return False

    human_delay("action")
    try:
        data = {
            'csrf_token': csrf, 'action': 'login', 'redirect': 'login',
            'phone': phone, 'password': password, 'captcha': captcha,
        }
        r = s.post(f'{BASE}/login?app=1', data=data, timeout=15,
                   headers=headers_func(f'{BASE}/login?app=1', dest="empty"),
                   allow_redirects=False)
        human_delay("query")
        location = r.headers.get('Location', '')
        print(f'  [+] 登录响应: HTTP {r.status_code}, Location={location}')
        if r.status_code in (301, 302) and ('/home' in location or location == '/home'):
            print('  [+] 登录成功')
            return True
        print(f'  [-] 登录失败, Location={location}')
        return False
    except Exception as e:
        print(f'  [-] 登录请求异常: {e}')
        return False

def do_check_signin(s, headers_func):
    human_delay("query")
    try:
        r = s.get(f'{BASE}/signin', timeout=15,
                  headers=headers_func(f'{BASE}/home', dest="document"))
        human_delay("query")
        html = r.text
        csrf = extract_csrf(html)
        already = 'is-today' in html or 'is-signed' in html
        return already, csrf
    except Exception as e:
        print(f'  [-] 签到页失败: {e}')
        return None, None

def do_signin(s, csrf, headers_func):
    human_delay("action")
    try:
        data = {'csrf_token': csrf, 'action': 'signin'}
        r = s.post(f'{BASE}/signin', data=data, timeout=15,
                   headers=headers_func(f'{BASE}/signin', dest="empty"),
                   allow_redirects=False)
        human_delay("query")
        ok = r.status_code in (301, 302)
        print(f'  [{"+" if ok else "-"}] 签到: HTTP {r.status_code}')
        return ok
    except Exception as e:
        print(f'  [-] 签到异常: {e}')
        return False

def get_points(s, headers_func):
    human_delay("query")
    try:
        r = s.get(f'{BASE}/lottery', timeout=15,
                  headers=headers_func(f'{BASE}/home', dest="document"))
        human_delay("query")
        m = re.search(r'可用积分[^<]*<strong>(\d+)</strong>', r.text)
        return int(m.group(1)) if m else 0
    except:
        return 0

def do_lottery(s, csrf, headers_func):
    human_delay("action")
    try:
        data = {'csrf_token': csrf, 'action': 'lottery', 'wheel_code': 'public', 'ajax': '1'}
        r = s.post(f'{BASE}/lottery', data=data, timeout=15,
                   headers=headers_func(f'{BASE}/lottery', dest="empty"),
                   allow_redirects=False)
        human_delay("query")
        if r.status_code == 200:
            try:
                return r.json()
            except:
                return {'ok': False, 'error': r.text[:100]}
        return {'ok': False, 'error': f'HTTP {r.status_code}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def process(phone, password, display_name, max_retry=3):
    print(f'\n{LINE}')
    print(f'  富牛 - {display_name} ({phone})')
    print(f'{LINE}')

    dev = random.choice(DEVICE_POOL)
    chrome = random.choice(CHROME_VERSIONS)
    ua = (f"Mozilla/5.0 (Linux; Android {dev['android']}; {dev['model']} Build/{dev['build']}; wv) "
          f"AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/{chrome} "
          f"Mobile Safari/537.36")

    def headers_func(referer=None, dest='document'):
        return _build_headers(ua, chrome, dev['android'], dev['model'], dev['build'],
                              referer=referer, dest=dest)

    print(f'  Device: {dev["brand"]} {dev["market"]} Android {dev["android"]}')
    print(f'  Viewport: {dev["width"]}x{dev["height"]} DPR={dev["dpr"]}')

    s = requests.Session()
    s.verify = False

    ok = False
    for attempt in range(max_retry):
        human_delay("account")
        ok = do_login(s, phone, password, headers_func)
        if ok:
            break
        if attempt < max_retry - 1:
            print(f'  [-] 重试登录 ({attempt + 1}/{max_retry})...')
            human_delay("account")
    if not ok:
        return f'FAIL {display_name}: login'

    human_delay("think")
    already, csrf = do_check_signin(s, headers_func)
    if already is None:
        return f'FAIL {display_name}: signin page error'
    if already:
        print('  [i] 今日已签到')
        signed = 'already'
    else:
        if do_signin(s, csrf, headers_func):
            print('  [+] 签到成功')
            signed = 'yes'
        else:
            print('  [-] 签到失败')
            signed = 'no'

    human_delay("think")
    try:
        r = s.get(f'{BASE}/lottery', timeout=15,
                  headers=headers_func(f'{BASE}/home', dest="document"))
        l_csrf = extract_csrf(r.text)
    except:
        l_csrf = csrf

    points = get_points(s, headers_func)
    print(f'  [+] 可用积分: {points}')

    lottery_result = ''
    if l_csrf and points >= 5:
        result = do_lottery(s, l_csrf, headers_func)
        if result.get('ok'):
            msg = result.get('message', '')
            print(f'  [+] 抽奖: {msg}')
            lottery_result = f'[{msg}]'
        else:
            err = result.get('error', 'unknown')
            print(f'  [-] 抽奖: {err}')
            lottery_result = f'[FAIL: {err}]'
    elif not l_csrf:
        print('  [-] 无法获取 CSRF，跳过抽奖')
    else:
        print(f'  [-] 积分不足 ({points} < 5)，跳过抽奖')

    return f'{display_name}: 签到={signed}, 抽奖={lottery_result or "skip"}, 积分={points}'

def main():
    print(f'\n  富牛签到+抽奖脚本 - 开始执行\n')
    random.seed(time.time())
    results = []
    for phone, password, display_name in ACCOUNTS:
        try:
            result = process(phone, password, display_name)
            results.append(result)
        except Exception as e:
            print(f'\n  [!] {display_name} 异常: {e}')
            results.append(f'FAIL {display_name}: exception - {str(e)}')
        human_delay("account")

    print(f'\n{LINE}')
    print('  执行完成 - 汇总')
    print(f'{LINE}')
    summary = '\n'.join(results)
    for r in results:
        print(f'  {r}')
    print(f'\n  汇总:\n{summary}')

    try:
        os.chdir(os.path.dirname(os.path.abspath(__file__)))
        from _push_helper import push_notify
        push_notify(title='富牛签到结果', content=summary)
    except:
        print('  [!] 推送模块未加载')

if __name__ == '__main__':
    main()
