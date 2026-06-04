#!/usr/bin/env python3
"""
袋鼠妈妈签到脚本 (有赞平台)
=============================
平台: 有赞 (Youzan)
小程序 AppID: wxb27b46293d405a20
店铺 kdt_id: 44587018
签到活动 checkinId: 17019

支持两种模式:
  1. 手动 token 模式: 设置环境变量 ds = "备注#access_token"
  2. WCS 自动模式: 设置 wx_server_url + wx_auth，自动获取 wx.login code 换取 access_token

环境变量:
  ds              - 手动 token (格式: "备注#access_token")
  wx_server_url   - WCS 控制台地址 (默认 http://127.0.0.1:8787)
  wx_auth         - WCS API Key
"""

import os
import sys
import json
import time
import random
import hashlib
import logging

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


# ====== 自动安装依赖 ======
try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests

# ====== 日志配置 ======
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('daishu')

# ====== 常量 ======
APPID = 'wxb27b46293d405a20'
KDT_ID = '44587018'
CHECKIN_ID = '17019'
API_BASE = 'https://h5.youzan.com'

# ====== 配置缓存 ======
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.daishu_config.json')

_DEFAULT_CONFIG = {
    'wx_server_url': 'http://127.0.0.1:8787',
    'wx_auth': '',
    'ds': '',  # 手动 token 降级
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
        'wx_auth': 'wx_auth',
        'ds': 'ds',
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


# ====== Token 缓存 ======
_TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.daishu_token_cache.json')
_TOKEN_TTL = 8 * 3600  # 8 小时


def _load_token_cache():
    if os.path.exists(_TOKEN_CACHE_FILE):
        try:
            with open(_TOKEN_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_token_cache(cache):
    try:
        with open(_TOKEN_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _token_cache_key(appid, user_key):
    raw = f'{appid}:{user_key}'
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def get_cached_token(appid, user_key):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    entry = cache.get(ck)
    if not entry:
        return None, 'no_cache'
    if time.time() - entry.get('ts', 0) > _TOKEN_TTL:
        del cache[ck]
        _save_token_cache(cache)
        return None, 'expired'
    return entry.get('data'), None


def set_cached_token(appid, user_key, token_data):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    cache[ck] = {'data': token_data, 'ts': time.time(), 'appid': appid}
    _save_token_cache(cache)


def invalidate_token(appid, user_key):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    if ck in cache:
        del cache[ck]
        _save_token_cache(cache)


# ====== WCS 客户端 ======
class WCSClient:
    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _post(self, path, data, timeout=60):
        r = requests.post(f'{self.base}{path}', json=data,
                          headers={'AUTH': self.auth, 'Content-Type': 'application/json'},
                          timeout=timeout)
        return r.json()

    def _get(self, path, timeout=30):
        r = requests.get(f'{self.base}{path}',
                         headers={'AUTH': self.auth}, timeout=timeout)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """对袋鼠妈妈小程序执行 wx.login() 获取 code"""
        body = {
            'appid': APPID,
            'userKey': user_key or openid,
            'openid': openid,
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


# ====== 有赞客户端 ======
class YouzanClient:
    """有赞平台 API 客户端"""

    def __init__(self, access_token, openid='', session_id=''):
        self.access_token = access_token
        self.openid = openid
        self.session_id = session_id  # 登录返回的 sessionId

    def _make_headers(self):
        devices = [
            ('16', 'M2012K11AC Build/BP2A.250605.031.A3'),
            ('15', 'PELM00 Build/OPR1A.20240502.001'),
            ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ]
        wv_list = ['8.0.72.3100', '8.0.70.2780', '8.0.68.2780']
        av, dev = random.choice(devices)
        wv = random.choice(wv_list)
        ua = (
            f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
            f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
            f'Chrome/{random.randint(140,146)}.0.{random.randint(6000,7680)} Mobile Safari/537.36 '
            f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
            f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
        )
        headers = {
            'User-Agent': ua,
            'Content-Type': 'application/json',
            'xweb_xhr': '1',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': f'https://servicewechat.com/{APPID}/39/page-frame.html',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }
        # 有赞 API 需要 Extra-Data 头携带会话信息
        if self.session_id:
            import uuid as _uuid
            headers['Extra-Data'] = json.dumps({
                'is_weapp': 1,
                'sid': self.session_id,
                'version': '2.232.5.101',
                'client': 'weapp',
                'bizEnv': 'wsc',
                'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                'ftime': int(time.time() * 1000),
            })
        return headers

    def _get(self, path, params=None):
        """GET 请求，自动附加公共参数"""
        if params is None:
            params = {}
        params.setdefault('app_id', APPID)
        params.setdefault('kdt_id', KDT_ID)
        params.setdefault('access_token', self.access_token)

        url = f'{API_BASE}{path}'
        resp = requests.get(url, params=params, headers=self._make_headers(), timeout=15)
        return resp.json()

    def get_checkin_info(self):
        """查询签到信息 (获取 checkinId)"""
        return self._get('/wscump/checkin/check-in-info.json')

    def get_checkin_status(self):
        """查询签到状态"""
        return self._get('/wscump/checkin/get_activity_by_yzuid_v2.json',
                         {'checkinId': CHECKIN_ID})

    def do_checkin(self):
        """执行签到"""
        return self._get('/wscump/checkin/checkinV2.json',
                         {'checkinId': CHECKIN_ID})

    def get_monthly_record(self, year, month):
        """查询月度签到记录"""
        return self._get('/wscump/checkin/find_checkin_info_by_month.json',
                         {'checkin_id': CHECKIN_ID, 'year': year, 'month': month})


# ====== 登录流程 ======
def login_via_wcs(openid, user_key=None):
    """通过 WCS 自动登录，返回 access_token 或 None"""
    wcs = WCSClient()

    # Step 1: 获取 wx.login code
    log.info('[WCS] 获取 loginCode...')
    login_code = None
    for attempt in range(3):
        try:
            login_code = wcs.get_code(openid, user_key or openid)
        except Exception as e:
            log.warning(f'[WCS] get_code 异常: {e}，重试 ({attempt+1}/3)...')
            login_code = None
        if login_code:
            break
        if attempt < 2:
            wait = 3 * (attempt + 1)
            log.info(f'[WCS] code 获取失败，{wait}s 后重试 ({attempt+1}/3)...')
            time.sleep(wait)

    if not login_code:
        log.error('loginCode 获取失败，已重试 3 次')
        return None

    log.info(f'[WCS] 获取到 code: {login_code[:10]}...')

    # Step 2: 用 code 换取有赞 access_token
    # 有赞真实登录端点: POST https://uic.youzan.com/passport/general/auth.json
    try:
        import uuid as _uuid
        resp = requests.post(
            f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APPID}',
            json={
                'appId': APPID,
                'code': login_code,
                'platformName': 'weapp',
                'signature': 'windows',
                'clientBiz': 'weapp_wsc',
                'inWsc': True,
                'kdtId': KDT_ID,
                'extraBizData': {
                    'enterOptions': {
                        'extKdtId': int(KDT_ID),
                        'path': 'pages/home/dashboard/index',
                        'query': {},
                        'scene': 1005,
                        'referrerInfo': {},
                        'apiCategory': 'default',
                    },
                    'guideBizDataMap': {'from_params': ''},
                    'sceneData': {},
                },
            },
            headers={
                'Content-Type': 'application/json',
                'Referer': f'https://servicewechat.com/{APPID}/39/page-frame.html',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541939) XWEB/19841',
                'xweb_xhr': '1',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'page-path': 'pages/home/dashboard/index',
                'app-mode': 'default',
                'Extra-Data': json.dumps({
                    'sid': '',
                    'version': '2.232.5.101',
                    'clientType': 'weapp-miniprogram',
                    'client': 'weapp',
                    'bizEnv': '',
                    'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                    'ftime': int(time.time() * 1000),
                }),
            },
            timeout=15,
        )
        data = resp.json()
        log.info(f'[有赞] 登录响应: code={data.get("code")}, msg={data.get("msg")}')

        if data.get('code') == 0 and data.get('data'):
            login_data = data['data']
            token = login_data.get('accessToken', '')
            session_id = login_data.get('sessionId', '')
            if token:
                log.info(f'[有赞] 获取到 accessToken: {token[:10]}..., sessionId: {session_id[:20]}...')
                return {'access_token': token, 'session_id': session_id}

    except Exception as e:
        log.error(f'[有赞] 登录请求异常: {e}')

    return None


def parse_manual_accounts():
    """解析手动 token 环境变量: "备注#access_token" """
    raw = _config.get('ds', '') or os.environ.get('ds', '')
    if not raw:
        return []

    accounts = []
    for item in raw.split('@'):
        item = item.strip()
        if not item:
            continue
        parts = item.split('#')
        if len(parts) >= 2:
            accounts.append({
                'remark': parts[0],
                'access_token': parts[1],
            })
        elif len(parts) == 1:
            accounts.append({
                'remark': '手动',
                'access_token': parts[0],
            })
    return accounts


# ====== 签到逻辑 ======
def run_checkin(client, remark=''):
    """执行签到流程"""
    prefix = f'[{remark}] ' if remark else ''

    # 1. 查询签到状态
    log.info(f'{prefix}查询签到状态...')
    status = client.get_checkin_status()
    if status.get('code') != 0:
        log.error(f'{prefix}查询签到状态失败: {status.get("msg")}')
        return False

    status_data = status.get('data', {})
    is_checkin = status_data.get('isCheckin', False)
    continues_day = status_data.get('continuesDay', 0)
    cycle_times = status_data.get('cycleTimes', 0)

    log.info(f'{prefix}连续签到: {continues_day} 天, 周期: {cycle_times} 天, 今日已签: {is_checkin}')

    if is_checkin:
        log.info(f'{prefix}今日已签到，跳过')
        return True

    # 2. 执行签到
    log.info(f'{prefix}执行签到...')
    time.sleep(random.uniform(0.5, 1.5))

    result = client.do_checkin()
    if result.get('code') != 0:
        log.error(f'{prefix}签到失败: {result.get("msg")}')
        return False

    checkin_data = result.get('data', {})
    success = checkin_data.get('success', False)
    desc = checkin_data.get('desc', '')

    if success:
        rewards = checkin_data.get('list', [])
        reward_str = ', '.join([
            f'{r.get("infos", {}).get("title", "未知奖励")}'
            for r in rewards
        ])
        log.info(f'{prefix}签到成功! {desc} - 获得: {reward_str}')
        return True
    else:
        log.warning(f'{prefix}签到未成功: {desc}')
        return False


def run_one_account(access_token, remark='', openid='', session_id=''):
    """单账号签到流程"""
    client = YouzanClient(access_token, openid, session_id)

    success = run_checkin(client, remark)

    return success


# ====== 主函数 ======
def main():
    manual_accounts = parse_manual_accounts()

    if manual_accounts:
        # 方式1: 手动 token 模式
        log.info(f'手动 token 模式: {len(manual_accounts)} 个账号')
        success_count = 0
        for i, acc in enumerate(manual_accounts):
            remark = acc.get('remark', f'账号{i+1}')
            token = acc.get('access_token', '')
            if not token:
                log.warning(f'[{remark}] token 为空，跳过')
                continue

            if run_one_account(token, remark):
                success_count += 1

            # 账号间延迟
            if i < len(manual_accounts) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s...')
                time.sleep(delay)

        log.info(f'签到完成: {success_count}/{len(manual_accounts)} 成功')

    elif WCS_AUTH:
        # 方式2: WCS 自动登录模式
        log.info('WCS 自动登录模式')
        wcs = WCSClient()
        accounts = wcs.get_accounts()
        if not accounts:
            log.error('未找到 WCS 账号')
            sys.exit(1)

        active = [a for a in accounts if not a.get('disabled', False)]
        
        # wx_opinion 过滤：只处理指定的 openid
        wx_opinion = os.environ.get('wx_opinion', '').strip()
        if wx_opinion:
            filter_openids = set(wx_opinion.split('&'))
            active = [a for a in active if a.get('openid', '') in filter_openids]
            log.info(f'wx_opinion 过滤后: {len(active)} 个账号')
        log.info(f'找到 {len(active)} 个活跃账号')

        success_count = 0
        for i, acc in enumerate(active):
            openid = acc.get('openid', '')
            user_key = acc.get('userKey', openid)
            display_name = acc.get('displayName', openid[:8])

            # 通过 WCS 登录获取 token + session_id
            login_info = login_via_wcs(openid, user_key)
            if not login_info:
                log.error(f'[{display_name}] 登录失败，跳过')
                continue

            access_token = login_info['access_token']
            session_id = login_info.get('session_id', '')

            if run_one_account(access_token, display_name, openid, session_id):
                success_count += 1

            # 账号间延迟
            if i < len(active) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s...')
                time.sleep(delay)

        log.info(f'签到完成: {success_count}/{len(active)} 成功')

    else:
        # 方式3: 无配置
        print('''
袋鼠妈妈签到脚本 - 配置帮助
============================

方式1: 手动 token 模式
  设置环境变量 ds:
    set ds=备注#access_token
  示例:
    set ds=我的账号#d413bd3fd179a158d19fa2f7603d73
  多账号用 @ 分隔:
    set ds=账号1#token1@账号2#token2

方式2: WCS 自动登录模式
  设置环境变量:
    set wx_server_url=http://127.0.0.1:8787
    set wx_auth=你的AUTH_KEY

access_token 从抓包数据中获取:
  URL 参数中包含 access_token=xxx 即可提取
        ''')
        sys.exit(1)


if __name__ == '__main__':
    import io
    _log_capture = io.StringIO()
    _old_stdout = sys.stdout
    _old_stderr = sys.stderr
    sys.stdout = _log_capture
    sys.stderr = _log_capture
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        print(f'脚本异常: {e}')
    finally:
        sys.stdout = _old_stdout
        sys.stderr = _old_stderr
    _logs = _log_capture.getvalue()
    if _logs.strip():
        print(_logs)
        try:
            push_notify('袋鼠mama_sign 签到结果', _logs[-2000:])
        except:
            pass



