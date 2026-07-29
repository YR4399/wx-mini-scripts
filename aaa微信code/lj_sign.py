"""
联家超市 - 每日签到脚本
API 域名: miniapi.retailo2o.com / minih5.retailo2o.com
AppID: wx975d6360e1ad27b6
模式: A (简单 - wx.login code 换 uid/skey)
签到: 7天周期，每天10积分，满7天额外20积分，连续签到有额外奖励
"""

import os
import sys
import time
import json
import random
import logging
import hashlib
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


try:
    import requests
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests

# ===== 日志 =====
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('lj_sign')

# ===== 常量 =====
APPID = 'wx975d6360e1ad27b6'
COMPONENT_APPID = 'wx42c09f03e563c137'
PLATFORM_NUM = '153846'
STORE_ID = '2007'
BSHAREKEY = '17795384229560210689'
API_BASE = 'https://miniapi.retailo2o.com'
H5_BASE = 'https://minih5.retailo2o.com'

# ===== 缓存 =====
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIG_FILE = os.path.join(_SCRIPT_DIR, '.lj_sign_config.json')
_TOKEN_CACHE_FILE = os.path.join(_SCRIPT_DIR, '.lj_sign_token_cache.json')
_CODE_CACHE_FILE = os.path.join(_SCRIPT_DIR, '.wxcode_cache.json')
_TOKEN_TTL = 8 * 3600  # 8小时
_CODE_TTL = 300  # 5分钟


def _load_json(path, default=None):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return default or {}


def _save_json(path, data):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ===== 配置三级加载 =====
_DEFAULT_CONFIG = {
    'wx_server_url': 'http://127.0.0.1:8787',
    'wx_auth': '',
    'lj': '',
}

_env_map = {
    'wx_server_url': 'wx_server_url',
    'wx_auth': 'wx_auth',
    'lj': 'lj',
}

def _load_config():
    config = dict(_DEFAULT_CONFIG)
    if os.path.exists(_CONFIG_FILE):
        try:
            with open(_CONFIG_FILE, 'r', encoding='utf-8') as f:
                config.update(json.load(f))
        except Exception:
            pass
    updated = False
    for cfg_key, env_name in _env_map.items():
        val = os.environ.get(env_name, '')
        if val and val != config.get(cfg_key, ''):
            config[cfg_key] = val
            updated = True
    if updated or not os.path.exists(_CONFIG_FILE):
        _save_json(_CONFIG_FILE, config)
    return config


_config = _load_config()
WCS_BASE = _config['wx_server_url'].rstrip('/')
WCS_AUTH = _config['wx_auth']


# ===== 随机 UA =====
def random_ua():
    """桌面微信小程序 UA"""
    versions = ['7.0.20.1781', '7.0.20.1761', '7.0.20.1741']
    wv = random.choice(versions)
    return (
        f'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        f'(KHTML, like Gecko) Chrome/{random.randint(130, 135)}.0.0.0 Safari/537.36 '
        f'MicroMessenger/{wv}(0x6700143B) NetType/WIFI MiniProgramEnv/Windows '
        f'WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541939) '
        f'XWEB/19841 miniProgram/{APPID}'
    )


# ===== Code 缓存 =====
def _code_cache_key(appid, user_key):
    return hashlib.sha256(f'{appid}:{user_key}'.encode()).hexdigest()[:16]


def get_cached_code(appid, user_key):
    cache = _load_json(_CODE_CACHE_FILE, {})
    ck = _code_cache_key(appid, user_key)
    entry = cache.get(ck)
    if not entry:
        return None
    if time.time() - entry.get('ts', 0) > _CODE_TTL:
        cache.pop(ck, None)
        _save_json(_CODE_CACHE_FILE, cache)
        return None
    return entry.get('code')


def set_code_cache(appid, user_key, code):
    cache = _load_json(_CODE_CACHE_FILE, {})
    cache[_code_cache_key(appid, user_key)] = {'code': code, 'ts': time.time()}
    _save_json(_CODE_CACHE_FILE, cache)


def invalidate_code(appid, user_key):
    cache = _load_json(_CODE_CACHE_FILE, {})
    ck = _code_cache_key(appid, user_key)
    if ck in cache:
        del cache[ck]
        _save_json(_CODE_CACHE_FILE, cache)


# ===== Token 缓存 =====
def _token_cache_key(user_key):
    return hashlib.sha256(f'lj:{user_key}'.encode()).hexdigest()[:16]


def get_cached_token(user_key):
    cache = _load_json(_TOKEN_CACHE_FILE, {})
    ck = _token_cache_key(user_key)
    entry = cache.get(ck)
    if not entry:
        return None
    if time.time() - entry.get('ts', 0) > _TOKEN_TTL:
        cache.pop(ck, None)
        _save_json(_TOKEN_CACHE_FILE, cache)
        return None
    return entry.get('data')


def set_cached_token(user_key, token_data):
    cache = _load_json(_TOKEN_CACHE_FILE, {})
    cache[_token_cache_key(user_key)] = {'data': token_data, 'ts': time.time()}
    _save_json(_TOKEN_CACHE_FILE, cache)


def invalidate_token(user_key):
    cache = _load_json(_TOKEN_CACHE_FILE, {})
    ck = _token_cache_key(user_key)
    if ck in cache:
        del cache[ck]
        _save_json(_TOKEN_CACHE_FILE, cache)


# ===== WCS 客户端 =====
class WCSClient:
    def __init__(self):
        self.base = WCS_BASE
        self.auth = WCS_AUTH

    def get_accounts(self):
        try:
            resp = requests.get(
                f'{self.base}/api/accounts',
                headers={'AUTH': self.auth},
                timeout=30,
                verify=False
            )
            data = resp.json()
            if data and data.get('status'):
                return data.get('data', {}).get('items', [])
        except Exception as e:
            log.error(f'获取账号列表失败: {e}')
        return None

    def get_code(self, openid, user_key=None):
        body = {
            'appid': APPID,
            'userKey': user_key or openid,
            'openid': openid,
        }
        # 先查缓存
        cached = get_cached_code(APPID, user_key or openid)
        if cached:
            log.info('  [cache] 命中 code 缓存')
            return cached
        try:
            resp = requests.post(
                f'{self.base}/wx/code',
                json=body,
                headers={'AUTH': self.auth, 'Content-Type': 'application/json'},
                timeout=60,
                verify=False
            )
            data = resp.json()
            if data and data.get('status') and data.get('data', {}).get('code'):
                code = data['data']['code']
                set_code_cache(APPID, user_key or openid, code)
                return code
            log.warning(f'  /wx/code 返回: {data}')
        except requests.exceptions.Timeout:
            log.warning('  /wx/code 超时')
        except requests.exceptions.RequestException as e:
            log.warning(f'  /wx/code 失败: {e}')
        return None


# ===== 登录 =====
def login_via_wcs(openid, user_key=None):
    """
    通过 WCS 获取 wx.login code → 登录/注册 → 获取 uid/skey
    返回: {'uid': ..., 'skey': ...} 或 None
    """
    wcs = WCSClient()
    uk = user_key or openid

    # Step 1: 获取 code（3次重试）
    login_code = None
    for attempt in range(3):
        login_code = wcs.get_code(openid, uk)
        if login_code:
            break
        wait = 3 * (attempt + 1)
        log.warning(f'  code 获取失败，{wait}s 后重试 ({attempt+1}/3)...')
        time.sleep(wait)

    if not login_code:
        log.error('  loginCode 获取失败，已重试 3 次')
        return None

    time.sleep(random.uniform(0.5, 1.5))

    # Step 2: 尝试登录
    login_url = (
        f'{API_BASE}/common/user4wechat/user4wechat/LoginbyWechatAppletFromPlatform'
        f'?_platform_num={PLATFORM_NUM}&bsharekey={BSHAREKEY}&shareCode={BSHAREKEY}'
        f'&code={login_code}&appid={APPID}&component_appid={COMPONENT_APPID}'
        f'&cmd=community&entityid={STORE_ID}&storeid={STORE_ID}'
    )
    headers = {
        'User-Agent': random_ua(),
        'Accept': '*/*',
        'X-Request-With': 'XMLHttpRequest',
        'xweb_xhr': '1',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': f'https://servicewechat.com/{APPID}/35/page-frame.html',
        'Cookie': f'_platform_num={PLATFORM_NUM};s_source=3;version=4.0.3;appcode={APPID};mp_scene=1007;bsharekey={BSHAREKEY};',
    }
    resp = requests.get(login_url, headers=headers, timeout=15, verify=False)
    data = resp.json()

    errno = data.get('errno', -1)

    # 已有账号 - 尝试从响应 cookies 或 data 中提取 uid/skey
    if errno == 0:
        d = data.get('data', {})
        uid = d.get('uid')
        skey = d.get('skey')
        if uid and skey:
            return {'uid': uid, 'skey': skey, 'openid': d.get('openid', openid)}
        # uid/skey 可能在 cookies 中
        cookies = resp.cookies
        uid = cookies.get('uid')
        skey = cookies.get('skey')
        if uid and skey:
            return {'uid': uid, 'skey': skey, 'openid': openid}
        log.warning(f'  登录成功但未获取到 uid/skey: {data}')
        return None

    # 用户不存在 - 需要注册
    if errno == 3520:
        log.info('  用户不存在，尝试注册...')
        time.sleep(random.uniform(0.3, 0.8))

        reg_url = (
            f'{API_BASE}/common/user/user/RegisterByWechatApplet'
            f'?_platform_num={PLATFORM_NUM}&bsharekey={BSHAREKEY}&shareCode={BSHAREKEY}'
            f'&code={login_code}&encryptedMobile=&iv4Mobile='
            f'&membersource=&ExtendInfo=%7B%7D&cmd=community'
            f'&entityid={STORE_ID}&storeid={STORE_ID}'
            f'&appid={APPID}&component_appid={COMPONENT_APPID}&Version=1'
        )
        reg_resp = requests.get(reg_url, headers=headers, timeout=15, verify=False)
        reg_data = reg_resp.json()

        if reg_data.get('errno') == 0:
            d = reg_data.get('data', {})
            uid = d.get('uid')
            skey = d.get('skey')
            if uid and skey:
                return {'uid': uid, 'skey': skey, 'openid': openid, 'isnew': d.get('isnew')}
        log.error(f'  注册失败: {reg_data}')
        return None

    log.error(f'  登录异常: {data}')
    return None


# ===== 签到业务 =====
class LianjiaClient:
    def __init__(self, uid, skey, openid=''):
        self.uid = uid
        self.skey = skey
        self.openid = openid
        self.session = requests.Session()
        self.session.verify = False
        self._init_session()

    def _init_session(self):
        """初始化会话 cookies"""
        self.session.cookies.set('_platform_num', PLATFORM_NUM)
        self.session.cookies.set('entityid', STORE_ID)
        self.session.cookies.set('uid', str(self.uid))
        self.session.cookies.set('skey', self.skey)
        self.session.headers.update({
            'User-Agent': random_ua(),
            'Accept': 'application/json, text/plain, */*',
            'xweb_xhr': '1',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Cache-Control': 'no-cache',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
        })

    def _h5_get(self, path, params=None):
        """H5 域名 GET 请求"""
        if params is None:
            params = {}
        params.setdefault('_platform_num', PLATFORM_NUM)
        params.setdefault('uid', self.uid)
        params.setdefault('skey', self.skey)
        url = f'{H5_BASE}{path}'
        try:
            resp = self.session.get(url, params=params, timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f'请求失败 {url}: {e}')
            return None

    def _api_get(self, path, params=None):
        """API 域名 GET 请求"""
        if params is None:
            params = {}
        params.setdefault('_platform_num', PLATFORM_NUM)
        params.setdefault('bsharekey', BSHAREKEY)
        params.setdefault('shareCode', BSHAREKEY)
        params.setdefault('uid', self.uid)
        params.setdefault('skey', self.skey)
        url = f'{API_BASE}{path}'
        try:
            resp = self.session.get(url, params=params, timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f'请求失败 {url}: {e}')
            return None

    def get_sign_info(self):
        """查询签到状态"""
        return self._h5_get('/common/signin/api/v1/cloud/sign_in/getSignInfo')

    def do_sign(self, sign_in_type=1):
        """执行签到"""
        return self._h5_get('/common/signin/api/v1/cloud/sign_in/do',
                            {'sign_in_type': sign_in_type})

    def get_user_info(self):
        """查询用户信息"""
        return self._api_get(
            '/common/userinfo/userinfo/GetUserInfo',
            {'version': '1'}
        )

    def get_account_info(self):
        """查询账户信息（积分、余额等）"""
        return self._api_get('/bstorecrmapi/bstore-crm-api/mem/userInfo/queryAccountInfo.do')


# ===== 签到主流程 =====
def run_one_account(client, remark=''):
    """单账号签到"""
    prefix = f'[{remark}]' if remark else ''
    log.info(f'{prefix} 开始签到 (uid={client.uid})')

    # 1. 查询签到状态
    info = client.get_sign_info()
    if not info or info.get('code') != 0:
        log.error(f'{prefix} 查询签到状态失败: {info}')
        return False

    sign_data = info.get('data', {})
    today_signed = sign_data.get('today_has_sign_in', False)
    daily_info = sign_data.get('daily_sign_in_info', {})

    # 签到周期信息
    re_sign_flag = sign_data.get('re_sign_in_flag', 0)  # 补签类型: 0无补签 2可补签
    resignin_cards = sign_data.get('resignin_card_nums', 0)  # 补签卡数量

    # 统计本周签到
    signed_days = sum(1 for v in daily_info.values() if v.get('sign_in_state') in (1, 2))
    total_days = len(daily_info)

    log.info(f'{prefix} 本周已签 {signed_days}/{total_days} 天, 今日已签: {today_signed}')
    log.info(f'{prefix} 补签卡: {resignin_cards} 张, 补签模式: {re_sign_flag}')

    # 2. 今日未签到则签到
    if not today_signed:
        time.sleep(random.uniform(0.5, 1.5))
        result = client.do_sign(sign_in_type=1)
        if not result or result.get('code') != 0:
            log.error(f'{prefix} 签到失败: {result}')
            return False

        do_data = result.get('data', {})
        consecutive = do_data.get('consecutive_days', 0)
        reward = do_data.get('reward_config', [])
        reward_val = reward[0].get('reward_value', '?') if reward else '?'
        is_full = do_data.get('is_full_signin', False)

        log.info(f'{prefix} 签到成功! 连续{consecutive}天, 获得积分: {reward_val}')
        if is_full:
            log.info(f'{prefix} 满7天额外奖励20积分!')
    else:
        log.info(f'{prefix} 今日已签到，跳过')

    # 3. 补签（如果有补签卡且本周有漏签）
    if resignin_cards > 0 and re_sign_flag == 2:
        missed = [k for k, v in daily_info.items() if v.get('sign_in_state') == 0]
        # 排除未来天数
        missed = [k for k in missed if int(k) <= 7]
        if missed and resignin_cards >= len(missed):
            log.info(f'{prefix} 发现 {len(missed)} 天漏签，使用补签卡补签')
            for day in missed:
                time.sleep(random.uniform(0.5, 1.0))
                result = client.do_sign(sign_in_type=2)
                if result and result.get('code') == 0:
                    log.info(f'{prefix} 第{day}天补签成功')
                else:
                    log.warning(f'{prefix} 第{day}天补签失败: {result}')

    # 4. 查询用户信息
    time.sleep(random.uniform(0.3, 0.8))
    user = client.get_user_info()
    if user and user.get('errno') == 0:
        u = user.get('data', {})
        nickname = u.get('nickname', '')
        level = u.get('userlevelname', '')
        score = u.get('score', '0')
        growth = u.get('growthvalue', 0)
        log.info(f'{prefix} 用户: {nickname} | 等级: {level} | 积分: {score} | 成长值: {growth}')

    # 5. 查询账户信息
    time.sleep(random.uniform(0.3, 0.8))
    acct = client.get_account_info()
    if acct and acct.get('code') == 0:
        a = acct.get('data', {})
        log.info(f'{prefix} 优惠券: {a.get("couponNum", 0)} 张 | 余额: {a.get("balance", 0)}')

    return True


# ===== 手动 token 降级 =====
def load_manual_accounts():
    raw = os.environ.get('wx_opinion') or os.environ.get('lj', '') or _config.get('lj', '')
    if not raw:
        return []
    accounts = []
    for item in raw.split('&'):
        parts = item.strip().split('#')
        if len(parts) >= 3:
            accounts.append({
                'remark': parts[0],
                'uid': parts[1],
                'skey': parts[2],
                'openid': parts[3] if len(parts) > 3 else '',
            })
    return accounts


# ===== 主函数 =====
def main():
    manual_accounts = load_manual_accounts()

    if manual_accounts:
        # 手动 token 模式
        log.info(f'手动 token 模式，共 {len(manual_accounts)} 个账号')
        for i, a in enumerate(manual_accounts):
            if i > 0:
                time.sleep(random.uniform(3, 8))
            client = LianjiaClient(a['uid'], a['skey'], a.get('openid', ''))
            run_one_account(client, a.get('remark', ''))

    elif WCS_AUTH:
        # WCS 自动登录模式
        wcs = WCSClient()
        accounts = wcs.get_accounts()
        if not accounts:
            log.error('未找到 WCS 账号，请先扫码添加')
            sys.exit(1)

        log.info(f'WCS 自动模式，共 {len(accounts)} 个账号')
        for i, acc in enumerate(accounts):
            if acc.get('disabled', False):
                continue
            if i > 0:
                time.sleep(random.uniform(3, 8))
            openid = acc.get('openid', '')
            user_key = acc.get('userKey', openid)
            remark = acc.get('displayName', openid[:8] if openid else f'acct_{i}')

            # 尝试读 token 缓存
            cached = get_cached_token(user_key)
            if cached:
                log.info(f'[{remark}] 命中 token 缓存，跳过登录')
                client = LianjiaClient(cached['uid'], cached['skey'], cached.get('openid', openid))
                run_one_account(client, remark)
                continue

            # WCS 登录
            login_info = login_via_wcs(openid, user_key)
            if login_info:
                set_cached_token(user_key, login_info)
                client = LianjiaClient(login_info['uid'], login_info['skey'],
                                       login_info.get('openid', openid))
                if login_info.get('isnew'):
                    log.info(f'[{remark}] 新用户注册成功!')
                run_one_account(client, remark)
            else:
                log.error(f'[{remark}] 登录失败')

    else:
        print('=' * 50)
        print('联家超市签到脚本')
        print('=' * 50)
        print()
        print('使用方式:')
        print()
        print('  方式一: WCS 自动登录（推荐）')
        print('    set wx_server_url=http://127.0.0.1:8787')
        print('    set wx_auth=你的AUTH_KEY')
        print('    python lj_sign.py')
        print()
        print('  方式二: 手动 token 降级')
        print('    set lj=备注1#uid1#skey1&备注2#uid2#skey2')
        print('    python lj_sign.py')
        print()
        print('签到规则:')
        print('  - 7天一个周期，每天签到得10积分')
        print('  - 满7天额外奖励20积分')
        print('  - 有补签卡可补签漏签天数')
        print()


if __name__ == '__main__':
    import io
    _tee_out, _tee_err = _enable_tee()
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        print(f'脚本异常: {e}')
    finally:
        sys.stdout = _tee_out.original

        sys.stderr = _tee_err.original

        _logs = _tee_out.getvalue()
    if _logs.strip():
        print(_logs)
        try:
            push_notify('lj_sign 签到结果', _logs[-2000:])
        except:
            pass



