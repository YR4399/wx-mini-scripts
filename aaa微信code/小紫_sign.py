#!/usr/bin/env python3
"""小紫有约 签到脚本 - 基于 HAR 抓包重写"""
import os
import sys
import json
import time
import random
import string
import logging
import requests
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


requests.packages.urllib3.disable_warnings()

# ===== 配置 =====
APPID = 'wx3db193ecdebd3fea'
BASE_URL = 'https://sxkyziqidonglai.cn'
SITE_ID = 'SITE_33254242630091515087'
CHANNEL_CODE = 'WXjxriol8e8293wezu'
ACT_CODE = 'SG2641'

WCS_BASE = os.environ.get('wx_server_url', 'http://host.docker.internal:8788')
WCS_AUTH = os.environ.get('wx_auth', '')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('zfxq')

# ===== WCS 获取 code (带 fallback) =====
def get_wx_code(openid):
    """尝试所有 WCS 接口获取 code"""
    body = {'appid': APPID, 'openid': openid}
    endpoints = ['/wx/code', '/wx/operatedata', '/wx/encryptkey', '/wx/encrypt']
    for path in endpoints:
        try:
            r = requests.post(f'{WCS_BASE}{path}', json=body,
                              headers={'auth': WCS_AUTH, 'Content-Type': 'application/json'},
                              timeout=60, verify=False)
            data = r.json()
            if data.get('status'):
                d = data.get('data', {})
                code = d.get('code') or d.get('encrypt_key')
                if code:
                    log.info(f'  {path} OK: {code[:20]}...')
                    return code
        except Exception as e:
            log.warning(f'  {path} error: {e}')
    return None

# ===== 登录 =====
def wx_authenticate(code):
    """用微信 code 认证，获取 sessionId"""
    url = f'{BASE_URL}/api/platform/wechatAuthenticate'
    params = {
        'code': code,
        'channelCode': CHANNEL_CODE,
        'siteId': SITE_ID,
        'deviceHash': ''.join(random.choices(string.ascii_lowercase + string.digits + '_-', k=32)),
    }
    try:
        r = requests.get(url, params=params, timeout=15, verify=False)
        data = r.json()
        if data.get('success'):
            sid = data.get('data', {}).get('sessionId', '')
            wx_openid = data.get('data', {}).get('wxOpenId', '')
            msg = data.get('msg', '')
            log.info(f'  wechatAuthenticate: {msg}')
            if sid:
                return sid, wx_openid
        else:
            log.warning(f'  wechatAuthenticate failed: {data.get("msg")}')
    except Exception as e:
        log.error(f'  wechatAuthenticate error: {e}')
    return None, None

def check_login(session_id):
    """检查登录状态"""
    url = f'{BASE_URL}/api/platform/isLogin'
    cookies = {'SESSION': session_id}
    try:
        r = requests.post(url, data={'channelCode': CHANNEL_CODE, 'siteId': SITE_ID},
                          cookies=cookies, timeout=15, verify=False)
        data = r.json()
        is_login = data.get('data', {}).get('isLogin', False)
        user_id = data.get('data', {}).get('userId')
        return is_login, user_id
    except Exception as e:
        log.error(f'  isLogin error: {e}')
    return False, None

# ===== 签到 =====
def sign_in(session_id):
    """执行签到"""
    url = f'{BASE_URL}/api/mobile/activity-v2/activity/launchByValidater'
    cookies = {'SESSION': session_id}
    body = {'actCode': ACT_CODE, 'siteId': SITE_ID}
    try:
        r = requests.post(url, json=body, cookies=cookies, timeout=15, verify=False)
        data = r.json()
        msg = data.get('msg', '')
        success = data.get('success', False)
        return success, msg
    except Exception as e:
        log.error(f'  sign_in error: {e}')
    return False, str(e)

def get_points(session_id):
    """查询积分"""
    url = f'{BASE_URL}/api/mobile/eShop/voucher/balance'
    cookies = {'SESSION': session_id}
    try:
        r = requests.post(url, data={'siteId': SITE_ID}, cookies=cookies, timeout=15, verify=False)
        data = r.json()
        balance = data.get('data', {}).get('balance', 0)
        return balance
    except:
        return 0

# ===== 主流程 =====
def process_account(openid):
    """处理单个账号"""
    log.info(f'--- 账号: {openid[:12]}... ---')

    # 1. 获取 wx.login code
    log.info('  获取 wx.code...')
    code = get_wx_code(openid)
    if not code:
        log.error('  获取 code 失败')
        return False

    # 2. 微信认证
    log.info('  微信认证...')
    session_id, wx_openid = wx_authenticate(code)
    if not session_id:
        log.error('  认证失败')
        return False

    # 3. 检查登录状态
    is_login, user_id = check_login(session_id)
    if not is_login:
        log.warning('  未登录（可能需要手机号验证），尝试直接签到...')

    # 4. 签到 (重试3次)
    for attempt in range(3):
        log.info(f'  签到 ({attempt+1}/3)...')
        success, msg = sign_in(session_id)
        if success:
            log.info(f'  签到成功: {msg}')
            points = get_points(session_id)
            log.info(f'  当前积分: {points}')
            return True
        log.warning(f'  签到失败: {msg}')
        if attempt < 2:
            time.sleep(3)
    return False

def main():
    log.info('=' * 50)
    log.info('小紫有约 签到脚本')
    log.info('=' * 50)

    # 读取账号
    raw = os.environ.get('wx_opinion', '') or os.environ.get('zfxq', '')
    if not raw:
        log.error('未配置 wx_opinion 或 zfxq 环境变量')
        sys.exit(1)

    # 支持 & 和 # 分隔
    if '&' in raw:
        openids = [o.strip() for o in raw.split('&') if o.strip()]
    else:
        openids = [o.strip() for o in raw.split('#') if o.strip()]

    if not openids:
        log.error('无有效账号')
        sys.exit(1)

    log.info(f'共 {len(openids)} 个账号')

    ok = 0
    for i, openid in enumerate(openids, 1):
        log.info(f'\n===== [{i}/{len(openids)}] =====')
        try:
            if process_account(openid):
                ok += 1
        except Exception as e:
            log.error(f'  异常: {e}')
        time.sleep(2)

    log.info(f'\n{"=" * 50}')
    log.info(f'完成: {ok}/{len(openids)} 成功')

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
            push_notify('小紫_sign 签到结果', _logs[-2000:])
        except:
            pass



