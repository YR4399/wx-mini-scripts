#!/usr/bin/env python3
"""
海天美味馆 签到 + 抽奖 + 任务脚本
基于 SunnyNet 抓包数据 2026-05-29

环境变量:
  wx_opinion - openid 列表 (用 & 分隔)
  haitian    - refresh_token 备用 (用 & 分隔)

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

# ===== 配置 =====
BASE = 'https://cmallapi.xkmm.cn'
SIGN_ACTIVITY = '202606'
LUCKY_ACTIVITY = 'jfcj202606'

WCS_BASE = os.environ.get('wx_server_url', 'http://host.docker.internal:8788')
WCS_AUTH = os.environ.get('wx_auth', '')
APPID = 'wx7a890ea13f50d7b6'

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('haitian')


# ===== WCS fallback =====
def get_wx_code(openid):
    body = {'appid': APPID, 'openid': openid}
    for path in ['/wx/code', '/wx/operatedata', '/wx/encryptkey', '/wx/encrypt']:
        try:
            r = requests.post(f'{WCS_BASE}{path}', json=body,
                              headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                              timeout=60, verify=False)
            data = r.json()
            if data.get('status'):
                d = data.get('data', {})
                code = d.get('code') or d.get('encrypt_key')
                if code:
                    log.info(f'  {path} OK')
                    return code
        except Exception as e:
            log.warning(f'  {path} error: {e}')
    return None


# ===== 登录 =====
def login_via_wcs(openid):
    """通过 WCS operatedata 获取 code+edata 登录"""
    # 一次 operatedata 调用同时获取 code + edata + iv
    code, edata, iv = get_operatedata(openid)
    if not code:
        log.error('  WCS 获取 code 失败')
        return None, None
    log.info(f'  code: {code[:20]}...')

    # 调用 phoneNew/login 登录
    import uuid as uuid_mod
    uid = uuid_mod.uuid4().hex[:20]
    params = {
        'code': code,
        'uuid': uid,
        'app_versions': '28.0.15',
    }
    if edata and iv:
        params['edata'] = edata
        params['iv'] = iv

    url = f'{BASE}/buyer-api/wechat/mini/phoneNew/login'
    try:
        headers = {
            'uuid': uid,
            'envVersion': 'release',
            'xweb_xhr': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 MicroMessenger/7.0.20.1781 MiniProgramEnv/Windows',
        }
        r = requests.post(url, params=params, json={}, headers=headers, timeout=15, verify=False)
        d = r.json()
        at = d.get('access_token', '') or d.get('accessToken', '')
        rt = d.get('refresh_token', '') or d.get('refreshToken', '')
        if at:
            log.info(f'  登录成功! uid={d.get("uid", "")}')
            return at, rt
        log.warning(f'  登录失败: {d.get("message", "")} code={d.get("code", "")}')
        # E131 可能是 code 过期，重试一次
        if d.get('code') == 'E131':
            log.info('  重试...')
            code2, edata2, iv2 = get_operatedata(openid)
            if code2:
                params['code'] = code2
                if edata2 and iv2:
                    params['edata'] = edata2
                    params['iv'] = iv2
                params['uuid'] = uuid_mod.uuid4().hex[:20]
                r = requests.post(url, params=params, json={}, headers=headers, timeout=15, verify=False)
                d = r.json()
                at = d.get('access_token', '') or d.get('accessToken', '')
                rt = d.get('refresh_token', '') or d.get('refreshToken', '')
                if at:
                    log.info(f'  重试登录成功! uid={d.get("uid", "")}')
                    return at, rt
                log.warning(f'  重试失败: {d.get("message", "")} code={d.get("code", "")}')
    except Exception as e:
        log.error(f'  登录异常: {e}')

    return None, None


def get_operatedata(openid):
    """获取 wx.getPhoneNumber 授权数据 (同时返回 code)"""
    body = {'appid': APPID, 'openid': openid}
    try:
        r = requests.post(f'{WCS_BASE}/wx/operatedata', json=body,
                          headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                          timeout=60, verify=False)
        data = r.json()
        if data.get('status'):
            d = data.get('data', {})
            code = d.get('code', '')
            edata = d.get('encryptedData', '') or d.get('data', '')
            iv = d.get('iv', '')
            if code:
                log.info(f'  operatedata OK (code+edata)')
                return code, edata, iv
    except Exception as e:
        log.warning(f'  operatedata error: {e}')
    return None, None, None


def get_token(openid, refresh_tok=None):
    """获取 token: 优先 refresh_token，失败则 WCS 登录"""
    # 1. 尝试 refresh_token
    if refresh_tok:
        log.info('  尝试 refresh_token...')
        at, rt = refresh_access_token(refresh_tok)
        if at:
            log.info('  refresh_token 成功')
            return at, rt
        log.info('  refresh_token 已过期')

    # 2. WCS 自动登录
    log.info('  WCS 自动登录...')
    return login_via_wcs(openid)


def refresh_access_token(refresh_tok):
    """用 refresh_token 换新 accessToken"""
    url = f'{BASE}/buyer-api/passport/token'
    r = requests.post(url, data=f'refresh_token={refresh_tok}',
                      headers={'Content-Type': 'application/x-www-form-urlencoded'},
                      timeout=15, verify=False)
    data = r.json()
    at = data.get('accessToken', '')
    rt = data.get('refreshToken', '')
    return at, rt


def make_auth(token):
    return {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}


# ===== 签到 =====
def check_sign(token):
    """查询签到状态"""
    url = f'{BASE}/buyer-api/sign/activity/member/info'
    r = requests.get(url, params={'activityCode': SIGN_ACTIVITY},
                     headers=make_auth(token), timeout=15, verify=False)
    data = r.json()
    is_sign = data.get('is_sign', False)
    sign_day = data.get('sign_day_num', 0)
    return is_sign, sign_day


def do_sign(token):
    """执行签到"""
    url = f'{BASE}/buyer-api/sign/activity/sign'
    body = {'activity_code': SIGN_ACTIVITY, 'fill_date': ''}
    r = requests.post(url, json=body, headers=make_auth(token), timeout=15, verify=False)
    data = r.json()
    is_sign = data.get('is_sign', False)
    sign_day = data.get('sign_day_num', 0)
    return is_sign, sign_day


def get_points(token):
    """查询积分"""
    url = f'{BASE}/buyer-api/members/points/current'
    r = requests.get(url, headers=make_auth(token), timeout=15, verify=False)
    return r.json().get('balance', 0) or r.json().get('current', 0)


# ===== 抽奖 =====
def get_lucky_opportunities(token):
    """查询抽奖次数"""
    url = f'{BASE}/buyer-api/lucky/activity/opporturnity'
    r = requests.get(url, params={'activityCode': LUCKY_ACTIVITY},
                     headers=make_auth(token), timeout=15, verify=False)
    data = r.json()
    return data.get('can_use', 0), data.get('opportunity_num', 0)


def do_lucky(token):
    """执行抽奖"""
    url = f'{BASE}/buyer-api/lucky/activity/extract'
    r = requests.get(url, params={'activityCode': LUCKY_ACTIVITY},
                     headers=make_auth(token), timeout=15, verify=False)
    data = r.json()
    prize = data.get('lucky_record_vo', {})
    prize_name = prize.get('prize_name', '未知')
    remaining = data.get('opporturnity', 0)
    return prize_name, remaining


# ===== 任务 =====
def get_tasks(token):
    """获取任务列表"""
    url = f'{BASE}/buyer-api/lucky/task/package'
    r = requests.get(url, params={'activityCode': LUCKY_ACTIVITY},
                     headers=make_auth(token), timeout=15, verify=False)
    return r.json()


def do_login_task(token):
    """完成登录任务 (自动)"""
    url = f'{BASE}/buyer-api/members/active/action'
    r = requests.get(url, params={'type': 'LOG'}, headers=make_auth(token),
                     timeout=15, verify=False)
    return r.json().get('code') == '200'


def do_browse_task(token):
    """模拟浏览任务"""
    url = f'{BASE}/buyer-api/members/commnity/brosing/duration/add'
    r = requests.get(url, params={'seconds': str(random.randint(15, 30))},
                     headers=make_auth(token), timeout=15, verify=False)
    return r.json().get('code') == '200'


# ===== 主流程 =====
def process_account(openid, refresh_tok=None):
    """处理单个账号"""
    if not refresh_tok:
        log.error('  无 refresh_token，跳过（需要抓包获取）')
        return False
    # 1. 刷新 token
    log.info('  刷新 token...')
    access_token, new_refresh = refresh_access_token(refresh_tok)
    if not access_token:
        log.error('  token 刷新失败（需要重新抓包获取 refresh_token）')
        return False
    log.info(f'  token 获取成功')
    if new_refresh:
        log.info(f'  新 refresh_token 已获取（下次可自动使用）')

    # 2. 查询积分
    points = get_points(access_token)
    log.info(f'  当前积分: {points}')

    # 3. 签到
    is_sign, sign_day = check_sign(access_token)
    if is_sign:
        log.info(f'  今日已签到 (连续{sign_day}天)')
    else:
        log.info('  执行签到...')
        is_sign, sign_day = do_sign(access_token)
        if is_sign:
            log.info(f'  签到成功! 连续{sign_day}天')
        else:
            log.warning('  签到失败')

    # 4. 完成任务获取抽奖次数
    log.info('  完成任务...')
    do_login_task(access_token)
    time.sleep(1)
    do_browse_task(access_token)
    time.sleep(1)

    # 5. 查询抽奖次数
    can_use, total = get_lucky_opportunities(access_token)
    log.info(f'  抽奖次数: 可用{can_use}/总{total}')

    # 6. 抽奖
    if can_use > 0:
        log.info(f'  开始抽奖 ({can_use}次)...')
        for i in range(can_use):
            try:
                prize_name, remaining = do_lucky(access_token)
                log.info(f'    [{i+1}] 中奖: {prize_name} (剩余{remaining}次)')
                time.sleep(2)
            except Exception as e:
                log.error(f'    [{i+1}] 抽奖失败: {e}')
                break
    else:
        log.info('  无抽奖次数')

    # 7. 最终积分
    final_points = get_points(access_token)
    log.info(f'  最终积分: {final_points}')

    return True


def main():
    log.info('=' * 50)
    log.info('海天美味馆 签到 + 抽奖 + 任务')
    log.info('=' * 50)

    # 读取账号 (openid 列表)
    raw_opinion = os.environ.get('wx_opinion', '')
    raw_haitian = os.environ.get('haitian', '')

    if raw_opinion:
        openids = [o.strip() for o in raw_opinion.split('&') if o.strip()]
    else:
        log.error('未配置 wx_opinion 环境变量')
        sys.exit(1)

    # refresh_token 列表 (可选)
    refresh_tokens = [t.strip() for t in raw_haitian.split('&') if t.strip()] if raw_haitian else []

    log.info(f'共 {len(openids)} 个账号')

    ok = 0
    for i, openid in enumerate(openids, 1):
        log.info(f'\n===== [{i}/{len(openids)}] =====')
        rt = refresh_tokens[i-1] if i-1 < len(refresh_tokens) else None
        try:
            if process_account(openid, rt):
                ok += 1
        except Exception as e:
            log.error(f'异常: {e}')
        time.sleep(3)

    log.info(f'\n{"=" * 50}')
    log.info(f'完成: {ok}/{len(openids)} 成功')


if __name__ == '__main__':
    main()
