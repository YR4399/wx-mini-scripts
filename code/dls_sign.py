#!/usr/bin/env python3
"""
杜蕾斯小程序 签到 + 抽奖
AppID: wxe11089c85860ec02

环境变量:
  dls - 多账号 Access-Token (用 & 分隔)

说明:
  杜蕾斯登录需要 code + mobile_code，WCS 无法获取 mobile_code
  仅支持手动 token 模式，token 从抓包获取（请求头 Access-Token）
"""
import os
import sys
import json
import time
import random
import logging
import requests

requests.packages.urllib3.disable_warnings()

# 清除代理
for _k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
    os.environ.pop(_k, None)
os.environ['NO_PROXY'] = '*'

# ====== 配置 ======
APPID = 'wxe11089c85860ec02'
API_BASE = 'https://vip.ixiliu.cn'
LOTTERY_SN = '468512040523264'

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('dls')

# ====== 配置缓存 ======
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.dls_config.json')

_DEFAULT_CONFIG = {
    'cached_tokens': {},  # 缓存的 token
}


def _load_config():
    """三级配置加载: 环境变量 > 缓存文件 > 默认值"""
    config = dict(_DEFAULT_CONFIG)

    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'r', encoding='utf-8') as f:
                config.update(json.load(f))
        except Exception:
            pass

    # 回写缓存
    try:
        with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

    return config


def _save_config(config):
    """保存配置"""
    try:
        with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def random_ua():
    """生成随机微信 User-Agent"""
    devices = [
        ('16', 'M2012K11AC Build/BP2A.250605.031.A3'),
        ('15', 'PELM00 Build/OPR1A.20240502.001'),
        ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ('14', 'SM-S918B Build/UP1A.231005.007'),
        ('13', 'V2141A Build/TP1A.220627.004'),
    ]
    wv_list = ['8.0.72.3100', '8.0.70.2780', '8.0.68.2780', '8.0.65.2780']
    av, dev = random.choice(devices)
    wv = random.choice(wv_list)
    return (
        f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
        f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
        f'Chrome/{random.randint(140,146)}.0.{random.randint(6000,7680)} Mobile Safari/537.36 '
        f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
        f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
    )


def get_headers(token):
    """构造请求头"""
    return {
        'Host': 'vip.ixiliu.cn',
        'Connection': 'keep-alive',
        'Access-Token': token,
        'Enterprise-hash': '10006',
        'sid': '10006',
        'content-type': 'application/json;charset=utf-8',
        'platform': 'MP-WEIXIN',
        'Accept-Encoding': 'gzip,compress,br,deflate',
        'User-Agent': random_ua(),
        'Referer': f'https://servicewechat.com/{APPID}/56/page-frame.html',
    }


def get_valid_token(idx, token, config):
    """获取有效 token: 缓存 → 直接使用"""
    cached_tokens = config.get('cached_tokens', {})
    cache_key = f'account_{idx}'

    # 1. 尝试缓存的 token
    if cache_key in cached_tokens:
        cached = cached_tokens[cache_key]
        if cached.get('token') and cached.get('expires', 0) > time.time():
            log.info(f'  使用缓存 token')
            return cached['token']

    # 2. 直接使用提供的 token
    if token:
        log.info(f'  使用手动 token')
        # 缓存 token (有效期假设 24 小时)
        cached_tokens[cache_key] = {
            'token': token,
            'expires': time.time() + 86400,
            'updated': time.strftime('%Y-%m-%d %H:%M:%S')
        }
        config['cached_tokens'] = cached_tokens
        _save_config(config)
        return token

    return None


class DLSSign:
    """杜蕾斯签到客户端"""

    def __init__(self, remark, token):
        self.remark = remark
        self.token = token
        self.results = []

    def check_token(self):
        """检查 token 是否有效"""
        url = f'{API_BASE}/mp/user/info'
        try:
            res = requests.get(url, headers=get_headers(self.token), timeout=10)
            if res.status_code == 200:
                data = res.json()
                if data.get('status') == 200:
                    nickname = data.get('data', {}).get('nickname', '未知')
                    log.info(f'  ✓ token 有效，用户: {nickname}')
                    return True
            log.warning(f'  ✗ token 无效')
            return False
        except Exception as e:
            log.error(f'  ✗ token 检查异常: {e}')
            return False

    def sign_in(self):
        """签到"""
        url = f'{API_BASE}/mp/sign/applyV2'
        try:
            res = requests.get(url, headers=get_headers(self.token), timeout=10)
            if res.status_code == 200:
                data = res.json()
                if data.get('status') == 200:
                    msg = '✅ 签到成功'
                elif '已签到' in data.get('message', ''):
                    msg = 'ℹ️ 今日已签到'
                else:
                    msg = f'❌ 签到失败: {data.get("message", "未知错误")}'
            else:
                msg = f'❌ 签到请求失败，状态码: {res.status_code}'
        except Exception as e:
            msg = f'❌ 签到异常: {str(e)}'

        log.info(f'  [签到] {msg}')
        self.results.append(msg)
        return msg

    def get_draw_chance(self):
        """获取抽奖次数"""
        url = f'{API_BASE}/mp/activity.lottery/getUserInfoV2'
        params = {'snId': LOTTERY_SN}
        try:
            res = requests.get(url, headers=get_headers(self.token), params=params, timeout=10)
            if res.status_code == 200:
                data = res.json()
                if data.get('status') == 200:
                    return data.get('data', {}).get('lotteryCount', 0)
            return 0
        except:
            return 0

    def lottery(self):
        """抽奖"""
        draw_count = self.get_draw_chance()
        if draw_count <= 0:
            msg = 'ℹ️ 今日抽奖次数已用完'
            log.info(f'  [抽奖] {msg}')
            self.results.append(msg)
            return msg

        url = f'{API_BASE}/mp/activity.lottery/draw'
        params = {'snId': LOTTERY_SN, 'channelSn': '0'}
        try:
            res = requests.get(url, headers=get_headers(self.token), params=params, timeout=10)
            if res.status_code == 200:
                data = res.json()
                if data.get('status') == 200:
                    prize = data.get('data', {}).get('prize', {}).get('prize_name', '未知奖品')
                    msg = f'✅ 抽奖成功，获得: {prize}'
                else:
                    msg = f'❌ 抽奖失败: {data.get("message", "未知错误")}'
            else:
                msg = f'❌ 抽奖请求失败，状态码: {res.status_code}'
        except Exception as e:
            msg = f'❌ 抽奖异常: {str(e)}'

        log.info(f'  [抽奖] {msg}')
        self.results.append(msg)
        return msg

    def run(self):
        """执行签到+抽奖"""
        log.info(f'[{self.remark}] 开始执行')

        # 检查 token
        if not self.check_token():
            msg = '❌ token 无效，跳过'
            self.results.append(msg)
            return self.results

        self.sign_in()
        time.sleep(random.uniform(0.5, 1.5))
        self.lottery()
        return self.results


def main():
    log.info('=' * 50)
    log.info('杜蕾斯 签到 + 抽奖')
    log.info('=' * 50)

    config = _load_config()

    # 从 dls 环境变量获取 token 列表
    raw = os.environ.get('dls', '')
    if not raw:
        log.error('未配置 dls 环境变量')
        log.error('格式: token1&token2&token3')
        log.error('token 从抓包获取，请求头中的 Access-Token 字段')
        sys.exit(1)

    # 解析 & 分隔的 token
    accounts = [(f'账号{i+1}', t.strip()) for i, t in enumerate(raw.split('&')) if t.strip()]
    if not accounts:
        log.error('未解析到有效账号')
        sys.exit(1)

    log.info(f'共 {len(accounts)} 个账号')

    all_results = []
    for idx, (remark, openid_or_token) in enumerate(accounts, 1):
        if not openid_or_token:
            log.warning(f'账号[{idx}] 配置为空，跳过')
            continue

        account_name = remark if remark else f'账号{idx}'
        log.info(f'\n{"=" * 50}')
        log.info(f'[{idx}/{len(accounts)}] {account_name}')
        log.info(f'{"=" * 50}')

        try:
            token = get_valid_token(idx, openid_or_token, config)
            if not token:
                log.error(f'  获取 token 失败')
                all_results.append(f'{account_name}: ❌ 获取 token 失败')
                continue

            client = DLSSign(account_name, token)
            results = client.run()
            all_results.append(f'{account_name}:\n' + '\n'.join(results))
        except Exception as e:
            log.error(f'{account_name} 异常: {e}')
            all_results.append(f'{account_name}: ❌ 异常 {e}')

        if idx < len(accounts):
            time.sleep(random.uniform(3, 6))

    # 输出汇总
    result_content = '\n\n'.join(all_results)
    log.info(f'\n{"=" * 50}')
    log.info(f'运行汇总:\n{result_content}')

    return result_content


if __name__ == '__main__':
    main()
