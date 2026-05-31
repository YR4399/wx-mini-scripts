# -*- coding: utf-8 -*-
"""
赵钱李孙养老 - WCS 控制台集成版
环境变量：
    ZQSM_P_TOKENS  - P-Token (JWT)，多个账号用&分隔（fallback模式）
    ZQSM_WCSIDS    - 兼容模式，格式: wcsid@encrypted_openid，多个账号用&分隔
    wx_server_url   - WCS控制台地址（默认 http://127.0.0.1:8787）
    wx_auth         - WCS控制台 APIKEY
    ZQSM_PROXIES   - 代理池 (可选)，格式 http://ip:port 或 socks5://ip:port
    ZQSM_WCS_LOCAL - 强制使用控制台自动发现模式 (true/false)
控制台模式（默认）：
    1. 自动通过 GET /api/accounts 发现所有账号
    2. 自动通过 POST /wx/encrypt 获取 encryptKey + iv
    3. AES-CBC 加密 openId 生成 64位 hex encrypted openId
    4. 自动通过 POST /wx/code 获取登录 code
    无需手动配置，无需抓包。
依赖：pip install pycryptodome requests
"""
import requests
import json
import time
import random
import base64
import logging
import re
import sys
import os
from urllib.parse import urlencode

# 清除代理（Docker 容器内可能有不可用的代理）
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'

try:
    from Crypto.Cipher import AES, PKCS1_v1_5
    from Crypto.PublicKey import RSA
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pycryptodome', '-q'])
    from Crypto.Cipher import AES, PKCS1_v1_5
    from Crypto.PublicKey import RSA

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s',
                    datefmt='%Y-%m-%d %H:%M:%S', handlers=[logging.StreamHandler()])
log = logging.getLogger('zqsm')

PENSION_URL = 'https://gm-pension-map.weijuju.com'
GUOMIN_URL = 'https://lfsplanning.guominpension.com'
WX_APPID = 'wxfeb453e6377c3137'
AES_KEY = 'h2sAxtVPjufWKF+vj8RvFQ=='
AES_KEY_BYTES = AES_KEY.encode('utf-8')

TOKEN_CACHE_DIR = os.environ.get('ZQSM_CACHE_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'zqsm_tokens'))


# ============ WCS 控制台客户端 ============

class WCSConsoleClient:
    """WCS 控制台 API 客户端 (daidai 面板)"""

    def __init__(self, base_url, auth):
        self.base_url = base_url.rstrip('/')
        self.auth = auth

    def _headers(self):
        return {'AUTH': self.auth, 'Content-Type': 'application/json'}

    def _post(self, path, data=None, timeout=30):
        try:
            resp = requests.post(f'{self.base_url}{path}', json=data or {},
                                headers=self._headers(), timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.error(f'控制台API {path} 失败: {e}')
            return None

    def _get(self, path, params=None, timeout=30):
        try:
            resp = requests.get(f'{self.base_url}{path}', params=params,
                               headers={'AUTH': self.auth}, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.error(f'控制台API {path} 失败: {e}')
            return None

    # ---- 账号管理 ----

    def get_accounts(self):
        """GET /api/accounts -> [{'openid', 'userKey', 'displayName', 'disabled', ...}]"""
        result = self._get('/api/accounts')
        if result and result.get('status'):
            data = result.get('data', {})
            return data.get('items', [])
        log.error(f'get_accounts 失败: {result}')
        return None

    def check_accounts_status(self, openids):
        """POST /api/accounts/status"""
        if isinstance(openids, str):
            openids = [openids]
        result = self._post('/api/accounts/status', {'openid': openids})
        if result and result.get('status'):
            return result.get('data', [])
        log.error(f'check_accounts_status 失败: {result}')
        return None

    def disable_account(self, user_key, disabled=True):
        return self._post('/api/accounts/disable', {'userKey': user_key, 'disabled': disabled})

    def delete_account(self, user_key):
        return self._post('/api/accounts/delete', {'userKey': user_key})

    # ---- 小程序运行 ----

    def get_code(self, openid, appid, timeout=60):
        data = {'appid': appid}
        if openid:
            data['openid'] = openid
        log.info(f'WCS控制台: 获取code (openid={openid[:8] if openid else "(自动)"}...)')
        result = self._post('/wx/code', data, timeout=timeout)
        if result and result.get('status'):
            return result.get('data', {})
        log.error(f'get_code 失败: {result}')
        return None

    def get_encrypt_key(self, openid, appid, timeout=60):
        data = {}
        if openid:
            data['openid'] = openid
        log.info(f'WCS控制台: 获取encrypt_key (openid={openid[:8] if openid else "(自动)"}...)')
        result = self._post('/wx/encryptkey', data, timeout=timeout)
        if result and result.get('status'):
            return result.get('data', {})
        log.error(f'get_encrypt_key 失败: {result}')
        return None

    def get_runtime_running(self, user_key, appid=None):
        params = {'userKey': user_key}
        if appid:
            params['appid'] = appid
        return self._get('/api/runtime/running', params)

    def get_runtime_applets(self, user_key):
        return self._get('/api/runtime/applets', {'userKey': user_key})

    def get_runtime_sandboxes(self):
        return self._get('/api/runtime/sandboxes')


# ============ WCS 客户端 (兼容层) ============

class WeChatCodeServer:
    """等价于 wcs.js，底层使用 WCSConsoleClient"""

    def __init__(self, console, appid):
        self.console = console
        self.appid = appid

    def get_code(self, openid=None):
        log.info('等待获取code (WCS控制台):')
        data = self.console.get_code(openid, self.appid)
        if data and 'code' in data:
            log.info('获取code成功')
            return {'status': True, 'data': data}
        return {'status': False, 'data': data}

    def get_encrypt_key(self, openid=None):
        log.info('获取encrypted openId (WCS控制台):')
        data = self.console.get_encrypt_key(openid, self.appid)
        if data:
            log.info('获取encrypted openId成功')
            return data
        return None

    def cloud_init(self, openid=None):
        log.info('cloud_init (未实现)')
        return None

    def cloud_call(self, openid=None):
        log.info('cloud_call (未实现)')
        return None


# ============ 工具函数 ============

def _random_ua():
    devices = [
        ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ('13', 'Pixel 7 Build/TQ3A.230901.001'),
        ('14', 'SM-S918B Build/UP1A.231005.007'),
        ('13', 'SM-S926B Build/UP1A.240305.002'),
        ('12', '23127PN0CC Build/UKQ1.231003.002'),
    ]
    wv = random.choice(['8.0.50.2780', '8.0.54.2780', '8.0.49.2760', '8.0.53.2780', '8.0.55.2780'])
    av, dev = random.choice(devices)
    return (f'Mozilla/5.0 (Linux; Android {av}; {dev}) '
            f'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 '
            f'MicroMessenger/{wv}(0x28003637) NetType/WIFI Language/zh_CN '
            f'MiniProgramEnv/android WeChat/arm64 Weixin NetType/WIFI Language/zh_CN')

def aes_ecb_decrypt(cipher_b64):
    raw = base64.b64decode(cipher_b64)
    cipher = AES.new(AES_KEY_BYTES, AES.MODE_ECB)
    decrypted = cipher.decrypt(raw)
    pad_len = decrypted[-1]
    if 0 < pad_len <= 16:
        decrypted = decrypted[:-pad_len]
    return json.loads(decrypted.decode('utf-8'))

def rsa_decrypt_chunked(cipher_b64, private_key_pem):
    key = RSA.import_key(private_key_pem)
    cipher = PKCS1_v1_5.new(key)
    sentinel = b'\x00' * 256
    raw = base64.b64decode(cipher_b64)
    chunk_size = key.size_in_bytes()
    result = b''
    for i in range(0, len(raw), chunk_size):
        chunk = raw[i:i + chunk_size]
        result += cipher.decrypt(chunk, sentinel)
    return result

def rsa_encrypt_chunked(plaintext, public_key_pem):
    key = RSA.import_key(public_key_pem)
    cipher = PKCS1_v1_5.new(key)
    max_chunk = key.size_in_bytes() - 11
    encoded = base64.b64encode(plaintext.encode('utf-8')).decode('utf-8')
    result = b''
    for i in range(0, len(encoded), max_chunk):
        chunk = encoded[i:i + max_chunk].encode('utf-8')
        result += cipher.encrypt(chunk)
    return base64.b64encode(result).decode('utf-8')


def _aes_encrypt_openid(openid, encrypt_key_b64, iv_hex):
    """用 WCS /wx/encrypt 返回的 encryptKey+iv 对 openId 做 AES-CBC 加密
    返回 64 位 hex，即登录接口需要的 encrypted openId"""
    key = base64.b64decode(encrypt_key_b64)
    iv = bytes.fromhex(iv_hex) * 2  # 8 bytes -> 16 bytes (repeat)
    raw = openid.encode('utf-8')
    bs = 16
    pad = bs - len(raw) % bs
    padded = raw + b'\x00' * (pad - 1) + bytes([pad])
    cipher = AES.new(key, AES.MODE_CBC, iv=iv)
    return cipher.encrypt(padded).hex()


# ============ P-Token 缓存 ============

def _token_cache_path(wcs_id):
    os.makedirs(TOKEN_CACHE_DIR, exist_ok=True)
    safe_name = wcs_id.replace('/', '_')
    return os.path.join(TOKEN_CACHE_DIR, f'{safe_name}.txt')

def _load_cached_ptoken(wcs_id):
    path = _token_cache_path(wcs_id)
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                token = f.read().strip()
            if token:
                return token
        except Exception:
            pass
    return None

def _save_cached_ptoken(wcs_id, p_token):
    path = _token_cache_path(wcs_id)
    try:
        with open(path, 'w') as f:
            f.write(p_token)
        log.info(f'P-Token已缓存: {path}')
    except Exception as e:
        log.warning(f'缓存P-Token失败: {e}')

def _verify_ptoken(p_token):
    try:
        import base64 as b64
        parts = p_token.split('.')
        if len(parts) != 3:
            return False
        payload = parts[1] + '=' * (4 - len(parts[1]) % 4)
        data = json.loads(b64.b64decode(payload))
        exp = data.get('exp', 0)
        return time.time() < exp
    except Exception:
        return False


# ============ 微信登录 (code -> P-Token) ============

def wx_login_get_ptoken(wcs, wcs_id, encrypted_open_id):
    """
    WCS getCode -> loginCode -> /user_login/mobile/v1/login -> P-Token (JWT)
    wcs_id: 原始 openId (用于缓存文件名)，单账号时可为 None
    encrypted_open_id: 64位hex，用于登录接口 body.openId
    """
    WX_LOGIN_URL = f'{GUOMIN_URL}/user/api/user_login/mobile/v1/login'

    code_res = wcs.get_code(wcs_id)
    if not code_res or not code_res.get('status'):
        log.error(f'WCS getCode 失败: {code_res}')
        return None

    login_code = code_res.get('data', {}).get('code')
    if not login_code:
        log.error(f'WCS 返回 code 为空: {code_res}')
        return None
    log.info(f'微信loginCode获取成功，长度: {len(login_code)}')

    time.sleep(random.uniform(1.0, 2.0))
    try:
        resp = requests.post(WX_LOGIN_URL,
            json={'openId': encrypted_open_id, 'loginCode': login_code,
                  'channelCode': '', 'inviteCode': '', 'activityId': ''},
            headers={'User-Agent': _random_ua(), 'Content-Type': 'application/json',
                     'X-channel-code': '', 'xweb_xhr': '1',
                     'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors',
                     'Sec-Fetch-Dest': 'empty',
                     'Referer': f'https://servicewechat.com/{WX_APPID}/66/page-frame.html',
                     'Accept-Language': 'zh-CN,zh;q=0.9'},
            timeout=15)
        resp.raise_for_status()
        data = resp.json()

        code = data.get('code')
        ok = data.get('ok')
        log.info(f'登录接口响应: code={code} message={data.get("message", "")}')

        if code == '00000000' and ok:
            inner = data.get('data', {})
            p_token = inner.get('token')
            user_name = inner.get('userName', '')
            if p_token:
                log.info(f'微信登录成功，用户: {user_name}，P-Token长度: {len(p_token)}')
                _save_cached_ptoken(wcs_id or 'default', p_token)
                return p_token
            else:
                log.error(f'登录返回中未找到token: {json.dumps(data, ensure_ascii=False)[:500]}')
                return None
        elif code == '01010006':
            log.info('账号已登录(服务端有session)，尝试获取P-Token...')
            cache_key = wcs_id or 'default'
            cached = _load_cached_ptoken(cache_key)
            if cached and _verify_ptoken(cached):
                log.info(f'缓存P-Token有效，长度: {len(cached)}')
                return cached

            env_tokens = os.environ.get('ZQSM_P_TOKENS', '')
            if env_tokens:
                for t in [t.strip() for t in env_tokens.split('&') if t.strip()]:
                    if _verify_ptoken(t):
                        log.info(f'从ZQSM_P_TOKENS获取有效P-Token，长度: {len(t)}')
                        _save_cached_ptoken(cache_key, t)
                        return t

            log.warning('无有效P-Token缓存，首次运行需手动抓包一次:')
            log.warning(f'  抓P-Token写入文件: {_token_cache_path(cache_key)}')
            log.warning(f'  或写入环境变量 ZQSM_P_TOKENS')
            return None
        else:
            log.error(f'登录接口返回失败: code={code} message={data.get("message", "")}')
            return None
    except Exception as e:
        log.error(f'微信登录请求失败: {e}')
        return None


# ============ Session 类 ============

class Session:
    def __init__(self, p_token, account_id, proxy=None):
        self.p_token = p_token
        self.account_id = account_id
        self.proxy = proxy
        self.token = None
        self.front_public_key = None
        self.after_private_key = None
        self.rs = requests.Session()
        self.dice_count = 0
        self.tools = {}
        self.fragment_count = 0
        self.user_point_count = 0
        self.user_task_total_count = 0
        self.task_milestones = []
        self.fail_count = 0

    def _headers(self):
        h = {
            'User-Agent': _random_ua(),
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Origin': PENSION_URL,
            'Referer': f'{PENSION_URL}/',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cookie': 'channelCode=default',
        }
        if self.token:
            h['token'] = self.token
        return h

    def _pub_pem(self):
        return f'-----BEGIN PUBLIC KEY-----\n{self.front_public_key}\n-----END PUBLIC KEY-----'

    def _priv_pem(self):
        return f'-----BEGIN RSA PRIVATE KEY-----\n{self.after_private_key}\n-----END RSA PRIVATE KEY-----'

    def _decrypt_data(self, data, endpoint):
        if endpoint == 'app/preInit':
            return aes_ecb_decrypt(data)
        if isinstance(data, str) and len(data) > 50:
            try:
                raw = rsa_decrypt_chunked(data, self._priv_pem())
                return json.loads(base64.b64decode(raw.decode()))
            except Exception:
                try:
                    return json.loads(raw.decode())
                except Exception:
                    return data
        return data

    def _post(self, endpoint, data=None, encrypted=False, has_data_sign=False, extra_params=None):
        url = f'{PENSION_URL}/{endpoint}'
        if encrypted and self.front_public_key:
            form = {}
            if data:
                for k, v in data.items():
                    form[k] = rsa_encrypt_chunked(str(v), self._pub_pem())
            if has_data_sign:
                payload = {'timestamp': int(time.time() * 1000)}
                if self.token:
                    payload['loginToken'] = self.token
                form['dataSign'] = rsa_encrypt_chunked(
                    json.dumps(payload, separators=(',', ':')), self._pub_pem())
        else:
            form = data or {}
        if extra_params:
            form.update(extra_params)

        time.sleep(random.uniform(1.0, 3.0))
        proxies = {'http': self.proxy, 'https': self.proxy} if self.proxy else None
        resp = self.rs.post(url, data=urlencode(form), headers=self._headers(),
                             proxies=proxies, timeout=15)
        result = resp.json()

        if result.get('code') == 200 and result.get('data') and encrypted:
            result['data'] = self._decrypt_data(result['data'], endpoint)
        return result

    def _handle_error(self, step, error, logical=False):
        """记录错误。logical=True 表示业务逻辑错误（如参数检验失败），不计入断路器"""
        if not logical:
            self.fail_count += 1
        log.error(f'x {step}: {error}')
        if self.fail_count >= 3:
            wait = random.uniform(600, 900)
            log.warning(f'断路器开启: 等待{wait:.0f}s')
            time.sleep(wait)
            self.fail_count = 0

    def get_token(self):
        try:
            log.info(f'获取pension token...')
            r = self._post('app/getToken', {'authCode': self.p_token})
            if r.get('code') == 200 and r.get('data'):
                self.token = r['data'].get('token', '')
                self.fail_count = 0
                log.info(f'pension token获取成功')
                return True
            self._handle_error('getToken', r.get('msg', ''))
            return False
        except Exception as e:
            self._handle_error('getToken', str(e))
            return False

    def pre_init(self):
        try:
            log.info(f'初始化RSA密钥...')
            r = self._post('app/preInit', {}, encrypted=True)
            if r.get('code') == 200 and r.get('data'):
                self.front_public_key = r['data'].get('frontPublicKey', '')
                self.after_private_key = r['data'].get('afterPrivateKey', '')
                self.fail_count = 0
                log.info(f'RSA密钥获取成功')
                return True
            self._handle_error('preInit', r.get('msg', ''))
            return False
        except Exception as e:
            self._handle_error('preInit', str(e))
            return False

    def get_init(self, verbose=False):
        try:
            r = self._post('app/init')
            if r.get('code') == 200 and r.get('data'):
                d = r['data']
                self.dice_count = d.get('diceCount', 0)
                self.tools = {}
                for k, v in d.items():
                    if k.startswith('dice') and k.endswith('Count') and k != 'diceCount':
                        tool_type = k[4:-5].lower()
                        if v and v > 0:
                            self.tools[tool_type] = v
                self.fragment_count = d.get('fragmentCount', 0)
                self.user_point_count = d.get('userPointCount', 0)
                self.user_task_total_count = d.get('userTaskTotalCount', 0)
                self.task_milestones = d.get('taskMilestoneList', [])
                self.fail_count = 0
                if verbose:
                    parts = [f'骰子:{self.dice_count}', f'积分:{self.user_point_count}',
                             f'任务:{self.user_task_total_count}']
                    for t, c in self.tools.items():
                        parts.append(f'{t}道具:{c}')
                    if self.fragment_count > 0:
                        parts.append(f'碎片:{self.fragment_count}')
                    log.info(' '.join(parts))
                return d
            self._handle_error('init', r.get('msg', ''))
            return None
        except Exception as e:
            self._handle_error('init', str(e))
            return None

    def get_task_list(self):
        try:
            r = self._post('app/taskList')
            if r.get('code') == 200 and r.get('data'):
                self.fail_count = 0
                return r['data']
            self._handle_error('taskList', r.get('msg', ''))
            return []
        except Exception as e:
            self._handle_error('taskList', str(e))
            return []

    def complete_task(self, task_id, task_name=''):
        try:
            r = self._post('app/completeTask', {'taskId': task_id},
                           encrypted=True, has_data_sign=True)
            if r.get('code') == 200:
                self.fail_count = 0
                return True
            msg = r.get('msg', '')
            # "参数检验失败"是业务逻辑错误（深度任务需真实用户操作），不计入断路器
            is_logical = '参数检验' in msg or '检验失败' in msg
            if is_logical:
                log.info(f'  {task_name}: {msg} (深度任务，需手动完成)')
            self._handle_error(f'completeTask({task_name})', msg, logical=is_logical)
            return False
        except Exception as e:
            self._handle_error(f'completeTask({task_name})', str(e))
            return False

    def receive_task_award(self, task_id, task_name=''):
        try:
            r = self._post('app/receiveTaskAward', {'taskId': task_id},
                           encrypted=True, has_data_sign=True)
            if r.get('code') == 200:
                self.fail_count = 0
                return True
            self._handle_error('receiveTaskAward', r.get('msg', ''))
            return False
        except Exception as e:
            self._handle_error('receiveTaskAward', str(e))
            return False

    def receive_milestone_award(self, idx):
        try:
            r = self._post('app/receiveTaskMilestoneAward', {'milestoneIndex': idx},
                           encrypted=True, has_data_sign=True)
            if r.get('code') == 200:
                self.fail_count = 0
                log.info(f'+ 里程碑 #{idx} 奖励领取成功')
                return True
            self._handle_error('receiveMilestone', r.get('msg', ''))
            return False
        except Exception as e:
            self._handle_error('receiveMilestone', str(e))
            return False

    def sign_in(self):
        try:
            r = self._post('app/sign', {}, encrypted=True, has_data_sign=True)
            if r.get('code') == 200:
                self.fail_count = 0
                log.info('+ 签到成功')
                return r.get('data')
            log.info(f'x 签到失败: {r.get("msg", "")}')
            return None
        except Exception as e:
            log.error(f'x 签到异常: {e}')
            return None

    TOOL_TYPE_MAP = {'add': 1, 'sub': 3, 'mul': 2, 'div': 4}
    TOOL_PRIORITY = ['mul', 'div', 'add', 'sub']

    def roll_dice(self):
        try:
            data = {}
            tool_name = ''
            for tool_key in self.TOOL_PRIORITY:
                if self.tools.get(tool_key, 0) > 0:
                    data['toolType'] = self.TOOL_TYPE_MAP.get(tool_key, 0)
                    tool_name = f'{tool_key}道具'
                    self.tools[tool_key] -= 1
                    break

            r = self._post('app/board/roll', data, encrypted=True, has_data_sign=True)
            if r.get('code') == 200:
                self.fail_count = 0
                resp_data = r.get('data', {})
                if isinstance(resp_data, dict):
                    steps = resp_data.get('steps', '?')
                    rewards = resp_data.get('rewards', [])
                    pts = sum(rr.get('pointCount', 0) for rr in rewards)
                    obtained = resp_data.get('obtainedTools', '')
                    if obtained:
                        self._parse_obtained_tools(obtained)
                    msg = f'-> 前进{steps}步 +{pts}积分'
                    if tool_name:
                        msg += f' [{tool_name}]'
                    if obtained:
                        msg += f' 获得道具:{obtained}'
                    log.info(msg)
                return resp_data
            self._handle_error('board/roll', r.get('msg', ''))
            return None
        except Exception as e:
            self._handle_error('board/roll', str(e))
            return None

    TOOL_TYPE_REVERSE = {v: k for k, v in TOOL_TYPE_MAP.items()}

    def _parse_obtained_tools(self, obtained_str):
        try:
            pairs = re.findall(r'(\d+):(\d+)', obtained_str)
            for tool_type, count in pairs:
                t, c = int(tool_type), int(count)
                key = self.TOOL_TYPE_REVERSE.get(t)
                if key:
                    self.tools[key] = self.tools.get(key, 0) + c
        except Exception:
            pass

    def show_badge_pop(self):
        try:
            r = self._post('app/showBadgePop')
            return r.get('data', {})
        except Exception:
            return {}

    def add_statistics(self, stat_type, business_id, child_id=None):
        try:
            d = {'type': stat_type, 'businessId': business_id, 'channel': 'default'}
            if child_id:
                d['childBusinessId'] = child_id
            return self._post('app/addStatistics', d)
        except Exception:
            return None

    def get_banner_config(self):
        try:
            r = self._post('app/getBannerConfig')
            return r.get('data')
        except Exception:
            return None

    def run(self):
        if not self.get_token():
            return
        time.sleep(random.uniform(2, 4))

        if not self.pre_init():
            return
        time.sleep(random.uniform(2, 4))

        self.get_banner_config()
        time.sleep(random.uniform(1, 3))

        init = self.get_init(verbose=True)
        if not init:
            return
        time.sleep(random.uniform(1, 3))

        self.show_badge_pop()
        time.sleep(random.uniform(1, 2))

        self.add_statistics('8', 'baseStatistic')
        time.sleep(random.uniform(1, 2))

        self.add_statistics('2', 'baseStatistic')
        time.sleep(random.uniform(1, 2))

        if not init.get('todaySigned'):
            self.sign_in()
            time.sleep(random.uniform(2, 5))
            self.get_init()
            time.sleep(random.uniform(1, 3))
        else:
            log.info('已签到')

        log.info(f'任务处理...')
        task_list = self.get_task_list()
        time.sleep(random.uniform(1, 3))

        if not task_list:
            log.info(f'任务列表为空')
        else:
            for task in task_list:
                name = task.get('taskName', '')
                tid = task.get('taskId', '')
                task_type = task.get('taskType', 0)
                recv_count = task.get('receiveAwardCount', 0)
                complete_count = task.get('taskCompleteCount', 0)
                limit = task.get('taskCompleteLimit', 1)
                reward_pt = task.get('rewardPointCount', 0)
                reward_dice = task.get('rewardDiceCount', 0)

                if recv_count >= limit:
                    log.info(f'{name} [type={task_type}] -> 已完成')
                    continue
                if task_type == 3:
                    log.info(f'{name} [type={task_type}] -> 跳过(需邀请)')
                    continue

                need_complete = complete_count < limit

                if not need_complete:
                    if self.receive_task_award(tid, name):
                        log.info(f'{name}  -> 领奖 +{reward_pt}分+{reward_dice}骰')
                    time.sleep(random.uniform(2, 4))
                    continue

                self.add_statistics('1', 'taskStatistic', tid)
                time.sleep(random.uniform(1, 2))
                if self.complete_task(tid, name):
                    time.sleep(random.uniform(2, 5))
                    self.get_init()
                    time.sleep(random.uniform(1, 3))
                    self.show_badge_pop()
                    time.sleep(random.uniform(1, 2))
                    self.receive_task_award(tid, name)
                    time.sleep(random.uniform(2, 4))
                    log.info(f'{name} [type={task_type}] -> 完成 +{reward_pt}分+{reward_dice}骰')
                else:
                    log.info(f'{name} [type={task_type}] -> 失败')

        self.get_init()
        time.sleep(random.uniform(1, 3))

        for i, ms in enumerate(self.task_milestones):
            if ms.get('receiveStatus') != 0:
                continue
            required = ms.get('milestoneCount', 0)
            if self.user_task_total_count >= required:
                self.receive_milestone_award(i)
                time.sleep(random.uniform(2, 4))
                self.get_init()
                time.sleep(random.uniform(1, 3))
                self.show_badge_pop()
                time.sleep(random.uniform(1, 2))

        init = self.get_init()
        if init:
            self.dice_count = init.get('diceCount', 0) + init.get('newUserDiceCount', 0)

        rolled = 0
        if self.dice_count > 0:
            log.info(f'掷骰子 x{self.dice_count}')
        while self.dice_count > 0:
            tool_info = ' '.join(f'{k}:{v}' for k, v in self.tools.items()) if self.tools else '无'
            log.info(f'当前道具状态 - {tool_info}')
            self.add_statistics('7', 'baseStatistic')
            time.sleep(random.uniform(1, 2))
            saved_tools = self.tools.copy()
            result = self.roll_dice()
            if not result:
                break
            time.sleep(random.uniform(3, 8))
            self.show_badge_pop()
            time.sleep(random.uniform(1, 2))
            init = self.get_init(verbose=True)
            if init:
                self.dice_count = init.get('diceCount', 0) + init.get('newUserDiceCount', 0)
                for k in list(self.tools.keys()):
                    if k in saved_tools and self.tools[k] < saved_tools[k]:
                        self.tools[k] = saved_tools[k]
            else:
                break
            rolled += 1
            time.sleep(random.uniform(2, 5))

        self._rolled = rolled


# ============ main() ============

def main():
    wcs_ids = os.environ.get('ZQSM_WCSIDS', '')
    p_tokens_env = os.environ.get('ZQSM_P_TOKENS', '')
    wcs_url = os.environ.get('wx_server_url', 'http://127.0.0.1:8787')
    wcs_auth = os.environ.get('wx_auth', '')
    proxy_env = os.environ.get('ZQSM_PROXIES', '')
    force_local = os.environ.get('ZQSM_WCS_LOCAL', '').lower() == 'true'

    proxies = [p.strip() for p in proxy_env.split(',') if p.strip()] if proxy_env else []

    # ---- 控制台自动发现模式 ----
    use_console = False
    console = None

    if wcs_auth and (force_local or '127.0.0.1' in wcs_url or not wcs_ids.strip()):
        try:
            console = WCSConsoleClient(wcs_url, wcs_auth)
            accounts = console.get_accounts()
            if accounts is not None:
                use_console = True
                log.info(f'WCS控制台模式 (服务器: {wcs_url})')
            else:
                log.warning('WCS控制台连接失败，尝试其他模式...')
        except Exception as e:
            log.warning(f'WCS控制台连接异常: {e}，尝试其他模式...')

    if use_console and console:
        log.info('使用控制台自动发现模式...')
        accounts = console.get_accounts()
        if accounts is None:
            log.error('控制台未返回账号列表')
            sys.exit(1)

        log.info(f'发现 {len(accounts)} 个账号:')
        for acc in accounts:
            disabled = acc.get('disabled', False)
            openid = acc.get('openid', '') or acc.get('userKey', '')
            display = acc.get('displayName', '') or openid[:12]
            log.info(f'  - {display} | {openid[:12]}... | 禁用={disabled}')

        active_accounts = [a for a in accounts if not a.get('disabled', False)]
        
        # wx_opinion 过滤：只处理指定的 openid
        wx_opinion = os.environ.get('wx_opinion', '').strip()
        if wx_opinion:
            filter_openids = set(wx_opinion.split('&'))
            active_accounts = [a for a in active_accounts 
                              if (a.get('openid') or a.get('userKey', '')) in filter_openids]
            log.info(f'wx_opinion 过滤后: {len(active_accounts)} 个账号')
        if not active_accounts:
            log.error('所有账号均已禁用，请在控制台启用账号')
            sys.exit(1)

        log.info(f'活跃账号: {len(active_accounts)} 个')

        # 批量健康状态检查
        openids = [a.get('openid') or a.get('userKey') for a in active_accounts]
        status_result = console.check_accounts_status(openids)
        if status_result:
            log.info('账号健康状态检查完成')

        for idx, acc in enumerate(active_accounts):
            user_key = acc.get('openid') or acc.get('userKey')
            display_name = acc.get('displayName', '') or user_key[:8]
            proxy = proxies[idx % len(proxies)] if proxies else None
            aid = f'{display_name}({idx + 1})'

            log.info(f'------ {aid} ({user_key[:8]}...) ------')

            # 获取 encryptKey + iv，AES-CBC 加密生成 encrypted openId
            enc_data = console.get_encrypt_key(user_key, WX_APPID)
            if not enc_data:
                log.error(f'{aid} 获取encryptKey失败，跳过')
                continue

            enc_key = enc_data.get('encrypt_key')
            iv_hex = enc_data.get('iv')
            if not enc_key or not iv_hex:
                log.error(f'{aid} encryptKey/iv 格式异常: {enc_data}')
                continue

            encrypted_open_id = _aes_encrypt_openid(user_key, enc_key, iv_hex)
            log.info(f'encrypted openId (AES-CBC): {encrypted_open_id[:16]}...')

            wcs = WeChatCodeServer(console, WX_APPID)
            p_token = wx_login_get_ptoken(wcs, user_key, str(encrypted_open_id))
            if not p_token:
                log.error(f'{aid} 获取P-Token失败，跳过')
                continue

            try:
                sess = Session(p_token, aid, proxy)
                sess.run()
                rolled = getattr(sess, '_rolled', 0)
                parts = [f'积分:{sess.user_point_count}', f'骰子:{sess.dice_count}',
                         f'任务:{sess.user_task_total_count}', f'掷骰:{rolled}次']
                for k, v in sess.tools.items():
                    if v > 0:
                        parts.append(f'{k}道具:{v}')
                log.info(f'汇总 {" ".join(parts)}')
            except Exception as e:
                log.error(f'致命错误: {e}')
                import traceback
                traceback.print_exc()

            if idx < len(active_accounts) - 1:
                time.sleep(random.uniform(5, 15))

    elif wcs_ids.strip():
        # 兼容模式：ZQSM_WCSIDS
        log.info(f'使用 WCS 兼容模式 (appid: {WX_APPID})')
        if not wcs_url or not wcs_auth:
            log.error('WCS模式需要同时设置 wx_server_url 和 wx_auth')
            sys.exit(1)

        console = WCSConsoleClient(wcs_url, wcs_auth)
        wcs = WeChatCodeServer(console, WX_APPID)

        accounts = []
        for item in wcs_ids.split('&'):
            item = item.strip()
            if not item:
                continue
            if '@' in item:
                parts = item.split('@', 1)
                accounts.append((parts[0].strip(), parts[1].strip()))
            else:
                log.error(f'格式错误，应为 wcsid@encrypted_openid: {item}')
                sys.exit(1)

        for idx, (wcs_id, enc_id) in enumerate(accounts):
            proxy = proxies[idx % len(proxies)] if proxies else None
            aid = f'第{idx + 1}个'
            log.info(f'------ {aid} wcsid: {wcs_id[:8]}... ------')

            p_token = wx_login_get_ptoken(wcs, wcs_id, enc_id)
            if not p_token:
                log.error(f'{aid} 获取P-Token失败，跳过')
                continue

            try:
                sess = Session(p_token, aid, proxy)
                sess.run()
                rolled = getattr(sess, '_rolled', 0)
                parts = [f'积分:{sess.user_point_count}', f'骰子:{sess.dice_count}',
                         f'任务:{sess.user_task_total_count}', f'掷骰:{rolled}次']
                for k, v in sess.tools.items():
                    if v > 0:
                        parts.append(f'{k}道具:{v}')
                log.info(f'汇总 {" ".join(parts)}')
            except Exception as e:
                log.error(f'致命错误: {e}')
                import traceback
                traceback.print_exc()

            if idx < len(accounts) - 1:
                time.sleep(random.uniform(5, 15))

    elif p_tokens_env.strip():
        # P-Token 直连模式
        log.info('使用 P-Token 模式')
        tokens = [t.strip() for t in p_tokens_env.split('&') if t.strip()]

        for idx, p_token in enumerate(tokens):
            proxy = proxies[idx % len(proxies)] if proxies else None
            aid = f'第{idx + 1}个'

            try:
                sess = Session(p_token, aid, proxy)
                sess.run()
                rolled = getattr(sess, '_rolled', 0)
                parts = [f'积分:{sess.user_point_count}', f'骰子:{sess.dice_count}',
                         f'任务:{sess.user_task_total_count}', f'掷骰:{rolled}次']
                for k, v in sess.tools.items():
                    if v > 0:
                        parts.append(f'{k}道具:{v}')
                log.info(f'汇总 {" ".join(parts)}')
            except Exception as e:
                log.error(f'致命错误: {e}')
                import traceback
                traceback.print_exc()

            if idx < len(tokens) - 1:
                time.sleep(random.uniform(5, 15))

    else:
        log.error('未设置环境变量')
        log.info('=== 控制台模式 (推荐) ===')
        log.info('export wx_auth="your-api-key"')
        log.info('export wx_server_url="http://127.0.0.1:8787"')
        log.info('')
        log.info('=== WCS 兼容模式 ===')
        log.info('export ZQSM_WCSIDS="wcsid@encrypted_openid&..."')
        log.info('export wx_server_url="http://your-wcs-server:port"')
        log.info('export wx_auth="your-api-key"')
        log.info('')
        log.info('=== P-Token 模式 (备选) ===')
        log.info('export ZQSM_P_TOKENS="P-Token值1&P-Token值2"')
        sys.exit(1)


if __name__ == '__main__':
    main()