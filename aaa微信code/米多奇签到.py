#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
米多奇小程序签到（有赞平台）

变量名：wx_opinion（WCS账号openid，多账号用&分隔）
需要：wx_server_url, wx_auth（WCS配置）

cron: 0 8 * * *
"""
# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========

import sys
import json
import requests

# ========== 推送通知 ==========
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'aaa微信code'))
try:
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========

APPID = 'wx876a1475cd1778ed'
KDT_ID = '184183627'
CHECKIN_ID = '6878521'

WX_SERVER_URL = os.environ.get('wx_server_url', '')
WX_AUTH = os.environ.get('wx_auth', '')
WX_OPINION = os.environ.get('wx_opinion', '')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841'


def mask_str(s):
    return s[:3] + '****' + s[-3:] if len(s) > 6 else s


def get_code(openid):
    """从WCS获取code"""
    try:
        resp = requests.post(
            f'{WX_SERVER_URL}/wx/code',
            json={'appid': APPID, 'openid': openid},
            headers={'auth': WX_AUTH},
            timeout=60,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('status') is True or data.get('code') == 0:
            d = data.get('data', '')
            code = d.get('code', '') if isinstance(d, dict) else d
            if code:
                return code
        return None
    except Exception as e:
        print(f'[WCS] 获取code异常: {e}')
        return None


def get_operatedata(openid):
    """从WCS获取手机号授权数据"""
    try:
        resp = requests.post(
            f'{WX_SERVER_URL}/wx/operatedata',
            json={'appid': APPID, 'openid': openid},
            headers={'auth': WX_AUTH},
            timeout=60,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('status') is True or data.get('code') == 0:
            return data.get('data', {})
        return None
    except Exception as e:
        print(f'[WCS] 获取operatedata异常: {e}')
        return None


def login(code, encrypted_data, iv):
    """有赞平台登录"""
    try:
        headers = {
            'User-Agent': UA,
            'Content-Type': 'application/json',
            'Accept': '*/*',
        }
        payload = {
            'errMsg': 'getPhoneNumber:ok',
            'encryptedData': encrypted_data,
            'iv': iv,
            'code': code,
            'downgrade': False,
            'bizDataMap': {'from_params': ''},
            'platformName': 'weapp',
            'source': 2,
            'signed': True,
            'appId': APPID,
            'kdtId': int(KDT_ID),
        }
        resp = requests.post(
            f'https://uic.youzan.com/passport/general/login/auth.json?kdt_id={KDT_ID}&app_id={APPID}',
            json=payload,
            headers=headers,
            timeout=20,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('code') == 0:
            d = data.get('data', {})
            return d.get('accessToken'), d.get('nickname', ''), d.get('mobile', '')
        print(f'[登录] 失败: {data.get("msg", data)}')
        return None, None, None
    except Exception as e:
        print(f'[登录] 异常: {e}')
        return None, None, None


def checkin(access_token):
    """签到"""
    try:
        headers = {
            'User-Agent': UA,
            'Accept': '*/*',
        }
        resp = requests.get(
            f'https://h5.youzan.com/wscump/checkin/checkinV2.json',
            params={
                'checkinId': CHECKIN_ID,
                'app_id': APPID,
                'kdt_id': KDT_ID,
                'access_token': access_token,
            },
            headers=headers,
            timeout=20,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('code') == 0:
            d = data.get('data', {})
            if d.get('success'):
                awards = d.get('list', [])
                award_str = ', '.join([a.get('infos', {}).get('title', '') for a in awards])
                print(f'✅ 签到成功: {award_str}')
                return True
            else:
                print(f'签到: {d.get("desc", "未知结果")}')
                return False
        # 已签到
        if '已签到' in str(data.get('msg', '')) or data.get('code') == 1:
            print('今日已签到')
            return True
        print(f'签到失败: {data.get("msg", data)}')
        return False
    except Exception as e:
        print(f'签到异常: {e}')
        return False


def get_checkin_info(access_token):
    """获取签到信息"""
    try:
        resp = requests.get(
            'https://h5.youzan.com/wscump/checkin/check-in-info.json',
            params={
                'app_id': APPID,
                'kdt_id': KDT_ID,
                'access_token': access_token,
            },
            timeout=20,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('code') == 0:
            return data.get('data', {})
        return None
    except Exception:
        return None


def run_account(openid):
    """运行单个账号"""
    print(f'\n========== {mask_str(openid)} ==========')
    
    # 1. 获取code
    code = get_code(openid)
    if not code:
        print('❌ 获取code失败')
        return
    print(f'[WCS] 获取code成功: {mask_str(code)}')
    
    # 2. 获取手机号授权数据
    op_data = get_operatedata(openid)
    if not op_data:
        print('❌ 获取手机号授权数据失败')
        return
    
    encrypted_data = op_data.get('encryptedData', '')
    iv = op_data.get('iv', '')
    if not encrypted_data or not iv:
        print('❌ 授权数据不完整')
        return
    print(f'[WCS] 获取授权数据成功')
    
    # 3. 登录
    access_token, nickname, mobile = login(code, encrypted_data, iv)
    if not access_token:
        print('❌ 登录失败')
        return
    print(f'[登录] 成功: {nickname} {mask_str(mobile)}')
    
    # 4. 获取签到信息
    info = get_checkin_info(access_token)
    if info:
        print(f'[签到] 活动ID: {info.get("checkInId")}')
    
    # 5. 签到
    checkin(access_token)


def main():
    all_logs = []
    
    if not WX_SERVER_URL or not WX_AUTH:
        print('❌ 未配置WCS (wx_server_url/wx_auth)')
        return 1
    
    if not WX_OPINION:
        print('❌ 未配置账号 (wx_opinion)')
        return 1
    
    accounts = [x.strip() for x in WX_OPINION.split('&') if x.strip()]
    print(f'共找到 {len(accounts)} 个账号')
    
    for openid in accounts:
        try:
            run_account(openid)
        except Exception as e:
            print(f'❌ 账号 {mask_str(openid)} 异常: {e}')
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
