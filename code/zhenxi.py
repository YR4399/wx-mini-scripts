# -*- coding: utf-8 -*-
"""
伊利甄稀冰淇淋 - 免单券/会员券自动抽奖 & 领取脚本 v2

小程序: #小程序://甄稀冰淇淋/Zr6Cnm6ShD5Z6up
AppID: wx21fd8b5d6d4cf1ca (从 UA 提取)

v2 架构变更 (基于 2026-05-21 HAR 分析 + 实测验证):
  - 业务域 zhenxiapp-admin.msxapi.digitalyili.com 的接口
    (/draw_wh, /draw_records_wh, /set_coupon_wh)
    不需要 access-token，只需 openid 即可调用！
  - gateway 域 msmarket.msx.digitalyili.com 的接口
    (/user/info, /login) 需要 token，但仅用于查询用户信息（非必须）
  - 因此主流程简化为: openid -> 直接抽奖 -> 查记录 -> 尝试领取

API 流程:
  1. (可选) /gateway/api/auth/account/user/info  -> 用 token 获取用户昵称等
  2. /api/draw_wh                        -> 抽奖 (只需 openid, 无需 token!)
  3. /api/draw_records_wh                -> 查询中奖记录 (只需 openid)
  4. /api/set_coupon_wh                  -> 领取待领取奖品 (需要有效身份)

环境变量:
    YLZX_TOKENS   - 手动模式: mobile#access-token 格式，多账号换行
                    示例: 150xxx192#xka9vTYME6TOoeGUjszAPJwwR70V...
    wx_auth       - WCS 模式: WCS 控制台 API Key（优先于手动模式）
                    WCS 模式下直接用 openid 抽奖，无需获取 token!

依赖: pip install requests
"""
import os
import sys
import time
import random
import logging

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
log = logging.getLogger('zhenxi')

# ============ 常量 ============

NAME = '伊利甄稀冰淇淋'
WX_APPID = 'wx21fd8b5d6d4cf1ca'

# API 地址
LOGIN_URL = 'https://msmarket.msx.digitalyili.com/gateway/api/auth/account/login'
INFO_URL = 'https://msmarket.msx.digitalyili.com/gateway/api/auth/account/user/info'
DRAW_URL = 'https://zhenxiapp-admin.msxapi.digitalyili.com/api/draw_wh'
RECORDS_URL = 'https://zhenxiapp-admin.msxapi.digitalyili.com/api/draw_records_wh'
CLAIM_URL = 'https://zhenxiapp-admin.msxapi.digitalyili.com/api/set_coupon_wh'

# WCS 控制台配置
WCS_BASE = os.environ.get('wx_server_url', 'http://host.docker.internal:18788')
WCS_AUTH = os.environ.get('wx_auth', '')


def random_ua():
    """生成随机微信小程序 UA (Android)"""
    devices = [
        ('14', 'SM-S918B Build/UP1A.231005.007'),
        ('13', 'V2141A Build/TP1A.220627.004'),
        ('12', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ('11', 'PELM00 Build/OPR1A.20240502.001'),
        ('10', 'MI 8 Build/QKQ1.190828.002'),
    ]
    wv_list = ['8.0.57.2820', '8.0.55.2780', '80.50.2700',
               '8.0.48.2680', '8.0.45.2660']
    av, dev = random.choice(devices)
    wv = random.choice(wv_list)
    hex_suffix = format(random.randint(0, 65535), '04X')
    return (
        f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
        f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
        f'Chrome/{random.randint(128,134)}.0.{random.randint(6000,7300)} '
        f'Mobile Safari/537.36 XWEB/{random.randint(130000,135000)} '
        f'MMWEBSDK/{random.randint(20250000,20250301)} '
        f'MMWEBID/{random.randint(6500,6600)} '
        f'MicroMessenger/{wv}(0x2800{hex_suffix}) '
        f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 '
        f'miniProgram/{WX_APPID}'
    )


# ============ WCS 控制台客户端 ============

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


# ============ 核心业务逻辑 ============

class ZhenXiClient:
    """
    甄稀冰淇淋 API 客户端 v2

    v2 变更: 主标识改为 openid，不再强制要求 access-token。
    业务接口(draw/records)只需要 openid，token 仅用于可选的用户信息查询。
    """

    def __init__(self, open_id, mobile='', access_token=None):
        """
        Args:
            open_id: 用户唯一标识 (必填, 来自 WCS 或手动输入)
            mobile: 手机号脱敏显示用
            access_token: 可选, 用于 gateway 域名查询用户信息
        """
        self.open_id = open_id
        self.access_token = access_token
        self.mobile = mobile
        self.rs = requests.Session()
        self.user_info = None
        # 统计
        self.draw_results = []
        self.claimed = []
        self.good_coupons = []

    def _info_headers(self):
        """查询用户信息的请求头 (msmarket 域名, 需要token)"""
        if not self.access_token:
            return None  # 无 token 则无法调用此接口
        return {
            'Host': 'msmarket.msx.digitalyili.com',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'Accept': '*/*',
            'User-Agent': random_ua(),
            'access-token': self.access_token,
            'Sec-Fetch-Site': 'same-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        }

    def _act_headers(self):
        """活动接口请求头 (zhenxiapp-admin 域名, 无需token!)"""
        return {
            'Host': 'zhenxiapp-admin.msxapi.digitalyili.com',
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'Accept': '*/*',
            'x-requested-with': 'com.tencent.mm',
            'priority': 'u=1, i',
            'User-Agent': random_ua(),
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': 'Android',
            'sec-ch-ua': (
                '"Chromium";v="130", "Android WebView";v="130", '
                '"Not?A_Brand";v="99"'
            ),
            'Sec-Fetch-Site': 'same-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        }

    def get_user_info(self):
        """
        Step 0 (可选): 用 access-token 获取用户昵称等信息。
        仅在有 token 时调用，失败不影响后续抽奖流程。
        """
        if not self.access_token:
            log.info('[*] 无 access-token，跳过用户信息查询')
            return True

        hdrs = self._info_headers()
        if not hdrs:
            return True

        log.info('[*] 查询用户信息...')
        try:
            resp = self.rs.get(INFO_URL, headers=hdrs, timeout=15)
            data = resp.json()
        except Exception as e:
            log.warning(f'  用户信息请求失败(不影响抽奖): {e}')
            return True

        if not data.get('data'):
            log.warning(f'  Token 可能已过期(不影响抽奖)')
            return True

        self.user_info = data['data']
        nickname = data['data'].get('nickName', '') or data['data'].get('name', '')
        phone = data['data'].get('mobile', '') or self.mobile
        oid_display = data['data'].get('openId', self.open_id)
        log.info(f'  openId: {oid_display[:12]}... | 昵称: {nickname} | 手机: {phone[:3]}****{phone[-3:] if len(phone) >= 7 else ""}')
        return True

    def draw_lottery(self, times=3):
        """
        Step 1: 抽奖指定次数。
        只需 openid, 无需 access-token!
        """
        log.info(f'[*] 开始抽奖 ({times} 次)...')
        for i in range(times):
            try:
                resp = self.rs.post(
                    DRAW_URL,
                    headers=self._act_headers(),
                    json={'openid': self.open_id},
                    timeout=15
                )
                data = resp.json()

                prize_name = ''
                if data.get('data') and isinstance(data['data'], dict):
                    prize_name = data['data'].get('prize_name', '')
                elif isinstance(data.get('data'), str):
                    prize_name = data['data']

                msg = data.get('msg', '') or data.get('info', '')
                prize_name = prize_name or msg or '(未中奖)'
                self.draw_results.append(prize_name)
                log.info(f'  抽奖 [{i+1}/{times}]: {prize_name}')

            except Exception as e:
                log.error(f'  抽奖[{i+1}] 异常: {e}')
                self.draw_results.append(f'(异常:{e})')

            if i < times - 1:
                time.sleep(random.uniform(1.5, 3.5))

    def claim_prizes(self):
        """
        Step 2 & 3: 查询中奖记录 + 尝试领取待领取奖品。
        注意: set_coupon_wh 可能因身份校验失败返回"用户不属于活动"，
        这是已知限制——业务接口不验证token，但领取时可能需要有效身份。
        """
        log.info('[*] 查询中奖记录...')
        try:
            resp = self.rs.post(
                RECORDS_URL,
                headers=self._act_headers(),
                json={
                    'openid': self.open_id,
                    'page': 1,
                    'pageSize': 100,
                },
                timeout=15
            )
            data = resp.json()
        except Exception as e:
            log.error(f'  记录查询失败: {e}')
            return

        records = []
        if data.get('data') and isinstance(data['data'], dict):
            records = data['data'].get('data', [])

        if not records:
            log.info('  无中奖记录')
            return

        log.info(f'  共 {len(records)} 条记录')

        for item in records:
            prize_id = item.get('id')
            status = item.get('status')
            prize_name = item.get('prize_name', '')

            if status == 1:
                # 待领取 -> 执行领取
                log.info(f'  [领取] {prize_name} (id={prize_id})')
                try:
                    c_resp = self.rs.post(
                        CLAIM_URL,
                        headers=self._act_headers(),
                        json={'openid': self.open_id, 'record_id': prize_id},
                        timeout=15
                    )
                    c_data = c_resp.json()
                    c_msg = c_data.get('msg', '')
                    if c_msg != 'success':
                        log.warning(f'    领取结果: {c_msg}')
                        # 已知问题: 可能返回"用户不存在"/"用户不属于活动"
                    else:
                        log.info(f'    领取成功!')
                        self.claimed.append(prize_name)
                except Exception as e:
                    log.error(f'    领取异常: {e}')

                time.sleep(random.uniform(1, 2))
            else:
                # 已处理/已使用等，只展示非通用优惠券的好券
                if '199-120' not in prize_name:
                    log.info(f'  [记录] 好券: {prize_name}')
                    self.good_coupons.append(prize_name)

    def run(self, draw_times=3):
        """
        执行完整流程: (查用户信息) -> 抽奖 -> 查记录 -> 领取

        v2: 不再强制要求 token。有 token 就查用户信息，没有也照样能抽。
        """
        log.info('=' * 50)
        log.info(f'  {NAME} - 自动抽奖 & 领取 v2')
        log.info('=' * 50)

        # 显示当前使用的 openid
        oid_show = self.open_id[:12] + '...' if len(self.open_id) > 15 else self.open_id
        log.info(f'  openid: {oid_show}')

        # Step 0 (可选): 获取用户信息
        self.get_user_info()

        # Step 1: 抽奖 (核心功能，不需要 token!)
        self.draw_lottery(draw_times)

        # Step 2 & 3: 查询 + 领取
        self.claim_prizes()

        # 汇总
        log.info('-' * 50)
        log.info('  本次汇总:')
        log.info(f'    抽奖结果: {" | ".join(self.draw_results)}')
        if self.claimed:
            log.info(f'    成功领取: {" | ".join(self.claimed)}')
        if self.good_coupons:
            log.info(f'    好券记录: {" | ".join(self.good_coupons)}')
        if not self.claimed and not self.good_coupons:
            log.info('   无可领取奖品 (或需手动在小程序内领取)')
        log.info('=' * 50)
        return True


# ============ 主入口 ============

def main():
    # 方式1: 手动 Token 模式 (YLZX_TOKENS)
    manual_tokens = os.environ.get('YLZX_TOKENS', '').strip()

    # 兼容旧变量名 ylzx
    if not manual_tokens:
        manual_tokens = os.environ.get('wx_opinion', '') or os.environ.get('ylzx', '')

    if manual_tokens:
        log.info('使用手动 Token 模式 (YLZX_TOKENS)')
        accounts = [line.strip() for line in manual_tokens.split('\n') if line.strip()]

        if not accounts:
            log.error('YLZX_TOKENS 变量为空!')
            sys.exit(1)

        log.info(f'发现 {len(accounts)} 个账号\n')
        for idx, account in enumerate(accounts):
            parts = account.split('#', 1)
            if len(parts) == 2:
                mobile, token = parts
                display = f'{mobile[:3]}*****{mobile[-3:]}' if len(mobile) >= 6 else mobile
                log.info(f'\n------ 账号 #{idx+1}: {display} ------')

                client = ZhenXiClient(open_id=f'manual_{idx}', mobile=mobile, access_token=token)
                # 手动模式下尝试通过 token 获取 openid
                client.get_user_info()
                if client.open_id == f'manual_{idx}' and client.user_info:
                    client.open_id = client.user_info.get('openId', client.open_id)
                client.draw_lottery(draw_times=3)
                client.claim_prizes()
            else:
                # 也支持纯 openid 格式 (v2 新增)
                openid = account.strip()
                log.info(f'\n------ 账号 #{idx+1}: {openid[:12]}... ------')
                client = ZhenXiClient(open_id=openid)
                client.run(draw_times=3)

            if idx < len(accounts) - 1:
                time.sleep(random.randint(1, 3))
        return

    # 方式2: WCS 自动登录模式 (v2 大幅简化!)
    if WCS_AUTH:
        log.info('使用 WCS 控制台模式 (v2 - openid 直连)')
        wcs = WCSClient()
        accounts = wcs.get_accounts()

        if not accounts:
            log.error('控制台未发现账号，请检查 WCS 是否运行')
            log.info('提示: set wx_auth=your-wcs-apikey 或 set YLZX_TOKENS=mobile#token')
            sys.exit(1)

        log.info(f'发现 {len(accounts)} 个账号\n')
        active = [a for a in accounts if not a.get('disabled', False)]

        for idx, acc in enumerate(active):
            openid = acc.get('openid', '') or acc.get('userKey', '')
            user_key = acc.get('userKey', openid)
            display = acc.get('displayName', '') or openid[:12]
            aid = f'{display}(#{idx+1})'

            log.info(f'\n------ {aid} ------')

            # v2: 不再需要 wcs_get_token()!
            # 直接用 WCS 提供的 openid 创建客户端并运行
            client = ZhenXiClient(open_id=openid, mobile=display)
            client.run(draw_times=3)

            if idx < len(active) - 1:
                time.sleep(random.uniform(3, 6))
        return

    # 无任何配置
    log.error('未提供认证信息! 请选择以下方式之一:')
    print(f'''
╔══════════════════════════════════════════╗
║     {NAME} - 配置说明                   ║
╠══════════════════════════════════════════╣
║                                          ║
║  方式一: 手动 Token                     ║
║    set YLZX_TOKENS=                     ║
║      手机号#access-token                ║
║    或纯 openid (每行一个)               ║
║                                          ║
║  方式二: WCS 控制台 (推荐!)             ║
║    set wx_auth=your-wcs-apikey           ║
║    自动获取所有账号的 openid 并抽奖     ║
║    无需手动配置 token!                   ║
║                                          ║
╚══════════════════════════════════════════╝
''')
    sys.exit(1)


if __name__ == '__main__':
    main()