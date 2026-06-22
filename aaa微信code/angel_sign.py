# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========

#!/usr/bin/env python3
"""
安吉尔 (Angel) 小程序自动签到脚本
通过 WCS Console 自动获取 wx.login code，完成登录 + 每日签到。

HAR 抓包来源: 安吉尔.qpic.cn_2026_05_23_22_51_10.har
AppID: wxc4a1f99a6c90c1a4
API Base: https://userone.angelgroup.com.cn
登录模式: A (简单模式 - code 换 token 在 JSON body)

接口分析:
  1. POST /api/member/app/wxLogin      → code 换 token + userId
  2. POST /api/member/marketSign/bulletinBoard  → 查询签到状态
  3. POST /api/member/marketSign/signTable      → 执行签到
"""

import os
import sys
import json
import time
import random
import hashlib
import logging
from datetime import datetime
from _log_tee import enable as _enable_tee


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


# ==== 自动安装依赖 ====
try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests

# ==== 日志 ====
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('angel')

# ==== 常量 ====
APPID = 'wxc4a1f99a6c90c1a4'
API_BASE = 'https://userone.angelgroup.com.cn'
MERCHANT_ID = '10000'

# ==== 配置缓存 (.angel_config.json) ====
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.angel_config.json')
_DEFAULT_CONFIG = {
    'wx_server_url': 'http://127.0.0.1:8787',
    'wx_auth':       '',
    'angel':         '',  # 手动 token 降级: "备注#openid#token#userId"
}


def _load_config():
    """三级配置: 环境变量 > 缓存文件 > 硬编码默认值"""
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
        'angel':         'angel',
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
        except Exception:
            pass

    return config


_config = _load_config()
WCS_BASE = _config['wx_server_url']
WCS_AUTH = _config['wx_auth']

# ==== Token 缓存 (.angel_token_cache.json) ====
_TOKEN_CACHE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '.angel_token_cache.json'
)
_TOKEN_TTL = 8 * 3600  # token 缓存 8 小时


def _get_cached_token(openid):
    if not os.path.exists(_TOKEN_CACHE):
        return None
    try:
        with open(_TOKEN_CACHE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        entry = cache.get(openid)
        if not entry or time.time() - entry.get('ts', 0) > _TOKEN_TTL:
            return None
        return entry.get('data')
    except Exception:
        return None


def _set_cached_token(openid, data):
    cache = {}
    if os.path.exists(_TOKEN_CACHE):
        try:
            with open(_TOKEN_CACHE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except Exception:
            pass
    cache[openid] = {'data': data, 'ts': time.time()}
    with open(_TOKEN_CACHE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def _invalidate_token(openid):
    if not os.path.exists(_TOKEN_CACHE):
        return
    try:
        with open(_TOKEN_CACHE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        if openid in cache:
            del cache[openid]
            with open(_TOKEN_CACHE, 'w', encoding='utf-8') as f:
                json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


# ==== 工具函数 ====

def random_ua():
    """生成随机微信 User-Agent，模拟真实设备"""
    devices = [
        ('16', 'M2012K11AC Build/BP2A.250605.031.A3'),
        ('15', 'PELM00 Build/OPR1A.20240502.001'),
        ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ('14', 'SM-S918B Build/UP1A.231005.007'),
        ('13', 'V2141A Build/TP1A.220627.004'),
    ]
    wv_list = ['8.0.72.3100', '8.0.70.2780', '8.0.68.2780',
               '8.0.65.2780', '8.0.60.2780']
    av, dev = random.choice(devices)
    wv = random.choice(wv_list)
    return (
        f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
        f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
        f'Chrome/{random.randint(140, 146)}.0.{random.randint(6000, 7680)} '
        f'Mobile Safari/537.36 '
        f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
        f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
    )


def make_headers(appid=APPID):
    """构建微信小程序完整请求头（含 merchantId + behavior）"""
    return {
        'User-Agent':      random_ua(),
        'Content-Type':    'application/json',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection':      'keep-alive',
        'xweb_xhr':        '1',
        'Sec-Fetch-Site':  'cross-site',
        'Sec-Fetch-Mode':  'cors',
        'Sec-Fetch-Dest':  'empty',
        'Referer':         f'https://servicewechat.com/{appid}/59/page-frame.html',
        # 安吉尔业务专属头
        'merchantId':      MERCHANT_ID,
        'behavior':        '{}',
    }


# ==== WCS Client ====

class WCSClient:
    """WCS 控制台客户端"""

    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _get(self, path, timeout=30):
        r = requests.get(
            f'{self.base}{path}',
            headers={'AUTH': self.auth},
            timeout=timeout,
        verify=False)
        return r.json()

    def _post(self, path, data, timeout=60):
        r = requests.post(
            f'{self.base}{path}',
            json=data,
            headers={'AUTH': self.auth, 'Content-Type': 'application/json'},
            timeout=timeout,
        verify=False)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """对安吉尔小程序执行 wx.login() 获取 code"""
        body = {
            'appid':   APPID,
            'userKey': user_key or openid,
            'openid':  openid,
        }
        try:
            data = self._post('/wx/code', body)
        except requests.exceptions.Timeout:
            log.warning('[WCS] /wx/code 请求超时')
            return None
        except requests.exceptions.RequestException as e:
            log.warning(f'[WCS] /wx/code 网络错误: {e}')
            return None

        if data and data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
        log.warning(f'[WCS] /wx/code 返回异常: {data}')
        return None


# ==== 业务登录 (Mode A: code → JSON body token) ====

def login_via_wcs(openid, user_key=None):
    """
    安吉尔登录流程 (Mode A — 简单模式):
      1. /wx/code → wx.login code
      2. POST /api/member/app/wxLogin → token + userId
    返回: dict {'token', 'openid', 'user_id', 'name', 'phone'} 或 None
    """
    wcs = WCSClient()

    # Step 1: 获取 wx.login code（重试 3 次，退避延迟 3s→6s）
    log.info('[Login] 获取 wx.login code...')
    login_code = None
    for attempt in range(3):
        try:
            login_code = wcs.get_code(openid, user_key or openid)
        except Exception as e:
            log.warning(f'get_code 异常: {e}')
            login_code = None
        if login_code:
            break
        if attempt < 2:
            wait = 3 * (attempt + 1)
            log.warning(f'code 获取失败，{wait}s 后重试 ({attempt + 1}/3)...')
            time.sleep(wait)

    if not login_code:
        log.error('wx.login code 获取失败，已重试 3 次')
        return None

    # Step 2: code 换 token
    time.sleep(random.uniform(0.5, 1.5))
    log.info('[Login] code → token...')

    try:
        resp = requests.post(
            f'{API_BASE}/api/member/app/wxLogin',
            json={'sourceType': 1, 'code': login_code},
            headers=make_headers(),
            timeout=15,
            verify=False,
        )
    except requests.RequestException as e:
        log.error(f'wxLogin 请求失败: {e}')
        return None

    data = resp.json()

    if data.get('code') != '200':
        log.error(f'wxLogin 失败: {data.get("message", data)}')
        return None

    login_data = data['data']
    token = login_data.get('token', '')
    uid = login_data.get('buyerUserId', '')
    openid_svr = login_data.get('wechatOpenId', '')

    if not token:
        log.error('wxLogin 返回无 token')
        return None

    result = {
        'token':   token,
        'openid':  openid_svr or openid,
        'user_id': uid,
        'name':    login_data.get('name', ''),
        'phone':   login_data.get('phone', ''),
    }

    log.info(f'[Login] 成功! user={result["name"]}, uid={uid}')
    return result


# ==== 安吉尔业务客户端 ====

class AngelClient:
    """安吉尔业务 API 封装"""

    def __init__(self, token, openid, user_id, name=''):
        self.token   = token
        self.openid  = openid
        self.user_id = user_id
        self.name    = name
        self.session = requests.Session()
        self.session.verify = False

    def _headers(self):
        h = make_headers()
        h['Authorization'] = f'Bearer {self.token}'
        return h

    def _post(self, path, data=None, timeout=15):
        try:
            resp = self.session.post(
                f'{API_BASE}{path}',
                json=(data or {}),
                headers=self._headers(),
                timeout=timeout,
            )
            result = resp.json()

            # 自动检测 token 失效
            msg = result.get('message', '') or ''
            if (result.get('code') in ('401', '403')
                    or resp.status_code in (401, 403)
                    or any(kw in msg for kw in ('登录', 'token', '失效', '过期', '未授权'))):
                log.warning(f'[{self.name}] token 失效，清除缓存')
                _invalidate_token(self.openid)
                return None

            return result
        except requests.RequestException as e:
            log.error(f'[_post] {path} 请求失败: {e}')
            return None

    def get_sign_status(self):
        """查询签到公告板状态"""
        now = datetime.now()
        body = {
            'checkInDateStart': f'{now.year}-{now.month:02d}-01 00:00:00',
            'checkInDateEnd':   f'{now.year}-{now.month:02d}-{now.day:02d} 23:59:59',
            'month':            now.month,
            'userId':           self.user_id,
        }
        return self._post('/api/member/marketSign/bulletinBoard', body)

    def do_sign(self):
        """执行签到"""
        now = datetime.now()
        body = {
            'checkInDateStart': f'{now.year}-{now.month:02d}-01 00:00:00',
            'checkInDateEnd':   f'{now.year}-{now.month:02d}-{now.day:02d} 23:59:59',
            'month':            now.month,
            'userId':           self.user_id,
        }
        return self._post('/api/member/marketSign/signTable', body)


# ==== 手动 token 降级 ====

def parse_manual_account():
    """从环境变量 angel 解析手动 token"""
    # 支持 wx_opinion 纯 openid 格式 (& 分隔)
    _wxop = os.environ.get('wx_opinion', '')
    if _wxop and '&' in _wxop and '#' not in _wxop:
        return None  # wx_opinion 纯 openid 格式, 由 WCS 自动登录处理
    raw = os.environ.get('angel', '') or _config.get('angel', '')
    if not raw:
        return None

    parts = raw.split('#')
    if len(parts) < 3:
        log.error('手动 token 格式错误，应为: 备注#openid#token#userId')
        return None

    return {
        'name':    parts[0],
        'openid':  parts[1],
        'token':   parts[2],
        'user_id': parts[3] if len(parts) > 3 else '',
    }


# ==== 签到主流程 ====

def run_one(client):
    """对一个账号执行签到，返回 True/False"""
    tag = client.name or client.user_id or client.openid[:8]

    # 1. 查询签到状态
    log.info(f'[{tag}] 查询签到状态...')
    status = client.get_sign_status()
    if status is None:
        log.error(f'[{tag}] 查询状态失败 (token 可能已失效)')
        return False

    if status.get('code') != '200':
        log.error(f'[{tag}] 查询返回异常: {status.get("message", status)}')
        return False

    data = status['data']
    activity_name = data.get('nameActivity', '签到活动')
    sign_records = data.get('signRecords', [])
    already_signed = data.get('alreadySignedNum', 0)

    today_str = datetime.now().strftime('%Y%m%d')
    already_today = any(r.get('signDd') == today_str for r in sign_records)

    if already_today:
        log.info(f'[{tag}] 今日已签到 ✓  ({activity_name}, 已签 {already_signed} 天)')
        return True

    # 2. 执行签到
    log.info(f'[{tag}] 执行签到...')
    time.sleep(random.uniform(0.5, 1.5))

    result = client.do_sign()
    if result is None:
        log.warning(f'[{tag}] 签到请求失败，token 已自动清除缓存')
        return False

    if result.get('code') != '200':
        log.error(f'[{tag}] 签到失败: {result.get("message", result)}')
        return False

    sign_data = result['data']
    days = sign_data.get('signInDays', 0)
    points = sign_data.get('awardsNum', 0)

    log.info(f'[{tag}] ✅ 签到成功!  连续 {days} 天, +{points} 积分')
    return True


def main():
    print('=' * 50)
    print('  安吉尔 (Angel) 小程序自动签到')
    print(f'  {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 50)

    # ── 方式 1: 手动 token 降级 ──
    manual = parse_manual_account()
    if manual:
        log.info(f'[手动模式] {manual["name"]}')
        client = AngelClient(
            manual['token'], manual['openid'],
            manual['user_id'], manual['name'],
        )
        ok = run_one(client)
        print(f'\n结果: {"✅ 成功" if ok else "❌ 失败"}')
        return 0 if ok else 1

    # ── 方式 2: WCS 自动登录 ──
    if not WCS_AUTH:
        print('\n❌ 未配置 WCS 连接信息')
        print('  请设置环境变量:')
        print('    set wx_auth=YOUR_API_KEY')
        print('    set wx_server_url=http://127.0.0.1:8787  (可选)')
        print('')
        print('  或者使用手动 token 降级:')
        print('    set angel=备注#openid#token#userId')
        return 1

    wcs = WCSClient()
    accounts = wcs.get_accounts()

    if not accounts:
        log.error('WCS 中无可用账号，请先在 daidai 面板扫码添加微信账号')
        return 1

    active = [a for a in accounts if not a.get('disabled', False)]
    if not active:
        log.warning('所有账号已禁用')
        return 1

    log.info(f'发现 {len(active)} 个启用账号')

    success_count = 0
    for acc in active:
        openid = acc.get('openid', '')
        user_key = acc.get('userKey', openid)

        print(f'\n{"-" * 40}')
        tag = f'{openid[:16]}...'
        log.info(f'账号: {tag}')

        # 获取 token（缓存 → WCS，失败自动重试）
        login_info = None
        for attempt in range(2):
            if attempt == 0:
                login_info = _get_cached_token(openid)
                if login_info:
                    log.info('[TokenCache] 命中缓存，跳过 wx.login')
                else:
                    log.info('[TokenCache] 未命中，通过 WCS 登录...')
                    login_info = login_via_wcs(openid, user_key)
                    if login_info:
                        _set_cached_token(openid, login_info)
            else:
                # 第二次：清除缓存，重新 WCS 登录
                log.info('[TokenCache] token 失效，清除缓存重新登录...')
                _invalidate_token(openid)
                login_info = login_via_wcs(openid, user_key)
                if login_info:
                    _set_cached_token(openid, login_info)

            if not login_info:
                if attempt == 0:
                    continue  # 重试
                log.error(f'登录失败，跳过账号: {tag}')
                break

            client = AngelClient(
                login_info['token'],
                login_info['openid'],
                login_info['user_id'],
                login_info.get('name', ''),
            )

            ok = run_one(client)
            if ok:
                success_count += 1
                break
            elif attempt == 0:
                # 签到失败可能因 token 过期，重试
                log.warning('签到失败，尝试重新登录...')
                continue
        else:
            pass

        # 多账号间随机延迟（防风控）
        time.sleep(random.uniform(3, 8))

    print(f'\n{"=" * 50}')
    print(f'  完成: {success_count}/{len(active)} 签到成功')
    print('=' * 50)

    return 0 if success_count > 0 else 1


if __name__ == "__main__":
    import io


    _tee_out, _tee_err = _enable_tee()

    # Make logging also write to _log_capture (fix empty push issue)
    _capture_handler = logging.StreamHandler(_log_capture)
    _capture_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
    log.addHandler(_capture_handler)
    log.propagate = False
    for _h in logging.getLogger().handlers[:]:
        logging.getLogger().removeHandler(_h)
    logging.getLogger().addHandler(_capture_handler)
    try:
        result = main()
    except SystemExit as e:
        result = e.code
    except Exception as e:
        print(f'脚本异常: {e}')
        result = 1
    finally:
        sys.stdout = _tee_out.original

        sys.stderr = _tee_err.original

        _logs = _tee_out.getvalue()
    if _logs.strip():
        print(_logs)
        try:
            push_notify('angel_sign 签到结果', _logs[-2000:])
        except:
            pass
    sys.exit(result or 0)



