# -*- coding: utf-8 -*-
"""
乐购 (ljgglp.com) 激励广告自动观看脚本
基于 HAR 抓包数据分析，自动完成 10 次/天 广告观看任务

API 流程:
  0. loginWxXcx   -> 用 wx.login code 换取 userToken (WCS 自动登录模式)
  1. adWatchInfo   -> 查询今日已看次数 / 剩余次数
  2. adWatchStart  -> 获取 playToken（模拟开始播放）
  3. adWatchCallback -> 提交观看完成（获得 +0.25 乐豆/次）

环境变量：
    LJ_AD_TOKEN    - userToken (JWT)，从抓包或登录获取
    LJ_AD_UID      - 用户 ID (数字)
    LJ_AD_DEVICE   - deviceId (数字字符串)
    LJ_AD_COUNT    - 观看次数，默认 10

依赖：pip install requests
"""
import os
import sys
import time
import random
import json
import logging
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('lj_ad')

# ============ 常量 ============

BASE_URL = 'https://www.ljgglp.com'
WX_APPID = 'wxd53de10d996cabff'   # 乐购小程序 AppID (从 HAR referer 提取)

# WCS 控制台配置
WCS_BASE = os.environ.get('wx_server_url', 'http://127.0.0.1:8787')
WCS_AUTH = os.environ.get('wx_auth', '')


def random_ua():
    """生成随机微信 UA"""
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


def make_headers():
    """构建请求头（模拟微信小程序环境）"""
    return {
        'User-Agent': random_ua(),
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Accept': 'application/json, text/plain, */*',
        'Origin': BASE_URL,
        'Referer': f'https://servicewechat.com/{WX_APPID}/2/page-frame.html',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }


# ============ WCS 控制台：获取 userToken ============

class WCSClient:
    """轻量级 WCS 控制台客户端"""

    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _get(self, path, timeout=30):
        r = requests.get(f'{self.base}{path}',
                         headers={'AUTH': self.auth}, timeout=timeout)
        return r.json()

    def _post(self, path, data, timeout=60):
        r = requests.post(f'{self.base}{path}', json=data,
                          headers={'AUTH': self.auth, 'Content-Type': 'application/json'},
                          timeout=timeout)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """通过 WCS 对乐购小程序执行 wx.login() 获取 code"""
        body = {'appid': WX_APPID, 'userKey': user_key or openid,
                'openid': openid}
        data = self._post('/wx/code', body)
        if data and data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
        log.warning(f'[WCS] /wx/code 返回: {data}')
        return None


def login_wcs_get_token(openid, user_key=None):
    """
    通过 WCS 控制台自动登录，返回乐购 userToken + uid
    流程: /wx/code -> 乐购 loginWxXcx 接口换取 Token
    """
    wcs = WCSClient()

    # Step 1: 通过 WCS 对乐购小程序获取 wx.login code
    log.info('[WCS] 获取乐购 loginCode...')
    for attempt in range(3):
        login_code = wcs.get_code(openid, user_key or openid)
        if login_code:
            break
        log.warning(f'[WCS] code 获取失败，重试 ({attempt+1}/3)...')
        time.sleep(3)

    if not login_code:
        log.error('[WCS] loginCode 获取失败，已重试3次')
        log.error('[WCS] 请确保 WCS 控制台中乐购小程序正在运行!')
        return None

    log.info(f'[WCS] loginCode 长度: {len(login_code)}')

    # Step 2: 用 code 调用乐购自己的登录接口换取 Token
    device_id = _gen_device_id()
    time.sleep(random.uniform(0.5, 1.5))

    resp = requests.get(
        f'{BASE_URL}/api.php/Login/loginWxXcx',
        params={'code': login_code, 'deviceId': device_id},
        headers={
            'User-Agent': random_ua(),
            'Referer': f'https://servicewechat.com/{WX_APPID}/2/page-frame.html',
        },
        timeout=15
    )
    data = resp.json()

    status = data.get('status')
    info = data.get('info', '')

    if status == 1 and data.get('data'):
        token_data = data['data']
        token = token_data.get('token') or token_data.get('userToken', '')
        uid = str(token_data.get('uid', '') or '')
        name = token_data.get('user_name', '') or ''
        # 有些接口可能把 token 放在顶层
        if not token and isinstance(token_data, dict):
            for key in ['token', 'userToken', 'access_token']:
                if key in token_data and token_data[key]:
                    token = token_data[key]
                    break
        log.info(f'[Login] 成功! uid={uid} name={name}')
        return token, uid, device_id

    log.error(f'[Login] 失败: status={status} info={info}')
    log.error(f'[Login] 完整响应: {json.dumps(data, ensure_ascii=False)[:300]}')
    return None


def _gen_device_id():
    """生成类似抓包中的 deviceId (时间戳+随机)"""
    ts = int(time.time() * 1000)
    rand = random.randint(100000, 999999)
    return f'{ts}{rand}'


# ============ 乐购广告核心逻辑 ============

class AdWatcher:
    """乐购激励广告自动观看器"""

    def __init__(self, user_token, uid, device_id=None):
        self.user_token = user_token
        self.uid = uid
        self.device_id = device_id or _gen_device_id()
        self.rs = requests.Session()
        self.total_reward = 0.0
        self.success_count = 0

    def _base_params(self):
        return {
            'deviceId': self.device_id,
            'userToken': self.user_token,
            'uid': self.uid,
        }

    def _request(self, endpoint, extra=None):
        """发送 POST 请求到乐购 API"""
        params = self._base_params()
        if extra:
            params.update(extra)

        for attempt in range(3):
            try:
                resp = self.rs.post(
                    f'{BASE_URL}/{endpoint}',
                    data=urlencode(params),
                    headers=make_headers(),
                    timeout=20
                )
                resp.raise_for_status()
                data = resp.json()
                if data.get('status') == 1:
                    return data
                else:
                    log.warning(f'  API 返回异常: {data.get("info", data)}')
                    return data
            except requests.exceptions.RequestException as e:
                log.error(f'  网络错误 (attempt {attempt+1}/3): {e}')
                if attempt < 2:
                    time.sleep(2)
        return None

    def query_info(self):
        """查询广告观看状态"""
        data = self._request('api.php/Lg/adWatchInfo')
        if data and data.get('status') == 1:
            info = data['data']
            return {
                'today_count': int(info.get('todayCount', 0)),
                'max_count': int(info.get('maxCount', 10)),
                'can_watch': int(info.get('canWatch', 0)),
                'ld_number': float(info.get('ld_number', 0)),
                'user_name': info.get('user_name', ''),
            }
        return None

    def start_watch(self):
        """开始观看广告，返回 playToken"""
        data = self._request('api.php/Lg/adWatchStart')
        if data and data.get('status') == 1:
            play_token = data['data'].get('playToken', '')
            return play_token
        log.error(f'  start_watch 失败: {data}')
        return None

    def finish_watch(self, play_token):
        """提交观看完成回调"""
        # HAR 中 callback 请求传的是完整 32 位 playToken
        data = self._request('api.php/Lg/adWatchCallback', {
            'playToken': play_token
        })
        if data and data.get('status') == 1:
            reward = float(data['data'].get('reward', 0))
            new_ld = float(data['data'].get('ld_number', 0))
            today = int(data['data'].get('todayCount', 0))
            can = int(data['data'].get('canWatch', 0))
            info = data.get('info', '')
            return {
                'reward': reward,
                'ld_number': new_ld,
                'today_count': today,
                'can_watch': can,
                'info': info,
            }
        log.error(f'  finish_watch 失败: {data}')
        return None

    def watch_one(self, index, total):
        """执行一次完整的广告观看流程"""
        log.info(f'--- [{index}/{total}] 开始第 {index} 次广告 ---')

        # Step 1: Start
        log.info(f'  [1/2] 请求开始播放...')
        play_token = self.start_watch()
        if not play_token:
            log.error(f'  [{index}] 获取 playToken 失败，跳过')
            return False
        log.info(f'  [1/2] playToken: {play_token[:8]}...')

        # 模拟观看时长 (广告通常 30s 左右，这里模拟 10-18s)
        watch_time = random.uniform(10, 18)
        log.info(f'  [*] 模拟观看 {watch_time:.1f}s...')
        time.sleep(watch_time)

        # Step 2: Callback
        log.info(f'  [2/2] 提交观看完成...')
        result = self.finish_watch(play_token)
        if not result:
            log.error(f'  [{index}] 回调提交失败')
            return False

        reward = result['reward']
        ld = result['ld_number']
        today = result['today_count']
        info = result['info']
        self.total_reward += reward
        self.success_count += 1

        log.info(f'  [{index}] {info} | 今日{today}次 | 乐豆:{ld} | 本轮+{reward}')
        return True

    def run(self, target_count=10):
        """执行目标次数的广告观看"""
        log.info('='*50)
        log.info('  乐购 激励广告自动观看')
        log.info('='*50)

        # 先查询当前状态
        info = self.query_info()
        if not info:
            log.error('查询广告状态失败!')
            return False

        name = info.get('user_name', '未知')
        done = info['today_count']
        limit = info['max_count']
        can = info['can_watch']
        current_ld = info['ld_number']

        log.info(f'用户: {name}')
        log.info(f'今日已看: {done}/{limit} 次')
        log.info(f'当前乐豆: {current_ld}')
        log.info(f'目标次数: {target_count}')

        if done >= target_count:
            log.info(f'今日已完成 {done} 次，达到目标！')
            return True

        if can != 1:
            log.warning(f'canWatch={can}，今日可能已达上限')
            return False

        remaining = min(target_count - done, limit - done)
        log.info(f'还需观看: {remaining} 次')
        log.info('-'*50)

        fail_streak = 0
        for i in range(1, remaining + 1):
            actual_idx = done + i
            ok = self.watch_one(actual_idx, target_count)

            if ok:
                fail_streak = 0
                # 每次间隔 3-8 秒
                wait = random.uniform(3, 8)
                log.info(f'  等待 {wait:.1f}s...')
                time.sleep(wait)
            else:
                fail_streak += 1
                if fail_streak >= 3:
                    log.error(f'连续失败 {fail_streak} 次，终止')
                    break
                time.sleep(random.uniform(5, 10))

        # 最终汇报
        log.info('='*50)
        final = self.query_info()
        if final:
            log.info(f'最终结果:')
            log.info(f'  用户: {final.get("user_name", "")}')
            log.info(f'  今日观看: {final["today_count"]}/{final["max_count"]} 次')
            log.info(f'  乐豆余额: {final["ld_number"]}')
        log.info(f'  本次成功: {self.success_count} 次')
        log.info(f'  本次奖励: +{self.total_reward:.2f} 乐豆')
        log.info('='*50)

        return True


# ============ 主入口 ============

def main():
    # 方式1: 环境变量直接提供 token
    token_env = os.environ.get('LJ_AD_TOKEN', '').strip()
    uid_env = os.environ.get('LJ_AD_UID', '').strip()
    device_env = os.environ.get('LJ_AD_DEVICE', '').strip()
    count_env = int(os.environ.get('LJ_AD_COUNT', '10').strip())

    if token_env and uid_env:
        log.info('使用环境变量 Token 模式')
        watcher = AdWatcher(token_env, uid_env, device_env or None)
        watcher.run(count_env)
        return

    # 方式2: 通过 WCS 控制台自动登录（对乐购小程序执行 wx.login）
    if WCS_AUTH:
        log.info('使用 WCS 控制台自动登录模式')
        wcs = WCSClient()
        accounts = wcs.get_accounts()

        if not accounts:
            log.error('控制台未发现账号，请检查 WCS 是否运行')
            log.info('提示: set wx_auth=your-wcs-apikey')
            sys.exit(1)

        log.info(f'发现 {len(accounts)} 个账号')

        active = [a for a in accounts if not a.get('disabled', False)]
        for idx, acc in enumerate(active):
            openid = acc.get('openid', '') or acc.get('userKey', '')
            user_key = acc.get('userKey', openid)
            display = acc.get('displayName', '') or openid[:12]
            aid = f'{display}(#{idx+1})'

            log.info(f'\n------ {aid} ------')

            # 登录获取 Token
            result = login_wcs_get_token(openid, user_key)
            if not result:
                log.error(f'{aid} 登录失败，跳过')
                continue

            p_token, uid, device_id = result
            watcher = AdWatcher(p_token, uid, device_id)
            watcher.run(count_env)

            if idx < len(active) - 1:
                time.sleep(random.uniform(5, 10))
        return

    # 方式3: 无任何配置
    log.error('未提供认证信息! 请选择以下方式之一:')
    print('''
╔══════════════════════════════════════════╗
║     乐购广告自动观看 - 配置说明           ║
╠══════════════════════════════════════════╣
║                                          ║
║  方式一: 直接提供 Token (推荐)            ║
║    set LJ_AD_TOKEN=你的JWT_Token          ║
║    set LJ_AD_UID=122319                  ║
║    set LJ_AD_DEVICE=17793625710384438093  ║
║                                          ║
║  方式二: WCS 控制台自动登录               ║
║    set wx_auth=your-wcs-apikey           ║
║    (需确保乐购小程序在 WCS 中运行)         ║
║                                          ║
╚══════════════════════════════════════════╝
''')
    sys.exit(1)


if __name__ == '__main__':
    main()