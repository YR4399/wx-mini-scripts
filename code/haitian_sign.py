#!/usr/bin/env python3
"""
海天美味馆 签到 + 积分任务 + 抽奖
基于 HAR 抓包 2026-05-30

环境变量:
  haitian - access_token (多个用 & 分隔)
            从抓包 login 响应中获取

用法:
  1. 手机抓包获取 phoneNew/login 响应中的 access_token
  2. 配置环境变量 haitian=<access_token>
  3. 运行脚本

说明:
  - access_token 有效期约 2 小时
  - refresh_token 海天服务端不稳定，脚本优先直接用 access_token
  - token 过期后需重新抓包获取

AppID: wx7a890ea13f50d7b6
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

# 配置
BASE = 'https://cmallapi.xkmm.cn'
LUCKY_ACTIVITY = 'jfcj202606'

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('haitian')

# Token 缓存
TOKEN_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.haitian_tokens.json')


def load_cache():
    try:
        with open(TOKEN_CACHE, 'r') as f:
            return json.load(f)
    except:
        return {}


def save_cache(cache):
    with open(TOKEN_CACHE, 'w') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def check_token(token):
    """检查 token 是否有效"""
    try:
        r = requests.get(f'{BASE}/buyer-api/members/points/current',
                         headers={'Authorization': token}, timeout=10, verify=False)
        return r.status_code == 200 and 'consum_point' in r.text
    except:
        return False


def refresh_token(rt):
    """用 refresh_token 换新 access_token (海天服务端不稳定)"""
    try:
        r = requests.get(f'{BASE}/buyer-api/auth/refresh',
                         headers={'Authorization': rt}, timeout=15, verify=False)
        if r.status_code == 200:
            d = r.json()
            at = d.get('access_token', '') or d.get('accessToken', '')
            new_rt = d.get('refresh_token', '') or d.get('refreshToken', '')
            if at:
                return at, new_rt
        log.warning(f'  刷新失败: {r.status_code} {r.text[:100]}')
    except Exception as e:
        log.error(f'  刷新异常: {e}')
    return None, None


def get_valid_token(idx, token):
    """获取有效 token: 直接用 → 缓存 → refresh(备选)"""
    cache = load_cache()
    key = f'account_{idx}'

    # 1. 直接用提供的 token
    if token and check_token(token):
        log.info('  ✓ token 有效')
        cache[key] = {
            'access_token': token,
            'updated': time.strftime('%Y-%m-%d %H:%M:%S')
        }
        save_cache(cache)
        return token

    # 2. 有缓存的 token，试用
    if key in cache and cache[key].get('access_token'):
        at = cache[key]['access_token']
        if check_token(at):
            log.info('  ✓ 使用缓存 token')
            return at

    # 3. 尝试 refresh (海天服务端不稳定，仅作备选)
    if token:
        log.info('  尝试 refresh...')
        at, new_rt = refresh_token(token)
        if at and check_token(at):
            cache[key] = {
                'access_token': at,
                'updated': time.strftime('%Y-%m-%d %H:%M:%S')
            }
            save_cache(cache)
            return at

    return None


def api(method, token, path, params=None, json_data=None):
    headers = {'Authorization': token, 'Content-Type': 'application/json'}
    r = requests.request(method, f'{BASE}{path}', params=params, json=json_data,
                         headers=headers, timeout=15, verify=False)
    try:
        return r.json()
    except:
        return r.text


def process_account(idx, total, token):
    """处理单个账号"""
    log.info('=' * 50)
    log.info(f'[{idx}/{total}] 海天美味馆')
    log.info('=' * 50)

    token = get_valid_token(idx, token)
    if not token:
        log.error('  ✗ token 无效或已过期，需重新抓包获取')
        return False

    # 查询积分
    points = api('GET', token, '/buyer-api/members/points/current')
    consum = points.get('consum_point', 0) if isinstance(points, dict) else 0
    log.info(f'  [积分] 当前: {consum}')

    # 签到
    log.info('  [签到] 执行签到...')
    api('GET', token, '/buyer-api/members/active/action', {'type': 'LOG'})
    time.sleep(0.5)

    # 积分任务
    log.info('  [任务] 活跃任务...')
    api('GET', token, '/buyer-api/members/active/action', {'type': 'ACT'})
    time.sleep(0.5)
    api('GET', token, '/buyer-api/members/active/action', {'type': 'PAG'})
    time.sleep(0.5)
    api('GET', token, '/buyer-api/members/active/action', {'type': 'SHA'})
    time.sleep(0.5)

    # 浏览时长
    log.info('  [任务] 浏览时长...')
    for _ in range(3):
        api('POST', token, f'/buyer-api/members/commnity/brosing/duration/add?seconds={random.randint(20, 45)}')
        time.sleep(1)

    # 文章浏览
    api('POST', token, '/buyer-api/members/article_view/add/28.0.15', json_data=['232', '230'])
    time.sleep(0.5)

    # 积分任务状态
    tasks = api('GET', token, '/buyer-api/members/pointTask')
    if isinstance(tasks, dict):
        sign = tasks.get('sign', [])
        if len(sign) >= 4:
            log.info(f'  [任务] 签到: {sign[0]}/{sign[2]} +{sign[3]}积分')
        browse = tasks.get('community_browse', [])
        if len(browse) >= 4:
            log.info(f'  [任务] 社区浏览: {browse[0]}/{browse[2]} +{browse[3]}积分')

    # 领取登录抽奖机会
    log.info('  [抽奖] 领取登录机会...')
    api('PUT', token, f'/buyer-api/lucky/task/getLoginOpporturnity/{LUCKY_ACTIVITY}')
    time.sleep(0.5)

    # 积分兑换抽奖机会
    log.info('  [抽奖] 积分兑换...')
    for _ in range(2):
        api('GET', token, '/buyer-api/lucky/activity/redeem', {'activityCode': LUCKY_ACTIVITY})
        time.sleep(1)

    # 查询抽奖次数
    opp = api('GET', token, '/buyer-api/lucky/activity/opporturnity', {'activityCode': LUCKY_ACTIVITY})
    can_use = opp.get('can_use', 0) if isinstance(opp, dict) else 0
    log.info(f'  [抽奖] 可用次数: {can_use}')

    # 抽奖
    if can_use > 0:
        log.info(f'  [抽奖] 开始抽奖 ({can_use} 次)...')
        for i in range(can_use):
            result = api('GET', token, '/buyer-api/lucky/activity/extract', {'activityCode': LUCKY_ACTIVITY})
            prize = result.get('lucky_record_vo', {}) if isinstance(result, dict) else {}
            name = prize.get('prize_name', '未中奖') if prize else '未中奖'
            remaining = result.get('opporturnity', 0) if isinstance(result, dict) else 0
            log.info(f'    [{i+1}/{can_use}] {name} (剩余 {remaining} 次)')
            time.sleep(random.uniform(1.5, 3))
    else:
        log.info('  [抽奖] 无可用次数')

    # 最终积分
    final = api('GET', token, '/buyer-api/members/points/current')
    final_consum = final.get('consum_point', 0) if isinstance(final, dict) else 0
    log.info(f'  [结果] 积分: {consum} → {final_consum} ({"+" if final_consum >= consum else ""}{final_consum - consum})')

    return True


def main():
    log.info('=' * 50)
    log.info('海天美味馆 签到 + 积分任务 + 抽奖')
    log.info('=' * 50)

    raw = os.environ.get('haitian', '')
    if not raw:
        log.error('未配置 haitian 环境变量')
        log.error('用法: 抓包获取 phoneNew/login 响应中的 access_token')
        log.error('      配置环境变量 haitian=<access_token>')
        log.error('说明: access_token 有效期约2小时，过期需重新抓包')
        sys.exit(1)

    tokens = [t.strip() for t in raw.split('&') if t.strip()]
    log.info(f'共 {len(tokens)} 个账号')

    ok = 0
    for i, token in enumerate(tokens, 1):
        try:
            if process_account(i, len(tokens), token):
                ok += 1
        except Exception as e:
            log.error(f'账号 {i} 异常: {e}')
        if i < len(tokens):
            time.sleep(random.uniform(3, 6))

    log.info(f'\n{"=" * 50}')
    log.info(f'完成: {ok}/{len(tokens)} 成功')


if __name__ == '__main__':
    main()
