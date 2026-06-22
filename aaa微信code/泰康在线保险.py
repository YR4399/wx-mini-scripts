#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泰康在线保险小程序每日签到、做金币悬赏任务

支持两种模式:
1. WCS模式（默认）: 通过微信服务器自动获取code登录
2. unionid模式: 直接使用unionid登录

变量名：
  wx_server_url  WCS地址
  wx_auth        WCS认证key
  wx_opinion     WCS账号openid（多账号用&分隔）
  tkzxbx         备注#unionid（可选，unionid模式）

cron: 0 12 * * *
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
import time
import uuid
import json
import base64
import random
import hashlib
import traceback
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

# ========== 推送通知 ==========
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'aaa微信code'))
try:
    from _push_helper import push_notify
    from _push_helper import send_push_notify  # 自动采集日志并推送

except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========

TITLE = '泰康在线保险小程序'
APPID = 'wx9e3e7020c4a10356'
FROMID = '67527'
DEFAULT_TIMEOUT = 20

WX_SERVER_URL = os.environ.get('wx_server_url', '')
WX_AUTH = os.environ.get('wx_auth', '')
WX_OPINION = os.environ.get('wx_opinion', '')


def mask_str(s):
    return s[:3] + '****' + s[-3:] if len(s) > 6 else s


def get_code_from_wcs(openid):
    if not WX_SERVER_URL or not WX_AUTH:
        return None
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
                print(f'[WCS] 获取code成功: {mask_str(code)}')
                return code
        print(f'[WCS] 获取code失败: {data}')
        return None
    except Exception as e:
        print(f'[WCS] 异常: {e}')
        return None


def get_unionid_from_code(code):
    """通过code获取unionid"""
    try:
        resp = requests.post(
            'https://m.tk.cn/wechat_item/rest/xcx/login',
            json={'appId': APPID, 'code': code},
            timeout=DEFAULT_TIMEOUT,
            proxies={'http': None, 'https': None},
            verify=False
        )
        data = resp.json()
        if data.get('error_code') == '0':
            uid = (data.get('data') or {}).get('unionid', '')
            if uid:
                print(f'[登录] 获取unionid成功: {mask_str(uid)}')
                return uid
        print(f'[登录] 获取unionid失败: {data}')
        return None
    except Exception as e:
        print(f'[登录] 获取unionid异常: {e}')
        return None


class TkzxClient:
    def __init__(self, remark='', openid='', unionid=''):
        self.remark = remark
        self.openid = openid
        self.unionid = unionid
        self.session = requests.Session()
        self.session.verify = False
        self.logs = []
        self.headers = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090c33)XWEB/13487',
            'content-type': 'application/x-www-form-urlencoded',
        }
        self.device_id = 'WC39ZUyXRgdExSj90tOeGomyOuuFeIVfnoBh4K6/N2S6+cPQvxZzEMpX4YkYGt7bl61lJVmGniEtWjSm22hAKQUL4jL6rQD4StL/WmrP2Tauiuo9Z2Nzm4Q==1487577677129'
        self.member_id = ''
        self.token = ''

    def log(self, msg):
        self.logs.append(str(msg))
        print(msg, flush=True)

    @staticmethod
    def encrypt_body(body, key='EEue2kxI0oh2GBJh'):
        aes = AES.new(key.encode(), AES.MODE_ECB)
        return aes.encrypt(pad(body.encode(), AES.block_size)).hex().upper()

    @staticmethod
    def make_body(payload):
        return json.dumps(payload, ensure_ascii=False, separators=(',', ':'))

    def post_json(self, url, **kw):
        r = self.session.post(url, timeout=DEFAULT_TIMEOUT, **kw)
        r.raise_for_status()
        return r.json()

    def enc_post(self, url, body):
        return self.post_json(url, headers=self.headers, json={'enc': True, 'encData': self.encrypt_body(body)})

    def login_wcs(self):
        """WCS模式：获取code -> 换取unionid -> 登录"""
        if not self.openid:
            return False
        # Step 1: 从WCS获取code
        code = get_code_from_wcs(self.openid)
        if not code:
            return False
        # Step 2: 用code换取unionid
        uid = get_unionid_from_code(code)
        if not uid:
            return False
        self.unionid = uid
        # Step 3: 用unionid登录
        return self._login_with_unionid()

    def login_unionid(self):
        if not self.unionid:
            return False
        return self._login_with_unionid()

    def _login_with_unionid(self):
        """使用unionid登录"""
        params = self.make_body({'platform': 'APPLET', 'fromid': FROMID, 'bindid': self.unionid})
        data = urlencode({'api_s': 'member.userbind', 'api_m': 'selectwxbindbybindid', 'params': params})
        try:
            r = self.post_json('https://m.tk.cn/member_api/', headers=self.headers, data=data)
            if r.get('result') != 'success':
                self.log(f'[登录] 失败: {r.get("message", r)}')
                return False
            d = r.get('data') or {}
            self.member_id = str(d.get('memberid', ''))
            self.token = str(d.get('token', ''))
            mobile = (d.get('pmemberuser') or {}).get('membertmmobile', '未知')
            self.log(f'[登录] 成功: {mobile}')
            return True
        except Exception as e:
            self.log(f'[登录] 异常: {e}')
            return False

    def login(self):
        if self.openid and WX_SERVER_URL:
            self.log('[登录] WCS模式...')
            if self.login_wcs():
                return True
        if self.unionid:
            self.log('[登录] unionid模式...')
            return self.login_unionid()
        self.log('[登录] 无可用方式')
        return False

    def sign_daily(self, nickname):
        body = self.make_body({'memberid': self.member_id, 'token': self.token, 'unionid': self.unionid or self.openid, 'deviceId': self.device_id, 'fromid': FROMID, 'platform': 'WECHAT', 'coordinate': '', 'nickName': nickname})
        r = self.enc_post('https://m.tk.cn/activity_execute/rest/membergoldbean/sign', body)
        if r.get('error_code') == '0':
            self.log(f'每日签到: +{(r.get("data") or {}).get("signAmount", 0)}积分')
        else:
            self.log(f'每日签到: {r.get("error_message", r)}')

    def query_tasks(self):
        body = self.make_body({'memberid': self.member_id, 'token': self.token, 'platform': 'WECHAT'})
        r = self.enc_post('https://m.tk.cn/activity_execute/rest/membergoldbean/queryTask', body)
        d = r.get('data')
        return d if isinstance(d, list) else []

    def handle_task(self, task):
        name = task.get('taskName', '未知')
        if task.get('status') == 'Y':
            self.log(f'{name}: 已完成')
            return
        body = self.make_body({'memberId': self.member_id, 'token': self.token, 'eventType': task.get('taskCode', ''), 'activityCode': 'membergoldbean', 'activityId': task.get('activityId', ''), 'assignmentId': task.get('assignmentId', ''), 'assignmentType': task.get('assignmentType', '')})
        self.enc_post('https://m.tk.cn/activity_execute/rest/noseEvent/saveNoseEventLog', body)
        tt = task.get('taskToken')
        vt = task.get('viewToken')
        if tt:
            time.sleep(random.randint(13, 15))
            r = self.post_json('https://m.tk.cn/activity_execute/rest/callback/taskCallBack', headers=self.headers, json={'memberId': self.member_id, 'taskToken': tt})
            self.log(f'{name}: {r.get("data") if r.get("error_code")=="0" else r.get("error_message", r)}')
        if vt:
            time.sleep(random.randint(13, 15))
            try:
                # browse 回调需要 Signature/Authorization 头
                self._generate_signature(from_id='71672')
                browse_headers = {
                    'user-agent': self.headers.get('user-agent', ''),
                    'content-type': 'application/json',
                    'accept': 'application/json, text/plain, */*',
                    'Signature': self.headers.get('Signature', ''),
                    'Authorization': self.headers.get('authorization', ''),
                }
                r = self.post_json('https://f.tk.cn/promotion/net-camp-api/api/callback/browse', headers=browse_headers, json={'viewToken': vt})
                self.log(f'{name}: {(r.get("data") or {}).get("msg", r.get("data")) if r.get("error_code")=="0" else r.get("error_message", r)}')
            except Exception as e:
                self.log(f'{name}: 浏览回调异常 {e}')

    def _generate_signature(self, from_id='71672'):
        """生成 Signature 和 Authorization 请求头"""
        auth_body = self.make_body({'memberId': self.member_id, 'token': self.token, 'platform': 'APPLET', 'fromId': from_id})
        self.headers['authorization'] = self.encrypt_body(auth_body, 'xdh3OmA5gEMMy0Mz').lower()
        client_id = '81b1950d'
        timestamp = int(time.time() * 1000)
        non_str = str(uuid.uuid4())
        minute_timestamp = 60000 * (timestamp // 60000)
        data = '%s%s%sgc6615f3f5b85f1ec09e' % (client_id, non_str, minute_timestamp)
        sign = hashlib.md5(hashlib.md5(data.encode()).hexdigest().encode()).hexdigest()
        sign_body = self.make_body({'clientId': client_id, 'nonStr': non_str, 'timestamp': timestamp, 'sign': sign})
        self.headers['Signature'] = self.encrypt_body(sign_body, 'xdh3OmA5gEMMy0Mz')

    def answer_quiz(self):
        """保障知识答题"""
        self.log('--- 保障知识答题 ---')
        try:
            # 检查答题活动是否可用
            resp = self.session.get(
                'https://m.tk.cn/promotion/activity_execute/rest/tk/answer/isActivityOver',
                headers=self.headers, timeout=DEFAULT_TIMEOUT
            ).json()
            if resp.get('error_code') != '0':
                self.log(f'答题活动检查失败: {resp.get("error_message", resp)}')
                return
            data = resp.get('data') or {}
            if not data.get('todayDate'):
                self.log('今日答题活动未开放')
                return

            # 获取答题主页信息
            page_data = self._get_main_page()
            if not page_data:
                return

            answer_task = page_data.get('answerTask') or {}
            answer_status = answer_task.get('answerStatus', 0)
            if answer_status == 0:
                self.log('答题: 今日已完成')
                return

            # 逐题答题
            max_rounds = 20
            for round_num in range(1, max_rounds + 1):
                question_detail = page_data.get('questionDetail') or {}
                correct_answer = question_detail.get('answer', '')
                question_text = question_detail.get('question', '')
                analysis = question_detail.get('analysis', '')
                options = question_detail.get('optionList') or []

                if not correct_answer:
                    self.log(f'答题第{round_num}轮: 未获取到正确答案，尝试随机作答')
                    correct_answer = random.choice(['A', 'B', 'C', 'D'])

                if question_text:
                    opt_str = ' | '.join(f'{o.get("option")}.{o.get("content")}' for o in options)
                    self.log(f'题目: {question_text}')
                    if opt_str:
                        self.log(f'选项: {opt_str}')
                    self.log(f'答案: {correct_answer} {"(解析: " + analysis + ")" if analysis else ""}')

                body = self.make_body({
                    'memberId': self.member_id, 'token': self.token, 'result': correct_answer,
                    'deviceId': self.device_id, 'os': 'weapp', 'platform': 'APPLET', 'fromId': '72474'
                })
                self._generate_signature(from_id='72474')
                resp = self.post_json(
                    'https://m.tk.cn/promotion/activity_execute/rest/tk/answer/answer',
                    headers=self.headers, json={'enc': True, 'encData': self.encrypt_body(body)}
                )
                if resp.get('error_code') != '0':
                    self.log(f'答题第{round_num}轮失败: {resp.get("error_message", resp)}')
                    break
                adata = resp.get('data') or {}
                is_right = adata.get('result', False)
                right = adata.get('right', 0)
                coin = adata.get('coin', 0)
                self.log(f'答题第{round_num}轮: {correct_answer} → {"✓" if is_right else "✗"} | 累计答对{right}题，金币{coin}')
                time.sleep(random.randint(2, 4))

                # 获取下一题
                page_data = self._get_main_page()
                if not page_data:
                    break
                check_task = page_data.get('answerTask') or {}
                if check_task.get('answerStatus', 0) == 0:
                    self.log(f'答题完成，共答对{right}题，获得{coin}金币')
                    break
            else:
                self.log(f'答题已达到最大轮次({max_rounds})，停止')
        except Exception:
            self.log(f'答题异常: {traceback.format_exc().strip()}')

    def _get_main_page(self):
        """获取答题主页信息"""
        body = self.make_body({
            'memberId': self.member_id, 'token': self.token,
            'unionId': self.unionid, 'fromId': '72474', 'platform': 'APPLET'
        })
        self._generate_signature(from_id='72474')
        resp = self.post_json(
            'https://m.tk.cn/promotion/activity_execute/rest/tk/answer/mainPage',
            headers=self.headers, json={'enc': True, 'encData': self.encrypt_body(body)}
        )
        if resp.get('error_code') != '0':
            self.log(f'获取答题主页失败: {resp.get("error_message", resp)}')
            return None
        return resp.get('data')

    def browse_product(self):
        """签到-浏览推荐产品（通过 viewProductCallback）"""
        self.log('--- 浏览推荐产品 ---')
        try:
            page_data = self._get_main_page()
            if not page_data:
                return

            answer_task = page_data.get('answerTask') or {}
            view_product_token = answer_task.get('viewProductToken', '')
            if not view_product_token:
                self.log('浏览: 未获取到viewProductToken')
                return

            self.log('等待浏览回调')
            time.sleep(random.randint(13, 15))

            # viewProductCallback 使用 enc_post 格式
            body = self.make_body({
                'viewToken': view_product_token, 'memberId': self.member_id,
                'token': self.token, 'deviceId': self.device_id, 'os': 'web'
            })
            cb_resp = self.enc_post(
                'https://f.tk.cn/activity_execute/rest/membergoldbean/viewProductCallback',
                body
            )
            if cb_resp.get('error_code') == '0':
                cb_data = cb_resp.get('data') or {}
                self.log(f'浏览推荐产品: {cb_data.get("msg", cb_data)}')
            else:
                self.log(f'浏览推荐产品失败: {cb_resp.get("error_message", cb_resp)}')
        except Exception:
            self.log(f'浏览推荐产品异常: {traceback.format_exc().strip()}')

    def run(self):
        self.log(f'********{self.remark}********')
        try:
            if not self.login():
                return self.logs
            self.headers['content-type'] = 'application/json'
            body = self.make_body({'memberId': self.member_id, 'token': self.token, 'fromid': FROMID, 'platform': 'WECHAT', 'rewardCode': 'redpacketone', 'deviceId': self.device_id})
            r = self.enc_post('https://m.tk.cn/activity_execute/rest/membergoldbean/exchange', body)
            self.log(f'兑换红包: {r.get("error_message", r)}')
            body = self.make_body({'memberId': self.member_id, 'token': self.token})
            r = self.enc_post('https://m.tk.cn/activity_execute/rest/membergoldbean/getMemberGoldbeanNickName', body)
            nickname = base64.b64encode(((r.get('data') or {}).get('nickName') or '').encode()).decode()
            self.sign_daily(nickname)
            for task in self.query_tasks():
                try:
                    self.handle_task(task)
                except Exception:
                    self.log(f'{task.get("taskName", "未知")}: {traceback.format_exc().strip()}')
            # 答题
            try:
                self.answer_quiz()
            except Exception:
                self.log(f'答题任务异常: {traceback.format_exc().strip()}')
            # 浏览推荐产品
            try:
                self.browse_product()
            except Exception:
                self.log(f'浏览任务异常: {traceback.format_exc().strip()}')
        except Exception:
            self.log(traceback.format_exc().strip())
        return self.logs


def main():
    all_logs = []
    
    # WCS模式
    if WX_SERVER_URL and WX_AUTH and WX_OPINION:
        for idx, openid in enumerate([x.strip() for x in WX_OPINION.split('&') if x.strip()], 1):
            print(f'\n>>>>>>>>WCS账号【{idx}】<<<<<<<<')
            logs = TkzxClient(remark=f'WCS{idx}', openid=openid).run()
            all_logs.extend(logs)
    
    # unionid模式
    raw = os.environ.get('tkzxbx', '').strip()
    if raw:
        for item in raw.split('&'):
            item = item.strip()
            if '#' not in item:
                continue
            remark, unionid = item.split('#', 1)
            print(f'\n>>>>>>>>{remark}<<<<<<<<')
            logs = TkzxClient(remark=remark, unionid=unionid).run()
            all_logs.extend(logs)
    
    if not all_logs:
        print('未配置账号')
        return 1
    
    try:
        push_notify('泰康在线保险 签到结果', '\n'.join(all_logs)[-2000:])
    except:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
