import os
import sys

# 清除代理环境变量
for _k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "*"

import time
import random
import json
import base64
import io
import logging
from datetime import datetime

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, -m, pip, install, requests, -q])
    import requests

try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, -m, pip, install, pycryptodome, -q])
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad

try:
    import numpy as np
    from PIL import Image
    from scipy.signal import correlate2d
    from scipy import ndimage
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, -m, pip, install, numpy, scipy, Pillow, -q])
    import numpy as np
    from PIL import Image
    from scipy.signal import correlate2d
    from scipy import ndimage

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('jph')


# ============ 常量 ============

APPID = 'wx8d41cdc44c8aeaab'  # 君品荟小程序 AppID
MALL_BASE = 'https://fm.exijiu.com'
GARDEN_BASE = 'https://apimallwm.exijiu.com'
AUTH_BASIC = 'Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ='
APP_VERSION = '1.0.0'
CHANNEL_CODE = 'xj_mall_wx_applet'

# 花园加密相关 (运行时从 WCS /wx/encryptkey 获取)
_encrypt_key_cache = {}  # {user_key: {'encryptKey': str, 'iv': str, 'ts': float}}


# ============ 自动缓存配置 ============

_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '.jph_config.json')

_DEFAULT_CONFIG = {
    'wx_server_url': 'http://host.docker.internal:18788',
    'wx_auth':       '',
    'jph':           '',  # 手动 token 降级 (备注#openid#商城token#花园token)
}


def _load_config():
    """三级配置加载: 环境变量 > 缓存文件 > 硬编码默认值"""
    config = dict(_DEFAULT_CONFIG)

    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'r', encoding='utf-8') as f:
                config.update(json.load(f))
        except Exception:
            pass

    env_map = {
        'wx_server_url': 'wx_server_url',
        'wx_auth':       'wx_auth',
        'jph':           'jph',
    }
    updated = False
    for cfg_key, env_name in env_map.items():
        val = os.environ.get(env_name, '')
        if val and val != config.get(cfg_key, ''):
            config[cfg_key] = val
            updated = True

    if updated or not os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            if updated:
                log.info(f'[Config] 已缓存配置 -> {_CACHE_FILE}')
        except Exception:
            pass

    return config


_config = _load_config()
WCS_BASE = _config['wx_server_url']
WCS_AUTH = _config['wx_auth']


# ============ 工具函数 ============

def random_ua():
    """生成随机微信 PC 版 User-Agent (HAR 抓包为 Windows 微信客户端)"""
    versions = [
        '7.0.20.1781(0x6700143B)',
        '7.0.21.1800(0x67001450)',
        '7.0.22.1820(0x67001460)',
    ]
    return (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
        f'MicroMessenger/{random.choice(versions)} '
        'NetType/WIFI MiniProgramEnv/Windows '
        'WindowsWechat/WMPF WindowsWechat(0x63090a13) '
        'UnifiedPCWindowsWechat(0xf254186b) XWEB/19481'
    )


def make_headers():
    """构建微信小程序请求头 (不声明 br, 避免 brotli 解码问题)"""
    return {
        'User-Agent':       random_ua(),
        'Content-Type':     'application/json',
        'xweb_xhr':         '1',
        'Sec-Fetch-Site':   'cross-site',
        'Sec-Fetch-Mode':   'cors',
        'Sec-Fetch-Dest':   'empty',
        'Accept':           '*/*',
        'Accept-Encoding':  'gzip, deflate',  # 不加 br, requests 无法解压 brotli
        'Accept-Language':  'zh-CN,zh;q=0.9',
        'Referer':          f'https://servicewechat.com/{APPID}/209/page-frame.html',
    }


def mall_headers(token):
    """商城系统请求头 (fm.exijiu.com)"""
    h = make_headers()
    h['x-access-token'] = token
    h['appid'] = APPID
    h['authorization'] = AUTH_BASIC
    h['app-version'] = APP_VERSION
    return h


def garden_headers(token):
    """花园系统请求头 (apimallwm.exijiu.com)"""
    h = make_headers()
    h['X-Access-Token'] = token
    h['AppID'] = APPID
    h['Authorization'] = AUTH_BASIC
    h['App-Version'] = APP_VERSION
    return h


# ============ AES-CBC 加密 (花园系统) ============

def aes_cbc_encrypt_pkcs7(plaintext, key_b64, iv_hex):
    """
    AES-CBC + PKCS7 加密, 输出 HEX 字符串

    与君品荟小程序源码 addEncryptData / aesEncryptData 一致:
    - key: base64 解码后的 16 字节
    - iv:  hex 解码后重复至 16 字节 (微信 getLatestUserKey 返回 8 字节 iv)
    - 明文: UTF-8 编码
    - padding: 标准 PKCS7
    - 输出: HEX 字符串 (非 Base64)
    """
    key = base64.b64decode(key_b64)
    iv_raw = bytes.fromhex(iv_hex)
    # iv 只有 8 字节, 重复到 16 字节 (AES block size)
    iv = iv_raw * 2 if len(iv_raw) == 8 else iv_raw

    text_bytes = plaintext.encode('utf-8')
    # PKCS7 padding
    pad_len = 16 - len(text_bytes) % 16
    padded = text_bytes + bytes([pad_len] * pad_len)

    cipher = AES.new(key, AES.MODE_CBC, iv)
    encrypted = cipher.encrypt(padded)
    return encrypted.hex()


def build_encrypt_params(params_dict, user_key):
    """
    构建花园系统加密请求体: 添加 ts + encryptData + version

    Args:
        params_dict: 业务参数 dict (如 {'id': 1527154, 'type': 1})
        user_key: WCS user_key (用于查找缓存的加密密钥)

    Returns:
        dict: 完整请求体 {'ts': ..., 'encryptData': ..., 'version': ..., ...其他业务参数}
    """
    cached = _encrypt_key_cache.get(user_key)
    if not cached:
        raise RuntimeError(f'加密密钥未初始化, 请先调用 init_garden_session()')

    # 添加时间戳
    params_dict['ts'] = int(time.time() * 1000)

    # JSON 序列化后加密 (注意: 先序列化再加密)
    plaintext = json.dumps(params_dict, separators=(',', ':'), ensure_ascii=False)
    encrypt_data = aes_cbc_encrypt_pkcs7(
        plaintext, cached['encryptKey'], cached['iv']
    )

    # 构建最终请求体
    result = dict(params_dict)
    result['encryptData'] = encrypt_data
    result['version'] = 1  # 微信 getLatestUserKey 返回 version=1
    return result


def build_encrypt_params_get(params_dict, user_key):
    """
    构建花园系统 GET 请求的加密 query 参数
    (答题接口 answerResultsJph 使用 GET + query params)
    """
    cached = _encrypt_key_cache.get(user_key)
    if not cached:
        raise RuntimeError('加密密钥未初始化')

    params_dict['ts'] = int(time.time() * 1000)
    plaintext = json.dumps(params_dict, separators=(',', ':'), ensure_ascii=False)
    encrypt_data = aes_cbc_encrypt_pkcs7(
        plaintext, cached['encryptKey'], cached['iv']
    )
    return {
        **params_dict,
        'encryptData': encrypt_data,
        'version': 1,
    }


# ============ WCS 客户端 ============

class WCSClient:
    """WCS 控制台客户端"""

    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH
        # WCS 容器内部 IP (Docker bridge network)
        self.wcs_internal = 'http://host.docker.internal:18788'

    def _get(self, path, timeout=30):
        r = requests.get(f'{self.base}{path}',
                         headers={'auth': self.auth}, timeout=timeout,
                         proxies={'http': None, 'https': None})
        return r.json()

    def _post(self, path, data, timeout=60):
        r = requests.post(f'{self.base}{path}', json=data,
                          headers={'auth': self.auth,
                                   'Content-Type': 'application/json'},
                          timeout=timeout,
                          proxies={'http': None, 'https': None})
        return r.json()

    def get_accounts(self):
        """获取已注册账号列表"""
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """对君品荟小程序执行 wx.login() 获取 code
        使用 Python requests 直接调用 WCS 容器内部 IP (绕过代理)
        """
        body = {'userKey': user_key or openid, 'openid': openid, 'appid': APPID}
        try:
            r = requests.post(f'{self.wcs_internal}/wx/code', json=body,
                              headers={'auth': self.auth, 'Content-Type': 'application/json'},
                              timeout=30, proxies={'http': None, 'https': None})
            data = r.json()
            if data.get('status') and data.get('data', {}).get('code'):
                return data['data']['code']
            log.warning(f'[WCS] /wx/code 返回: {data}')
        except Exception as e:
            log.warning(f'[WCS] /wx/code 异常: {e}')
        return None

    def get_encrypt_key(self, openid, user_key=None):
        """获取花园系统 AES 加密密钥 (wx.getUserCryptoManager().getLatestUserKey)"""
        body = {'userKey': user_key or openid, 'openid': user_key or openid}
        try:
            r = requests.post(f'{self.wcs_internal}/wx/encryptkey', json=body,
                              headers={'auth': self.auth, 'Content-Type': 'application/json'},
                              timeout=60, proxies={'http': None, 'https': None})
            data = r.json()
            if data.get('status') and data.get('data'):
                enc_data = data['data']
                ek = enc_data.get('encrypt_key', '')
                iv = enc_data.get('iv', '')
                if ek and iv:
                    uk = user_key or openid
                    _encrypt_key_cache[uk] = {
                        'encryptKey': ek,
                        'iv': iv,
                        'ts': time.time(),
                    }
                    log.info(f'[WCS] 获取加密密钥成功 (iv={iv})')
                    return ek, iv
            log.warning(f'[WCS] /wx/encryptkey 返回: {data}')
        except Exception as e:
            log.warning(f'[WCS] /wx/encryptkey 异常: {e}')
        return None, None
# ============ 自动登录 (WCS code) ============

def login_via_code(wcs, openid, user_key=None):
    """
    通过 WCS /wx/code 获取 login code, 调用 wxMiniLogin 纯 code 登录
    已绑定手机号的用户可直接用 code 获取 token, 无需 phoneCode

    Returns:
        dict: {'openid': ..., 'token': ..., 'remark': ...} 或 None
    """
    uk = user_key or openid

    # 获取 login code
    code = None
    for attempt in range(3):
        code = wcs.get_code(openid, uk)
        if code:
            break
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    if not code:
        log.error('[登录] 获取 wx.login code 失败')
        return None

    log.info(f'[登录] 尝试纯 code 登录 (code={code[:12]}...)')

    # 调用 wxMiniLogin, 只传 code 不传 phoneCode
    try:
        headers = make_headers()
        headers['appid'] = APPID
        headers['authorization'] = AUTH_BASIC
        headers['app-version'] = APP_VERSION

        resp = requests.post(
            f'{MALL_BASE}/api/v2/login/wxMiniSilentLogin',
            json={'code': code},
            headers=headers,
            timeout=15
        )

        try:
            data = resp.json()
        except Exception:
            log.warning(f'[登录] HTTP {resp.status_code}, 响应解码失败 (长度 {len(resp.content)})')
            return None

        # 打印服务端响应, 方便排查
        log.info(f'[登录] 响应: {json.dumps(data, ensure_ascii=False)[:300]}')

        if data.get('code') == '10000' and data.get('success'):
            login_data = data.get('data', {})
            token = login_data.get('token', '')
            open_id = login_data.get('openId', '')
            phone = login_data.get('phone', '')

            if token and open_id:
                log.info(f'[登录] 成功! openid={open_id[:12]}..., phone={phone[:3]}***{phone[-4:]}')
                return {
                    'openid':    open_id,
                    'token':     token,
                    'remark':    f'{phone[:3]}***{phone[-4:]}' if phone else open_id[:8],
                }

        return None

    except Exception as e:
        log.error(f'[登录] 请求异常: {e}')
        return None


def wcs_auto_login(wcs):
    """
    WCS 全自动模式: 遍历所有 WCS 账号, 尝试纯 code 登录
    成功的账号自动缓存 token, 用于后续签到/花园操作
    """
    accounts = wcs.get_accounts()
    if not accounts:
        log.warning('[WCS] 无注册账号')
        return []

    log.info(f'[WCS] 发现 {len(accounts)} 个注册账号, 开始自动登录...')
    results = []

    for i, wa in enumerate(accounts):
        openid = wa.get('openid', '')
        user_key = wa.get('userKey', openid)
        nick = wa.get('nickName', '') or wa.get('remark', '') or openid[:8]

        if not openid:
            log.warning(f'[WCS] 账号 #{i+1} 无 openid, 跳过')
            continue

        log.info(f'[WCS] 处理账号 #{i+1}: {nick}')

        login_result = login_via_code(wcs, openid, user_key)
        if login_result:
            login_result['user_key'] = user_key
            results.append(login_result)
        else:
            log.warning(f'[WCS] 账号 #{i+1} {nick} 自动登录失败, 请手动提供 token')

        # 账号间延迟
        if i < len(accounts) - 1:
            delay = random.uniform(2, 5)
            time.sleep(delay)

    return results


def save_tokens_to_config(results):
    """将自动登录获取的 token 缓存到配置文件"""
    if not results:
        return

    existing_raw = _config.get('jph', '')
    existing_accounts = {}
    for line in existing_raw.split('||'):
        line = line.strip()
        if line:
            try:
                acc = parse_manual_account(line)
                existing_accounts[acc['openid']] = line
            except Exception:
                pass

    # 更新或新增
    for r in results:
        entry = f"{r['remark']}#{r['openid']}#{r['token']}#{r['token']}"
        existing_accounts[r['openid']] = entry

    # 写回配置
    new_jph = '||'.join(existing_accounts.values())
    _config['jph'] = new_jph
    try:
        with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(_config, f, indent=2, ensure_ascii=False)
        log.info(f'[Config] 已缓存 {len(results)} 个自动登录 token -> {_CACHE_FILE}')
    except Exception as e:
        log.warning(f'[Config] 缓存写入失败: {e}')


# ============ 手动 token 降级 ============

def parse_manual_account(raw):
    """
    解析手动 token 字符串
    格式: 备注#openid#商城token#花园token
    """
    # 支持纯 openid 格式
    if '&' in raw and '#' not in raw:
        return [{'remark': o[:8], 'openid': o, 'mall_token': '', 'garden_token': ''} for o in raw.split('&') if o.strip()]
    parts = raw.strip().split('#')
    if len(parts) < 4:
        raise ValueError(f'格式错误, 需要: 备注#openid#商城token#花园token, 实际: {raw}')
    return {
        'remark':   parts[0],
        'openid':   parts[1],
        'mall_token':   parts[2],
        'garden_token': parts[3],
    }


def load_manual_accounts():
    """从环境变量/缓存加载手动 token 账号"""
    raw = os.environ.get('wx_opinion', '') or os.environ.get('jph', '')
    if not raw:
        return []
    accounts = []
    for line in raw.split('||'):
        line = line.strip()
        if line:
            result = parse_manual_account(line)
            if isinstance(result, list):
                accounts.extend(result)
            else:
                accounts.append(result)
    return accounts




# ============ 滑块验证码处理 ============

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


def solve_captcha(token, headers):
    """获取验证码 → 本地检测缺口 → AES-ECB 加密 → 提交"""
    # headers already passed
    r = requests.post(f'{MALL_BASE}/api/captcha/get', json={}, headers=headers, timeout=15, verify=False)
    d = r.json()
    if not d.get('success'):
        return None
    rd = d['data']['repData']
    ct, sk = rd['token'], rd['secretKey']
    x = detect_gap(rd['originalImageBase64'], rd.get('jigsawImageBase64', ''))
    log.info(f"  缺口: x={x}")
    pd = json.dumps({"x": round(x), "y": 5, "t": int(time.time()*1000), "sk": sk[:16]}, separators=(',',':'))
    enc = base64.b64encode(AES.new(sk.encode(), AES.MODE_ECB).encrypt(pad(pd.encode(), 16))).decode()
    r2 = requests.post(f'{MALL_BASE}/api/captcha/check', json={'token': ct, 'pointJson': enc}, headers=headers, timeout=15, verify=False)
    if r2.json().get('data',{}).get('success'):
        log.info("  ✅ 验证码通过")
        return ct
    log.info(f"  ❌ 验证码失败: {r2.json().get('data',{}).get('repMsg','')}")
    return None



def mall_sign_in(mall_token, wcs=None, openid=None, user_key=None):
    """
    商城每日签到 (带滑块验证码处理)
    """
    headers = mall_headers(mall_token)

    # 获取新的 wx.login code
    code = None
    if wcs and openid:
        for attempt in range(3):
            code = wcs.get_code(openid, user_key or openid)
            if code:
                break
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
        if not code:
            log.warning("[商城签到] 获取 login code 失败")

    # 尝试签到 (最多重试 3 次, 处理验证码)
    for i in range(3):
        captcha_token = solve_captcha(mall_token, headers)

        if code:
            body = {"code": code, "channelCode": CHANNEL_CODE}
        else:
            body = {"channelCode": CHANNEL_CODE}

        if captcha_token:
            body["captchaToken"] = captcha_token

        try:
            resp = requests.post(
                f"{MALL_BASE}/api/customer/daily/fillSignIn",
                json=body,
                headers=headers,
                timeout=15,
                verify=False
            )
            data = resp.json()
            if data.get("code") == "10000" and data.get("success"):
                sign_data = data.get("data", {})
                points = sign_data.get("pointValue", 0)
                desc = sign_data.get("resultDesc", "")
                cont_days = sign_data.get("continuousSignDays", 0)
                log.info(f"[商城签到] 成功! +{points}积分, 连签{cont_days}天 - {desc}")
                return True
            elif data.get("code") == "10000" and not data.get("success"):
                log.info("[商城签到] 已签到")
                return True
            elif "验证码" in str(data.get("message", "")) and i < 2:
                log.warning(f"[商城签到] 验证码失败, 重试...")
                time.sleep(2)
                continue
            else:
                log.warning(f"[商城签到] 失败: {data}")
                return False
        except Exception as e:
            log.error(f"[商城签到] 请求异常: {e}")
            return False

    return False



def mall_check_sign(mall_token):
    """检查今日是否已签到"""
    try:
        resp = requests.post(
            f'{MALL_BASE}/api/customer/daily/checkTodaySignIn',
            json={},
            headers=mall_headers(mall_token),
            timeout=15
        )
        data = resp.json()
        if data.get('code') == '10000':
            return data.get('data', False)
        return None
    except Exception as e:
        log.error(f'[商城签到检查] 异常: {e}')
        return None


# ============ 花园系统 ============

def init_garden_session(garden_token, wcs, openid, user_key=None):
    """
    初始化花园系统 session:
    1. 获取 AES 加密密钥 (WCS /wx/encryptkey)
    2. 保存 session key (saveSessionKey)
    """
    uk = user_key or openid

    # Step 1: 获取加密密钥
    ek, iv = wcs.get_encrypt_key(openid, uk)
    if not ek:
        log.error('[花园初始化] 获取加密密钥失败')
        return False

    # Step 2: 保存 session key
    code = None
    for attempt in range(3):
        code = wcs.get_code(openid, uk)
        if code:
            break
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    if not code:
        log.error('[花园初始化] 获取 login code 失败')
        return False

    try:
        resp = requests.get(
            f'{GARDEN_BASE}/garden/wechat/saveSessionKey',
            params={'code': code},
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            log.info('[花园初始化] session key 保存成功')
            return True
        else:
            log.warning(f'[花园初始化] saveSessionKey 返回: {data}')
            # 即使返回异常也继续尝试, 有些情况下不影响后续操作
            return True
    except Exception as e:
        log.error(f'[花园初始化] saveSessionKey 异常: {e}')
        return False


def garden_daily_sign(garden_token, user_key):
    """花园每日签到"""
    params = {}
    body = build_encrypt_params(params, user_key)

    try:
        resp = requests.post(
            f'{GARDEN_BASE}/garden/sign/dailySign',
            json=body,
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            sign_data = data.get('data', {})
            tips = sign_data.get('tips', '')
            water = sign_data.get('water', '0')
            log.info(f'[花园签到] 成功! {tips} (浇水x{water})')
            return True
        else:
            msg = data.get('msg', '')
            if data.get('err') == 5001:
                log.warning(f'[花园签到] 被防刷拦截 (5001), 跳过后续花园操作')
                return 'blocked'
            log.warning(f'[花园签到] 失败: {msg} ({data})')
            return False
    except Exception as e:
        log.error(f'[花园签到] 请求异常: {e}')
        return False


def get_garden_info(garden_token):
    """获取会员花园信息 (浇水/施肥/种子数量等)"""
    try:
        resp = requests.get(
            f'{GARDEN_BASE}/garden/Gardenmemberinfo/getMemberInfo',
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            info = data.get('data', {})
            return {
                'level':      info.get('level_name', ''),
                'integration': info.get('integration', '0'),
                'water':      info.get('water', 0),
                'manure':     info.get('manure', 0),
                'sorghum':    info.get('sorghum', 0),
                'wheat':      info.get('wheat', 0),
                'wine_yeast': info.get('wine_yeast', 0),
                'wine':       info.get('wine', 0),
            }
        return None
    except Exception as e:
        log.error(f'[花园信息] 异常: {e}')
        return None


def get_sorghum_index(garden_token):
    """获取地块状态 (8块地)"""
    try:
        resp = requests.get(
            f'{GARDEN_BASE}/garden/sorghum/index',
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            return data.get('data', [])
        return None
    except Exception as e:
        log.error(f'[地块状态] 异常: {e}')
        return None


def garden_seed(garden_token, user_key, plot_id, crop_type=1):
    """
    种植作物
    Args:
        plot_id: 地块 ID
        crop_type: 1=高粱, 2=小麦
    """
    params = {'id': plot_id, 'type': crop_type}
    body = build_encrypt_params(params, user_key)

    crop_name = '高粱' if crop_type == 1 else '小麦'
    try:
        resp = requests.post(
            f'{GARDEN_BASE}/garden/sorghum/seed',
            json=body,
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            crop_info = data.get('data', {})
            crop_time = crop_info.get('crop_time', '')
            log.info(f'[种植{crop_name}] 成功! 地块#{plot_id}, 预计成熟: {crop_time}')
            return True
        else:
            msg = data.get('msg', '')
            if data.get('err') == 5001:
                log.warning(f'[种植{crop_name}] 被防刷拦截 (5001)')
                return 'blocked'
            log.warning(f'[种植{crop_name}] 失败: {msg} ({data})')
            return False
    except Exception as e:
        log.error(f'[种植{crop_name}] 请求异常: {e}')
        return False


def garden_watering(garden_token, user_key, plot_id):
    """浇水"""
    params = {'id': plot_id}
    body = build_encrypt_params(params, user_key)

    try:
        resp = requests.post(
            f'{GARDEN_BASE}/garden/sorghum/watering',
            json=body,
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            crop_info = data.get('data', {})
            water_num = crop_info.get('water_num', 0)
            crop_time = crop_info.get('crop_time', '')
            log.info(f'[浇水] 成功! 地块#{plot_id}, 已浇{water_num}次, 预计: {crop_time}')
            return True
        else:
            msg = data.get('msg', '')
            err_code = data.get('err', 0)
            if err_code == 5001:
                log.warning(f'[浇水] 被防刷拦截 (5001)')
                return 'blocked'
            else:
                log.warning(f'[浇水] 失败: {msg} ({data})')
            return False
    except Exception as e:
        log.error(f'[浇水] 请求异常: {e}')
        return False


def get_question(garden_token):
    """获取每日答题题目"""
    try:
        resp = requests.get(
            f'{GARDEN_BASE}/garden/Gardenquestiontask/index',
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            questions = data.get('data', [])
            if questions:
                q = questions[0]
                return {
                    'id':       q.get('id'),
                    'title':    q.get('title', ''),
                    'options':  q.get('options', ''),
                    'answer':   q.get('answer', ''),
                    'analysis': q.get('answer_analysis', ''),
                }
        return None
    except Exception as e:
        log.error(f'[答题] 获取题目异常: {e}')
        return None


def submit_answer(garden_token, user_key, item_id, selected):
    """
    提交答题 (GET 请求, 加密参数在 query string 中)
    Args:
        item_id: 题目 ID
        selected: 选择的选项 (如 'A', 'B')
    """
    params = {'itemid': item_id, 'selected': selected}
    query = build_encrypt_params_get(params, user_key)

    try:
        resp = requests.get(
            f'{GARDEN_BASE}/garden/Gardenquestiontask/answerResultsJph',
            params=query,
            headers=garden_headers(garden_token),
            timeout=15
        )
        data = resp.json()
        if data.get('err') == 0 and data.get('success'):
            log.info(f'[答题] 回答正确! 奖励已发放')
            return True
        else:
            msg = data.get('msg', '')
            log.info(f'[答题] {msg}')
            return False
    except Exception as e:
        log.error(f'[答题] 提交异常: {e}')
        return False


# ============ 主流程 ============

def run_one_account(acc, wcs=None):
    """
    执行单个账号的完整流程

    Args:
        acc: 账号信息 dict, 需含:
            - remark: 备注
            - openid: 微信 openid
            - mall_token: 商城 token
            - garden_token: 花园 token
        wcs: WCSClient 实例 (可选, 用于获取 code 和加密密钥)
    """
    remark = acc.get('remark', acc['openid'][:8])
    openid = acc['openid']
    mall_token = acc['mall_token']
    garden_token = acc['garden_token']
    user_key = acc.get('user_key', openid)

    log.info(f'{"="*50}')
    log.info(f'开始处理账号: {remark}')
    log.info(f'{"="*50}')

    # ---- 商城签到 ----
    log.info('[1/5] 商城签到...')
    signed = mall_check_sign(mall_token)
    if signed is True:
        log.info('[商城签到] 今日已签到, 跳过')
    elif signed is False:
        time.sleep(random.uniform(0.5, 1.5))
        if wcs:
            mall_sign_in(mall_token, wcs, openid, user_key)
        else:
            mall_sign_in(mall_token)
    else:
        log.warning('[商城签到] 无法检查签到状态')
        if wcs:
            time.sleep(random.uniform(0.5, 1.5))
            mall_sign_in(mall_token, wcs, openid, user_key)

    # ---- 花园系统初始化 (需要 WCS) ----
    if not wcs:
        log.warning('[花园] 无 WCS 连接, 跳过花园系统操作')
        return

    log.info('[2/5] 花园系统初始化...')
    time.sleep(random.uniform(1.0, 2.0))
    # 用 WCS 注册的 openid 获取 encryptkey (不是君品荟 openId)
    wcs_openid = acc.get('wcs_openid', user_key)
    if not init_garden_session(garden_token, wcs, wcs_openid, user_key):
        log.error('[花园初始化] 失败, 跳过花园操作')
        return

    # ---- 花园信息 ----
    log.info('[3/5] 获取花园信息...')
    time.sleep(random.uniform(0.5, 1.0))
    info = get_garden_info(garden_token)
    if info:
        log.info(
            f'[花园信息] 等级: {info["level"]}, 积分: {info["integration"]}, '
            f'浇水: {info["water"]}, 施肥: {info["manure"]}, '
            f'高粱: {info["sorghum"]}, 小麦: {info["wheat"]}'
        )

    # ---- 花园签到 ----
    log.info('[4/5] 花园签到...')
    time.sleep(random.uniform(0.5, 1.5))
    sign_result = garden_daily_sign(garden_token, user_key)
    blocked_5001 = (sign_result == 'blocked')

    # ---- 种植与浇水 ----
    if blocked_5001:
        log.info('[5/5] 跳过种植与浇水 (5001 防刷拦截)')
    else:
        log.info('[5/5] 种植与浇水...')
        time.sleep(random.uniform(0.5, 1.0))
        plots = get_sorghum_index(garden_token)
        if plots:
            for plot in plots:
                status = plot.get('status', -1)
                plot_id = plot.get('id')
                if status == -1:
                    time.sleep(random.uniform(0.8, 1.5))
                    garden_seed(garden_token, user_key, plot_id, crop_type=1)
                elif status in (10, 0):
                    time.sleep(random.uniform(0.8, 1.5))
                    garden_watering(garden_token, user_key, plot_id)

    # ---- 每日答题 ----
    log.info('[附加] 每日答题...')
    time.sleep(random.uniform(0.5, 1.0))
    question = get_question(garden_token)
    if question:
        q_title = question['title']
        q_answer = question['answer']
        q_analysis = question['analysis']
        q_id = question['id']
        log.info(f'[答题] 题目: {q_title}')
        # 直接用正确答案
        log.info(f'[答题] 提交答案: {q_answer} (来源: {q_analysis})')
        time.sleep(random.uniform(0.5, 1.0))
        submit_answer(garden_token, user_key, q_id, q_answer)
    else:
        log.info('[答题] 无题目或已答完')

    # ---- 最终花园信息 ----
    time.sleep(random.uniform(0.3, 0.8))
    final_info = get_garden_info(garden_token)
    if final_info:
        log.info(
            f'[最终状态] 积分: {final_info["integration"]}, '
            f'浇水: {final_info["water"]}, 施肥: {final_info["manure"]}, '
            f'高粱: {final_info["sorghum"]}, 小麦: {final_info["wheat"]}'
        )

    log.info(f'账号 {remark} 处理完成')


def main():
    """三路分发: 手动 token -> WCS 自动 -> 帮助"""
    # 优先使用 jph 手动 token
    jph_raw = os.environ.get("jph", "") or _config.get("jph", "")
    if jph_raw:
        manual_accounts = []
        for line in jph_raw.split("||"):
            line = line.strip()
            if line:
                try:
                    manual_accounts.append(parse_manual_account(line))
                except:
                    pass
        if manual_accounts:
            log.info(f"[Config] 使用 jph 手动 token: {len(manual_accounts)} 个账号")
        else:
            manual_accounts = load_manual_accounts()
    else:
        manual_accounts = load_manual_accounts()

    # 分离: 有 token 的用手动模式, 无 token 的用 WCS 自动登录
    has_token = [a for a in manual_accounts if a.get('mall_token')]
    no_token = [a for a in manual_accounts if not a.get('mall_token')]

    if no_token and WCS_AUTH:
        # 有纯 openid (无 token) -> 先用 WCS 自动登录获取 token
        wcs = WCSClient()
        try:
            wcs_accounts = wcs.get_accounts()
            if wcs_accounts:
                log.info(f'[WCS] 发现 {len(wcs_accounts)} 个注册账号, 为 {len(no_token)} 个纯 openid 账号自动登录...')
                for wa in wcs_accounts:
                    wcs_openid = wa["openid"]
                    uk = wa.get("userKey", wcs_openid)
                    login_result = login_via_code(wcs, wcs_openid, uk)
                    if login_result:
                        acc = {
                            "openid": login_result.get("openid", wcs_openid),
                            "mall_token": login_result["token"],
                            "garden_token": login_result["token"],
                            "remark": login_result.get("remark", wcs_openid[:8]),
                            "user_key": uk,
                            "wcs_openid": wcs_openid,
                        }
                        has_token.append(acc)
                        log.info(f'[自动登录] {acc["remark"]} 成功')
                    else:
                        log.warning(f'[自动登录] {wcs_openid[:12]} 失败, 跳过')
        except Exception as e:
            log.warning(f'[WCS] 自动登录异常: {e}')

    manual_accounts = has_token

    if manual_accounts:
        # 方式1: 手动 token 降级模式
        wcs = WCSClient() if WCS_AUTH else None
        if wcs:
            # 验证 WCS 连接
            try:
                accounts = wcs.get_accounts()
                if accounts is not None:
                    log.info(f'[WCS] 连接成功, 发现 {len(accounts)} 个注册账号')
                else:
                    log.warning('[WCS] 连接异常')
            except Exception as e:
                log.warning(f'[WCS] 连接失败: {e}')
                wcs = None

        # 按顺序关联 WCS 账号
        wcs_account_map = {}
        if wcs:
            try:
                wcs_accounts_list = wcs.get_accounts()
                if wcs_accounts_list:
                    for idx2, wa in enumerate(wcs_accounts_list):
                        wcs_account_map[idx2] = wa
            except Exception:
                pass

        for i, acc in enumerate(manual_accounts):
            if wcs and i in wcs_account_map:
                wa = wcs_account_map[i]
                acc['wcs_openid'] = wa['openid']
                acc['user_key'] = wa.get('userKey', wa['openid'])

            run_one_account(acc, wcs)

            # 账号间延迟
            if i < len(manual_accounts) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s 后处理下一个账号...')
                time.sleep(delay)

    elif WCS_AUTH:
        # 方式2: 纯 WCS 自动 code 登录模式
        wcs = WCSClient()
        try:
            test = wcs.get_accounts()
            if test is None:
                log.error('[WCS] 连接失败, 请检查 wx_server_url 和 wx_auth')
                sys.exit(1)
        except Exception as e:
            log.error(f'[WCS] 连接异常: {e}')
            sys.exit(1)

        auto_results = wcs_auto_login(wcs)

        if not auto_results:
            log.error(
                '所有账号自动登录失败。\n'
                '可能原因: 账号首次登录需要手机号授权 (phoneCode)\n'
                '解决方案: 手动抓包获取 token 后使用手动模式:\n'
                '  set jph=备注#openid#商城token#花园token\n'
                'Token 获取: 抓包 fm.exijiu.com 请求头的 x-access-token'
            )
            sys.exit(1)

        # 缓存自动获取的 token
        save_tokens_to_config(auto_results)

        # 转换为标准账号格式执行后续操作
        for i, r in enumerate(auto_results):
            acc = {
                'remark':       r['remark'],
                'openid':       r['openid'],
                'mall_token':   r['token'],
                'garden_token': r['token'],  # 商城和花园用同一个 token (首次登录后一致)
                'user_key':     r.get('user_key', r['openid']),
            }
            run_one_account(acc, wcs)

            if i < len(auto_results) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s 后处理下一个账号...')
                time.sleep(delay)

    else:
        # 方式3: 无配置 -> 显示帮助
        log.info('君品荟自动化脚本 - 使用帮助')
        log.info('=' * 50)
        log.info('')
        log.info('方式1 (推荐): WCS 自动 code 登录')
        log.info('   set wx_server_url=http://host.docker.internal:18788')
        log.info('   set wx_auth=你的AUTH_KEY')
        log.info('   python jph.py')
        log.info('   -> 自动获取 code, 调 wxMiniLogin 登录, token 自动缓存')
        log.info('')
        log.info('方式2: 手动 token 模式 (自动登录失败时)')
        log.info('   set jph=备注#openid#商城token#花园token')
        log.info('   python jph.py')
        log.info('')
        log.info('多账号用 || 分隔:')
        log.info('   set jph=账号1#o1#t1#g1||账号2#o2#t2#g2')
        log.info('')
        log.info('Token 获取方式:')
        log.info('  - 微信小程序抓包 (Charles/Fiddler/MitmProxy)')
        log.info('  - 商城 token: fm.exijiu.com 请求头的 x-access-token')
        log.info('  - 花园 token: apimallwm.exijiu.com 请求头的 X-Access-Token')
        log.info('  - openid: 登录接口响应体中的 openId 字段')
        log.info('')
        log.info('配置会自动缓存到 .jph_config.json, 后续运行无需重复 set')
        sys.exit(1)


if __name__ == '__main__':
    main()