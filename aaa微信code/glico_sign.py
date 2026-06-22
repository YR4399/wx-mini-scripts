import os,ssl,urllib3
urllib3.disable_warnings()
ssl._create_default_https_context=ssl._create_unverified_context
for k in ("HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy"):os.environ.pop(k,None)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
格力高club 微信小程序 - 签到 + 抽奖 + 520约会灵感签 自动化脚本

功能:
  1. 每日签到 (PUT /checkin)
  2. 签到抽奖 (POST /lotteries/submit/{lottery_id})
  3. 520约会灵感签抽签 3次 (POST /lottery-sticks/{stick_id}/lottery)

登录模式: A (简单模式)
  - POST /auth/signin_oauth_weixin_mp 传 wx.login code
  - 从响应头 X-Auth-Token 获取 token
  - 再 POST /auth/signin_oauth_weixin_mp_phone 传加密手机号信息完成登录

配置:
  - 环境变量 wx_server_url / wx_auth 用于 WCS 连接
  - 环境变量 glico 用于手动 token 降级: "备注#openid#token"
"""

import json
import os
import random
import sys
import time
import hashlib
import logging
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
log = logging.getLogger('glico')

# ====== 常量 ======
API_BASE = 'https://crm.glico.cn/miniapp/member'
WX_APPID = 'wx0245348276df851b'
LOTTERY_ID = 98038385          # 签到抽奖ID
STICK_ID = '2052269816767766530'  # 520约会灵感签活动ID

WCS_BASE = os.environ.get('wx_server_url', 'http://127.0.0.1:8787')
WCS_AUTH = os.environ.get('wx_auth', '')

# ====== 配置缓存 ======
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '.glico_config.json')

_DEFAULT_CONFIG = {
    'wx_server_url': 'http://127.0.0.1:8787',
    'wx_auth': '',
    'glico': '',
}


def _load_config():
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
        'glico': 'glico',
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
_TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 '.glico_token_cache.json')
_TOKEN_TTL = 8 * 3600  # 8小时


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
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def _token_cache_key(openid):
    return hashlib.sha256(openid.encode()).hexdigest()[:16]


def get_cached_token(openid):
    cache = _load_token_cache()
    ck = _token_cache_key(openid)
    entry = cache.get(ck)
    if not entry:
        return None, 'no_cache'
    if time.time() - entry.get('ts', 0) > _TOKEN_TTL:
        del cache[ck]
        _save_token_cache(cache)
        return None, 'expired'
    return entry.get('data'), None


def set_cached_token(openid, token_data):
    cache = _load_token_cache()
    ck = _token_cache_key(openid)
    cache[ck] = {'data': token_data, 'ts': time.time()}
    _save_token_cache(cache)


def invalidate_token(openid):
    cache = _load_token_cache()
    ck = _token_cache_key(openid)
    if ck in cache:
        del cache[ck]
        _save_token_cache(cache)


# ====== 工具函数 ======
def random_ua():
    """生成随机微信 User-Agent"""
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
        f'Chrome/{random.randint(140,146)}.0.{random.randint(6000,7680)} Mobile Safari/537.36 '
        f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
        f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
    )


def make_headers(token=None):
    """构建请求头"""
    headers = {
        'User-Agent':      random_ua(),
        'Content-Type':    'application/json',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection':      'keep-alive',
        'X-App-Source':    'weixin_mp',
        'xweb_xhr':        '1',
        'Sec-Fetch-Site':  'cross-site',
        'Sec-Fetch-Mode':  'cors',
        'Sec-Fetch-Dest':  'empty',
        'Referer':         f'https://servicewechat.com/{WX_APPID}/208/page-frame.html',
        'Origin':          'https://servicewechat.com',
    }
    if token:
        headers['X-Auth-Token'] = token
    return headers


# ====== WCS 客户端 ======
class WCSClient:
    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _get(self, path, timeout=30):
        r = requests.get(f'{self.base}{path}',
                         headers={'AUTH': self.auth}, timeout=timeout, verify=False)
        return r.json()

    def _post(self, path, data, timeout=60):
        r = requests.post(f'{self.base}{path}', json=data,
                          headers={'AUTH': self.auth,
                                   'Content-Type': 'application/json'},
                          timeout=timeout, verify=False)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """获取 wx.login code"""
        body = {
            'appid':   WX_APPID,
            'userKey': user_key or openid,
            'openid':  openid,
        }
        data = self._post('/wx/code', body)
        if data and data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
        log.warning(f'[WCS] /wx/code 返回: {data}')
        return None


# ====== 格力高业务客户端 ======
class GlicoClient:
    def __init__(self, token, openid=''):
        self.token = token
        self.openid = openid

    def _get(self, path, params=None):
        url = f'{API_BASE}{path}'
        resp = requests.get(url, params=params, verify=False,
                            headers=make_headers(self.token), timeout=15)
        return self._handle_resp(resp)

    def _post(self, path, data=None, params=None):
        url = f'{API_BASE}{path}'
        resp = requests.post(url, json=(data or {}), params=params, verify=False,
                             headers=make_headers(self.token), timeout=15)
        return self._handle_resp(resp)

    def _put(self, path, data=None):
        url = f'{API_BASE}{path}'
        resp = requests.put(url, json=(data or {}), verify=False,
                            headers=make_headers(self.token), timeout=15)
        return self._handle_resp(resp)

    def _handle_resp(self, resp):
        """处理响应，检测token失效"""
        if resp.status_code in (401, 403):
            log.warning('响应 401/403，token 可能失效')
            return {'_token_invalid': True}
        try:
            return resp.json()
        except Exception:
            return {'_parse_error': True, 'text': resp.text[:200]}

    # ---- 签到 ----
    def get_checkin_status(self):
        """获取签到状态"""
        return self._get('/checkin')

    def do_checkin(self):
        """执行签到"""
        return self._put('/checkin', {})

    # ---- 签到抽奖 ----
    def get_lottery_info(self, lottery_id):
        """获取抽奖信息"""
        return self._get(f'/lottery/{lottery_id}')

    def do_lottery(self, lottery_id, address_id=''):
        """执行签到抽奖"""
        params = {'addressId': address_id} if address_id else None
        return self._post(f'/lotteries/submit/{lottery_id}', {}, params=params)

    # ---- 520约会灵感签 ----
    def get_stick_info(self, stick_id):
        """获取抽签活动信息"""
        return self._get(f'/lottery-sticks/{stick_id}')

    def do_stick_lottery(self, stick_id):
        """执行抽签"""
        return self._post(f'/lottery-sticks/{stick_id}/lottery', {})

    def share_stick(self, stick_id):
        """分享抽签活动"""
        return self._post(f'/action/shared_lottery_stick?detailId={stick_id}', {})


# ====== 登录流程 ======
def login_with_code(code):
    """
    格力高登录流程：
      1. POST /auth/signin_oauth_weixin_mp 传 code
         -> 从响应头获取 X-Auth-Token
      2. 用 token 拉取会员信息验证登录态
    """
    # Step 1: code 换 token
    log.info('[登录] Step 1: code 换 token...')
    resp = requests.post(
        f'{API_BASE}/auth/signin_oauth_weixin_mp',
        json={'code': code},
        headers=make_headers(),
        timeout=15,
    )
    data = resp.json()
    if data.get('code') != 0:
        log.error(f'[登录] Step 1 失败: {data}')
        return None

    token = resp.headers.get('X-Auth-Token', '')
    if not token:
        log.error('[登录] 响应头缺少 X-Auth-Token')
        return None
    log.info('[登录] token 获取成功')

    # Step 2: 验证 token 有效性（拉取会员信息）
    time.sleep(random.uniform(0.3, 0.8))
    profile_resp = requests.get(
        f'{API_BASE}/profile',
        headers=make_headers(token),
        timeout=15,
    )
    profile = profile_resp.json()
    if profile.get('code') != 0:
        log.error(f'[登录] token 验证失败: {profile}')
        return None

    member_data = profile.get('data', {})
    member_id = member_data.get('id', '')
    openid = member_data.get('openId', '')
    name = member_data.get('name', '')
    log.info(f'[登录] 成功! memberId={member_id}, name={name}')

    return {
        'token': token,
        'openid': openid,
        'member_id': member_id,
        'member_data': member_data,
    }


def login_via_wcs(openid, user_key=None):
    """通过 WCS 自动登录"""
    wcs = WCSClient()

    # 获取 code（重试3次）
    log.info('[WCS] 获取 loginCode...')
    login_code = None
    for attempt in range(3):
        try:
            login_code = wcs.get_code(openid, user_key or openid)
        except Exception as e:
            log.warning(f'[WCS] get_code 异常: {e}')
            login_code = None
        if login_code:
            break
        if attempt < 2:
            wait = 3 * (attempt + 1)
            log.warning(f'code 获取失败，{wait}s 后重试 ({attempt+1}/3)...')
            time.sleep(wait)

    if not login_code:
        log.error('loginCode 获取失败，已重试 3 次')
        return None

    # 用 code 登录
    time.sleep(random.uniform(0.5, 1.5))
    return login_with_code(login_code)


def get_or_refresh_token(openid, user_key=None):
    """获取有效 token（优先读缓存）"""
    token_data, reason = get_cached_token(openid)
    if token_data:
        log.info(f'[TokenCache] 命中缓存')
        return token_data

    log.info('[TokenCache] 未命中，走 WCS 登录...')
    token_data = login_via_wcs(openid, user_key)
    if token_data:
        set_cached_token(openid, token_data)
        log.info('[TokenCache] 新 token 已缓存')
    return token_data


# ====== 手动账号解析 ======
def parse_manual_accounts():
    """解析手动 token: 备注#openid#token"""
    raw = os.environ.get('wx_opinion') or os.environ.get('glico', '') or _config.get('glico', '')
    if not raw:
        return []
    accounts = []
    _wxop = os.environ.get("wx_opinion", "")
    if _wxop and "&" in _wxop and "#" not in _wxop:
        return [{"remark": o[:8], "openid": o, "token": "", "user_key": o} for o in _wxop.split("&") if o.strip()]
    for line in raw.split(','):
        line = line.strip()
        if not line:
            continue
        parts = line.split('#')
        if len(parts) >= 3:
            accounts.append({
                'remark': parts[0],
                'openid': parts[1],
                'token': parts[2],
            })
    return accounts


# ====== 业务逻辑 ======
def run_account(token, openid='', user_key=None):
    """执行单个账号的签到抽奖流程"""
    client = GlicoClient(token, openid)

    # 1. 查询签到状态
    log.info('--- 查询签到状态 ---')
    checkin_info = client.get_checkin_status()
    if checkin_info.get('_token_invalid'):
        log.error('Token 失效，跳过')
        return False

    if checkin_info.get('code') != 0:
        log.error(f'查询签到状态失败: {checkin_info}')
        return False

    checkin_data = checkin_info.get('data', {})
    is_signin = checkin_data.get('isSignIn', False)
    continuous_days = checkin_data.get('continuousDays', 0)
    log.info(f'当前签到状态: {"已签到" if is_signin else "未签到"}, 连续签到: {continuous_days}天')

    # 2. 执行签到
    if not is_signin:
        log.info('--- 执行签到 ---')
        time.sleep(random.uniform(0.5, 1.5))
        result = client.do_checkin()
        if result.get('code') == 0:
            reward = result.get('data', {}).get('reward', '')
            log.info(f'签到成功! 奖励: {reward}')
        else:
            log.warning(f'签到结果: {result}')
    else:
        log.info('今日已签到，跳过')

    # 3. 签到抽奖
    log.info('--- 签到抽奖 ---')
    time.sleep(random.uniform(0.5, 1.5))
    lottery_info = client.get_lottery_info(LOTTERY_ID)
    if lottery_info.get('code') == 0:
        lottery_data = lottery_info.get('data', {})
        items = lottery_data.get('items', [])
        if items:
            item = items[0]
            chances = item.get('chances', 0)
            history_today = item.get('historyCountToday', 0)
            log.info(f'抽奖机会: {chances}, 今日已抽: {history_today}')
            if chances > history_today:
                time.sleep(random.uniform(0.5, 1.5))
                result = client.do_lottery(LOTTERY_ID)
                log.info(f'抽奖结果: {result}')
            else:
                log.info('今日抽奖次数已用完')
        else:
            log.info('无抽奖配置')
    else:
        log.warning(f'获取抽奖信息失败: {lottery_info}')

    # 4. 520约会灵感签抽签（3次）
    log.info('--- 520约会灵感签抽签 ---')
    time.sleep(random.uniform(0.5, 1.5))
    stick_info = client.get_stick_info(STICK_ID)
    if stick_info.get('code') == 0:
        stick_data = stick_info.get('data', {})
        tries_limit = stick_data.get('triesLimit', 3)
        remaining = stick_data.get('remainingTimes', 0)
        log.info(f'抽签活动: {stick_data.get("name", "")}, 总次数: {tries_limit}, 剩余: {remaining}')

        for i in range(remaining):
            time.sleep(random.uniform(1.0, 2.5))
            log.info(f'第 {i+1}/{remaining} 次抽签...')
            result = client.do_stick_lottery(STICK_ID)
            if result.get('code') == 0:
                stick_result = result.get('data', {})
                stick_name = stick_result.get('stick', '')
                reward = stick_result.get('rewardReceived', '')
                log.info(f'  抽签结果: {stick_name} | 奖励: {reward or "无"}')
            else:
                log.warning(f'  抽签失败: {result}')
                break
    else:
        log.warning(f'获取抽签信息失败: {stick_info}')

    return True


def run_wcs_mode():
    """WCS 自动登录模式"""
    wcs = WCSClient()
    accounts = wcs.get_accounts()
    if not accounts:
        log.error('WCS 中没有可用账号')
        return

    log.info(f'发现 {len(accounts)} 个账号')
    for acc in accounts:
        if acc.get('disabled'):
            continue
        openid = acc.get('openid', '')
        user_key = acc.get('userKey', openid)
        remark = acc.get('displayName', openid[:16])
        log.info(f'\n========== 账号: {remark} ==========')

        token_data = get_or_refresh_token(openid, user_key)
        if not token_data:
            log.error('登录失败，跳过')
            continue

        run_account(token_data['token'], openid, user_key)
        time.sleep(random.uniform(3, 8))


def run_manual_mode():
    """手动 token 模式"""
    accounts = parse_manual_accounts()
    if not accounts:
        log.error('手动模式: 未配置账号')
        return

    for acc in accounts:
        log.info(f'\n========== 账号: {acc["remark"]} ==========')
        run_account(acc['token'], acc['openid'])
        time.sleep(random.uniform(3, 8))


def main():
    manual_accounts = parse_manual_accounts()

    # 过滤掉没有 token 的账号（纯 openid 由 WCS 处理）
    has_token = [a for a in manual_accounts if a.get('token')]
    no_token = [a for a in manual_accounts if not a.get('token')]

    if has_token:
        log.info('使用手动 token 模式')
        run_manual_mode()
    elif WCS_AUTH:
        log.info('使用 WCS 自动登录模式')
        run_wcs_mode()
    elif no_token:
        log.error('有 openid 但 WCS 未配置，无法自动登录')
    else:
        log.error('未配置登录方式')
        print()
        print('请设置以下环境变量之一:')
        print('  1. WCS 自动模式:')
        print('     set wx_server_url=http://127.0.0.1:8787')
        print('     set wx_auth=你的AUTH_KEY')
        print()
        print('  2. 手动 token 模式:')
        print('     set glico=备注#openid#token')
        print()
        print('脚本首次运行后会自动缓存配置到 .glico_config.json')
        sys.exit(1)


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
            push_notify('glico_sign 签到结果', _logs[-2000:])
        except:
            pass



