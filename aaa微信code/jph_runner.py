# ========== 推送通知 ==========
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========

"""君品荟商城签到 - 仅商城签到功能
- 签到检测: POST /api/customer/daily/checkTodaySignIn
- 签到执行: POST /api/customer/daily/fillSignIn (需滑块验证)
- 滑块: /api/captcha/get → 2captcha 识别 → /api/captcha/check → fillSignIn
"""
import os, sys, subprocess, json, time, base64, io
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'

import requests
requests.packages.urllib3.disable_warnings()

APPID = 'wx8d41cdc44c8aeaab'
BASE = 'https://fm.exijiu.com'
AUTH_BASIC = 'Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ='
WCS_LOCAL = 'http://host.docker.internal:18788'
WCS_INTERNAL = 'http://host.docker.internal:18788'
WCS_AUTH = '1509ea7aca117dcbb7e635c0c007d528'
TWOCAPTCHA_KEY = '56c8245006ed3a5bbd407639dbc7cf8c'
# AES 加密密钥
AES_KEY = '7d3a8b9f2c1e5d4a'.encode()

ACCOUNTS = [
    ('oLvh-0ydiGAnlYBAVXbouPVAxXN4', '陌白'),
    ('oLvh-06JSe-78wETfzEs0o0cPAJU', '陌白白'),
    ('oLvh-07UPzQLJuCGIanokS7cdggM', 'ww'),
]

UA = ('Mozilla/5.0 (Linux; Android 14; 2106118C Build/UKQ1.231003.002; wv) '
      'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 '
      'Mobile Safari/537.36')

def _headers(token=None):
    """构建请求头 — 不设置 Accept-Encoding，避免 brotli 压缩导致解析失败"""
    h = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': UA,
        'Referer': f'https://servicewechat.com/{APPID}/218/page-frame.html',
        'AppID': APPID,
        'App-Version': '1.7',
        'Authorization': AUTH_BASIC,
    }
    if token:
        h['X-Access-Token'] = token
    return h

# ============================================================
# WCS 登录
# ============================================================
def _get_wcs_url():
    for url in [WCS_INTERNAL, WCS_LOCAL]:
        try:
            r = requests.post(f'{url}/wx/code', json={'openid': '__probe__'},
                              headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                              timeout=3, proxies={'http': None, 'https': None})
            if r.status_code == 200:
                return url
        except Exception:
            continue
    return WCS_LOCAL

def get_wx_code(openid):
    wcs_url = _get_wcs_url()
    body = {"openid": openid, "appid": APPID}
    try:
        r = requests.post(f'{wcs_url}/wx/code', json=body,
                          headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                          timeout=15, proxies={'http': None, 'https': None})
        data = r.json()
        if data.get('status') and isinstance(data.get('data'), dict) and data['data'].get('code'):
            return data['data']['code']
        if data.get('success') and isinstance(data.get('data'), dict) and data['data'].get('code'):
            return data['data']['code']
        print(f'  ⚠️ code 返回: {json.dumps(data, ensure_ascii=False)[:200]}')
    except Exception as e:
        print(f'  ❌ code 请求失败: {e}')
    return None

def login(code):
    try:
        r = requests.post(f'{BASE}/api/v2/login/wxMiniSilentLogin', json={'code': code},
                          headers=_headers(), timeout=30, verify=False)
        d = r.json()
        if d.get('success'):
            return d['data']['token'], d['data'].get('phone', '')
        msg = d.get('message', '未知')
        print(f'  ⚠️ 登录失败: {msg}')
    except Exception as e:
        print(f'  ❌ 登录异常: {e}')
    return None, None

# ============================================================
# 商城签到
# ============================================================
def check_sign(token):
    """检查今日是否已签到"""
    try:
        r = requests.post(f'{BASE}/api/customer/daily/checkTodaySignIn', json={},
                          headers=_headers(token), timeout=10, verify=False)
        d = r.json()
        if d.get('success'):
            # data 是布尔值: True=已签到, False=未签到
            return bool(d.get('data', False))
    except Exception as e:
        print(f'  ⚠️ 签到状态异常: {e}')
    return False

def aes_encrypt_ecb(data_dict, secret_key):
    """AES-ECB 加密 - 与 JS 脚本一致"""
    try:
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import pad
        key = (secret_key or AES_KEY)[:16]
        if len(key) != 16:
            key = key[:16].ljust(16, b'\0')
        data_str = json.dumps(data_dict, separators=(',', ':'), ensure_ascii=False)
        data_bytes = data_str.encode('utf-8')
        cipher = AES.new(key, AES.MODE_ECB)
        encrypted = cipher.encrypt(pad(data_bytes, 16))
        return base64.b64encode(encrypted).decode('utf-8')
    except ImportError:
        print('  ⚠️ pycryptodome 未安装，无法加密')
        return None
    except Exception as e:
        print(f'  ⚠️ 加密异常: {e}')
        return None

def _submit_2captcha(image_path):
    """上传文件到 2captcha 获取验证码 ID
    返回 (captcha_id, None) 或 (None, error_msg)
    """
    try:
        with open(image_path, 'rb') as f:
            r = requests.post('https://2captcha.com/in.php',
                              data={'key': TWOCAPTCHA_KEY, 'method': 'normal', 'softid': '234'},
                              files={'file': (os.path.basename(image_path), f, 'image/png')},
                              timeout=45)
        txt = r.text.strip()
        if txt.startswith('OK|'):
            return txt.split('|')[1], None
        return None, txt
    except Exception as e:
        return None, str(e)


def _poll_2captcha(captcha_id, timeout=120):
    """轮询 2captcha 获取识别结果
    返回 (x_coord, None) 或 (None, error_msg)
    """
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f'https://2captcha.com/res.php',
                             params={'key': TWOCAPTCHA_KEY, 'action': 'get', 'id': captcha_id},
                             timeout=45)
            txt = r.text.strip()
            if txt.startswith('OK|'):
                result = txt.split('|')[1]
                # 2captcha 返回的是文本，对于缺口图片就是 X 坐标数字
                try:
                    return int(result.strip()), None
                except ValueError:
                    return None, f'无法解析结果: {result}'
            elif txt == 'CAPTCHA_NOT_READY':
                time.sleep(5)
                continue
            else:
                return None, txt
        except Exception as e:
            return None, str(e)
    return None, 'timeout'


def solve_captcha(token):
    """滑块验证码完整流程: get → 2captcha识别 → check"""
    try:
        # Step 1: 获取滑块图片
        r = requests.post(f'{BASE}/api/captcha/get', json={'captchaType': 'blockPuzzle'},
                          headers=_headers(token), timeout=20, verify=False)
        d = r.json()
        if not d.get('success'):
            msg = d.get('message', '')
            if '频繁' in msg or '10分钟' in msg:
                print('  ⚠️ 接口限流，等待后重试...')
                time.sleep(10)
                return solve_captcha(token)
            print(f'  ⚠️ 获取滑块失败: {msg}')
            return False

        rep_data = d['data'].get('repData', {})
        captcha_token = rep_data.get('token', '')
        secret_key = rep_data.get('secretKey', '')
        back_img_b64 = rep_data.get('originalImageBase64', '')
        slide_img_b64 = rep_data.get('jigsawImageBase64', '')

        if not captcha_token or not back_img_b64:
            print('  ⚠️ 滑块数据不完整')
            return False

        # Step 2: 拼接图片提交 2captcha
        try:
            from PIL import Image
            back_data = base64.b64decode(back_img_b64)
            slide_data = base64.b64decode(slide_img_b64)
            back_img = Image.open(io.BytesIO(back_data)).convert('RGB')
            slide_img = Image.open(io.BytesIO(slide_data)).convert('RGB')

            # 缩小滑块图放在背景图下方，方便工人识别
            slide_small = slide_img.resize((back_img.width // 3, slide_img.height // 3))
            combined = Image.new('RGB', (back_img.width, back_img.height + slide_small.height), (255, 255, 255))
            combined.paste(back_img, (0, 0))
            combined.paste(slide_small, (0, back_img.height))

            img_path = '/tmp/captcha_combined.png'
            combined.save(img_path)
        except Exception as e:
            print(f'  ❌ 图片处理失败: {e}')
            return False

        print('  🧩 提交 2captcha 识别...')
        captcha_id, err = _submit_2captcha(img_path)
        if not captcha_id:
            print(f'  ❌ 2captcha 提交失败: {err}')
            return False
        print(f'  📋 任务ID: {captcha_id}')

        x, err = _poll_2captcha(captcha_id)
        if x is None:
            print(f'  ❌ 2captcha 识别失败: {err}')
            return False
        print(f'  🔍 2captcha 识别 x={x}')

        # Step 3: 加密坐标
        point_json = aes_encrypt_ecb({'x': x, 'y': 5}, secret_key)
        if not point_json:
            return False

        # Step 4: 提交校验
        r = requests.post(f'{BASE}/api/captcha/check',
                          json={'captchaType': 'blockPuzzle', 'pointJson': point_json, 'token': captcha_token},
                          headers=_headers(token), timeout=30, verify=False)
        d = r.json()
        if d.get('success'):
            print('  ✅ 滑块验证通过')
            return True
        else:
            msg = d.get('message', '未知')
            print(f'  ⚠️ 滑块校验失败: {msg}')
            # 如果限流，等待后重试
            if '频繁' in msg or '10分钟' in msg:
                print('  ⚠️ 接口限流，等待后重试...')
                time.sleep(15)
                return solve_captcha(token)
            return False

    except Exception as e:
        print(f'  ❌ 滑块异常: {e}')
        return False

def do_sign(token, code):
    """执行商城签到（需先过滑块）"""
    # 先过滑块
    print('  🧩 执行滑块验证...')
    if not solve_captcha(token):
        print('  ❌ 滑块验证失败，跳过签到')
        return False

    # 提交签到
    try:
        r = requests.post(f'{BASE}/api/customer/daily/fillSignIn',
                          json={'code': code, 'channelCode': 'xj_mall_wx_applet'},
                          headers=_headers(token), timeout=30, verify=False)
        d = r.json()
        if d.get('success'):
            print('  ✅ 签到成功!')
            return True
        msg = d.get('message', '')
        if '已签到' in msg or 'today' in msg.lower() or 'already' in msg.lower():
            print('  ✅ 今日已签到')
            return True
        print(f'  ⚠️ 签到: {msg}')
        return False
    except Exception as e:
        print(f'  ❌ 签到异常: {e}')
        return False

# ============================================================
# 主处理流程
# ============================================================
def process(openid, name):
    print(f'\n{"="*50}')
    print(f'  处理账号: {name} ({openid[:15]}...)')
    print(f'{"="*50}')

    # 获取 code
    code = get_wx_code(openid)
    if not code or len(code) < 10:
        print('  ❌ 获取 code 失败')
        return False
    print('  ✅ 获取 code 成功')

    # 登录
    token, phone = login(code)
    if not token:
        print('  ❌ 登录失败')
        return False
    print(f'  ✅ 登录成功 (手机: {phone})')
    time.sleep(1)

    # 商城签到
    print('\n  [商城签到]')
    is_signed = check_sign(token)
    if is_signed:
        print('  ✅ 今日已签到')
    else:
        print('  ⏳ 尚未签到，执行签到...')
        do_sign(token, code)

    print(f'\n  ✅ {name} 处理完成')
    return True

def main():
    NL = chr(10); print(NL + '  🌸 君品荟商城签到 - 开始执行' + NL)
    MAX_ATTEMPTS = int(os.environ.get('JPH_MAX_ATTEMPTS', '5'))
    MAX_TOTAL_RUNS = int(os.environ.get('JPH_MAX_TOTAL_RUNS', '8'))
    account_status = {}
    account_data = {name: (openid, name) for openid, name in ACCOUNTS}
    for name in account_data:
        account_status[name] = False
    total_run = 0
    bar = '=' * 50
    while any(not account_status[n] for n in account_data):
        total_run += 1
        remaining = [n for n in account_data if not account_status[n]]
        if total_run > MAX_TOTAL_RUNS:
            print('⚠️ 已达总轮数上限 ' + str(MAX_TOTAL_RUNS) + '，停止重试')
            break
        if not remaining:
            break
        attempt_count = {n: 1 for n in remaining}
        print(bar)
        print(f'  🔄 第 {total_run} 轮，待处理账号: {", ".join(remaining)}')
        print(f'{bar}')
        for name in remaining:
            openid, _ = account_data[name]
            attempts = attempt_count[name]
            if attempts > MAX_ATTEMPTS:
                print('⛔ ' + name + ' 已达最大重试次数 ' + str(MAX_ATTEMPTS) + '，跳过')
                continue
            try:
                print('▶ [' + name + '] 第 ' + str(attempts) + '/' + str(MAX_ATTEMPTS) + ' 次尝试...')
                ok = process(openid, name)
                if ok:
                    account_status[name] = True
                    print(f'  ✅ {name} 第 {attempts} 次成功！')
                else:
                    attempt_count[name] = attempts + 1
                    wait = min(30 + (attempts - 1) * 10, 120)
                    print(f'  ⏳ {name} 第 {attempts} 次失败，等待 {wait} 秒后重试...')
                    time.sleep(wait)
            except Exception as e:
                print('❌ ' + name + ' 异常: ' + str(e))
                attempt_count[name] = attempts + 1
                time.sleep(30)
        time.sleep(5)
    print(bar)
    print('  执行完成 - 汇总')
    print(bar)
    summary_lines = []
    for name in account_data:
        status = '✅' if account_status[name] else '❌'
        print(f'  {name}: {status}')
        summary_lines.append(f'{name}: {status}')
    summary = chr(10).join(summary_lines)
    print(chr(10) + '  📝 汇总:' + chr(10) + summary)
    push_notify(title='君品荟签到结果', content=summary)


if __name__ == '__main__':
    main()
