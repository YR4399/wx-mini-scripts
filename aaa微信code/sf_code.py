"""
顺丰速运积分任务脚本 - 微信code登录版（优化版）
功能：自动完成顺丰速运小程序每日签到、积分任务领取与奖励兑换
版本：1.4.0
更新日期：2026-06-17

优化内容：
- 模拟访问任务跳转链接，提高任务完成率
- 支持自动兑换积分礼品（若积分足够）
- 增强重试与代理切换，提升稳定性
- 细化任务状态处理，减少遗漏
"""
import hashlib
import json
import os
import random
import re
import time
from datetime import datetime
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass
from urllib.parse import unquote, urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# ==================== 全局配置常量 ====================
PROXY_TIMEOUT = 15
MAX_PROXY_RETRIES = 8
REQUEST_RETRY_COUNT = 3

CONCURRENT_NUM = int(os.getenv('SFBF', '1'))
if CONCURRENT_NUM > 20:
    CONCURRENT_NUM = 20
    print(f'并发数量超过最大值20，已自动调整为20')
elif CONCURRENT_NUM < 1:
    CONCURRENT_NUM = 1
    print(f'并发数量小于1，已自动调整为1（串行模式）')
print_lock = Lock()

# 微信登录配置
WX_SERVER_URL = os.getenv('wx_server_url', '')
WX_AUTH = os.getenv('wx_auth', '')
SF_APPID = 'wxd4185d00bf7e08ac'
SF_PUBLIC_ID = 'gh_f9d9fca26a50'
CHANNEL = '26duanwutanchuang4'
PLATFORM = 'MINI_PROGRAM'


# ==================== 配置类 ====================
@dataclass
class Config:
    APP_NAME: str = "顺丰速运"
    VERSION: str = "1.4.0"
    PROXY_API_URL: str = os.getenv('SF_PROXY_API_URL', '')

    PROXY_TIMEOUT = 15
    MAX_PROXY_RETRIES = 8
    REQUEST_RETRY_COUNT = 3

    TOKEN: str = 'wwesldfs29aniversaryvdld29'
    SYS_CODE: str = 'MCS-MIMP-CORE'

    SKIP_TASKS: List[str] = None

    def __post_init__(self):
        if self.SKIP_TASKS is None:
            # 仅保留绝对无法自动完成的任务
            self.SKIP_TASKS = [
                '用行业模板寄件下单',  # 需手动填写寄件信息
                '每月累计寄件',        # 需真实寄件记录
                '完成每月任务',        # 月任务依赖其他完成情况
                '参与积分活动'         # 活动页面需手动操作
            ]


# ==================== 日志系统 ====================
class Logger:
    ICONS = {
        'task_found': '🎯',
        'task_skip': '⏭️',
        'task_complete': '✅',
        'reward_get': '🎁',
        'info': '📝',
        'success': '✨',
        'error': '❌',
        'warning': '⚠️',
        'user': '👤',
        'money': '💰',
    }

    def __init__(self):
        self.messages: List[str] = []
        self.current_account_msg: List[str] = []
        self.lock = Lock()

    def _format_msg(self, icon: str, content: str) -> str:
        return f"{icon} {content}"

    def _safe_print(self, msg: str):
        with print_lock:
            print(msg)

    def task_found(self, task_name: str, status: int = 2):
        msg = self._format_msg(self.ICONS['task_found'], f"发现任务: {task_name} (状态: {status})")
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def task_skip(self, task_name: str, reason: str = ""):
        msg = self._format_msg(self.ICONS['task_skip'], f"[{task_name}] 已跳过" + (f" ({reason})" if reason else ""))
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def task_complete(self, task_name: str):
        msg = self._format_msg(self.ICONS['task_complete'], f"[{task_name}] 提交成功")
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def reward_get(self, task_name: str):
        msg = self._format_msg(self.ICONS['reward_get'], f"[{task_name}] 奖励领取成功")
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def info(self, content: str):
        msg = self._format_msg(self.ICONS['info'], content)
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def success(self, content: str):
        msg = self._format_msg(self.ICONS['success'], content)
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def error(self, content: str):
        msg = self._format_msg(self.ICONS['error'], content)
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def warning(self, content: str):
        msg = self._format_msg(self.ICONS['warning'], content)
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def user_info(self, account_index: int, mobile: str):
        msg = self._format_msg(self.ICONS['user'], f"账号{account_index}: 【{mobile}】登录成功")
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def points_info(self, points: int, prefix: str = "当前积分"):
        msg = self._format_msg(self.ICONS['money'], f"{prefix}: 【{points}】")
        self._safe_print(msg)
        with self.lock:
            self.current_account_msg.append(msg)
            self.messages.append(msg)

    def reset_account_msg(self):
        self.current_account_msg = []

    def get_all_messages(self) -> str:
        return '\n'.join(self.messages)

    def get_account_messages(self) -> str:
        return '\n'.join(self.current_account_msg)


# ==================== 微信服务端客户端 ====================
class WechatServerClient:
    def __init__(self, server_url: str, auth_code: str):
        self.server_url = server_url.rstrip('/')
        self.auth_code = auth_code
        self.session = requests.Session()

    def get_wxcode(self, appid: str, openid: str) -> Optional[str]:
        url = f"{self.server_url}/wx/code"
        headers = {'Content-Type': 'application/json', 'auth': self.auth_code}
        data = {'appid': appid, 'openid': openid}
        try:
            resp = self.session.post(url, headers=headers, json=data, timeout=30)
            result = resp.json()
            if result.get('status'):
                return result.get('data', {}).get('code')
            return None
        except Exception:
            return None


# ==================== 代理管理器 ====================
class ProxyManager:
    def __init__(self, api_url: str):
        self.api_url = api_url
        self.logger = Logger()

    def get_proxy(self) -> Optional[Dict[str, str]]:
        try:
            if not self.api_url:
                return None

            response = requests.get(self.api_url, timeout=10)
            if response.status_code == 200:
                proxy_text = response.text.strip()
                if ':' in proxy_text:
                    if proxy_text.startswith('http://') or proxy_text.startswith('https://'):
                        proxy = proxy_text
                    else:
                        proxy = f'http://{proxy_text}'
                    return {'http': proxy, 'https': proxy}
            return None
        except Exception:
            return None


# ==================== HTTP客户端 ====================
class SFHttpClient:
    def __init__(self, config: Config, proxy_manager: ProxyManager):
        self.config = config
        self.proxy_manager = proxy_manager
        self.session = requests.Session()
        self.session.verify = False

        proxy = self.proxy_manager.get_proxy()
        if proxy:
            self.session.proxies = proxy

        self.headers = {
            'Host': 'mcs-mimp-web.sf-express.com',
            'upgrade-insecure-requests': '1',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat XWEB/6945 Flue',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-user': '?1',
            'sec-fetch-dest': 'document',
            'accept-language': 'zh-CN,zh',
            'platform': PLATFORM,
            'channel': CHANNEL,
        }

    def _generate_sign(self) -> Dict[str, str]:
        timestamp = str(int(round(time.time() * 1000)))
        data = f'token={self.config.TOKEN}&timestamp={timestamp}&sysCode={self.config.SYS_CODE}'
        signature = hashlib.md5(data.encode()).hexdigest()
        return {
            'sysCode': self.config.SYS_CODE,
            'timestamp': timestamp,
            'signature': signature
        }

    def request(
            self,
            url: str,
            method: str = 'POST',
            data: Optional[Dict] = None,
            max_retries: int = REQUEST_RETRY_COUNT
    ) -> Optional[Dict[str, Any]]:
        sign_data = self._generate_sign()
        self.headers.update(sign_data)

        retry_count = 0
        proxy_retry_count = 0

        while proxy_retry_count < MAX_PROXY_RETRIES:
            try:
                if retry_count >= 2:
                    new_proxy = self.proxy_manager.get_proxy()
                    if new_proxy:
                        self.session.proxies = new_proxy
                    retry_count = 0

                try:
                    if method.upper() == 'GET':
                        response = self.session.get(url, headers=self.headers, timeout=PROXY_TIMEOUT)
                    elif method.upper() == 'POST':
                        response = self.session.post(url, headers=self.headers, json=data or {}, timeout=PROXY_TIMEOUT)
                    else:
                        raise ValueError(f'不支持的请求方法: {method}')

                    response.raise_for_status()

                    try:
                        res = response.json()
                        if res is None:
                            retry_count += 1
                            time.sleep(2)
                            continue
                        return res
                    except (json.JSONDecodeError, ValueError):
                        retry_count += 1
                        if retry_count < max_retries:
                            time.sleep(2)
                            continue
                        return None

                except requests.exceptions.RequestException:
                    retry_count += 1
                    if 'ProxyError' in str(Exception) or 'SSLError' in str(Exception):
                        proxy_retry_count += 1
                        if proxy_retry_count < MAX_PROXY_RETRIES:
                            new_proxy = self.proxy_manager.get_proxy()
                            if new_proxy:
                                self.session.proxies = new_proxy
                    time.sleep(2)
                    continue

            except Exception:
                proxy_retry_count += 1
                if proxy_retry_count < MAX_PROXY_RETRIES:
                    time.sleep(2)
                    continue
                else:
                    return None
        return None

    def login_by_wxcode(self, wxcode: str) -> Tuple[bool, str, str]:
        try:
            url = f'https://ucmp.sf-express.com/wxaccess/weixin/appOnLogin?code={wxcode}&publicId={SF_PUBLIC_ID}'
            resp = self.session.get(url, headers={
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15',
                'Content-Type': 'application/json'
            }, timeout=PROXY_TIMEOUT)
            result = resp.json()
            if not (result.get('sessionId') or result.get('unionid')):
                return (False, '', '')

            session_id = result.get('sessionId', '')
            activity_url = f'https://ucmp.sf-express.com/wechat-act3/weixin/activity/sfnewactivity?bizCode=%7B%22path%22%3A%22%2Forigin%2Fa%2Fmimp-activity%2FdragonBoat2026%22%2C%22supportShare%22%3A%22YES%22%2C%22from%22%3A%2226duanwutanchuang4%22%7D&citycode=021&cityname=&miniProgramAd=1&wxapp-version=V17.63&suuid={session_id}'

            activity_resp = self.session.get(activity_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF UnifiedPCWindowsWechat XWEB/19921 miniProgram/wxd4185d00bf7e08ac',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }, timeout=PROXY_TIMEOUT, allow_redirects=True)

            final_url = activity_resp.url
            user_id = ''
            phone = ''

            if 'userId=' in final_url:
                match = re.search(r'userId=([A-F0-9]+)', final_url)
                if match:
                    user_id = match.group(1)
                match = re.search(r'mobile=(\d+)\*\*\*\*(\d+)', final_url)
                if match:
                    phone = match.group(1) + '****' + match.group(2)

            self.session.cookies.set('_login_user_id_', user_id, domain='mcs-mimp-web.sf-express.com')
            self.session.cookies.set('_login_mobile_', phone, domain='mcs-mimp-web.sf-express.com')
            return (True, user_id, phone)
        except Exception:
            return (False, '', '')

    def login(self, url: str, timeout: int = PROXY_TIMEOUT) -> Tuple[bool, str, str]:
        try:
            decoded_input = unquote(url)
            if decoded_input.startswith('sessionId=') or '_login_mobile_=' in decoded_input:
                cookie_dict = {}
                for item in decoded_input.split(';'):
                    item = item.strip()
                    if '=' in item:
                        k, v = item.split('=', 1)
                        cookie_dict[k] = v
                for k, v in cookie_dict.items():
                    self.session.cookies.set(k, v, domain='mcs-mimp-web.sf-express.com')
                user_id = cookie_dict.get('_login_user_id_', '')
                phone = cookie_dict.get('_login_mobile_', '')
                if phone:
                    return True, user_id, phone
                else:
                    return False, '', ''
            else:
                decoded_url = unquote(url)
                self.session.get(decoded_url, headers=self.headers, timeout=timeout)
                cookies = self.session.cookies.get_dict()
                user_id = cookies.get('_login_user_id_', '')
                phone = cookies.get('_login_mobile_', '')
                if phone:
                    return True, user_id, phone
                else:
                    return False, '', ''
        except Exception:
            return False, '', ''


# ==================== 任务执行器 ====================
class TaskExecutor:
    def __init__(
            self,
            http_client: SFHttpClient,
            logger: Logger,
            config: Config,
            user_id: str
    ):
        self.http = http_client
        self.logger = logger
        self.config = config
        self.user_id = user_id
        self.total_points = 0

        self.taskId = ""
        self.taskCode = ""
        self.strategyId = ""
        self.title = ""
        self.point = 0
        self.button_redirect = ""

    @staticmethod
    def generate_device_id(characters: str = 'abcdef0123456789') -> str:
        result = ''
        for char in 'xxxxxxxx-xxxx-xxxx':
            if char == 'x':
                result += random.choice(characters)
            else:
                result += char
        return result

    def _extract_task_id_from_url(self, url: str) -> str:
        try:
            parsed = urlparse(url)
            params = parse_qs(parsed.query)

            if '_ug_view_param' in params:
                ug_params = json.loads(unquote(params['_ug_view_param'][0]))
                if 'taskId' in ug_params:
                    return str(ug_params['taskId'])

            if url.startswith('com.sf-express://'):
                json_str = url.split('_ug_view_param=')[1]
                ug_params = json.loads(unquote(json_str))
                if 'taskId' in ug_params:
                    return str(ug_params['taskId'])
        except Exception:
            pass
        return ''

    def _set_task_attrs(self, task: Dict) -> None:
        self.taskId = str(task.get('taskId', ''))
        self.taskCode = str(task.get('taskCode', ''))
        self.strategyId = int(task.get('strategyId', 0))
        self.title = str(task.get('title', '未知任务'))
        self.point = int(task.get('point', 0))
        self.button_redirect = task.get('buttonRedirect', '')

        if not self.taskCode and self.button_redirect:
            extracted_task_id = self._extract_task_id_from_url(self.button_redirect)
            if extracted_task_id:
                self.taskCode = extracted_task_id

    def _visit_task_url(self, url: str) -> bool:
        """模拟访问任务跳转链接，完成前置动作"""
        try:
            # 如果是小程序跳转链接，需要解析并执行相应操作
            if url.startswith('com.sf-express://'):
                # 提取参数，模拟打开小程序页面
                # 这里简单处理：仅记录访问，实际可能需要调用特定接口
                self.logger.info(f"模拟访问小程序链接: {url[:50]}...")
                # 有些任务只需访问即可，这里不做额外处理
                return True
            else:
                # 普通H5链接，直接GET访问
                resp = self.http.session.get(url, timeout=PROXY_TIMEOUT, allow_redirects=True)
                if resp.status_code == 200:
                    self.logger.info(f"访问任务链接成功")
                    return True
                else:
                    self.logger.warning(f"访问任务链接返回状态码: {resp.status_code}")
                    return False
        except Exception as e:
            self.logger.warning(f"访问任务链接异常: {str(e)}")
            return False

    def sign_in(self) -> Tuple[bool, str]:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralTaskSignPlusService~automaticSignFetchPackage'
        data = {"comeFrom": "vioin", "channelFrom": "WEIXIN"}

        response = self.http.request(url, data=data)
        if response and response.get('success'):
            count_day = response.get('obj', {}).get('countDay', 0)
            packet_list = response.get('obj', {}).get('integralTaskSignPackageVOList', [])

            if packet_list:
                packet_name = packet_list[0].get('packetName', '未知奖励')
                self.logger.success(f'小程序签到成功，获得【{packet_name}】，本周累计签到【{count_day + 1}】天')
            else:
                self.logger.info(f'今日已小程序签到，本周累计签到【{count_day + 1}】天')
            return True, ''
        else:
            error_msg = response.get('errorMessage', '未知错误') if response else '请求失败'
            self.logger.error(f'小程序签到失败: {error_msg}')
            return False, error_msg

    def new_sign_in(self) -> Tuple[bool, str]:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralSignV2Service~sign'
        data = {}

        original_platform = self.http.headers.get('platform', PLATFORM)
        self.http.headers['platform'] = 'SFAPP'

        try:
            response = self.http.request(url, data=data)
            if response and response.get('success'):
                obj = response.get('obj', {})
                signed = obj.get('signed', False)
                day_count = obj.get('dayCount', 0)
                award = obj.get('award', {})

                if signed and award:
                    gift_bag_name = award.get('giftBagName', '未知奖励')
                    self.logger.success(f'[新签到] 签到成功，连续第{day_count}天，获得【{gift_bag_name}】')
                elif signed:
                    self.logger.info(f'[新签到] 今日已签到，连续第{day_count}天')
                else:
                    self.logger.info(f'[新签到] 签到完成')
                return True, ''
            else:
                error_msg = response.get('errorMessage', '未知错误') if response else '请求失败'
                self.logger.error(f'[新签到] 失败: {error_msg}')
                return False, error_msg
        finally:
            self.http.headers['platform'] = original_platform

    def get_task_list(self) -> List[Dict]:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~queryPointTaskAndSignFromES'

        all_tasks = []
        task_codes_seen = set()

        for channel_type in ['1', '2', '3', '4', '01', '02', '03', '04']:
            data = {
                'channelType': channel_type,
                'deviceId': self.generate_device_id(),
            }

            response = self.http.request(url, data=data)

            if response and response.get('success') and response.get('obj'):
                if channel_type == '1':
                    self.total_points = response['obj'].get('totalPoint', 0)

                tasks = response['obj'].get('taskTitleLevels', [])

                for task in tasks:
                    task_code = task.get('taskCode')
                    task_title = task.get('title', '未知任务')

                    if 'buttonRedirect' in task:
                        extracted_id = self._extract_task_id_from_url(task['buttonRedirect'])
                        if extracted_id and not task_code:
                            task_code = extracted_id
                            task['taskCode'] = extracted_id

                    if not task_code and 'buttonRedirect' in task:
                        extracted_id = self._extract_task_id_from_url(task['buttonRedirect'])
                        if extracted_id:
                            task['taskCode'] = extracted_id
                            task_code = extracted_id

                    if not task_code:
                        continue

                    if task_code not in task_codes_seen:
                        task_codes_seen.add(task_code)
                        all_tasks.append(task)
        return all_tasks

    def execute_task(self) -> bool:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask'
        data = {'taskCode': self.taskCode}

        response = self.http.request(url, data=data)
        if response and response.get('success'):
            return True
        return False

    def _update_points(self):
        tasks = self.get_task_list()
        if tasks:
            self.logger.points_info(self.total_points, "当前积分")

    def receive_task_reward(self) -> bool:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~fetchIntegral'
        data = {
            "strategyId": self.strategyId,
            "taskId": self.taskId,
            "taskCode": self.taskCode,
            "deviceId": self.generate_device_id()
        }

        response = self.http.request(url, data=data)
        if response:
            if response.get('success'):
                self.logger.success(f'成功领取任务奖励: {self.title}')
                return True
        return False

    # ---------- 生活特权领取 ----------
    def get_welfare_list(self) -> List[Dict]:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberGoods~mallGoodsLifeService~list'
        data = {
            "memGrade": 3,
            "categoryCode": "SHTQ",
            "showCode": "SHTQWNTJ"
        }

        response = self.http.request(url, data=data)
        if response and response.get('success'):
            obj_list = response.get('obj', [])
            welfare_list = []
            for module in obj_list:
                goods_list = module.get('goodsList', [])
                for goods in goods_list:
                    if goods.get('exchangeStatus') == 1:
                        welfare_list.append({
                            'goodsId': goods.get('goodsId'),
                            'goodsNo': goods.get('goodsNo'),
                            'goodsName': goods.get('goodsName'),
                            'showName': goods.get('showName', ''),
                            'id': goods.get('id')
                        })
            return welfare_list
        return []

    def receive_welfare(self, goods_no: str, goods_name: str, task_code: str) -> bool:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberGoods~pointMallService~createOrder'
        data = {
            "from": "Point_Mall",
            "orderSource": "POINT_MALL_EXCHANGE",
            "goodsNo": goods_no,
            "quantity": 1,
            "taskCode": task_code
        }

        response = self.http.request(url, data=data)
        if response and response.get('success'):
            order_no = response.get('obj', {}).get('orderNo', '')
            self.logger.success(f'成功领取生活特权: {goods_name} (订单号: {order_no})')
            return True
        else:
            error_msg = response.get('errorMessage', '未知错误') if response else '请求失败'
            self.logger.error(f'领取生活特权失败: {goods_name} - {error_msg}')
            return False

    def handle_welfare_task(self, task_title: str) -> bool:
        self.logger.info('正在获取生活特权列表...')

        welfare_list = self.get_welfare_list()
        if not welfare_list:
            self.logger.warning('没有可领取的生活特权')
            return False

        self.logger.info(f'找到 {len(welfare_list)} 个可领取的生活特权')

        for welfare in welfare_list:
            goods_no = welfare.get('goodsNo')
            goods_name = welfare.get('goodsName')
            show_name = welfare.get('showName')

            if not goods_no:
                continue

            display_name = f"{show_name} - {goods_name}" if show_name else goods_name

            if self.receive_welfare(goods_no, display_name, self.taskCode):
                return True
            time.sleep(1)
        return False

    # ---------- 积分兑换礼品（用于“用积分兑任意礼品”任务） ----------
    def _get_exchangeable_goods(self) -> List[Dict]:
        """获取积分商城可兑换的商品列表（按积分升序）"""
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberGoods~pointMallService~list'
        data = {
            "categoryCode": "POINT_MALL",
            "pageNum": 1,
            "pageSize": 20,
            "sortType": "point_asc"  # 积分升序
        }
        response = self.http.request(url, data=data)
        if response and response.get('success'):
            goods_list = response.get('obj', {}).get('list', [])
            # 过滤出可兑换的（积分足够且库存充足）
            available = []
            for g in goods_list:
                if g.get('exchangeStatus') == 1 and g.get('stock') > 0:
                    available.append({
                        'goodsNo': g.get('goodsNo'),
                        'goodsName': g.get('goodsName'),
                        'point': g.get('point', 0),
                        'stock': g.get('stock', 0)
                    })
            # 按积分升序排列
            available.sort(key=lambda x: x['point'])
            return available
        return []

    def _exchange_gift(self, goods_no: str, goods_name: str) -> bool:
        url = 'https://mcs-mimp-web.sf-express.com/mcs-mimp/commonPost/~memberGoods~pointMallService~createOrder'
        data = {
            "from": "Point_Mall",
            "orderSource": "POINT_MALL_EXCHANGE",
            "goodsNo": goods_no,
            "quantity": 1,
            "taskCode": ""  # 兑换礼品可能不需要taskCode
        }
        response = self.http.request(url, data=data)
        if response and response.get('success'):
            order_no = response.get('obj', {}).get('orderNo', '')
            self.logger.success(f'成功兑换礼品: {goods_name} (订单号: {order_no})')
            return True
        else:
            error_msg = response.get('errorMessage', '未知错误') if response else '请求失败'
            self.logger.error(f'兑换礼品失败: {goods_name} - {error_msg}')
            return False

    def handle_gift_exchange_task(self, task_title: str) -> bool:
        """尝试兑换积分礼品以完成任务"""
        self.logger.info('正在查询可兑换商品...')
        goods_list = self._get_exchangeable_goods()
        if not goods_list:
            self.logger.warning('没有可兑换的商品')
            return False

        # 取前5个最低积分的商品尝试兑换
        for goods in goods_list[:5]:
            goods_no = goods['goodsNo']
            goods_name = goods['goodsName']
            point = goods['point']
            stock = goods['stock']
            self.logger.info(f"尝试兑换: {goods_name} (积分:{point}, 库存:{stock})")
            if self._exchange_gift(goods_no, goods_name):
                return True
            time.sleep(1)
        return False

    # ---------- 主执行函数 ----------
    def run_all_tasks(self) -> Tuple[int, int, int, int]:
        print('-' * 50)

        self.logger.info('正在获取任务列表...')
        tasks = self.get_task_list()
        if not tasks:
            self.logger.error('获取任务列表失败')
            return (0, 0, 0, 0)

        points_before = self.total_points
        self.logger.points_info(points_before, "执行前积分")

        total_tasks = len(tasks)
        completed_count = 0
        skipped_count = 0
        failed_count = 0

        for task in tasks:
            task_title = task.get('title', '未知任务')
            task_status = task.get('status', -1)  # -1表示未知
            self._set_task_attrs(task)

            # 状态0：未开始，跳过
            if task_status == 0:
                self.logger.task_skip(task_title, "任务未开始")
                skipped_count += 1
                continue

            # 状态3：已完成
            if task_status == 3:
                self.logger.success(f'{task_title} - 已完成')
                completed_count += 1
                continue

            # 检查是否在跳过列表中
            if task_title in self.config.SKIP_TASKS:
                self.logger.task_skip(task_title, "手动跳过")
                skipped_count += 1
                continue

            self.logger.task_found(task_title, task_status)

            # 特殊任务：生活特权
            if '领任意生活特权福利' in task_title:
                if self.handle_welfare_task(task_title):
                    time.sleep(2)
                    if self.execute_task():
                        self.logger.task_complete(task_title)
                        time.sleep(2)
                        if self.receive_task_reward():
                            self.logger.reward_get(task_title)
                            self._update_points()
                            completed_count += 1
                        else:
                            failed_count += 1
                    else:
                        self.logger.warning(f'任务执行失败: {task_title}')
                        failed_count += 1
                else:
                    self.logger.warning(f'{task_title} - 无法完成,跳过')
                    skipped_count += 1
                time.sleep(3)
                continue

            # 特殊任务：用积分兑任意礼品
            if '用积分兑任意礼品' in task_title:
                if self.handle_gift_exchange_task(task_title):
                    time.sleep(2)
                    if self.execute_task():
                        self.logger.task_complete(task_title)
                        time.sleep(2)
                        if self.receive_task_reward():
                            self.logger.reward_get(task_title)
                            self._update_points()
                            completed_count += 1
                        else:
                            failed_count += 1
                    else:
                        self.logger.warning(f'任务执行失败: {task_title}')
                        failed_count += 1
                else:
                    self.logger.warning(f'{task_title} - 无法兑换礼品,跳过')
                    skipped_count += 1
                time.sleep(3)
                continue

            # 通用处理
            if task_status == 1:  # 待完成
                # 检查是否有跳转链接，先访问
                if self.button_redirect:
                    self._visit_task_url(self.button_redirect)
                    time.sleep(2)

                # 尝试完成任务
                success = False
                for attempt in range(2):  # 最多重试2次
                    if self.execute_task():
                        self.logger.task_complete(task_title)
                        success = True
                        break
                    else:
                        self.logger.warning(f'任务完成失败，重试 {attempt+1}/2')
                        time.sleep(2)
                if not success:
                    self.logger.error(f'任务完成最终失败: {task_title}')
                    failed_count += 1
                    continue

                time.sleep(2)
                task_status = 2  # 标记为待领取

            if task_status == 2:  # 待领取
                if self.receive_task_reward():
                    self.logger.reward_get(task_title)
                    self._update_points()
                    completed_count += 1
                else:
                    # 再次尝试完成 + 领取
                    self.logger.warning(f'领取奖励失败，尝试重新完成并领取...')
                    if self.execute_task():
                        time.sleep(2)
                        if self.receive_task_reward():
                            self.logger.reward_get(task_title)
                            self._update_points()
                            completed_count += 1
                        else:
                            self.logger.error(f'重新领取仍失败: {task_title}')
                            failed_count += 1
                    else:
                        self.logger.error(f'重新完成失败: {task_title}')
                        failed_count += 1
                continue

            # 其他未知状态
            self.logger.task_skip(task_title, f"未知状态 {task_status}")
            skipped_count += 1

            time.sleep(3)

        # 更新最终积分
        tasks = self.get_task_list()
        points_after = self.total_points if tasks else points_before
        if tasks:
            self.logger.points_info(points_after, "执行后积分")

        self.logger.info(f"任务统计: 总计 {total_tasks}，完成 {completed_count}，跳过 {skipped_count}，失败 {failed_count}")
        return (points_before, points_after, completed_count, failed_count)


# ==================== 账号管理器 ====================
class AccountManager:
    def __init__(self, openid: str, account_index: int, config: Config, wx_client: WechatServerClient):
        self.openid = openid
        self.account_index = account_index + 1
        self.config = config
        self.wx_client = wx_client
        self.logger = Logger()
        self.proxy_manager = ProxyManager(config.PROXY_API_URL)

        self.login_success = False
        self.user_id = None
        self.phone = None
        self.http_client = None

        retry_count = 0
        while retry_count < MAX_PROXY_RETRIES and not self.login_success:
            try:
                self.http_client = SFHttpClient(config, self.proxy_manager)

                self.logger.info(f'账号{self.account_index}: 获取微信code...')
                wxcode = self.wx_client.get_wxcode(SF_APPID, openid)
                if not wxcode:
                    self.logger.error(f'账号{self.account_index}: 获取微信code失败')
                    retry_count += 1
                    time.sleep(2)
                    continue

                success, self.user_id, self.phone = self.http_client.login_by_wxcode(wxcode)

                if success:
                    masked_phone = self.phone[:3] + "*" * 4 + self.phone[7:] if len(self.phone) >= 7 else self.phone
                    self.logger.user_info(self.account_index, masked_phone)
                    self.login_success = True
                    break
                else:
                    if retry_count < MAX_PROXY_RETRIES - 1:
                        self.logger.warning(f'账号{self.account_index} 登录失败，尝试重新获取代理 ({retry_count + 1}/{MAX_PROXY_RETRIES})')
                        time.sleep(2)
            except Exception as e:
                self.logger.error(f'账号{self.account_index} 登录异常: {str(e)[:100]}')

            retry_count += 1

        if not self.login_success:
            self.logger.error(f'账号{self.account_index} 登录失败，已重试{MAX_PROXY_RETRIES}次')

    def run(self) -> Dict[str, Any]:
        if not self.login_success:
            return {
                'success': False,
                'phone': '',
                'points_before': 0,
                'points_after': 0,
                'points_earned': 0,
                'completed': 0,
                'failed': 0
            }

        wait_time = random.randint(1000, 3000) / 1000.0
        time.sleep(wait_time)

        executor = TaskExecutor(self.http_client, self.logger, self.config, self.user_id)

        # 执行两种签到
        new_sign_success, _ = executor.new_sign_in()
        time.sleep(1)
        sign_success, error_msg = executor.sign_in()

        if not sign_success and '活动太火爆' in error_msg:
            max_retries = 3
            for retry in range(max_retries):
                self.logger.warning(f'签到失败（IP受限），2秒后重新获取代理并重试（第{retry + 1}次）...')
                time.sleep(2)

                try:
                    self.http_client = SFHttpClient(self.config, self.proxy_manager)
                    success, self.user_id, self.phone = self.http_client.login_by_wxcode(
                        self.wx_client.get_wxcode(SF_APPID, self.openid)
                    )

                    if success:
                        executor.http = self.http_client
                        executor.user_id = self.user_id

                        sign_success, error_msg = executor.sign_in()
                        if sign_success:
                            self.logger.success('重新登录后签到成功')
                            break
                        elif '活动太火爆' not in error_msg:
                            break
                except Exception:
                    pass

        points_before, points_after, completed, failed = executor.run_all_tasks()
        points_earned = points_after - points_before

        return {
            'success': True,
            'phone': self.phone,
            'points_before': points_before,
            'points_after': points_after,
            'points_earned': points_earned,
            'completed': completed,
            'failed': failed
        }


# ==================== 单账号执行函数 ====================
def run_single_account(openid: str, index: int, config: Config, wx_client: WechatServerClient) -> Dict[str, Any]:
    try:
        with print_lock:
            print(f"开始执行账号{index + 1}")

        account = AccountManager(openid, index, config, wx_client)
        result = account.run()

        if result['success']:
            with print_lock:
                print(f"账号{index + 1}执行完成")
        else:
            with print_lock:
                print(f"账号{index + 1}执行失败")

        result['index'] = index
        return result
    except Exception as e:
        error_msg = f"账号{index + 1}执行异常: {str(e)}"
        with print_lock:
            print(error_msg)
        return {
            'index': index,
            'success': False,
            'phone': '',
            'points_before': 0,
            'points_after': 0,
            'points_earned': 0,
            'completed': 0,
            'failed': 0,
            'error': error_msg
        }


# ==================== 主程序 ====================
def main():
    config = Config()

    if not WX_SERVER_URL or not WX_AUTH:
        print("未配置微信服务端环境变量")
        print("请配置以下环境变量：")
        print("  wx_server_url=http://你的wechatserver地址:端口")
        print("  wx_auth=你的auth密钥")
        return

    wx_client = WechatServerClient(WX_SERVER_URL, WX_AUTH)

    openid_env = os.getenv('sf_openid', '')
    if not openid_env:
        print("未配置 sf_openid 环境变量")
        return

    openids = [oid.strip() for oid in openid_env.split('&') if oid.strip()]
    if not openids:
        print("sf_openid 环境变量为空")
        return

    random.shuffle(openids)
    print("=" * 50)
    print(f"{config.APP_NAME} v{config.VERSION} - 微信code登录版（优化）")
    print(f"账号数量: {len(openids)} 个")
    print(f"并发数量: {CONCURRENT_NUM}")
    print(f"执行时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)

    all_results = []

    if CONCURRENT_NUM <= 1:
        print("使用串行模式执行...")
        for index, openid in enumerate(openids):
            result = run_single_account(openid, index, config, wx_client)
            all_results.append(result)

            if index < len(openids) - 1:
                print("=" * 50)
                print("等待 2 秒后执行下一个账号...")
                time.sleep(2)
    else:
        print(f"使用并发模式执行，并发数: {CONCURRENT_NUM}")
        with ThreadPoolExecutor(max_workers=CONCURRENT_NUM) as executor:
            future_to_index = {
                executor.submit(run_single_account, oid, idx, config, wx_client): idx
                for idx, oid in enumerate(openids)
            }

            for future in as_completed(future_to_index):
                all_results.append(future.result())

    all_results.sort(key=lambda x: x['index'])

    success_count = sum(1 for r in all_results if r['success'])
    total_earned = sum(r['points_earned'] for r in all_results if r['success'])
    total_completed = sum(r.get('completed', 0) for r in all_results if r['success'])
    total_failed = sum(r.get('failed', 0) for r in all_results if r['success'])

    print(f"\n" + "=" * 80)
    print("积分统计汇总")
    print("=" * 80)
    print(f"{'序号':<6} {'手机号':<15} {'今日获得积分':<15} {'总积分':<15} {'完成任务':<12} {'状态':<10}")
    print("-" * 80)

    for result in all_results:
        index = result['index'] + 1
        phone = result['phone'][:3] + "****" + result['phone'][7:] if result['phone'] else "未登录"
        earned = result['points_earned']
        total = result['points_after']
        completed = result.get('completed', 0)
        status = "成功" if result['success'] else "失败"

        print(f"{index:<6} {phone:<15} {earned:<15} {total:<15} {completed:<12} {status:<10}")

    print("-" * 80)
    print(f"{'汇总':<6} {'账号总数: ' + str(len(all_results)):<15} {'今日总获得: ' + str(total_earned):<15} {'':<15} {'总完成: ' + str(total_completed):<12} {'成功: ' + str(success_count):<10}")
    print("=" * 80)

    print("\n所有账号任务执行完成!")


if __name__ == '__main__':
    main()