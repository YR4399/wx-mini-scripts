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
import time
import requests


def _req_retry(fn, *args, _retries=3, **kw):
    """网络请求退避重试：超时/连接/SSL 错误重试 3 次"""
    last = None
    for i in range(_retries):
        try:
            return fn(*args, **kw)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError) as e:
            last = e
            if i < _retries - 1:
                print(f"  [retry] {fn.__name__} 网络异常({e.__class__.__name__}), {i+1}s 后重试 {i+1}/{_retries}", flush=True)
                time.sleep(i + 1)
    raise last

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
API_BASE = 'https://mxa.miduoqi.com/api'  # 米多奇API域名

wx_server_url = os.environ.get('wx_server_url', '')
wx_auth = os.environ.get('wx_auth', '')
WX_OPINION = os.environ.get('wx_opinion', '')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841'


def mask_str(s):
    return s[:3] + '****' + s[-3:] if len(s) > 6 else s


def get_code(openid):
    """从WCS获取code"""
    try:
        resp = _req_retry(requests.post,
            f'{wx_server_url}/wx/code',
            json={'appid': APPID, 'openid': openid},
            headers={'auth': wx_auth},
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


def login(code):
    """有赞平台登录 - 使用 /passport/general/auth.json（不需要encryptedData）"""
    try:
        import uuid as _uuid
        headers = {
            'User-Agent': UA,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{APPID}/39/page-frame.html',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Extra-Data': json.dumps({
                'sid': '',
                'version': '2.232.5.101',
                'clientType': 'weapp-miniprogram',
                'client': 'weapp',
                'bizEnv': '',
                'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                'ftime': int(time.time() * 1000),
            }),
        }
        payload = {
            'appId': APPID,
            'code': code,
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
        }
        resp = _req_retry(requests.post,
            f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APPID}',
            json=payload,
            headers=headers,
            timeout=20,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('code') == 0 and data.get('data'):
            d = data['data']
            return d.get('accessToken'), d.get('sessionId', '')
        print(f'[登录] 失败: code={data.get("code")} msg={data.get("msg", data)}')
        return None, None
    except Exception as e:
        print(f'[登录] 异常: {e}')
        return None, None


def checkin(access_token, session_id=''):
    """签到"""
    try:
        import uuid as _uuid

        headers = {
            'User-Agent': UA,
            'Accept': '*/*',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{APPID}/39/page-frame.html',
        }
        if session_id:
            headers['Extra-Data'] = json.dumps({
                'sid': session_id,
                'version': '2.232.5.101',
                'client': 'weapp',
                'bizEnv': 'wsc',
                'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                'ftime': int(time.time() * 1000),
            })
        resp = _req_retry(requests.get,
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
        if '已达最大参与次数' in str(data.get('msg', '')) or '已签到' in str(data.get('msg', '')):
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
        resp = _req_retry(requests.get,
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
    
    # 2. 登录（不需要encryptedData）
    access_token, session_id = login(code)
    if not access_token:
        print('❌ 登录失败')
        return
    print(f'[登录] 成功')
    
    # 3. 获取签到信息
    info = get_checkin_info(access_token)
    if info:
        print(f'[签到] 活动ID: {info.get("checkInId")}')
    
    # 4. 签到（需要session_id）
    checkin(access_token, session_id)


def main():
    all_logs = []
    
    if not wx_server_url or not wx_auth:
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
