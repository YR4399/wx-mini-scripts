"""
顺丰速运 - 端午活动专版（自动助力版 + 金币统计 + 推送通知）
环境变量：
    sfsyUrl 或 sf_wxid  -> 账号列表（换行分隔）
    WECHAT_SERVER        -> 微信code服务地址（wxid登录必填）
    SF_PROXY_API_URL     -> 代理IP提取地址（可选）
    SFBF                 -> 并发数量（默认1，最大20）
    SF_DRAGONBOAT_LOTTERY-> 端午金币抽奖开关（1=开启，默认关闭）
    SF_DRAGONBOAT_MAX_CRUSH-> 端午最大砸粽次数（默认20）
    SF_DRAGON_ASSIST_TARGETS -> 可选，手动指定助力目标（逗号分隔）
    
    # 推送配置（可选，配置任意一个即可自动推送结果）
    PUSHPLUS_TOKEN       -> PushPlus 推送 token
    WECHAT_WORK_WEBHOOK  -> 企业微信机器人 webhook 地址
    DINGTALK_WEBHOOK     -> 钉钉机器人 webhook 地址
    DINGTALK_SECRET      -> 钉钉机器人加签密钥（可选，有则签名）
    SERVERCHAN_KEY       -> Server酱 SCKEY（旧版）或 SendKey（新版）
    BARK_KEY             -> Bark 推送 key（如 https://api.day.app/xxx）
    TELEGRAM_BOT_TOKEN   -> Telegram Bot Token
    TELEGRAM_CHAT_ID     -> Telegram 接收消息的 Chat ID
"""
import hashlib
import json
import os
import sys
import time
import re
import random
import logging
import traceback
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from urllib.parse import quote

import requests

requests.packages.urllib3.disable_warnings(requests.packages.urllib3.exceptions.InsecureRequestWarning)

# ---------- 端午子开关 ----------
def _dragon_lottery_enabled() -> bool:
    return (os.getenv("SF_DRAGONBOAT_LOTTERY") or "").strip() == "1"

def _dragon_max_crush() -> int:
    return int(os.getenv("SF_DRAGONBOAT_MAX_CRUSH", "20") or "20")

# ---------- 日志 ----------
logging.basicConfig(level=logging.INFO, format="%(message)s", handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger()
print_lock = Lock()

CONCURRENT_NUM = int(os.getenv('SFBF', '1'))
CONCURRENT_NUM = max(1, min(CONCURRENT_NUM, 20))

# ==================== 端午奖品全局汇总 ====================
lottery_records: List[Dict[str, str]] = []
lottery_lock = Lock()
SUMMARY_EXCLUDE_PATTERNS = [
    r"9折寄件券", r"(?<!1)2元寄件券", r"92折寄件券",
    r"2元寄件券[（(]满20元可用[）)]", r"海底捞7\.9折夜宵券", r"5元寄件券",
]
LOW_VALUE_COUPON_LIMIT = 12

def add_lottery_record(account: str, gift: str, detail: str, source: str = "端午活动") -> None:
    with lottery_lock:
        lottery_records.append({
            "date": time.strftime("%Y-%m-%d"),
            "account": account,
            "gift": gift,
            "detail": detail,
            "source": source,
        })

def is_low_value_coupon(prize_text: str) -> bool:
    text = str(prize_text or "")
    if not any(word in text for word in ("券", "红包")):
        return False
    for value in re.findall(r"(\d+(?:\.\d+)?)\s*元", text):
        try:
            if float(value) < LOW_VALUE_COUPON_LIMIT:
                return True
        except Exception:
            continue
    return False

def print_lottery_summary() -> None:
    today = time.strftime("%Y-%m-%d")
    today_records = []
    for item in lottery_records:
        if item.get("date") != today:
            continue
        prize_text = f"{item.get('gift', '')} {item.get('detail', '')}"
        if any(re.search(pattern, prize_text) for pattern in SUMMARY_EXCLUDE_PATTERNS):
            continue
        if is_low_value_coupon(prize_text):
            continue
        today_records.append(item)
    safe_print("=" * 50)
    safe_print(f"🎁 今日奖品汇总（{today}）")
    if not today_records:
        safe_print("📭 暂无奖品记录")
    else:
        for idx, item in enumerate(today_records, 1):
            detail = f"，{item['detail']}" if item.get("detail") else ""
            source = f"[{item.get('source', '奖品')}]"
            safe_print(f"{idx}. {source} {item['account']}: {item['gift']}{detail}")
    safe_print("=" * 50)

def safe_print(*args, **kwargs):
    with print_lock:
        print(*args, **kwargs)

# ==================== 推送通知模块 ====================
def _dingtalk_sign(secret: str, timestamp: int) -> str:
    """钉钉机器人加签"""
    import hmac
    import base64
    string_to_sign = f"{timestamp}\n{secret}"
    hmac_code = hmac.new(secret.encode('utf-8'), string_to_sign.encode('utf-8'), digestmod=hashlib.sha256).digest()
    return base64.b64encode(hmac_code).decode('utf-8')

def send_push(content: str) -> None:
    """
    根据环境变量自动选择推送渠道，发送消息内容。
    支持: PushPlus、企业微信机器人、钉钉机器人、Server酱、Bark、Telegram
    """
    if not content:
        return

    # 1. PushPlus
    token = os.getenv("PUSHPLUS_TOKEN") or os.getenv("PLUSPLUS_TOKEN")
    if token:
        try:
            url = "https://www.pushplus.plus/send"
            payload = {
                "token": token,
                "title": "顺丰端午活动通知",
                "content": content,
                "template": "txt"
            }
            resp = requests.post(url, json=payload, timeout=10)
            if resp.status_code == 200 and resp.json().get("code") == 200:
                safe_print("✅ PushPlus 推送成功")
            else:
                safe_print(f"⚠️ PushPlus 推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ PushPlus 推送异常: {e}")
        return

    # 2. 企业微信机器人
    webhook = os.getenv("WECHAT_WORK_WEBHOOK")
    if webhook:
        try:
            data = {"msgtype": "text", "text": {"content": content}}
            resp = requests.post(webhook, json=data, timeout=10)
            if resp.status_code == 200 and resp.json().get("errcode") == 0:
                safe_print("✅ 企业微信机器人推送成功")
            else:
                safe_print(f"⚠️ 企业微信推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ 企业微信推送异常: {e}")
        return

    # 3. 钉钉机器人
    dingtalk_url = os.getenv("DINGTALK_WEBHOOK")
    if dingtalk_url:
        try:
            timestamp = int(round(time.time() * 1000))
            secret = os.getenv("DINGTALK_SECRET")
            if secret:
                sign = _dingtalk_sign(secret, timestamp)
                dingtalk_url = f"{dingtalk_url}&timestamp={timestamp}&sign={sign}"
            data = {"msgtype": "text", "text": {"content": content}}
            resp = requests.post(dingtalk_url, json=data, timeout=10)
            if resp.status_code == 200 and resp.json().get("errcode") == 0:
                safe_print("✅ 钉钉机器人推送成功")
            else:
                safe_print(f"⚠️ 钉钉推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ 钉钉推送异常: {e}")
        return

    # 4. Server酱 (新版支持 sct.ftqq.com)
    sckey = os.getenv("SERVERCHAN_KEY")
    if sckey:
        try:
            url = f"https://sctapi.ftqq.com/{sckey}.send"
            data = {"title": "顺丰端午活动通知", "desp": content}
            resp = requests.post(url, data=data, timeout=10)
            if resp.status_code == 200 and resp.json().get("code") == 0:
                safe_print("✅ Server酱推送成功")
            else:
                safe_print(f"⚠️ Server酱推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ Server酱推送异常: {e}")
        return

    # 5. Bark
    bark_key = os.getenv("BARK_KEY")
    if bark_key:
        try:
            # 支持完整URL或仅key
            if bark_key.startswith("http"):
                url = bark_key
            else:
                url = f"https://api.day.app/{bark_key}"
            payload = {
                "title": "顺丰端午活动",
                "body": content,
                "icon": "https://www.sf-express.com/ico/favicon.ico"
            }
            resp = requests.post(url, json=payload, timeout=10)
            if resp.status_code == 200 and resp.json().get("code") == 200:
                safe_print("✅ Bark 推送成功")
            else:
                safe_print(f"⚠️ Bark 推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ Bark 推送异常: {e}")
        return

    # 6. Telegram Bot
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if bot_token and chat_id:
        try:
            url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
            data = {"chat_id": chat_id, "text": content, "parse_mode": "HTML"}
            resp = requests.post(url, json=data, timeout=10)
            if resp.status_code == 200 and resp.json().get("ok"):
                safe_print("✅ Telegram 推送成功")
            else:
                safe_print(f"⚠️ Telegram 推送失败: {resp.text}")
        except Exception as e:
            safe_print(f"❌ Telegram 推送异常: {e}")
        return

    # 若未配置任何推送渠道，静默跳过
    # safe_print("ℹ️ 未配置任何推送渠道，跳过推送")

def build_push_text(gold_results: List[Tuple[str, int]]) -> str:
    """构建推送消息的文本内容（奖品汇总 + 金币统计）"""
    today = time.strftime("%Y-%m-%d")
    today_records = []
    for item in lottery_records:
        if item.get("date") != today:
            continue
        prize_text = f"{item.get('gift', '')} {item.get('detail', '')}"
        if any(re.search(pattern, prize_text) for pattern in SUMMARY_EXCLUDE_PATTERNS):
            continue
        if is_low_value_coupon(prize_text):
            continue
        today_records.append(item)
    lines = []
    lines.append("=" * 50)
    lines.append(f"🎁 今日奖品汇总（{today}）")
    if not today_records:
        lines.append("📭 暂无奖品记录")
    else:
        for idx, item in enumerate(today_records, 1):
            detail = f"，{item['detail']}" if item.get("detail") else ""
            source = f"[{item.get('source', '奖品')}]"
            lines.append(f"{idx}. {source} {item['account']}: {item['gift']}{detail}")
    lines.append("=" * 50)
    lines.append("💰 各账号金币余额统计")
    lines.append("-" * 50)
    total_gold = 0
    for name, gold in gold_results:
        lines.append(f"{name:<20} : {gold} 金币")
        total_gold += gold
    lines.append("-" * 50)
    lines.append(f"总计金币 : {total_gold}")
    lines.append("=" * 50)
    return "\n".join(lines)

# ==================== 核心类（仅端午活动） ====================
class SFAPI:
    BASE = "https://mcs-mimp-web.sf-express.com"
    RUM_URL = "https://fee-gw.sf-express.com/report/rum"
    DRAGON_INDEX = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026IndexService~index"
    TASK_LIST = "/mcs-mimp/commonPost/~memberNonactivity~activityTaskService~taskList"
    FINISH_TASK = "/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask"
    FETCH_REWARD = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026TaskService~fetchTaskReward"
    QUERY_STATUS = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026ZongziService~queryStatus"
    CRUSH = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026ZongziService~crush"
    EXTRA_REWARD_CARDS = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026ZongziService~queryExtraRewardCards"
    LOTTERY_DRAW = "/mcs-mimp/commonPost/~memberNonactivity~dragonBoat2026LotteryService~prizeDraw"
    WECHAT_SIGNATURE = "/mcs-mimp/share/weChat/signature"

    ACTIVITY_CODE = "DRAGONBOAT_2026"
    CHANNEL = "26duanwutanchuang4"
    CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sf_session_cache.json')
    cache_lock = Lock()

    def __init__(self, info: str, index: int, all_user_ids: Dict[str, str] = None):
        self.index = index + 1
        self.headers = {'platform': 'MINI_PROGRAM'}
        self._ucmp_deviceid = None
        self.all_user_ids = all_user_ids or {}
        self.gold_coin = 0   # 金币余额

        raw = info.strip()
        if not raw:
            raise ValueError("账号为空")
        if 'sessionId=' in raw or '_login_mobile_=' in raw:
            self.login_type = 'cookie'
            self.cookie_str = raw
        elif raw.startswith('http'):
            self.login_type = 'url'
            self.url = raw
        else:
            self.login_type = 'wxid'
            if '#' in raw:
                self.wxid, self.deviceid = raw.split('#', 1)
                self.wxid = self.wxid.strip()
                self.deviceid = self.deviceid.strip()
            else:
                self.wxid = raw
                self.deviceid = None

        safe_print(f"\n====== 第{self.index}个账号 ======")

        self.proxy = self._fetch_proxy_ip()
        self.s = requests.Session()
        if self.proxy:
            self.s.proxies = {"http": f"http://{self.proxy}", "https": f"http://{self.proxy}"}
        self.s.verify = False

        self.user_id = ''
        self.phone = self.mobile = ''
        self.suuid = ''

        self.login_res = self._login()

    # ---------- 代理 ----------
    @staticmethod
    def _fetch_proxy_ip(max_retries: int = 3) -> Optional[str]:
        proxy_url = os.getenv('SF_PROXY_API_URL') or os.getenv('ProxyIP')
        if not proxy_url:
            return None
        for _ in range(max_retries):
            try:
                resp = requests.get(proxy_url, timeout=5)
                proxy_ip = resp.text.strip()
                if re.match(r'^\d+\.\d+\.\d+\.\d+:\d+$', proxy_ip):
                    return proxy_ip
                data = resp.json()
                if data.get('code') == -1:
                    return None
            except Exception:
                time.sleep(3)
        return None

    # ---------- 签名与请求 ----------
    @staticmethod
    def calc_md5(text: str) -> str:
        return hashlib.md5(text.encode()).hexdigest()

    def get_sign(self) -> Tuple[Optional[dict], Optional[str]]:
        ts = str(int(round(time.time() * 1000)))
        raw = f"token=wwesldfs29aniversaryvdld29&timestamp={ts}&sysCode=MCS-MIMP-CORE"
        sign = {'sysCode': 'MCS-MIMP-CORE', 'timestamp': ts, 'signature': self.calc_md5(raw)}
        return sign, ts

    def get_headers(self) -> dict:
        headers = {
            'Host': 'mcs-mimp-web.sf-express.com',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'accept': 'application/json, text/plain, */*',
            'platform': self.headers.get('platform', 'MINI_PROGRAM'),
            'channel': self.CHANNEL,
        }
        sign, _ = self.get_sign()
        if sign:
            headers.update(sign)
        return headers

    def do_request(self, url: str, data: dict = None, req_type: str = 'post',
                   max_retries: int = 3, extra_headers: dict = None) -> Optional[dict]:
        if data is None:
            data = {}
        headers = self.get_headers()
        if extra_headers:
            headers.update(extra_headers)
        proxies = {'http': self.proxy, 'https': self.proxy} if self.proxy else None

        for attempt in range(max_retries):
            try:
                if req_type == 'post':
                    resp = self.s.post(url, json=data, headers=headers, proxies=proxies, timeout=15)
                else:
                    resp = self.s.get(url, params=data, headers=headers, proxies=proxies, timeout=15)

                if resp.status_code == 200:
                    try:
                        return resp.json()
                    except json.JSONDecodeError:
                        safe_print(f"⚠️ 响应非JSON: {resp.text[:100]}")
                        return None
                else:
                    safe_print(f"⚠️ 请求返回非200状态码: {resp.status_code}")
            except requests.RequestException as e:
                safe_print(f"⚠️ 请求异常 (尝试 {attempt+1}/{max_retries}): {e}")
                time.sleep(2)
        return None

    # ---------- 微信code获取 ----------
    def _get_wx_code(self) -> Optional[str]:
        server = os.getenv('WECHAT_SERVER')
        if not server:
            safe_print('❌ 未设置WECHAT_SERVER环境变量')
            return None
        try:
            resp = requests.post(
                f"{server}/api/v1/wx/app/get/code",
                json={"wxid": self.wxid, "appid": "wxd4185d00bf7e08ac"},
                timeout=15
            )
            data = resp.json()
            if data.get('Code') == 0:
                return data.get('Data', {}).get('code')
            else:
                safe_print(f"获取code失败: {data.get('Message', '未知错误')}")
        except Exception as e:
            safe_print(f"获取code异常: {e}")
        return None

    # ---------- 会话缓存 ----------
    def _load_session_cache(self) -> Optional[dict]:
        try:
            with self.cache_lock:
                if not os.path.exists(self.CACHE_FILE):
                    return None
                with open(self.CACHE_FILE, 'r', encoding='utf-8') as f:
                    cache = json.load(f)
            key = self.wxid if self.login_type == 'wxid' else self.cookie_str[:30]
            entry = cache.get(key)
            if not entry:
                return None
            if time.time() - entry.get('timestamp', 0) > 86400:
                return None
            if entry.get('ucmp_deviceid'):
                self._ucmp_deviceid = entry['ucmp_deviceid']
            return entry
        except Exception:
            return None

    def _save_session_cache(self):
        try:
            entry = {
                'timestamp': time.time(),
                'suuid': self.suuid,
                'user_id': self.user_id,
                'phone': self.phone,
                'ucmp_deviceid': getattr(self, '_ucmp_deviceid', ''),
                'cookies': {c.name: c.value for c in self.s.cookies}
            }
            key = self.wxid if self.login_type == 'wxid' else self.cookie_str[:30]
            with self.cache_lock:
                cache = {}
                if os.path.exists(self.CACHE_FILE):
                    with open(self.CACHE_FILE, 'r', encoding='utf-8') as f:
                        cache = json.load(f)
                cache[key] = entry
                with open(self.CACHE_FILE, 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False)
        except Exception as e:
            safe_print(f'保存缓存异常: {e}')

    # ---------- UCMP 辅助 ----------
    def _generate_ucmp_device_id(self) -> str:
        ts = str(int(time.time() * 1000))
        return f"{ts}-{random.randint(1000000, 9999999)}-{''.join(random.choice('0123456789abcdef') for _ in range(16))}-{random.randint(10000000, 99999999)}"

    def _get_ucmp_headers(self, suuid: str = '') -> dict:
        if not self._ucmp_deviceid:
            self._ucmp_deviceid = self.deviceid or self._generate_ucmp_device_id()
        nonce = ''.join(random.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(32))
        sign = hashlib.md5(f'wxapp-valid-0328{nonce}{suuid}'.encode()).hexdigest().upper()
        return {
            'content-type': 'application/json',
            'noncestr': nonce,
            'suuid': suuid,
            'deviceid': self._ucmp_deviceid,
            'appid': 'wxapp-valid-0328',
            'sign': sign,
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x1800452d) NetType/WIFI Language/zh_CN',
            'referer': 'https://servicewechat.com/wxd4185d00bf7e08ac/663/page-frame.html'
        }

    # ========== 登录 ==========
    def _login(self) -> bool:
        if self.login_type == 'cookie':
            return self._login_with_cookie()
        elif self.login_type == 'url':
            return self._login_with_url()
        else:
            return self._login_with_code()

    def _login_with_cookie(self) -> bool:
        try:
            for item in self.cookie_str.split(';'):
                if '=' in item:
                    k, v = item.split('=', 1)
                    self.s.cookies.set(k.strip(), v.strip(), domain='mcs-mimp-web.sf-express.com')
            self.phone = self.mobile = self.s.cookies.get('_login_mobile_', '')
            self.user_id = self.s.cookies.get('_login_user_id_', '')
            if self.phone:
                safe_print(f'✅ {self.phone} (Cookie登录)')
                return True
            safe_print('Cookie登录失败：未提取到手机号')
            return False
        except Exception as e:
            safe_print(f'Cookie登录异常: {e}')
            return False

    def _login_with_url(self) -> bool:
        try:
            self.s.get(self.url, headers=self.get_headers(), timeout=15)
            self.phone = self.mobile = self.s.cookies.get('_login_mobile_', '')
            self.user_id = self.s.cookies.get('_login_user_id_', '')
            if self.phone:
                safe_print(f'✅ {self.phone} (URL登录)')
                return True
            safe_print('URL登录失败：未提取到手机号')
            return False
        except Exception as e:
            safe_print(f'URL登录异常: {e}')
            return False

    def _login_with_code(self, max_retries: int = 3) -> bool:
        self.s.cookies.clear()
        cached = self._load_session_cache()
        if cached:
            for name, value in cached.get('cookies', {}).items():
                if isinstance(value, str):
                    self.s.cookies.set(name, value, domain='mcs-mimp-web.sf-express.com')
            self.suuid = cached.get('suuid', '')
            test_url = self.BASE + "/mcs-mimp/commonPost/~memberIntegral~userInfoService~queryUserInfo"
            resp = self.do_request(test_url, {"sysCode": "ESG-CEMP-CORE", "token": "zeTLTYeG0bLetfRk"})
            if resp and resp.get('success'):
                self.user_id = cached.get('user_id', '')
                self.phone = self.mobile = cached.get('phone', '')
                safe_print(f'✅ {self.phone} (缓存)')
                return True
            else:
                self.s.cookies.clear()

        for attempt in range(1, max_retries + 1):
            try:
                code = self._get_wx_code()
                if not code:
                    safe_print(f'获取code失败，重试 {attempt}/{max_retries}')
                    time.sleep(2)
                    continue

                ucmp_h = self._get_ucmp_headers()
                resp = self.s.get(
                    f'https://ucmp.sf-express.com/wxaccess/weixin/appOnLogin?code={code}&publicId=gh_f9d9fca26a50',
                    headers=ucmp_h, timeout=10
                )
                if resp.status_code != 200:
                    safe_print(f'appOnLogin 状态异常: {resp.status_code}')
                    continue
                try:
                    data = resp.json()
                except Exception:
                    safe_print('appOnLogin 响应非JSON')
                    continue
                if 'sessionId' not in data:
                    safe_print(f'appOnLogin失败: {data.get("errorMessage","")}')
                    time.sleep(2)
                    continue
                self.suuid = data['sessionId']

                bind_h = self._get_ucmp_headers(self.suuid)
                resp = self.s.post(
                    'https://ucmp.sf-express.com/wxopen/weixin/wxMemIsBind',
                    json={}, headers=bind_h, timeout=10
                )
                if resp.status_code != 200:
                    safe_print(f'wxMemIsBind 状态异常: {resp.status_code}')
                    continue
                try:
                    bind_data = resp.json()
                except Exception:
                    safe_print('wxMemIsBind 响应非JSON')
                    continue
                if not (bind_data.get('success') and bind_data.get('obj')):
                    safe_print('wxMemIsBind 返回失败')
                    time.sleep(2)
                    continue
                self.phone = self.mobile = bind_data['obj'].get('mobile', '')
                self.user_id = bind_data['obj'].get('memId', '')

                biz_code = json.dumps({
                    "path": "/up-member/newPoints",
                    "linkCode": "SFAC20230803190840424",
                    "supportShare": "YES",
                    "subCategoryCode": "1",
                    "from": "mypoint",
                    "categoryCode": "1"
                })
                sfnew_url = (
                    f'https://ucmp.sf-express.com/wechat-act/weixin/activity/sfnewactivity?'
                    f'bizCode={quote(biz_code)}&regSource=mypoint&citycode=025&cityname={quote("南京")}'
                    f'&wxapp-version=V17.49&suuid={self.suuid}'
                )
                sfnew_headers = {
                    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x1800452d) NetType/WIFI Language/zh_CN',
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                }
                self.s.get(sfnew_url, headers=sfnew_headers, timeout=15, allow_redirects=True)

                login_mobile = self.s.cookies.get('_login_mobile_')
                login_user_id = self.s.cookies.get('_login_user_id_')
                if login_mobile and login_user_id:
                    self.phone = self.mobile = login_mobile
                    self.user_id = login_user_id
                    safe_print(f'✅ {self.mobile}')
                    self._save_session_cache()
                    return True
                else:
                    safe_print('未获取到 mcs cookie')
            except Exception as e:
                safe_print(f'登录异常: {e}')
                traceback.print_exc()
                self.s.cookies.clear()
            time.sleep(2)
        return False

    # ========== 端午活动 ==========
    def _dragon_build_referer(self, invite_user_id: str = None) -> str:
        mobile = self.mobile or self.s.cookies.get('_login_mobile_', '')
        user_id = self.user_id or self.s.cookies.get('_login_user_id_', '')
        base = (
            "https://mcs-mimp-web.sf-express.com/origin/a/mimp-activity/dragonBoat2026"
            f"?mobile={mobile}&userId={user_id}"
            "&path=/origin/a/mimp-activity/dragonBoat2026&supportShare=YES&from=26duanwutanchuang4"
        )
        if invite_user_id:
            sep = "&" if "?" in base else "?"
            base = f"{base}{sep}inviteUserId={invite_user_id}&type=task_invite"
        return base

    def _dragon_warmup(self):
        """预热：进入活动、微信签名、上报、首页、任务、状态等"""
        try:
            entry_url = self._dragon_build_referer()
            self.s.get(entry_url, headers={'Accept': 'text/html,application/xhtml+xml'}, timeout=15, allow_redirects=True)
            self.do_request(self.BASE + self.WECHAT_SIGNATURE, {"url": self._dragon_build_referer()}, extra_headers={'Referer': entry_url})
            try:
                now_ms = int(time.time() * 1000)
                user_id = self.user_id
                event_id = hashlib.md5(f"{user_id}-{now_ms}-{random.random()}".encode()).hexdigest()
                payload = {
                    "data": [{
                        "sdkInfo": {"sdkVersion": "1.0.0"},
                        "userInfo": {"userId": user_id, "userTrackId": hashlib.md5(f"{user_id}-track".encode()).hexdigest()},
                        "timeInfo": {"time": now_ms, "clientTime": now_ms},
                        "appInfo": {"appId": "637b5859cab6b3d12cd20489"},
                        "pageInfo": {"href": entry_url, "baseUrl": self.BASE + "/origin/a/mimp-activity/dragonBoat2026", "title": ""},
                        "eventInfo": {"category": "precollect", "type": "pageview", "eventID": event_id, "eventData": {"level": "critical", "pathname": "/dragonBoat2026"}},
                    }]
                }
                self.s.post(self.RUM_URL, headers={'Content-Type': 'text/plain;charset=UTF-8'}, data=json.dumps(payload, separators=(",", ":")))
            except:
                pass
            self.do_request(self.BASE + self.DRAGON_INDEX, {})
            self.do_request(self.BASE + self.TASK_LIST, {"activityCode": self.ACTIVITY_CODE, "channelType": "MINI_PROGRAM"})
            self.do_request(self.BASE + self.QUERY_STATUS, {})
        except:
            pass

    def _dragon_assist(self):
        manual_targets = os.getenv("SF_DRAGON_ASSIST_TARGETS", "")
        if manual_targets.strip():
            targets = [x.strip() for x in manual_targets.split(",") if x.strip()]
            safe_print(f"[端午] 使用手动指定的助力目标: {len(targets)} 个")
        else:
            if not self.all_user_ids:
                safe_print("[端午] 未获取到其他账号信息，跳过助力")
                return
            targets = []
            my_uid = self.user_id
            for acc_info, uid in self.all_user_ids.items():
                if uid and uid != my_uid:
                    targets.append(uid)
            if not targets:
                safe_print("[端午] 没有找到其他可助力的账号，跳过")
                return
            safe_print(f"[端午] 自动从账号列表中提取 {len(targets)} 个助力目标")

        assisted = 0
        for target in targets:
            if target == self.user_id:
                continue
            referer = self._dragon_build_referer(target)
            resp = self.do_request(self.BASE + self.DRAGON_INDEX,
                                   {"inviteType": 1, "inviteUserId": target},
                                   extra_headers={'Referer': referer})
            if resp and resp.get('success'):
                safe_print(f"[端午] 助力好友 {target[:8]}... 成功")
                assisted += 1
                time.sleep(1)
                continue
            msg = str(resp.get('errorMessage') or '') if resp else ''
            if "已助力" in msg or "已达" in msg or "上限" in msg:
                safe_print(f"[端午] 助力 {target[:8]}... {msg}")
                continue
            time.sleep(1)
        if assisted == 0:
            safe_print("[端午] 所有助力目标均失败或已达上限")

    def _dragon_task_browse(self):
        resp = self.do_request(self.BASE + self.TASK_LIST, {"activityCode": self.ACTIVITY_CODE, "channelType": "MINI_PROGRAM"})
        if not resp or not resp.get('success'):
            return
        tasks = resp.get('obj') or []
        browse = next((x for x in tasks if x.get('taskType') == 'BROWSE_LIFE_SERVICE'), None)
        if not browse:
            safe_print("[端午] 未找到浏览任务")
            return
        task_code = browse.get('taskCode', '')
        status = browse.get('status')
        process = browse.get('process', '')
        can_receive = browse.get('canReceiveTokenNum', 0)

        if status == 2 and task_code:
            self.do_request(self.BASE + self.FINISH_TASK, {"taskCode": task_code})
            time.sleep(random.uniform(0.5, 1.0))
            resp2 = self.do_request(self.BASE + self.TASK_LIST, {"activityCode": self.ACTIVITY_CODE, "channelType": "MINI_PROGRAM"})
            if resp2 and resp2.get('success'):
                tasks = resp2.get('obj') or []
                browse = next((x for x in tasks if x.get('taskType') == 'BROWSE_LIFE_SERVICE'), browse)
                can_receive = browse.get('canReceiveTokenNum', 0)
                process = browse.get('process', '')

        safe_print(f"[端午] 浏览任务进度: {process}")
        if can_receive > 0 or browse.get('status') == 1:
            self._dragon_fetch_reward()
        else:
            safe_print("[端午] 浏览任务暂无可领奖励")

    def _dragon_fetch_reward(self):
        resp = self.do_request(self.BASE + self.FETCH_REWARD, {"channelType": "MINI_PROGRAM", "activityCode": self.ACTIVITY_CODE})
        if resp and resp.get('success'):
            received = resp.get('obj', {}).get('receivedAccountList', [])
            if received:
                texts = [f"{item.get('currency', '')} x{item.get('amount', 0)}" for item in received]
                safe_print(f"[端午] 领取奖励: {', '.join(texts)}")
            else:
                safe_print("[端午] 领取奖励: 暂无可领取")
        else:
            safe_print(f"[端午] 领取奖励失败: {resp.get('errorMessage', '未知') if resp else '无响应'}")

    def _dragon_crush(self):
        max_crush = _dragon_max_crush()
        resp = self.do_request(self.BASE + self.QUERY_STATUS, {})
        if not resp or not resp.get('success'):
            safe_print("[端午] 查询金粽余额失败")
            return
        obj = resp.get('obj', {})
        zongzi = 0
        for item in obj.get('currentAccountList', []):
            if item.get('currency') == 'GOLD_ZONGZI':
                try:
                    zongzi = int(item.get('balance', 0))
                except:
                    pass
                break
        total_crush = int(obj.get('totalCrushTimes', 0))
        safe_print(f"[端午] 当前金粽: {zongzi}，已砸{total_crush}次")
        crush_times = min(zongzi, max_crush)
        if crush_times <= 0:
            safe_print("[端午] 金粽不足，跳过砸粽")
            return
        for i in range(crush_times):
            crush_resp = self.do_request(self.BASE + self.CRUSH, {})
            if not crush_resp or not crush_resp.get('success'):
                safe_print(f"[端午] 第{i+1}次砸粽失败")
                break
            obj2 = crush_resp.get('obj', {})
            received = obj2.get('receivedAccountList', [])
            coin_add = 0
            other_rewards = []
            for item in received:
                currency = item.get('currency', '')
                amount = item.get('amount', 0)
                if currency == 'GOLD_COIN':
                    coin_add += int(amount)
                else:
                    name = item.get('currencyName') or currency or "未知"
                    other_rewards.append(f"{name} x{amount}")
                    add_lottery_record(self.display_name, f"{name} x{amount}", "砸金粽获得", "砸金粽")
            if obj2.get('extraCardType') == 'SURPRISE':
                award = obj2.get('award', {})
                name = award.get('couponName') or award.get('productName') or '惊喜礼盒'
                amount = award.get('amount', 1)
                add_lottery_record(self.display_name, name, f"x{amount} 惊喜礼盒", "惊喜礼盒")
            for item in obj2.get('currentAccountList', []):
                if item.get('currency') == 'GOLD_ZONGZI':
                    remain = int(item.get('balance', 0))
                    safe_print(f"[端午] 第{i+1}次砸粽: 获得{coin_add}金币 " + (f"+{','.join(other_rewards)}" if other_rewards else "") + f"，剩余金粽{remain}")
                    break
            time.sleep(random.uniform(0.5, 1.2))

    def _dragon_lottery(self):
        if not _dragon_lottery_enabled():
            safe_print("[端午] 金币抽奖未开启（环境变量 SF_DRAGONBOAT_LOTTERY=1）")
            return
        resp = self.do_request(self.BASE + self.QUERY_STATUS, {})
        if not resp or not resp.get('success'):
            return
        obj = resp.get('obj', {})
        coin = 0
        for item in obj.get('currentAccountList', []):
            if item.get('currency') == 'GOLD_COIN':
                try:
                    coin = int(item.get('balance', 0))
                except:
                    pass
                break
        if coin < 2000:
            safe_print(f"[端午] 金币不足2000（当前{coin}），无法抽奖")
            return
        draw_resp = self.do_request(self.BASE + self.LOTTERY_DRAW, {"ruleType": "LOTTERY", "shouldNum": 2000})
        if draw_resp and draw_resp.get('success'):
            obj2 = draw_resp.get('obj', {})
            gift_name = obj2.get('giftBagName', '未知奖品')
            worth = obj2.get('giftBagWorth')
            products = obj2.get('productDTOList', [])
            detail_parts = []
            for prod in products:
                name = prod.get('couponName') or prod.get('productName') or '-'
                amount = prod.get('amount', 1)
                expire = prod.get('expirationDate')
                expire_text = f"，有效期至{expire}" if expire else ""
                detail_parts.append(f"{name} x{amount}{expire_text}")
            detail = "；".join(detail_parts)
            worth_text = f"，价值{worth}" if worth else ""
            safe_print(f"[端午] 金币抽奖: {gift_name}{worth_text}，{detail}")
            add_lottery_record(self.display_name, f"{gift_name}{worth_text}", detail, "金币抽奖")
        else:
            safe_print(f"[端午] 金币抽奖失败: {draw_resp.get('errorMessage', '') if draw_resp else '无响应'}")

    def _dragon_query_extra_cards(self):
        resp = self.do_request(self.BASE + self.EXTRA_REWARD_CARDS, {})
        if resp and resp.get('success'):
            cards = resp.get('obj', [])
            if cards:
                safe_print(f"[端午] 额外奖励卡: {', '.join(str(c.get('extraType', '')) for c in cards)}")

    def _dragon_query_gold(self) -> int:
        """查询当前金币余额并更新 self.gold_coin"""
        resp = self.do_request(self.BASE + self.QUERY_STATUS, {})
        if resp and resp.get('success'):
            obj = resp.get('obj', {})
            for item in obj.get('currentAccountList', []):
                if item.get('currency') == 'GOLD_COIN':
                    try:
                        self.gold_coin = int(item.get('balance', 0))
                    except:
                        self.gold_coin = 0
                    break
        return self.gold_coin

    def dragonboat_activity(self):
        safe_print("\n====== 开始端午活动 ======")
        self._dragon_assist()
        self._dragon_warmup()
        time.sleep(random.uniform(0.5, 1.0))
        self._dragon_task_browse()
        self._dragon_crush()
        self._dragon_lottery()
        self._dragon_query_extra_cards()
        self._dragon_query_gold()
        safe_print(f"[端午] 活动结束，当前金币: {self.gold_coin}")

    @property
    def display_name(self) -> str:
        phone = self.phone or self.mobile or ''
        if phone:
            return re.sub(r"(1\d{2})\d{4}(\d{4})", r"\1****\2", phone)
        user_id = self.user_id
        return user_id[:6] + '***' if user_id else f"账号{self.index}"

    def main(self):
        if not self.login_res:
            safe_print("登录失败，终止处理")
            return False
        self.dragonboat_activity()
        return True


# ==================== 辅助函数：预先获取所有账号的 user_id ====================
def get_user_id_from_account(account_info: str) -> Tuple[str, str]:
    try:
        temp = SFAPI(account_info, 0)
        if temp.login_res:
            return temp.user_id, temp.display_name
        else:
            return "", ""
    except Exception as e:
        safe_print(f"预获取账号信息失败: {e}")
        return "", ""


# ==================== 金币统计输出 ====================
def print_gold_summary(accounts_gold: List[Tuple[str, int]]):
    """输出金币汇总表格"""
    safe_print("\n" + "=" * 50)
    safe_print("💰 各账号金币余额统计")
    safe_print("=" * 50)
    total_gold = 0
    for name, gold in accounts_gold:
        safe_print(f"{name:<20} : {gold} 金币")
        total_gold += gold
    safe_print("-" * 50)
    safe_print(f"总计金币 : {total_gold}")
    safe_print("=" * 50)


# ==================== 运行入口 ====================
def run_single_account(info: str, idx: int, all_user_ids: Dict[str, str], gold_list: List):
    try:
        client = SFAPI(info, idx, all_user_ids)
        client.main()
        gold_list.append((client.display_name, client.gold_coin))
    except Exception as e:
        safe_print(f"账号{idx+1} 发生异常: {e}")
        traceback.print_exc()
        gold_list.append((f"账号{idx+1}", 0))


if __name__ == '__main__':
    env_val = os.getenv('sf_wxid') or os.getenv('sfsyUrl')
    if not env_val:
        safe_print("❌ 未找到账号变量（sfsyUrl 或 sf_wxid）")
        sys.exit(1)

    accounts = [a.strip() for a in env_val.replace('&', chr(10)).replace(chr(13)+chr(10), chr(10)).split(chr(10)) if a.strip()]
    safe_print(f"检测到 {len(accounts)} 个账号")

    # 预先获取所有账号的 user_id（用于自动助力）
    safe_print("\n====== 预获取账号信息（用于自动助力） ======")
    all_user_ids = {}
    for i, acc in enumerate(accounts):
        uid, display = get_user_id_from_account(acc)
        if uid:
            all_user_ids[display] = uid
            safe_print(f"账号 {i+1}: {display} -> {uid[:8]}...")
        else:
            safe_print(f"账号 {i+1}: 获取 user_id 失败，将跳过该账号的助力目标")
    safe_print(f"成功获取 {len(all_user_ids)} 个账号的 user_id")

    # 存放每个账号的金币和名称
    gold_results = []

    if CONCURRENT_NUM <= 1:
        for i, acc in enumerate(accounts):
            run_single_account(acc, i, all_user_ids, gold_results)
    else:
        with ThreadPoolExecutor(max_workers=CONCURRENT_NUM) as executor:
            futures = [executor.submit(run_single_account, acc, i, all_user_ids, gold_results) for i, acc in enumerate(accounts)]
            for future in as_completed(futures):
                future.result()

    print_lottery_summary()
    print_gold_summary(gold_results)

    # 推送通知（如已配置）
    push_content = build_push_text(gold_results)
    # send_push(push_content)