#!/usr/bin/env python3
"""君品荟签到+花园 - 支持从宿主机或容器内运行
滑块验证码: 本地模板匹配 + AES-ECB 加密
花园功能: sessionKey保存、签到、高粱收获
"""
import os, sys, subprocess
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'

def _ensure(pkg, pip_name=None):
    try:
        __import__(pkg)
    except ImportError:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', pip_name or pkg, '-q', '--break-system-packages'])
_ensure('numpy'); _ensure('scipy'); _ensure('PIL', 'Pillow'); _ensure('requests'); _ensure('Crypto', 'pycryptodome')

import json, time, io
import numpy as np
import requests
from PIL import Image
from scipy.signal import correlate2d
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

requests.packages.urllib3.disable_warnings()

APPID = 'wx8d41cdc44c8aeaab'
BASE = 'https://fm.exijiu.com'
GARDEN_BASE = 'https://apimallwm.exijiu.com'
AUTH_BASIC = 'Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ='
WCS_AUTH = '976dc5b3977cd2cbb8c61ddd32e9f885'
WCS_INTERNAL = 'http://172.17.0.3:8787'

ACCOUNTS = [
    ('owNAX6j83m4TzrbIA5R3iNXM1iY0', '陌白'),
    ('owNAX6ue8pWjcCwrfF-A3M9pgMNw', '陌白白'),
    ('owNAX6vYHRZK81cK3dEFTonp9RzA', 'ww'),
]


def get_wx_code(openid):
    body = {"openid": openid, "appid": APPID}
    body_str = json.dumps(body)
    try:
        cmd = f'wget -qO- --no-proxy --timeout=15 --post-data=\'{body_str}\' --header="auth: {WCS_AUTH}" --header="Content-Type: application/json" {WCS_INTERNAL}/wx/code'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, encoding='utf-8', errors='replace')
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            if data.get('status') and data.get('data', {}).get('code'):
                return data['data']['code']
    except Exception:
        pass
    try:
        r = requests.post(f'{WCS_INTERNAL}/wx/code', json=body,
                          headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                          timeout=30, proxies={'http': None, 'https': None})
        data = r.json()
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
    bg = np.array(Image.open(io.BytesIO(bytes.fromhex(bg_b64))).convert('L'))
    if slider_b64:
        sl = np.array(Image.open(io.BytesIO(bytes.fromhex(slider_b64))).convert('L'))
        bg_n = (bg - bg.mean()) / (bg.std() + 1e-6)
        sl_n = (sl - sl.mean()) / (sl.std() + 1e-6)
        corr = correlate2d(bg_n, sl_n, mode='valid')
        return int(np.unravel_index(np.argmax(corr), corr.shape)[1])
    from scipy import ndimage
    edge = np.abs(ndimage.sobel(bg, axis=1)).mean(axis=0)
    edge[:50] = 0
    return int(np.argmax(edge))


def solve_captcha(token):
    h = make_h(token)
    r = requests.post(f'{BASE}/api/captcha/get', json={}, headers=h, timeout=15, verify=False)
    d = r.json()
    if not d.get('success'):
        return None
    rd = d['data']['repData']
    ct, sk = rd['token'], rd['secretKey']
    x = detect_gap(rd['originalImageBase64'], rd.get('jigsawImageBase64', ''))
    print(f"  缺口: x={x}")
    import base64
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


# ==================== 花园功能 ====================

def garden_make_h(token):
    return {
        'X-Access-Token': token,
        'Content-Type': 'application/json',
        'AppID': APPID,
        'Authorization': AUTH_BASIC,
        'App-Version': '1.0.0',
    }


def garden_save_session_key(token, code):
    h = garden_make_h(token)
    try:
        r = requests.get(f'{GARDEN_BASE}/garden/wechat/saveSessionKey?code={code}', headers=h, timeout=15, verify=False)
        try:
            d = r.json()
            if d.get('success'):
                print("  ✅ 花园sessionKey保存成功")
                return True
            print(f"  ⚠️ 花园sessionKey: {d.get('message', '未知')}")
            return False
        except Exception:
            if r.status_code == 200:
                print("  ✅ 花园sessionKey已保存")
                return True
            print(f"  ⚠️ 花园sessionKey: HTTP {r.status_code}")
            return False
    except Exception as e:
        print(f"  ❌ 花园sessionKey异常: {e}")
        return False


def garden_get_member_info(token):
    h = garden_make_h(token)
    try:
        r = requests.get(f'{GARDEN_BASE}/garden/Gardenmemberinfo/getMemberInfo', headers=h, timeout=15, verify=False)
        d = r.json()
        if d.get('success'):
            info = d.get('data', {})
            print(f"  🌱 等级: {info.get('level_name', '未知')}, 积分: {info.get('integration', 0)}, 浇水: {info.get('water', 0)}, 施肥: {info.get('manure', 0)}, 高粱: {info.get('sorghum', 0)}, 小麦: {info.get('wheat', 0)}")
            return info
        print(f"  ⚠️ 花园信息: {d.get('message', '未知')}")
        return None
    except Exception as e:
        print(f"  ❌ 花园信息异常: {e}")
        return None


def garden_get_sorghum_index(token):
    h = garden_make_h(token)
    try:
        r = requests.get(f'{GARDEN_BASE}/garden/sorghum/index', headers=h, timeout=15, verify=False)
        d = r.json()
        if d.get('success'):
            fields = d.get('data', [])
            planted = [f for f in fields if f.get('status', -1) > 0]
            print(f"  🌾 高粱田: {len(planted)}/{len(fields)} 块已种植")
            return fields
        return []
    except Exception as e:
        print(f"  ❌ 高粱信息异常: {e}")
        return []


def garden_encrypt_data(session_key, ts=None):
    """生成花园加密数据 - hex编码"""
    if ts is None:
        ts = int(time.time() * 1000)
    try:
        key = session_key[:16].encode()
        data = json.dumps({'ts': ts}, separators=(',',':')).encode()
        cipher = AES.new(key, AES.MODE_ECB)
        encrypted = cipher.encrypt(pad(data, 16))
        return ts, encrypted.hex()
    except Exception:
        return ts, None


def garden_sign(token, session_key):
    h = garden_make_h(token)
    ts, enc = garden_encrypt_data(session_key)
    if not enc:
        print("  ❌ 加密失败")
        return False
    try:
        r = requests.post(f'{GARDEN_BASE}/garden/sign/dailySign', json={'ts': ts, 'encryptData': enc, 'version': 8}, headers=h, timeout=15, verify=False)
        d = r.json()
        if d.get('success'):
            print("  ✅ 花园签到成功!")
            return True
        msg = d.get('message', '')
        if '已签' in msg:
            print("  ✅ 花园今日已签到")
            return True
        print(f"  ⚠️ 花园签到: {msg}")
        return False
    except Exception as e:
        print(f"  ❌ 花园签到异常: {e}")
        return False


def garden_harvest(token, session_key, field_id):
    h = garden_make_h(token)
    ts, enc = garden_encrypt_data(session_key)
    if not enc:
        print("  ❌ 加密失败")
        return False
    try:
        r = requests.post(f'{GARDEN_BASE}/garden/sorghum/harvest', json={'id': field_id, 'ts': ts, 'encryptData': enc, 'version': 8}, headers=h, timeout=15, verify=False)
        d = r.json()
        if d.get('success'):
            print("  ✅ 收获成功!")
            return True
        print(f"  ⚠️ 收获: {d.get('message', '未知')}")
        return False
    except Exception as e:
        print(f"  ❌ 收获异常: {e}")
        return False


def process(openid, remark):
    print(f"\n{'='*50}\n账号: {remark} ({openid[:12]}...)\n{'='*50}")

    code = get_wx_code(openid)
    if not code:
        print("  ❌ 获取 code 失败")
        return False
    print(f"  ✅ code: {code[:20]}...")

    token, phone = login(code)
    if not token:
        print("  ❌ 登录失败")
        return False
    print(f"  ✅ 登录成功 ({phone})")

    # 商城签到
    print("\n  [商城签到]")
    if check_sign(token):
        print("  ✅ 今日已签到")
    else:
        print("  签到中...")
        ok, msg = do_sign(token, code)
        if ok:
            print(f"  ✅ {msg}")
        else:
            print(f"  ❌ {msg}")

    # 花园功能
    print("\n  [花园]")
    garden_save_session_key(token, code)
    time.sleep(1)

    member_info = garden_get_member_info(token)
    time.sleep(1)

    sorghum_fields = garden_get_sorghum_index(token)
    time.sleep(1)

    garden_sign(token, code)
    time.sleep(1)

    if sorghum_fields:
        for field in sorghum_fields:
            if field.get('status') == 2:
                garden_harvest(token, code, field['id'])
                time.sleep(1)

    return True


def main():
    print(f"{'='*50}\n君品荟 签到+花园\n{time.strftime('%Y-%m-%d %H:%M:%S')}\n{'='*50}")
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
