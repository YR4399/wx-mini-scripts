#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
1、安装python依赖loguru
2、抓https://account.wps.cn/p/auth/check 抓取请求头中的 cookie 字段
确保包含 uid 和 act_csrf_token 等关键字段

变量名：WPS_TASK_CK
变量值：备注#cookie
"""

import os
import sys
import random
import time
import json
import hashlib
import hmac
import threading
import requests
import urllib3
import unicodedata
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from loguru import logger

# ---------------- 配置区域 ----------------
# 禁用 SSL 警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 加载 notify 模块
try:
    from _push_helper import send_push_notify as send_notify
except ImportError:
    logger.warning("未检测到 notify.py，将无法推送消息")
    send_notify = None
    from _push_helper import send_push_notify as send_notify

# 全局配置
CFG_THREADS = int(os.getenv('WPS_CONCURRENCY', 3))  # 默认3线程并发
CFG_PROXY_API = os.getenv('WPS_PROXY_API', '')      # 代理API地址
CFG_START_DELAY = int(os.getenv('WPS_DELAY_START', 0)) # 启动随机延时

# 模块化配置开关 - True=开启, False=关闭
CFG_MODULES = {
    'task_center': True,      # WPS任务中心
    'fragment_collect': True, # 天天领福利
    'assistant': True,        # 办公助手
    'svip_applet': True,      # 超级会员小程序
    'pc_task_center': True,   # WPS任务中心新版任务页（补充任务/抽奖）
}

# 全局锁，用于控制提取IP的频率（防止并发提取导致API报错）
PROXY_EXTRACT_LOCK = threading.Lock()


def generate_sign(t: dict, i: str, r: str) -> tuple:
    """
    小程序签到签名生成函数
    :param t: 原始字典
    :param i: 固定前缀字符串
    :param r: HmacSHA256的密钥
    :return: (签名结果, UTC时间字符串)
    """
    # 1. 排序键并重构字典
    sorted_keys = sorted(t.keys())
    n = {key: t[key] for key in sorted_keys}
    
    # 2. JSON序列化
    p = json.dumps(n, ensure_ascii=False, separators=(',', ':'))
    
    # 3. 计算MD5
    md5_p = hashlib.md5(p.encode('utf-8')).hexdigest()
    
    # 4. 获取UTC时间字符串
    utc_time = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S GMT')
    
    # 5. 拼接待签名字符串
    f = i + md5_p + utc_time
    
    # 6. HmacSHA256签名
    hmac_obj = hmac.new(r.encode('utf-8'), f.encode('utf-8'), hashlib.sha256)
    return hmac_obj.hexdigest(), utc_time

# ---------------- 工具类 ----------------

class Utils:
    @staticmethod
    @staticmethod
    def random_sleep(s=1.0, e=None):
        """
        随机休眠函数（外部传秒，内部精确到毫秒）
        支持小数秒参数，内部自动转换为毫秒级随机值，保证休眠精度
        """
        # 1. 类型校验与转换：确保参数为数字（支持int/float）
        try:
            s = float(s)
            e = float(e) if e is not None else None
        except (ValueError, TypeError):
             # 兼容旧代码单纯传参错误的情况，默认1秒
            s = 1.0
            e = 2.0

        # 2. 处理默认值：单参数时，上限 = 下限 + 1.0秒
        if e is None:
            e = s + 1.0

        # 3. 边界修正：确保下限 ≤ 上限
        if s > e:
            s, e = e, s

        # 4. 额外防护：避免休眠时间为负数
        s = max(s, 0.0)
        e = max(e, 0.0)

        # 5. 核心转换：秒 → 毫秒
        s_ms = int(round(s * 1000))
        e_ms = int(round(e * 1000))

        # 6. 生成毫秒级随机数 → 转回秒
        sleep_ms = random.randint(s_ms, e_ms)
        sleep_sec = sleep_ms / 1000

        # 7. 执行休眠
        time.sleep(sleep_sec)
        return round(sleep_sec, 3)

    @staticmethod
    def parse_cookie_str(cookie_str):
        """
        将 Cookie 字符串转换为字典
        :param cookie_str: 格式为 "key1=value1; key2=value2" 的 Cookie 字符串
        :return: 转换后的字典，格式为 {key1: value1, key2: value2}
        """
        cookie_dict = {}
        # 处理空字符串情况
        if not cookie_str:
            return cookie_dict

        # 按分号分隔 Cookie 键值对
        cookie_pairs = [pair.strip() for pair in cookie_str.split(';') if pair.strip()]

        for pair in cookie_pairs:
            # 按第一个等号分割（兼容值中包含等号的情况，如 "token=abc=123"）
            key_value = pair.split('=', 1)
            if len(key_value) == 2:
                key, value = key_value
                cookie_dict[key.strip()] = value.strip()
            else:
                # 处理异常格式（如仅有 key 无 value，如 "isLogin"）
                cookie_dict[key_value[0].strip()] = ""

        return cookie_dict

    @staticmethod
    def mask_uid(uid):
        """脱敏 UID: 12345678 -> 12***78"""
        s_uid = str(uid)
        if len(s_uid) > 4:
            return f"{s_uid[:2]}***{s_uid[-2:]}"
        return s_uid

    @staticmethod
    def get_visual_width(s):
        """计算字符串的视觉宽度（简单粗暴版：非ASCII算2）"""
        width = 0
        for char in s:
            # 简单粗暴：只要不是标准ASCII字符，在中文Windows终端下通常都占2位
            # 这涵盖了中文、全角符号、以及大部分 Emoji
            if ord(char) > 127:
                width += 2
            else:
                width += 1
        return width

    @staticmethod
    def pad_str(s, width):
        """左对齐填充，确保视觉对齐"""
        visual_len = Utils.get_visual_width(s)
        padding = max(0, width - visual_len)
        return s + " " * padding

# ---------------- 代理管理类 (核心) ----------------

class ProxyManager:
    """管理代理提取与验证，支持锁机制"""
    
    @staticmethod
    def get_valid_proxy(api_url: str, retries=3) -> Optional[Dict[str, str]]:
        if not api_url:
            return None

        # 模拟浏览器 UA，防止被代理商防火墙拦截
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }

        for i in range(retries):
            # --- 关键：加锁提取 ---
            # 只有拿到锁的线程才能请求API，其他人排队
            with PROXY_EXTRACT_LOCK:
                if i > 0: 
                    time.sleep(3) # 重试前等待
                
                try:
                    # logger.debug(f"正在提取代理 IP (第 {i+1} 次尝试)...")
                    resp = requests.get(api_url, headers=headers, timeout=10)
                    if resp.status_code != 200:
                        logger.warning(f"代理API请求失败: {resp.status_code}")
                        continue
                    
                    proxy_str = ProxyManager._parse_api_response(resp.text)
                    if not proxy_str:
                        logger.warning(f"代理API解析失败，返回内容: {resp.text[:50]}")
                        continue
                        
                    proxies = {
                        "http": f"http://{proxy_str}",
                        "https": f"http://{proxy_str}"
                    }
                    
                    # 提取成功后，休息1.5秒再释放锁，满足一般代理商 1s/次的限制
                    time.sleep(1.5) 
                    
                except Exception as e:
                    logger.error(f"代理提取异常: {e}")
                    continue

            # --- 验证环节 (释放锁后并发验证) ---
            if ProxyManager._check_connectivity(proxies):
                logger.info(f"代理验证成功: {proxy_str}")
                return proxies
            else:
                pass 
                # logger.warning(f"代理 {proxy_str} 连通性测试失败")

        return None

    @staticmethod
    def _parse_api_response(text: str) -> str:
        """智能解析 Text 或 JSON 格式的代理"""
        text = text.strip()
        try:
            # 尝试 JSON 解析
            if text.startswith('{') or text.startswith('['):
                data = json.loads(text)
                # 适配常见格式: {"code":200, "data": [{"ip":..., "port":...}]}
                if isinstance(data, dict):
                    if "data" in data:
                        inner = data["data"]
                        if isinstance(inner, list) and len(inner) > 0:
                            item = inner[0]
                            return f"{item.get('ip')}:{item.get('port')}"
                        elif isinstance(inner, dict):
                            return f"{inner.get('ip')}:{inner.get('port')}"
                if isinstance(data, list) and len(data) > 0:
                    item = data[0]
                    return f"{item.get('ip')}:{item.get('port')}"
                    
            # 尝试纯文本解析 (1.1.1.1:8888)
            if ':' in text and len(text.split(':')) >= 2:
                return text.split()[0] # 过滤可能的换行符
        except:
            pass
        return None

    @staticmethod
    def _check_connectivity(proxies):
        """验证代理是否可用（任意一种协议通即可）"""
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        try:
            # 优先测 HTTPS (WPS业务主用)
            requests.get("https://www.baidu.com", headers=headers, proxies=proxies, timeout=3)
            return True
        except:
            try:
                # 回退测 HTTP
                requests.get("http://www.baidu.com", headers=headers, proxies=proxies, timeout=3)
                return True
            except:
                return False

# ---------------- 业务逻辑类 ----------------

class WPSUser:
    def __init__(self, index, user_data, proxies=None):
        self.idx = index
        self.cookie_dict = Utils.parse_cookie_str(user_data.get('cookie'))
        
        # 基础信息
        self.raw_username = user_data.get('username', f'User_{index}')
        self.uid = self.cookie_dict.get('uid', 'Unknown')
        self.csrf = self.cookie_dict.get('act_csrf_token', '')
        self.proxies = proxies
        
        # 构造显示名称：备注(脱敏UID)
        self.masked_uid = Utils.mask_uid(self.uid)
        self.display_name = f"{self.raw_username}({self.masked_uid})"
        
        # 日志前缀
        self.log_prefix = f"[{self.display_name}]"
        
        # 结果容器
        self.result_summary = {
            "name": self.display_name,
            # 汇总统计
            "sign_total": 0,      # 签到成功总数
            "sign_count": 3,      # 签到模块总数 (任务中心/天天福利/小程序)
            "task_total": 0,      # 任务完成总数
            "lottery_total": 0,   # 抽奖总次数
            "score": "未知",
            "status": "❌",
            # 各模块明细
            "modules": {
                "task_center": {"sign": False, "task": 0, "lottery": 0},
                "fragment": {"sign": False, "lottery": 0},
                "assistant": {"task": 0, "lottery": 0},
                "pc_task_center": {"task": 0, "lottery": 0},
                "applet": {"sign": False},
            }
        }

        # 初始化 Session
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        })
        self.session.verify = False
        if self.proxies:
            self.session.proxies.update(self.proxies)
        self.session.cookies.update(self.cookie_dict)

    def request(self, method, url, **kwargs):
        """封装请求，统一处理异常"""
        try:
            resp = self.session.request(method, url, timeout=10, **kwargs)
            return resp
        except Exception as e:
            logger.error(f"{self.log_prefix} 请求异常: {str(e)[:50]}")
            return None

    def get_public_key(self):
        headers = {
            'origin': 'https://personal-act.wps.cn',
            'referer': 'https://personal-act.wps.cn/',
        }
        resp = self.request('GET', 'https://personal-bus.wps.cn/sign_in/v1/encrypt/key', headers=headers)
        if resp and resp.json().get('code') == 1000000:
            return resp.json()['data']
        return None

    def sign_in(self, encrypt_data):
        """执行签到"""
        # 1. 获取签名
        try:
            sign_payload = {'encryptData': encrypt_data, 'userId': self.uid}
            # 注意：如果 py.leishennb.icu 挂了，这里会报错
            rnl_resp = self.request('POST', 'https://py.leishennb.icu/v1/rnl-2-gather/get-wps-publickey', json=sign_payload)
            if not rnl_resp or rnl_resp.status_code != 200:
                logger.error(f"{self.log_prefix} 获取签名参数失败")
                return False
            
            rnl_data = rnl_resp.json().get('data')
            if not rnl_data:
                return False
        except:
            return False

        # 2. 提交签到
        headers = {
            'origin': 'https://personal-act.wps.cn',
            'token': rnl_data['token'],
        }
        resp = self.request('POST', 'https://personal-bus.wps.cn/sign_in/v1/sign_in', headers=headers, json=rnl_data['data'])
        
        if not resp: return False
        
        data = resp.json()
        
        # 成功
        if data.get('code') == 1000000:
            reward = data['data']['rewards'][0]['reward_name']
            logger.success(f"{self.log_prefix} 签到成功: {reward}")
            self.result_summary["modules"]["task_center"]["sign"] = True
            self.result_summary["sign_total"] += 1
            return True
            
        # 重复签到
        msg = data.get('msg', '')
        if 'has sign' in msg:
            logger.info(f"{self.log_prefix} 今日已签到")
            self.result_summary["modules"]["task_center"]["sign"] = True
            self.result_summary["sign_total"] += 1
            return True
            
        logger.error(f"{self.log_prefix} 签到失败: {data}")
        self.result_summary["sign"] = "❌ 失败"
        return False



    def get_info(self):
        """获取用户信息(积分、抽奖次数、任务列表)"""
        url = 'https://personal-act.wps.cn/activity-rubik/activity/page_info?activity_number=HD2025031821201822&page_number=YM2025040908558269&filter_params=%7B%22cs_from%22:%22web_vipcenter_banner_inpublic%22,%22mk_key%22:%224b9deqIfqNO3KCZrgH17WPH1kdzMoKUEvya%22,%22position%22:%22pc_aty_ban3_kaixue_test_b%22%7D'
        resp = self.request('GET', url)
        if not resp: return None
        
        try:
            data = resp.json()
            if data['result'] != 'ok': return None
            
            info = {"times": 0, "score": 0, "task_list": []}
            for item in data["data"]:
                # 提取抽奖次数
                if item.get("type") == 45 and item.get("lottery_v2"):
                    for session in item["lottery_v2"].get("lottery_list", []):
                        if session.get("session_id") == 2:
                            info["times"] = session.get("times", 0)
                # 提取积分
                if item.get("task_center_user_info"):
                    info["score"] = item["task_center_user_info"].get("integral", 0)
                elif item.get("integral_waterfall"):
                    info["score"] = item["integral_waterfall"].get("user_integral", 0)
                # 提取任务列表
                if item.get("task_center"):
                    info["task_list"] = item["task_center"].get("task_list", [])
            
            return info
        except:
            return None

    def _task_action(self, task_id, action_type="task_center.finish"):
        """通用任务接口"""
        headers = {'x-act-csrf-token': self.csrf, 'origin': 'https://personal-act.wps.cn'}
        payload = {
            'component_uniq_number': {
                'activity_number': 'HD2025031821201822',
                'page_number': 'YM2025040908558269',
                'component_number': 'ZJ2025040709458367',
                'component_node_id': 'FN1744160180RthG',
                'filter_params': {'cs_from': 'web_vipcenter_banner_inpublic'}
            },
            'component_type': 35,
            'component_action': action_type,
            'task_center': {'task_id': task_id}
        }
        resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
        try:
            return resp.json()
        except:
            return None

    def _get_browse_task_info(self, token):
        """获取浏览任务的 batch_tag"""
        timestamp = int(time.time() * 1000)
        params = {'batch_tag': timestamp, 'token': token}
        resp = self.request('GET', 'https://personal-act.wps.cn/activity-rubik/user/task_center/task_info', params=params)
        try:
            data = resp.json()
            if data.get('result') == 'ok':
                return timestamp + data['data']['start_at']
        except:
            pass
        return None

    def _finish_browse_task(self, token, batch_tag):
        """提交浏览任务完成"""
        headers = {'origin': 'https://personal-act.wps.cn'}
        payload = {'batch_tag': batch_tag, 'token': token}
        resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/user/task_center/task_finish', headers=headers, json=payload)
        try:
            return resp.json().get('result') == 'ok'
        except:
            return False

    def do_task(self, task_list):
        """执行所有任务"""
        if not task_list:
            logger.info(f"{self.log_prefix} 未获取到任务列表")
            return

        cnt_done = 0
        skip_keywords = ['消费', '邀请', '微博', '苏宁易购', '开通会员']

        for task in task_list:
            title = task['title']
            task_id = task['task_id']
            status = task['task_status'] # 2=已完成

            if status == 2:
                continue
            
            if any(k in title for k in skip_keywords):
                logger.info(f"{self.log_prefix} 跳过任务: {title}")
                continue

            # 开始处理
            logger.info(f"{self.log_prefix} 执行任务: {title}")
            
            if '浏览' in title:
                # 1. Start Task
                res = self._task_action(task_id, "task_center.start")
                if res and res.get('result') == 'ok':
                    token = res['data']['task_center'].get('token')
                    if token:
                        # 2. Get Info (Wait time)
                        tag = self._get_browse_task_info(token)
                        if tag:
                            Utils.random_sleep(11, 13) # 模拟浏览
                            # 3. Finish Task
                            if self._finish_browse_task(token, tag):
                                Utils.random_sleep(1, 2)
                                # 4. Reward
                                rew = self._task_action(task_id, "task_center.reward")
                                if rew and rew.get('result') == 'ok' and rew['data']['task_center']['success']:
                                    logger.success(f"{self.log_prefix} 完成浏览任务: {title}")
                                    cnt_done += 1
                                    continue
            else:
                # 普通任务: Finish -> Reward
                res = self._task_action(task_id, "task_center.finish")
                if res and res.get('result') == 'ok' and res['data']['task_center']['success']:
                    Utils.random_sleep(1, 2)
                    rew = self._task_action(task_id, "task_center.reward")
                    if rew and rew.get('result') == 'ok' and rew['data']['task_center']['success']:
                        logger.success(f"{self.log_prefix} 完成任务: {title}")
                        cnt_done += 1
                        continue
            
            Utils.random_sleep(1.5, 3)

        self.result_summary["modules"]["task_center"]["task"] = cnt_done
        self.result_summary["task_total"] += cnt_done

    def run_lottery(self, times):
        """抽奖逻辑"""
        headers = {'x-act-csrf-token': self.csrf}
        payload = {
            'component_uniq_number': {
                'activity_number': 'HD2025031821201822',
                'page_number': 'YM2025040908558269',
                'component_number': 'ZJ2025092916516585',
                'component_node_id': 'FN1762345949vdR1'
            },
            'component_type': 45,
            'component_action': 'lottery_v2.exec',
            'lottery_v2': {'session_id': 2}
        }
        
        success_rewards = []
        safe_guard = 0
        
        while times > 0 and safe_guard < 10:
            safe_guard += 1
            Utils.random_sleep(2, 4)
            
            resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
            if not resp: break
            
            res = resp.json()
            if res.get('result') == 'ok':
                name = res['data']['lottery_v2']['reward_name']
                logger.success(f"{self.log_prefix} 抽奖获得: {name}")
                if name: success_rewards.append(name)
            else:
                break
            
            # 刷新次数
            info = self.get_info()
            if info:
                times = info['times']
                # 更新最终积分
                self.result_summary["score"] = info['score']
            else:
                break

        self.result_summary["modules"]["task_center"]["lottery"] = len(success_rewards)
        self.result_summary["lottery_total"] += len(success_rewards)

    # ============== 天天领福利 ===============
    def fragment_collect_sign_in(self):
        """天天领福利签到"""
        headers = {
            'content-type': 'application/json',
            'x-act-csrf-token': self.csrf,
            'origin': 'https://personal-act.wps.cn',
            'referer': 'https://personal-act.wps.cn/rubik2/portal/HD2025031721339450/YM2025031721331326?cs_from=ad_ucsty_rwzx&position=ad_ucsty_rwzx',
        }
        sign_date = datetime.now().strftime("%Y-%m-%d")
        payload = {
            'component_uniq_number': {
                'activity_number': 'HD2025031721339450',
                'page_number': 'YM2025031721331326',
                'component_number': 'ZJ2025061815363325',
                'component_node_id': 'FN1750234948dBVL',
                'filter_params': {'cs_from': 'ad_ucsty_rwzx', 'position': 'ad_ucsty_rwzx'},
            },
            'component_type': 42,
            'component_action': 'fragment_collect.sign_in',
            'fragment_collect': {'sign_date': sign_date, 'series_id': '', 'is_new_sign_series': True},
        }
        try:
            resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
            if not resp: return False
            data = resp.json()
            if data.get('result') == 'ok':
                success = data['data']['fragment_collect']['success']
                reason = data['data']['fragment_collect']['reason']
                if success:
                    logger.success(f"{self.log_prefix} 天天领福利签到成功: {reason}")
                    self.result_summary["modules"]["fragment"]["sign"] = True
                    self.result_summary["sign_total"] += 1
                    return True
                else:
                    logger.info(f"{self.log_prefix} 天天领福利签到: {reason}")
                    return False
            msg = data.get('msg', '')
            if 'Duplicate entry' in msg:
                logger.info(f"{self.log_prefix} 天天领福利今日已签到")
                self.result_summary["modules"]["fragment"]["sign"] = True
                self.result_summary["sign_total"] += 1
            else:
                logger.error(f"{self.log_prefix} 天天领福利签到失败: {msg}")
            return False
        except Exception as e:
            logger.error(f"{self.log_prefix} 天天领福利签到异常: {e}")
            return False

    def get_lottery3_info(self):
        """获取天天领福利抽奖次数"""
        try:
            resp = self.request('GET', 'https://personal-act.wps.cn/activity-rubik/activity/page_info?activity_number=HD2025031721339450&page_number=YM2025031721331326&filter_params=%7B%22cs_from%22:%22ad_ucsty_rwzx%22,%22position%22:%22ad_ucsty_rwzx%22%7D')
            if not resp: return 0
            data = resp.json()
            if data.get('result') == 'ok':
                for item in data['data']:
                    if item.get('lottery_v2'):
                        for session in item['lottery_v2'].get('lottery_list', []):
                            if session.get('times'):
                                return session['times']
            return 0
        except:
            return 0

    def run_lottery3(self, times):
        """天天领福利抽奖"""
        headers = {'x-act-csrf-token': self.csrf, 'content-type': 'application/json'}
        payload = {
            'component_uniq_number': {
                'activity_number': 'HD2025031721339450',
                'page_number': 'YM2025031721331326',
                'component_number': 'ZJ2025092916515917',
                'component_node_id': 'FN1761875116m2x8',
                'filter_params': {'cs_from': 'ad_ucsty_rwzx', 'position': 'ad_ucsty_rwzx'},
            },
            'component_type': 45,
            'component_action': 'lottery_v2.exec',
            'lottery_v2': {'session_id': 3001},
        }
        lottery_count = 0
        for i in range(times):
            Utils.random_sleep(2, 4)
            resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
            if not resp: break
            res = resp.json()
            if res.get('result') == 'ok':
                name = res['data']['lottery_v2']['reward_name']
                logger.success(f"{self.log_prefix} 天天领福利抽奖获得: {name}")
                lottery_count += 1
            else:
                logger.error(f"{self.log_prefix} 天天领福利抽奖失败: {res.get('msg')}")
                break
        self.result_summary["modules"]["fragment"]["lottery"] = lottery_count
        self.result_summary["lottery_total"] += lottery_count

    # ============== 办公助手 ===============
    def get_assistant_info(self):
        """获取办公助手任务列表和抽奖次数"""
        try:
            resp = self.request('GET', 'https://personal-act.wps.cn/activity-rubik/activity/page_info?activity_number=HD2025031010408781&page_number=YM2025061216463517&filter_params=%7B%22cs_from%22:%22xinchao_activity_lottery%22,%22position%22:%22xinchao_bgzs_autoreply_2148_cj%22%7D')
            if not resp: return None
            data = resp.json()
            task_list, lottery_times = None, 0
            for item in data.get('data', []):
                if 'task_center' in item and 'task_list' in item['task_center']:
                    task_list = item['task_center']['task_list']
                if 'lottery' in item and item['lottery']:
                    lottery = item['lottery']
                    if lottery.get('rewards') and len(lottery['rewards']) > 0:
                        lottery_times = lottery['rewards'][0].get('times', 0)
            return {'task_list': task_list, 'lottery_times': lottery_times}
        except:
            return None

    def do_assistant_task(self, task_list):
        """执行办公助手任务"""
        if not task_list: return
        headers = {'content-type': 'application/json'}
        task_done = 0
        for task in task_list:
            task_id = task['task_id']
            title = task['title']
            status = task.get('task_status', 0)
            if status == 1:
                continue
            # 领取奖励
            payload = {
                'component_uniq_number': {
                    'activity_number': 'HD2025031010408781',
                    'page_number': 'YM2025061216463517',
                    'component_number': 'ZJ2024083022083755',
                    'component_node_id': 'FN1740387182DaYX',
                },
                'component_type': 14,
                'component_action': 'task_center.reward',
                'task_center': {'task_id': task_id},
            }
            try:
                resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
                if resp and resp.json().get('result') == 'ok':
                    task_center = resp.json()['data']['task_center']
                    if task_center['success']:
                        logger.success(f"{self.log_prefix} 办公助手领取 [{title}] 成功")
                        task_done += 1
                    else:
                        logger.info(f"{self.log_prefix} 办公助手 [{title}]: {task_center.get('reason')}")
            except:
                pass
            Utils.random_sleep(1, 2)
        self.result_summary["modules"]["assistant"]["task"] = task_done
        self.result_summary["task_total"] += task_done

    def run_assistant_lottery(self, times):
        """办公助手抽奖"""
        headers = {'content-type': 'application/json'}
        payload = {
            'component_uniq_number': {
                'activity_number': 'HD2025031010408781',
                'page_number': 'YM2025061216463517',
                'component_number': 'ZJ2024083022081230',
                'component_node_id': 'FN1741940010rC4c',
            },
            'component_type': 2,
            'component_action': 'lottery.exec',
            'lottery': {
                'pay_source': '', 'integral_source': '', 'position': 'bgzs_tasks_cj',
                'source': '', 'ids': '1115,1119,1116,1117,1120,1121,1122,1118', 'sign': ''
            },
        }
        lottery_count = 0
        for i in range(times):
            Utils.random_sleep(2, 4)
            resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
            if not resp: break
            res = resp.json()
            if res.get('result') == 'ok':
                name = res['data']['lottery']['name']
                logger.success(f"{self.log_prefix} 办公助手抽奖获得: {name}")
                lottery_count += 1
            else:
                logger.error(f"{self.log_prefix} 办公助手抽奖失败: {res.get('msg')}")
                break
        self.result_summary["modules"]["assistant"]["lottery"] = lottery_count
        self.result_summary["lottery_total"] += lottery_count


    # ============== WPS任务中心新版任务页（补充任务） ===============
    # 来源：任务中心新版页面 YM2025031821202008，仅处理 allowlist 中的补充任务，避免误做邀请/消费/认证类任务。
    PC_TASK_PAGE_URL = 'https://personal-act.wps.cn/activity-rubik/activity/page_info?activity_number=HD2025031821201822&page_number=YM2025031821202008&filter_params=%7B%22cs_from%22:%22web_vipcenter_banner_inpublic%22,%22mk_key%22:%22JkVKmMVj6h1ZuPwEIlZmVef5hIIZ0Em91FRo%22,%22position%22:%22pc_aty_ban3_kaixue_test_b%22%7D'
    PC_TASK_ACTIVITY = 'HD2025031821201822'
    PC_TASK_PAGE = 'YM2025031821202008'
    PC_TASK_COMPONENT = 'ZJ2025031817022062'
    PC_TASK_NODE = 'FN1741233669OAvA'
    PC_LOTTERY_COMPONENT = 'ZJ2025092916515917'
    PC_LOTTERY_NODE = 'FN1762345906XgXt'
    PC_LOTTERY_SESSION_ID = 2
    PC_EXTRA_TASK_TITLES = {
        '体验1次AI功能',
        '逛一逛WPS挑战计划',
        '去体验高效备考',
        '完成1次PDF转换',
        '完成1次合并文档',
        '体验1次图片转文字',
        '体验1次图片转PDF',
    }

    def get_pc_task_center_info(self):
        """获取新版 WPS 任务中心任务列表、积分和抽奖次数。"""
        headers = {
            'origin': 'https://personal-act.wps.cn',
            'referer': 'https://personal-act.wps.cn/rubik2/portal/HD2025031821201822/YM2025031821202008?cs_from=web_vipcenter_banner_inpublic&mk_key=JkVKmMVj6h1ZuPwEIlZmVef5hIIZ0Em91FRo&position=pc_aty_ban3_kaixue_test_b',
        }
        resp = self.request('GET', self.PC_TASK_PAGE_URL, headers=headers)
        if not resp:
            return None
        try:
            data = resp.json()
            if data.get('result') != 'ok':
                return None

            info = {"times": 0, "score": self.result_summary.get("score", "未知"), "task_list": []}
            for item in data.get('data', []):
                if item.get('task_center'):
                    info['task_list'] = item['task_center'].get('task_list', [])
                if item.get('task_center_user_info'):
                    info['score'] = item['task_center_user_info'].get('integral', info['score'])
                elif item.get('integral_waterfall'):
                    info['score'] = item['integral_waterfall'].get('user_integral', info['score'])
                if item.get('lottery_v2'):
                    for session in item['lottery_v2'].get('lottery_list', []):
                        if session.get('session_id') == self.PC_LOTTERY_SESSION_ID:
                            info['times'] = session.get('times', 0)
            return info
        except Exception as e:
            logger.error(f"{self.log_prefix} 新版任务中心信息解析异常: {e}")
            return None

    def _pc_task_action(self, task_id, action_type="task_center.finish"):
        """新版任务中心通用任务动作接口。"""
        headers = {
            'content-type': 'application/json',
            'x-act-csrf-token': self.csrf,
            'origin': 'https://personal-act.wps.cn',
        }
        payload = {
            'component_uniq_number': {
                'activity_number': self.PC_TASK_ACTIVITY,
                'page_number': self.PC_TASK_PAGE,
                'component_number': self.PC_TASK_COMPONENT,
                'component_node_id': self.PC_TASK_NODE,
                'filter_params': {
                    'cs_from': 'web_vipcenter_banner_inpublic',
                    'mk_key': 'JkVKmMVj6h1ZuPwEIlZmVef5hIIZ0Em91FRo',
                    'position': 'pc_aty_ban3_kaixue_test_b',
                },
            },
            'component_type': 35,
            'component_action': action_type,
            'task_center': {'task_id': task_id},
        }
        resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
        try:
            return resp.json() if resp else None
        except Exception:
            return None

    @staticmethod
    def _task_center_success(res):
        """兼容不同返回格式，判断 task_center 动作是否成功。"""
        if not res or res.get('result') != 'ok':
            return False
        task_center = res.get('data', {}).get('task_center', {})
        return bool(task_center.get('success', True))

    def do_pc_task_center_tasks(self, task_list):
        """执行文件中要求新增的 7 个 WPS 新版任务中心任务。"""
        if not task_list:
            logger.info(f"{self.log_prefix} 新版任务中心未获取到任务列表")
            return

        cnt_done = 0
        for task in task_list:
            title = task.get('title', '')
            task_id = task.get('task_id')
            status = task.get('task_status', 0)
            event = task.get('task_event', '')

            if title not in self.PC_EXTRA_TASK_TITLES:
                continue
            if status == 2:
                logger.info(f"{self.log_prefix} 新版任务中心已完成，跳过: {title}")
                continue
            if not task_id:
                continue

            logger.info(f"{self.log_prefix} 新版任务中心执行任务: {title} ({event})")

            ok = False
            # 浏览类任务仍走 start -> task_info -> task_finish -> reward；本次新增任务主要是 click / func_exp。
            if event == 'browse' or '浏览' in title:
                res = self._pc_task_action(task_id, "task_center.start")
                if self._task_center_success(res):
                    token = res.get('data', {}).get('task_center', {}).get('token')
                    if token:
                        batch_tag = self._get_browse_task_info(token)
                        if batch_tag:
                            Utils.random_sleep(11, 13)
                            ok = self._finish_browse_task(token, batch_tag)
            else:
                res = self._pc_task_action(task_id, "task_center.finish")
                ok = self._task_center_success(res)

            Utils.random_sleep(1, 2)
            rew = self._pc_task_action(task_id, "task_center.reward")
            if self._task_center_success(rew):
                logger.success(f"{self.log_prefix} 新版任务中心完成并领取奖励: {title}")
                cnt_done += 1
            else:
                reason = ''
                if rew:
                    reason = rew.get('msg') or rew.get('data', {}).get('task_center', {}).get('reason', '')
                if ok:
                    logger.info(f"{self.log_prefix} 新版任务中心任务已提交，领奖未确认: {title} {reason}")
                else:
                    logger.warning(f"{self.log_prefix} 新版任务中心任务未完成: {title} {reason}")

            Utils.random_sleep(1.5, 3)

        self.result_summary["modules"]["pc_task_center"]["task"] = cnt_done
        self.result_summary["task_total"] += cnt_done

    def run_pc_task_center_lottery(self, times):
        """执行新版任务中心抽奖。"""
        headers = {
            'content-type': 'application/json',
            'x-act-csrf-token': self.csrf,
            'origin': 'https://personal-act.wps.cn',
        }
        payload = {
            'component_uniq_number': {
                'activity_number': self.PC_TASK_ACTIVITY,
                'page_number': self.PC_TASK_PAGE,
                'component_number': self.PC_LOTTERY_COMPONENT,
                'component_node_id': self.PC_LOTTERY_NODE,
                'filter_params': {
                    'cs_from': 'web_vipcenter_banner_inpublic',
                    'mk_key': 'JkVKmMVj6h1ZuPwEIlZmVef5hIIZ0Em91FRo',
                    'position': 'pc_aty_ban3_kaixue_test_b',
                },
            },
            'component_type': 45,
            'component_action': 'lottery_v2.exec',
            'lottery_v2': {'session_id': self.PC_LOTTERY_SESSION_ID},
        }

        lottery_count = 0
        safe_guard = 0
        while times > 0 and safe_guard < 10:
            safe_guard += 1
            Utils.random_sleep(2, 4)
            resp = self.request('POST', 'https://personal-act.wps.cn/activity-rubik/activity/component_action', headers=headers, json=payload)
            if not resp:
                break
            try:
                res = resp.json()
            except Exception:
                break

            if res.get('result') == 'ok':
                name = res.get('data', {}).get('lottery_v2', {}).get('reward_name', '')
                logger.success(f"{self.log_prefix} 新版任务中心抽奖获得: {name}")
                lottery_count += 1
            else:
                logger.info(f"{self.log_prefix} 新版任务中心抽奖结束: {res.get('msg')}")
                break

            info = self.get_pc_task_center_info()
            if info:
                times = info.get('times', 0)
                self.result_summary["score"] = info.get('score', self.result_summary.get("score", "未知"))
            else:
                break

        self.result_summary["modules"]["pc_task_center"]["lottery"] = lottery_count
        self.result_summary["lottery_total"] += lottery_count

    # ============== 小程序签到 ===============
    def applet_sign(self):
        """WPS超级会员小程序签到"""
        s_key = '06196ab4da15c09a3aaee610162ca56f'
        try:
            resp = self.request('GET', 'https://personal-bus.wps.cn/activity/clock_in/v1/info')
            if resp and resp.status_code == 200:
                data = resp.json()
                s_key = data.get('data', {}).get('s_key', s_key)
        except:
            pass
        
        ss = '7908b285f33c837d'
        json_data = {'client_type': 1}
        signature, utc_time = generate_sign(json_data, s_key, ss)
        
        # 小程序签到需要特殊 headers，使用独立请求
        headers = {
            'signature': signature,
            'Date': utc_time,
            'x-csrftoken': '1234567890',
            'content-type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 MicroMessenger/8.0.49.2600',
            'Referer': 'https://servicewechat.com/wx2f333d84a103825d/240/page-frame.html',
            'Cookie': '; '.join([f'{k}={v}' for k, v in self.cookie_dict.items()]),
        }
        try:
            resp = requests.post(
                'https://personal-bus.wps.cn/activity/clock_in/v1/clock_in',
                headers=headers,
                json=json_data,
                timeout=10,
                verify=False
            )
            if resp.status_code != 200:
                logger.warning(f"{self.log_prefix} 小程序签到失败: {resp.status_code}")
                return False
                
            data = resp.json()
            result = data.get('result', '')
            msg = data.get('msg', '')
            
            # 签到成功
            if result == 'ok':
                logger.success(f"{self.log_prefix} 小程序签到成功")
                self.result_summary["modules"]["applet"]["sign"] = True
                self.result_summary["sign_total"] += 1
                return True
            
            # 已签到（多种可能的返回格式）
            if 'clocked' in msg.lower() or '已签到' in msg or '已打卡' in msg:
                logger.info(f"{self.log_prefix} 小程序今日已签到")
                self.result_summary["modules"]["applet"]["sign"] = True
                self.result_summary["sign_total"] += 1
                return True
            
            # 其他情况记录完整响应
            logger.warning(f"{self.log_prefix} 小程序签到未知结果: {data}")
            return False
        except Exception as e:
            logger.error(f"{self.log_prefix} 小程序签到异常: {e}")
            return False

    def run(self):
        """单账号执行入口"""
        try:
            logger.info(f"{self.log_prefix} 开始执行任务...")
            
            # ============== 1. WPS任务中心 ==============
            if CFG_MODULES.get('task_center', True):
                logger.info(f"{self.log_prefix} [WPS任务中心] 开始执行...")
                info = self.get_info()
                if not info:
                    logger.error(f"{self.log_prefix} 无法获取用户信息，Cookie可能失效")
                    self.result_summary["status"] = "❌ 无效"
                    return self.result_summary
                
                logger.info(f"{self.log_prefix} 初始积分: {info['score']}, 抽奖次数: {info['times']}")
                
                # 签到
                key = self.get_public_key()
                if key:
                    self.sign_in(key)
                    Utils.random_sleep(2, 4)
                
                # 任务
                if info.get('task_list'):
                    self.do_task(info['task_list'])
                Utils.random_sleep(2, 4)
                
                # 抽奖
                info = self.get_info()
                if info:
                    self.run_lottery(info['times'])
                    self.result_summary["score"] = info['score']
                
                logger.info(f"{self.log_prefix} [WPS任务中心] 执行完成")
            

            # ============== 1.1 WPS任务中心新版任务页（补充任务） ==============
            if CFG_MODULES.get('pc_task_center', True):
                logger.info(f"{self.log_prefix} [WPS任务中心新版任务页] 开始执行...")
                Utils.random_sleep(1, 2)
                pc_info = self.get_pc_task_center_info()
                if pc_info:
                    logger.info(f"{self.log_prefix} 新版任务中心积分: {pc_info.get('score')}, 抽奖次数: {pc_info.get('times')}")
                    if pc_info.get('task_list'):
                        self.do_pc_task_center_tasks(pc_info['task_list'])
                    Utils.random_sleep(2, 4)
                    pc_info = self.get_pc_task_center_info()
                    if pc_info:
                        self.result_summary["score"] = pc_info.get('score', self.result_summary.get("score", "未知"))
                        if pc_info.get('times', 0) > 0:
                            self.run_pc_task_center_lottery(pc_info['times'])
                else:
                    logger.warning(f"{self.log_prefix} 新版任务中心信息获取失败，跳过补充任务")
                logger.info(f"{self.log_prefix} [WPS任务中心新版任务页] 执行完成")
            
            # ============== 2. 天天领福利 ==============
            if CFG_MODULES.get('fragment_collect', True):
                logger.info(f"{self.log_prefix} [天天领福利] 开始执行...")
                Utils.random_sleep(1, 2)
                
                # 签到
                self.fragment_collect_sign_in()
                Utils.random_sleep(1, 2)
                
                # 抽奖
                lottery3_times = self.get_lottery3_info()
                if lottery3_times > 0:
                    self.run_lottery3(lottery3_times)
                
                logger.info(f"{self.log_prefix} [天天领福利] 执行完成")
            
            # ============== 3. 办公助手 ==============
            if CFG_MODULES.get('assistant', True):
                logger.info(f"{self.log_prefix} [办公助手] 开始执行...")
                Utils.random_sleep(1, 2)
                
                assistant_info = self.get_assistant_info()
                if assistant_info:
                    # 任务
                    if assistant_info.get('task_list'):
                        self.do_assistant_task(assistant_info['task_list'])
                    Utils.random_sleep(1, 2)
                    
                    # 抽奖
                    assistant_info = self.get_assistant_info()  # 刷新次数
                    if assistant_info and assistant_info.get('lottery_times', 0) > 0:
                        self.run_assistant_lottery(assistant_info['lottery_times'])
                
                logger.info(f"{self.log_prefix} [办公助手] 执行完成")
            
            # ============== 4. 小程序签到 ==============
            if CFG_MODULES.get('svip_applet', True):
                logger.info(f"{self.log_prefix} [小程序签到] 开始执行...")
                Utils.random_sleep(1, 2)
                self.applet_sign()
                logger.info(f"{self.log_prefix} [小程序签到] 执行完成")
            
            self.result_summary["status"] = "✅ 正常"
            logger.info(f"{self.log_prefix} 全部任务执行结束")
            return self.result_summary

        except Exception as e:
            logger.error(f"{self.log_prefix} 运行崩溃: {e}")
            self.result_summary["status"] = "❌ 异常"
            return self.result_summary

# ---------------- 主程序 ----------------

def process_user_task(user_info):
    """线程池调用的包装函数"""
    idx, data = user_info
    
    # 1. 获取代理 (如果有配置)
    proxies = None
    if CFG_PROXY_API:
        proxies = ProxyManager.get_valid_proxy(CFG_PROXY_API)
        if not proxies:
            # 构建一个基础的失败结果，方便表格显示
            raw_name = data.get('username', f'User_{idx}')
            uid_guess = Utils.parse_cookie_str(data.get('cookie')).get('uid', '?')
            masked = Utils.mask_uid(uid_guess)
            name = f"{raw_name}({masked})"
            
            logger.error(f"[{name}] 获取代理失败，跳过执行以保安全")
            return {
                "name": name, "sign": "-", "task": "-", 
                "lottery": "-", "score": "-", "status": "🚫 跳过"
            }
    
    # 2. 实例化并执行
    bot = WPSUser(idx, data, proxies)
    return bot.run()

def print_summary_table(results):
    """打印漂亮的汇总表格"""
    if not results: return
    
    print("\n" + "="*80)
    print(f"{'账号':<20} {'签到':<10} {'任务':<8} {'抽奖':<12} {'积分':<6} {'状态':<6}")
    print("-" * 80)
    
    msg_lines = []
    detail_lines = []  # 模块明细
    
    for r in results:
        # 截断过长的名字
        name = r['name']
        if len(name) > 18: name = name[:18]
        
        # 兼容旧格式（代理失败等情况）
        if 'sign_total' not in r:
            print(f"{name:<20} {r.get('sign','-'):<10} {r.get('task','-'):<8} {r.get('lottery','-'):<12} {str(r.get('score','-')):<6} {r.get('status','-'):<6}")
            msg_lines.append(f"👤 {r['name']} | {r.get('status','-')}")
            continue
        
        # 新格式统计
        sign_str = f"{r['sign_total']}/{r['sign_count']}签"
        task_str = f"{r['task_total']}个"
        lottery_str = f"{r['lottery_total']}次"
        score_str = str(r.get('score', '-'))
        status_str = r.get('status', '-')
        
        # 打印到控制台
        print(f"{name:<20} {sign_str:<10} {task_str:<8} {lottery_str:<12} {score_str:<6} {status_str:<6}")
        
        # 构建推送消息
        line = f"👤 {r['name']} | 📅 {sign_str} | 🎁 {lottery_str} | 💰 {score_str}"
        msg_lines.append(line)
        
        # 构建模块明细
        m = r.get('modules', {})
        tc = m.get('task_center', {})
        fg = m.get('fragment', {})
        at = m.get('assistant', {})
        pc = m.get('pc_task_center', {})
        ap = m.get('applet', {})
        
        detail = f"\n📊 {r['name']} 模块明细:"
        detail += f"\n  - WPS任务中心: {'✅签到' if tc.get('sign') else '❌签到'} | {tc.get('task',0)}任务 | {tc.get('lottery',0)}抽奖"
        detail += f"\n  - 天天领福利: {'✅签到' if fg.get('sign') else '❌签到'} | {fg.get('lottery',0)}抽奖"
        detail += f"\n  - 办公助手: {at.get('task',0)}任务 | {at.get('lottery',0)}抽奖"
        detail += f"\n  - WPS新版任务中心: {pc.get('task',0)}任务 | {pc.get('lottery',0)}抽奖"
        detail += f"\n  - 小程序: {'✅签到' if ap.get('sign') else '❌签到'}"
        detail_lines.append(detail)
        
    print("="*80)
    
    # 打印模块明细
    for d in detail_lines:
        print(d)
    print()
    
    # 推送消息包含明细
    return "\n".join(msg_lines) + "\n" + "\n".join(detail_lines)

def main():
    # 1. 读取环境
    env_ck = os.getenv('WPS_TASK_CK', '')
    if not env_ck:
        logger.error("未找到环境变量 WPS_TASK_CK")
        return

    users = []
    for line in env_ck.split('\n'):
        if not line.strip(): continue
        # 支持多种分隔符
        if '#' in line:
            parts = line.split('#')
        elif '&' in line:
            parts = line.split('&')
        else:
            parts = [line]
            
        if len(parts) >= 2:
            users.append({'username': parts[0].strip(), 'cookie': parts[1].strip()})
        else:
             # 兼容只有cookie的情况
            users.append({'username': f"User_{len(users)+1}", 'cookie': line.strip()})

    count = len(users)
    logger.info(f"共加载 {count} 个账号，并发线程: {CFG_THREADS}")
    
    if CFG_PROXY_API:
        logger.info(f"代理模式已开启: {CFG_PROXY_API[:30]}...")
    else:
        logger.warning("未配置代理API，将使用本机IP直连 (高并发风险)")

    # 2. 启动随机延时
    if CFG_START_DELAY > 0:
        delay = random.randint(1, CFG_START_DELAY)
        logger.info(f"随机启动延时: {delay}秒...")
        time.sleep(delay)

    # 3. 线程池并发执行
    results = []
    task_args = list(enumerate(users, 1))
    
    with ThreadPoolExecutor(max_workers=CFG_THREADS) as executor:
        future_to_user = {executor.submit(process_user_task, arg): arg for arg in task_args}
        
        for future in as_completed(future_to_user):
            try:
                res = future.result()
                results.append(res)
            except Exception as exc:
                logger.error(f"线程执行异常: {exc}")

    # 4. 汇总与推送
    # 尝试按账号顺序简单排序 (可选优化)
    # results.sort(key=lambda x: x['name'])
    
    notify_content = print_summary_table(results)
    
    if send_notify and notify_content:
        send_notify("WPS每日任务PRO", notify_content)
    elif not send_notify:
        logger.info("未配置推送，跳过")
    else:
        logger.info("无有效结果，跳过推送")

if __name__ == '__main__':
    main()
