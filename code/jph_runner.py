#!/usr/bin/env python3
"""君品荟签到 - 支持从宿主机或容器内运行
滑块验证码: 本地模板匹配 + AES-ECB 加密
"""
import os, sys, subprocess
# 清除代理（必须在 import 之前）
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'

# 自动安装缺失依赖
def _ensure(pkg, pip_name=None):
    try:
        __import__(pkg)
    except ImportError:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', pip_name or pkg, '-q', '--break-system-packages'])
_ensure('numpy'); _ensure('scipy'); _ensure('PIL', 'Pillow'); _ensure('requests'); _ensure('Crypto', 'pycryptodome')

import json, time, io, base64
import numpy as np
import requests
from PIL import Image
from scipy.signal import correlate2d
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

requests.packages.urllib3.disable_warnings()

APPID = 'wx8d41cdc44c8aeaab'
BASE = 'https://fm.exijiu.com'
AUTH_BASIC = 'Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ='
WCS_AUTH = '976dc5b3977cd2cbb8c61ddd32e9f885'
WCS_INTERNAL = 'http://host.docker.internal:18788'

ACCOUNTS = [
    ('owNAX6j83m4TzrbIA5R3iNXM1iY0', '陌白'),
    ('owNAX6ue8pWjcCwrfF-A3M9pgMNw', '陌白白'),
    ('owNAX6vYHRZK81cK3dEFTonp9RzA', 'ww'),
]

def get_wx_code(openid):
    body = {"openid": openid, "appid": APPID}
    body_str = json.dumps(body)
    # 方法1: wget --no-proxy (容器内最可靠)
    try:
        cmd = f'wget -qO- --no-proxy --timeout=15 --post-data=\'{body_str}\' --header="auth: {WCS_AUTH}" --header="Content-Type: application/json" {WCS_INTERNAL}/wx/code'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, encoding='utf-8', errors='replace')
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            if data.get('status') and data.get('data', {}).get('code'):
                return data['data']['code']
    except Exception:
        pass
    # 方法2: requests (宿主机)
    try:
        r = requests.post(f'{WCS_INTERNAL}/wx/code', json=body,
                          headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                          timeout=30, proxies={'http': None, 'https': None})
        data = r.json()
        if data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
    except Exception:
        pass
    # 方法3: wsl docker exec (宿主机备选)
    try:
        cmd = f'wsl docker exec wechatserver wget -qO- --timeout=15 --post-data=\'{body_str}\' --header="auth: {WCS_AUTH}" --header="Content-Type: application/json" http://localhost:8787/wx/code'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60, encoding='utf-8', errors='replace')
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            if data.get('status') and data.get('data', {}).get('code'):
                return data['data']['code']
    except Exception:
        pass
    return None

def login(code):
    h = {'Content-Type': 'application/json', 'appid': APPID, 'authorization': AUTH_BASIC, 'app-version': '1.0.0'}
    r = requests.post(f'{BASE}/api/v2/login/wxMiniSilentLogin', json={'code': code}, headers=h, timeout=15, verify=False)
    d = r.json()
    if d.get('success'):
        return d['data']['token'], d['data'].get('phone', '')
    return None, None

def make_h(token):
    return {'X-Access-Token': token, 'Content-Type': 'application/json', 'appid': APPID, 'authorization': AUTH_BASIC, 'app-version': '1.0.0'}

def check_sign(token):
    r = requests.post(f'{BASE}/api/customer/daily/checkTodaySignIn', json={}, headers=make_h(token), timeout=15, verify=False)
    return r.json().get('data', False)

def detect_gap(bg_b64, slider_b64):
    """本地模板匹配检测缺口 x 坐标"""
    bg = np.array(Image.open(io.BytesIO(base64.b64decode(bg_b64))).convert('L'))
    if slider_b64:
        sl = np.array(Image.open(io.BytesIO(base64.b64decode(slider_b64))).convert('L'))
        bg_n = (bg - bg.mean()) / (bg.std() + 1e-6)
        sl_n = (sl - sl.mean()) / (sl.std() + 1e-6)
        corr = correlate2d(bg_n, sl_n, mode='valid')
        return int(np.unravel_index(np.argmax(corr), corr.shape)[1])
    from scipy import ndimage
    edge = np.abs(ndimage.sobel(bg, axis=1)).mean(axis=0)
    edge[:50] = 0
    return int(np.argmax(edge))

def solve_captcha(token):
    """获取验证码 → 本地检测缺口 → AES-ECB 加密 → 提交"""
    h = make_h(token)
    r = requests.post(f'{BASE}/api/captcha/get', json={}, headers=h, timeout=15, verify=False)
    d = r.json()
    if not d.get('success'):
        return None
    rd = d['data']['repData']
    ct, sk = rd['token'], rd['secretKey']
    x = detect_gap(rd['originalImageBase64'], rd.get('jigsawImageBase64', ''))
    print(f"  缺口: x={x}")
    pd = json.dumps({"x": round(x), "y": 5, "t": int(time.time()*1000), "sk": sk[:16]}, separators=(',',':'))
    enc = base64.b64encode(AES.new(sk.encode(), AES.MODE_ECB).encrypt(pad(pd.encode(), 16))).decode()
    r2 = requests.post(f'{BASE}/api/captcha/check', json={'token': ct, 'pointJson': enc}, headers=h, timeout=15, verify=False)
    if r2.json().get('data',{}).get('success'):
        print("  ✅ 验证码通过")
        return ct
    print(f"  ❌ 验证码失败: {r2.json().get('data',{}).get('repMsg','')}")
    return None

def do_sign(token, code):
    h = make_h(token)
    for i in range(3):
        ct = solve_captcha(token)
        body = {'code': code, 'channelCode': 'xj_mall_wx_applet'}
        if ct: body['captchaToken'] = ct
        r = requests.post(f'{BASE}/api/customer/daily/fillSignIn', json=body, headers=h, timeout=15, verify=False)
        d = r.json()
        if d.get('success'): return True, d.get('data',{}).get('resultDesc','成功')
        if '验证码' in d.get('message','') and i < 2:
            print(f"  重试 ({i+2}/3)..."); time.sleep(2); continue
        return False, d.get('message','未知')
    return False, '重试用完'

def process(openid, remark):
    print(f"\n{'='*50}\n账号: {remark} ({openid[:12]}...)\n{'='*50}")
    code = get_wx_code(openid)
    if not code: print("  ❌ 获取 code 失败"); return False
    print(f"  ✅ code: {code[:20]}...")
    token, phone = login(code)
    if not token: print("  ❌ 登录失败"); return False
    print(f"  ✅ 登录成功 ({phone})")
    if check_sign(token): print("  ✅ 今日已签到"); return True
    print("  签到...")
    ok, msg = do_sign(token, code)
    if ok: print(f"  ✅ {msg}"); return True
    print(f"  ❌ {msg}"); return False

def main():
    print(f"{'='*50}\n君品荟 签到\n{time.strftime('%Y-%m-%d %H:%M:%S')}\n{'='*50}")
    ok = 0
    for oid, rm in ACCOUNTS:
        try:
            if process(oid, rm): ok += 1
        except Exception as e:
            print(f"  ❌ {e}")
        time.sleep(3)
    print(f"\n完成: {ok}/{len(ACCOUNTS)} 成功")

if __name__ == '__main__':
    main()
