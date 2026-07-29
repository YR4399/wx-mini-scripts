# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========
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

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
牛牛短剧 - 自动登录 + 任务脚本（wechatserver 适配版）
原作者：foglamb
适配：wechatserver /wx/code 接口自动获取 wx.login code

环境变量:
  NIUNIU_ACCOUNT  : wechatserver userKey（多账号用 & 或换行分隔）
  NIUNIU_TOKENS   : 手动抓包的 token（多账号用 & 或换行分隔），可与 NIUNIU_ACCOUNT 混搭
  wx_server_url   : wechatserver 地址，如 https://wc.smallfawn.top（呆呆面板自动注入）
  wx_auth         : wechatserver 认证 key（呆呆面板自动注入）

小程序AppID: wxcb95401f250e9a53（牛牛短剧）
"""

import requests
import json
import time
import os
import sys
import random
import re
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple, List, Any
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ============================================================================
# 配置
# ============================================================================

# wechatserver 配置（优先从呆呆面板小写环境变量读取）
WX_SERVER_URL = os.getenv("wx_server_url") or os.getenv("WX_SERVER_URL", "")
WX_AUTH = os.getenv("wx_auth") or os.getenv("WX_AUTH", "")

# 小程序 AppID
APPID = os.getenv("NIUNIU_APPID", "wxcb95401f250e9a53")

# 账号配置（两种方式可混搭）
_account_env = os.environ.get('wx_opinion', '') or os.environ.get('NIUNIU_ACCOUNT', '')
_token_env = os.getenv("NIUNIU_TOKENS", "")

WX_USERKEYS = [a.strip() for line in _account_env.split("\n")
               for a in line.split("&") if a.strip()] if _account_env else []
MANUAL_TOKENS = [t.strip() for line in _token_env.split("\n")
                 for t in line.split("&") if t.strip()] if _token_env else []

# 业务 API
BUSINESS_API_BASE = "https://api.tianjinzhitongdaohe.com/sqx_fast"
CACHE_FILE = "niuniu_cache.json"

# 请求参数
REQUEST_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_DELAY = 5
MAX_VIDEO_PER_DAY = 20

# 吃饭补贴时间段
EAT_TIME_SLOTS = [
    {"name": "早餐", "start": 6, "end": 10},
    {"name": "午餐", "start": 11, "end": 14},
    {"name": "晚餐", "start": 17, "end": 20},
    {"name": "夜宵", "start": 21, "end": 24},
]

VIDEO_WATCH_DURATION = (15.1, 20.5)
VIDEO_INTERVAL = (25, 35)
TASK_INTERVAL = (2, 5)
LIKE_INTERVAL = (3, 6)
REWARD_TARGETS = [1, 5, 9, 15, 20]
VIDEO_DURATION_STEPS = [60, 300, 900, 1800, 3600, 7200, 9000]  # 最长150分钟
# 时长任务配置：每档等待时间(秒)，加上随机5-15分钟抖动模拟真实观看
DURATION_BASE_WAIT = [50, 240, 480, 900, 1800, 3600, 5400]
DURATION_JITTER = (300, 900)  # 每档额外随机抖动 5-15 分钟
DURATION_TARGET_RATIO = (0.4, 0.7)  # 随机完成 40%-70% 的档数（不全做完）

# ============================================================================
# 启动检查
# ============================================================================

if not WX_USERKEYS and not MANUAL_TOKENS:
    print("❌ 未配置任何账号信息")
    print("  NIUNIU_ACCOUNT : wechatserver userKey（如 34d20cec）")
    print("  NIUNIU_TOKENS  : 手动 token（从小程序抓包）")
    sys.exit(1)

if WX_USERKEYS and not WX_SERVER_URL:
    print("❌ 配置了 NIUNIU_ACCOUNT 但未设置 wx_server_url")
    sys.exit(1)

# ============================================================================
# 账号状态枚举
# ============================================================================

class AccountStatus:
    OK = "ok"
    TOKEN_EXPIRED = "token_expired"
    TOKEN_INVALID = "token_invalid"
    WX_ERROR = "wx_error"
    BANNED = "banned"
    NETWORK_ERROR = "network_error"
    UNKNOWN_ERROR = "unknown_error"

# ============================================================================
# 工具函数
# ============================================================================

def check_banned_response(data: dict) -> bool:
    if not data:
        return False
    msg = str(data.get("msg", "")).lower()
    return "封禁" in msg or "ban" in msg or "禁止" in msg


def check_token_valid(data: dict) -> Tuple[bool, str]:
    if not data:
        return False, "无响应数据"
    code = data.get("code")
    msg = str(data.get("msg", "")).lower()
    if code == 401:
        return False, "token_expired"
    if "token" in msg and ("无效" in msg or "过期" in msg):
        return False, "token_expired"
    if "登录" in msg and ("过期" in msg or "失效" in msg):
        return False, "token_expired"
    if "不存在" in msg:
        return False, "account_invalid"
    if "封禁" in msg or "ban" in msg:
        return False, "banned"
    return True, "ok"


def create_session() -> requests.Session:
    session = requests.Session()
    session.verify = False
    retry = Retry(total=MAX_RETRIES, backoff_factor=1,
                  status_forcelist=[429, 500, 502, 503, 504],
                  allowed_methods=["GET", "POST"])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def safe_request(method: str, url: str, **kwargs) -> Optional[requests.Response]:
    session = create_session()
    for attempt in range(MAX_RETRIES + 1):
        try:
            if method.upper() == "GET":
                return session.get(url, timeout=REQUEST_TIMEOUT, **kwargs)
            elif method.upper() == "POST":
                return session.post(url, timeout=REQUEST_TIMEOUT, **kwargs)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY)
        except Exception:
            break
    return None


def random_sleep(seconds_range: Tuple[float, float], reason: str = ""):
    t = random.uniform(*seconds_range)
    if reason:
        print(f"💤 {reason}，等待 {t:.1f}s...")
    time.sleep(t)

# ============================================================================
# 日志
# ============================================================================

def log(msg: str, level: str = "INFO", tag: str = ""):
    ts = datetime.now().strftime("%H:%M:%S")
    icons = {
        "INFO": "ℹ️", "WARN": "⚠️", "ERROR": "❌", "SUCCESS": "✅",
        "BANNED": "🚫", "SKIP": "⏭️", "EXPIRED": "⏰", "INVALID": "❓",
    }
    icon = icons.get(level, "ℹ️")
    prefix = f"[{ts}] {icon}"
    if tag:
        prefix += f" [{tag}]"
    print(f"{prefix} {msg}", flush=True)

# ============================================================================
# 账号配置类
# ============================================================================

class AccountConfig:
    def __init__(self, account_id: str, account_type: str, token: Optional[str] = None,
                 userkey: Optional[str] = None):
        self.account_id = account_id
        self.account_type = account_type  # "wx" or "manual"
        self.token = token
        self.userkey = userkey            # wechatserver userKey
        self.status = AccountStatus.OK
        self.status_message = ""
        self.consecutive_failures = 0
        self.display_name = self._get_display_name()

    def _get_display_name(self) -> str:
        if self.account_type == "wx":
            return f"wx:{self.userkey}"
        else:
            return f"manual:{self.account_id[:8]}..."

    def set_status(self, status: str, message: str = ""):
        self.status = status
        self.status_message = message

    def is_runnable(self) -> bool:
        return self.status == AccountStatus.OK


def load_accounts() -> List[AccountConfig]:
    accounts = []
    for userkey in WX_USERKEYS:
        accounts.append(AccountConfig(account_id=userkey, account_type="wx",
                                      userkey=userkey))
    for i, token in enumerate(MANUAL_TOKENS):
        tid = token[:8] if len(token) >= 8 else f"token{i+1}"
        accounts.append(AccountConfig(account_id=tid, account_type="manual", token=token))
    return accounts

# ============================================================================
# wechatserver 获取 wx.login code
# ============================================================================

def get_wx_code(userkey: str, account: AccountConfig) -> Optional[str]:
    """通过 wechatserver /wx/code 获取 wx.login code"""
    url = f"{WX_SERVER_URL.rstrip('/')}/wx/code"
    headers = {"AUTH": WX_AUTH}
    payload = {"userKey": userkey, "openid": userkey, "appid": APPID}

    for attempt in range(3):
        try:
            resp = requests.post(url, json=payload, headers=headers,
                                 timeout=REQUEST_TIMEOUT, verify=False)
            data = resp.json()
            code = data.get("data", {}).get("code") or data.get("code")
            if code and code != "":
                log(f"获取 wx code 成功", "SUCCESS", account.display_name)
                return code
            else:
                errmsg = data.get("msg", data.get("message", str(data)))
                log(f"获取 wx code 失败 (尝试{attempt+1}/3): {errmsg}", "WARN", account.display_name)
                if attempt < 2:
                    time.sleep(3)
        except Exception as e:
            log(f"获取 wx code 异常: {e}", "ERROR", account.display_name)
            if attempt < 2:
                time.sleep(3)

    account.set_status(AccountStatus.WX_ERROR, "wechatserver 获取code失败")
    return None


# ============================================================================
# 业务登录：code → open_id → token
# ============================================================================

def wxlogin(code: str, account: AccountConfig) -> Optional[dict]:
    """GET /sqx_fast/app/Login/wxLogin?code=xxx → 返回包含 open_id 的 data"""
    url = f"{BUSINESS_API_BASE}/app/Login/wxLogin"
    resp = safe_request("GET", url, params={"code": code})
    if not resp:
        account.set_status(AccountStatus.NETWORK_ERROR, "wxLogin 网络错误")
        return None

    try:
        data = resp.json()
    except Exception:
        account.set_status(AccountStatus.UNKNOWN_ERROR, "wxLogin 响应解析失败")
        return None

    if check_banned_response(data):
        account.set_status(AccountStatus.BANNED, "账号已被封禁")
        log("账号已被封禁！", "BANNED", account.display_name)
        return None

    if data.get("code") != 0:
        msg = data.get("msg", "")
        account.set_status(AccountStatus.UNKNOWN_ERROR, msg)
        log(f"wxLogin 失败: {msg}", "ERROR", account.display_name)
        return None

    return data.get("data")


def insert_wx_user(open_id: str, account: AccountConfig) -> Optional[str]:
    """POST /sqx_fast/app/Login/insertWxUser → 返回 token"""
    url = f"{BUSINESS_API_BASE}/app/Login/insertWxUser"
    payload = {
        "openId": open_id,
        "userName": "游客",
        "avatar": "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png",
        "sex": 1,
        "phone": "",
        "inviterCode": "",
        "qdCode": "",
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/json",
        "xweb_xhr": "1",
        "referer": f"https://servicewechat.com/{APPID}/19/page-frame.html",
    }

    resp = safe_request("POST", url, json=payload, headers=headers)
    if not resp:
        account.set_status(AccountStatus.NETWORK_ERROR, "insertWxUser 网络错误")
        return None

    try:
        data = resp.json()
    except Exception:
        account.set_status(AccountStatus.UNKNOWN_ERROR, "insertWxUser 响应解析失败")
        return None

    if check_banned_response(data):
        account.set_status(AccountStatus.BANNED, "账号已被封禁")
        log("账号已被封禁！", "BANNED", account.display_name)
        return None

    if data.get("code") == 0:
        token = data.get("data", {}).get("token") or data.get("token")
        if token:
            log("获取 token 成功", "SUCCESS", account.display_name)
            return token

    account.set_status(AccountStatus.UNKNOWN_ERROR, data.get("msg", "获取token失败"))
    log(f"insertWxUser 失败: {data.get('msg')}", "ERROR", account.display_name)
    return None


def refresh_token_wx(account: AccountConfig, cache: "TaskCache") -> Optional[str]:
    """通过 wechatserver 获取新 token 并缓存"""
    log("通过 wechatserver 获取 token...", "INFO", account.display_name)

    code = get_wx_code(account.userkey, account)
    if not code:
        cache.mark_account_invalid(account.account_id, account.status_message)
        return None

    random_sleep(TASK_INTERVAL)

    login_data = wxlogin(code, account)
    if not login_data:
        cache.mark_account_invalid(account.account_id, account.status_message)
        return None

    open_id = login_data.get("open_id")
    if not open_id:
        account.set_status(AccountStatus.UNKNOWN_ERROR, "未获取到 open_id")
        cache.mark_account_invalid(account.account_id, "未获取到 open_id")
        log("未获取到 open_id", "ERROR", account.display_name)
        return None

    token = insert_wx_user(open_id, account)
    if token:
        account.set_status(AccountStatus.OK, "")
        return token

    cache.mark_account_invalid(account.account_id, account.status_message)
    return None

# ============================================================================
# 缓存管理
# ============================================================================

class TaskCache:
    def __init__(self, cache_file: str):
        self.cache_file = cache_file
        self.cache = self._load()

    def _load(self) -> Dict:
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {"tokens": {}, "daily_tasks": {}, "eat_tasks": {}, "banned": {},
                "invalid_accounts": {}, "sign_info": {}}

    def save(self):
        try:
            with open(self.cache_file, "w", encoding="utf-8") as f:
                json.dump(self.cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"保存缓存失败: {e}", "ERROR")

    # token
    def get_token(self, account_id: str) -> Optional[str]:
        return self.cache.get("tokens", {}).get(account_id, {}).get("token")

    def save_token(self, account_id: str, token: str):
        self.cache.setdefault("tokens", {})[account_id] = {
            "token": token,
            "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.save()

    def clear_token(self, account_id: str):
        if account_id in self.cache.get("tokens", {}):
            del self.cache["tokens"][account_id]
            self.save()

    # daily tasks
    def is_daily_task_done(self, account_id: str, task_name: str) -> bool:
        today = datetime.now().strftime("%Y-%m-%d")
        d = self.cache.get("daily_tasks", {}).get(account_id, {})
        return d.get("date") == today and d.get(task_name, False)

    def mark_daily_task_done(self, account_id: str, task_name: str, value: Any = True):
        today = datetime.now().strftime("%Y-%m-%d")
        tasks = self.cache.setdefault("daily_tasks", {})
        if account_id not in tasks or tasks[account_id].get("date") != today:
            tasks[account_id] = {"date": today}
        tasks[account_id][task_name] = value
        tasks[account_id]["update_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.save()

    def get_video_count(self, account_id: str) -> int:
        today = datetime.now().strftime("%Y-%m-%d")
        d = self.cache.get("daily_tasks", {}).get(account_id, {})
        return d.get("video_count", 0) if d.get("date") == today else 0

    def add_video_count(self, account_id: str, count: int = 1):
        today = datetime.now().strftime("%Y-%m-%d")
        tasks = self.cache.setdefault("daily_tasks", {})
        if account_id not in tasks or tasks[account_id].get("date") != today:
            tasks[account_id] = {"date": today}
        tasks[account_id]["video_count"] = tasks[account_id].get("video_count", 0) + count
        tasks[account_id]["update_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.save()

    # eat
    def is_eat_done(self, account_id: str, slot_name: str) -> bool:
        today = datetime.now().strftime("%Y-%m-%d")
        d = self.cache.get("eat_tasks", {}).get(account_id, {})
        return d.get("date") == today and d.get(slot_name, False)

    def mark_eat_done(self, account_id: str, slot_name: str):
        today = datetime.now().strftime("%Y-%m-%d")
        eat = self.cache.setdefault("eat_tasks", {})
        if account_id not in eat or eat[account_id].get("date") != today:
            eat[account_id] = {"date": today}
        eat[account_id][slot_name] = True
        self.save()

    # banned / invalid
    def is_banned(self, account_id: str) -> bool:
        b = self.cache.get("banned", {}).get(account_id, {})
        return b.get("banned", False) and b.get("date") == datetime.now().strftime("%Y-%m-%d")

    def mark_banned(self, account_id: str):
        self.cache.setdefault("banned", {})[account_id] = {
            "banned": True, "date": datetime.now().strftime("%Y-%m-%d"),
            "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.save()

    def is_account_invalid_today(self, account_id: str) -> Tuple[bool, str]:
        inv = self.cache.get("invalid_accounts", {}).get(account_id, {})
        if inv.get("invalid") and inv.get("date") == datetime.now().strftime("%Y-%m-%d"):
            return True, inv.get("reason", "")
        return False, ""

    def mark_account_invalid(self, account_id: str, reason: str):
        self.cache.setdefault("invalid_accounts", {})[account_id] = {
            "invalid": True, "reason": reason,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.save()

    # sign
    def get_sign_record(self, account_id: str) -> Dict:
        today = datetime.now().strftime("%Y-%m-%d")
        d = self.cache.get("sign_info", {}).get(account_id, {})
        if d.get("date") != today:
            return {"date": today, "signed": False, "resigned_dates": []}
        return d

    def mark_signed(self, account_id: str, date: str, is_resign: bool = False):
        today = datetime.now().strftime("%Y-%m-%d")
        info = self.cache.setdefault("sign_info", {})
        if account_id not in info or info[account_id].get("date") != today:
            info[account_id] = {"date": today, "signed": False, "resigned_dates": []}
        rec = info[account_id]
        if date == today:
            rec["signed"] = True
        else:
            rec.setdefault("resigned_dates", [])
            if date not in rec["resigned_dates"]:
                rec["resigned_dates"].append(date)
        self.save()

# ============================================================================
# 请求工具（带 token 验证）
# ============================================================================

def make_headers(token: str) -> dict:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
                      "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF "
                      "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201",
        "content-type": "application/x-www-form-urlencoded",
        "xweb_xhr": "1",
        "token": token,
        "referer": f"https://servicewechat.com/{APPID}/19/page-frame.html",
        "accept-language": "zh-CN,zh;q=0.9",
    }


def make_json_headers(token: str) -> dict:
    h = make_headers(token)
    h["content-type"] = "application/json"
    return h


def safe_check(resp: Optional[requests.Response], account: AccountConfig,
               cache: TaskCache) -> Tuple[bool, Optional[dict]]:
    """check_response 的安全版本：失败时不改变账号状态，避免单个请求失败导致后续任务全部跳过"""
    saved_status = account.status
    saved_msg = account.status_message
    ok, data = check_response(resp, account, cache)
    if not ok:
        account.status = saved_status
        account.status_message = saved_msg
    return ok, data


def check_response(resp: Optional[requests.Response], account: AccountConfig,
                   cache: TaskCache) -> Tuple[bool, Optional[dict]]:
    if not resp:
        account.set_status(AccountStatus.NETWORK_ERROR, "网络请求失败")
        return False, None

    try:
        data = resp.json()
    except Exception:
        account.set_status(AccountStatus.UNKNOWN_ERROR, "响应解析失败")
        return False, None

    if check_banned_response(data):
        account.set_status(AccountStatus.BANNED, "账号已被封禁")
        cache.mark_banned(account.account_id)
        log("账号已被封禁！", "BANNED", account.display_name)
        return False, None

    valid, reason = check_token_valid(data)
    if not valid:
        if reason == "token_expired":
            account.set_status(AccountStatus.TOKEN_EXPIRED, "Token 已过期")
            cache.clear_token(account.account_id)
            # 不标记 invalid，让上层 process_account 刷新 token 后重试
            log("Token 已过期，正在刷新...", "EXPIRED", account.display_name)
        elif reason == "account_invalid":
            account.set_status(AccountStatus.TOKEN_INVALID, "账号无效")
            cache.mark_account_invalid(account.account_id, "账号无效")
            log(f"账号无效: {data.get('msg')}", "INVALID", account.display_name)
        elif reason == "banned":
            account.set_status(AccountStatus.BANNED, "账号已被封禁")
            cache.mark_banned(account.account_id)
            log("账号已被封禁！", "BANNED", account.display_name)
        return False, None

    return True, data

# ============================================================================
# 业务接口
# ============================================================================

def get_integral(token: str, account: AccountConfig, cache: TaskCache) -> int:
    url = f"{BUSINESS_API_BASE}/app/integral/selectByUserId"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if ok and data and data.get("code") == 0:
        return data.get("data", {}).get("integralNum", 0)
    return 0


def get_user_info(token: str, account: AccountConfig, cache: TaskCache) -> Optional[Dict]:
    url = f"{BUSINESS_API_BASE}/app/user/selectUserById"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if ok and data and data.get("code") == 0:
        return data.get("data", {})
    return None


def sign_in(token: str, account: AccountConfig, cache: TaskCache,
            date: str = None) -> bool:
    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")
    url = f"{BUSINESS_API_BASE}/app/integral/signIn"
    resp = safe_request("GET", url, params={"date": date}, headers=make_headers(token))
    ok, data = check_response(resp, account, cache)
    if not ok:
        return False
    if data.get("code") == 0:
        is_resign = date != datetime.now().strftime("%Y-%m-%d")
        cache.mark_signed(account.account_id, date, is_resign)
        label = f"补签({date})" if is_resign else "签到"
        log(f"{label}成功: {data.get('msg')}", "SUCCESS", account.display_name)
        return True
    else:
        msg = data.get("msg", "")
        if "已经" in msg or "已签到" in msg:
            cache.mark_signed(account.account_id, date, False)
        log(f"签到: {msg}", "INFO", account.display_name)
        return False


def try_resign_missing_days(token: str, account: AccountConfig, cache: TaskCache) -> int:
    user_info = get_user_info(token, account, cache)
    if not user_info:
        return 0
    sign_status = user_info.get("signStatus", "")
    if not sign_status:
        return 0
    today = datetime.now()
    resign_count = 0
    for i, ch in enumerate(sign_status):
        if ch == "0":
            day = i + 1
            if day > today.day:
                continue
            sign_date = datetime(today.year, today.month, day).strftime("%Y-%m-%d")
            rec = cache.get_sign_record(account.account_id)
            if sign_date in rec.get("resigned_dates", []):
                continue
            log(f"发现漏签: {sign_date}，尝试补签...", "INFO", account.display_name)
            if sign_in(token, account, cache, sign_date):
                resign_count += 1
                random_sleep((2, 4))
    return resign_count


def do_sign_and_resign(token: str, account: AccountConfig, cache: TaskCache) -> Tuple[bool, int]:
    today = datetime.now().strftime("%Y-%m-%d")
    rec = cache.get_sign_record(account.account_id)
    signed = rec.get("signed", False)
    if not signed:
        signed = sign_in(token, account, cache, today)
    else:
        log("今日已签到", "SKIP", account.display_name)
    # 补签前保存账号状态，防止 getUserInfo 的 check_response 改变状态导致后续任务被跳过
    saved_status = account.status
    saved_msg = account.status_message
    resign_count = try_resign_missing_days(token, account, cache)
    # 恢复账号状态（补签失败不应影响后续任务）
    if account.status != AccountStatus.OK and saved_status == AccountStatus.OK:
        account.status = saved_status
        account.status_message = saved_msg
    return signed, resign_count


def like_video(token: str, account: AccountConfig, cache: TaskCache,
               like_count: int = 2) -> int:
    url = f"{BUSINESS_API_BASE}/app/courseCollect/insertCourseCollect"
    payload = {"courseId": 1386, "courseDetailsId": 113881, "classify": 2, "type": 1}
    success_count = 0
    for i in range(like_count):
        if not account.is_runnable():
            break
        resp = safe_request("POST", url, json=payload, headers=make_json_headers(token))
        ok, data = safe_check(resp, account, cache)
        if ok and data and data.get("code") == 0:
            success_count += 1
            log(f"第{i+1}/{like_count}次点赞成功", "SUCCESS", account.display_name)
        else:
            if data:
                msg = data.get("msg", "")
                label = "INFO" if ("已经" in msg or "重复" in msg) else "WARN"
                log(f"第{i+1}次点赞: {msg}", label, account.display_name)
            if not account.is_runnable():
                break
        if i < like_count - 1 and account.is_runnable():
            random_sleep(LIKE_INTERVAL)
    return success_count


def claim_like_reward(token: str, account: AccountConfig, cache: TaskCache) -> bool:
    url = f"{BUSINESS_API_BASE}/app/integral/goodVideo"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if ok and data and data.get("code") == 0:
        log(f"领取点赞奖励: {data.get('msg')}", "SUCCESS", account.display_name)
        return True
    elif data:
        msg = data.get("msg", "")
        level = "INFO" if ("已经" in msg or "已领取" in msg) else "WARN"
        log(f"点赞奖励: {msg}", level, account.display_name)
    return False


def claim_video_reward(token: str, account: AccountConfig, cache: TaskCache,
                       before_integral: int, target: int) -> bool:
    url = f"{BUSINESS_API_BASE}/app/integral/lookVideoNum"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if not ok:
        return False
    if data.get("code") != 0:
        log(f"领取奖励: {data.get('msg')}", "INFO", account.display_name)
        return False
    time.sleep(1)
    after = get_integral(token, account, cache)
    earned = after - before_integral
    if earned > 0:
        log(f"达到{target}次目标，获得 +{earned} 金币!", "SUCCESS", account.display_name)
        return True
    return False


def watch_one_video(token: str, account: AccountConfig, cache: TaskCache,
                    current: int, total: int) -> bool:
    """看视频次数任务（与 JS 版 niuniuduanju.js 一致）：
    1. 模拟观看 2. POST /app/user/updateUsers 更新次数 3. GET /app/integral/lookVideoNum 领奖励"""
    t = random.uniform(*VIDEO_WATCH_DURATION)
    log(f"模拟观看视频 ({t:.1f}s)...", "INFO", account.display_name)
    time.sleep(t)
    # STEP 1: 更新用户观看次数（与 JS 版 updateUserWatchCount 一致）
    step = REWARD_TARGETS[min(current - 1, len(REWARD_TARGETS) - 1)] if current <= max(REWARD_TARGETS) else current
    update_user_watch_count(token, account, step, current)
    random_sleep((2, 3))
    # STEP 2: 领取奖励（与 JS 版 lookVideoNum 一致）
    saved_status = account.status
    saved_msg = account.status_message
    url = f"{BUSINESS_API_BASE}/app/integral/lookVideoNum"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if ok and data and data.get("code") == 0:
        if current % 5 == 0 or current == total:
            log(f"第{current}/{total}次观看成功", "SUCCESS", account.display_name)
        return True
    elif data:
        msg = str(data.get("msg", ""))
        if "已领取" in msg or "已完成" in msg or "不能重复" in msg:
            log(f"第{current}次: 今日已完成", "SKIP", account.display_name)
        else:
            log(f"第{current}次观看失败: {msg}", "WARN", account.display_name)
    account.status = saved_status
    account.status_message = saved_msg
    return False


def watch_videos(token: str, account: AccountConfig, cache: TaskCache) -> int:
    if cache.is_daily_task_done(account.account_id, "video_completed"):
        log("今日广告任务已完成", "SKIP", account.display_name)
        return 0
    watched = cache.get_video_count(account.account_id)
    need = MAX_VIDEO_PER_DAY - watched
    if need <= 0:
        cache.mark_daily_task_done(account.account_id, "video_completed", True)
        return 0
    log(f"开始看广告，今日已看 {watched}/{MAX_VIDEO_PER_DAY} 次", "INFO", account.display_name)
    success = 0
    for i in range(need):
        if not account.is_runnable():
            break
        cur = watched + i + 1
        before = get_integral(token, account, cache)
        if watch_one_video(token, account, cache, cur, MAX_VIDEO_PER_DAY):
            success += 1
            cache.add_video_count(account.account_id)
            if cur in REWARD_TARGETS and account.is_runnable():
                log(f"达到{cur}次目标，尝试领取奖励...", "INFO", account.display_name)
                claim_video_reward(token, account, cache, before, cur)
        else:
            account.consecutive_failures += 1
            if account.consecutive_failures >= 3:
                log(f"连续失败{account.consecutive_failures}次，停止", "WARN", account.display_name)
                break
            continue
        account.consecutive_failures = 0
        if i < need - 1 and account.is_runnable():
            random_sleep(VIDEO_INTERVAL, "视频间隔")
    new_total = watched + success
    if new_total >= MAX_VIDEO_PER_DAY:
        cache.mark_daily_task_done(account.account_id, "video_completed", True)
    if success > 0:
        log(f"今日累计: {new_total}/{MAX_VIDEO_PER_DAY} 次", "INFO", account.display_name)
    return success


def get_current_eat_slot() -> Optional[Dict]:
    h = datetime.now().hour
    for slot in EAT_TIME_SLOTS:
        if slot["start"] <= h < slot["end"]:
            return slot
    return None


def eat_gold(token: str, account: AccountConfig, cache: TaskCache) -> Tuple[bool, str]:
    url = f"{BUSINESS_API_BASE}/app/integral/eatGold"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if not ok:
        return False, "请求失败"
    return (data.get("code") == 0, data.get("msg", ""))


def check_and_claim_eat_gold(token: str, account: AccountConfig, cache: TaskCache) -> bool:
    slot = get_current_eat_slot()
    if not slot:
        return False
    name = slot["name"]
    if cache.is_eat_done(account.account_id, name):
        log(f"{name}补贴今日已领取", "SKIP", account.display_name)
        return False
    # 获取服务端时间配置
    url = f"{BUSINESS_API_BASE}/app/common/type/933"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if not ok or not data or data.get("code") != 0:
        return False
    config = data.get("data", {})
    value = config.get("value", "")
    eat_list = config.get("eatList", [])
    h = datetime.now().hour
    for i, slot_str in enumerate(value.split(",")):
        parts = slot_str.split("-")
        if len(parts) == 2:
            sh = int(parts[0].split(":")[0])
            eh = int(parts[1].split(":")[0])
            if sh <= h < eh:
                if i < len(eat_list) and eat_list[i] == 1:
                    cache.mark_eat_done(account.account_id, name)
                    return False
                before = get_integral(token, account, cache)
                log(f"尝试领取{name}补贴...", "INFO", account.display_name)
                ok2, msg = eat_gold(token, account, cache)
                if ok2:
                    cache.mark_eat_done(account.account_id, name)
                    after = get_integral(token, account, cache)
                    earned = after - before
                    log(f"{name}补贴领取成功 +{earned}金币", "SUCCESS", account.display_name)
                    return True
                else:
                    if "已经" in msg or "已领取" in msg:
                        cache.mark_eat_done(account.account_id, name)
                    log(f"{name}补贴失败: {msg}", "WARN", account.display_name)
                    return False
    return False

# ============================================================================
# 日常任务总入口
# ============================================================================

def watch_duration(token: str, account: AccountConfig, cache: TaskCache) -> int:
    """模拟观看时长任务（拟人化：真实等待 + 随机不全部做完）"""
    if cache.is_daily_task_done(account.account_id, "duration_completed"):
        log("今日时长任务已完成", "SKIP", account.display_name)
        return 0
    try:
        saved_status = account.status
        saved_msg = account.status_message
        user_info = get_user_info(token, account, cache)
        if not user_info:
            account.status = saved_status
            account.status_message = saved_msg
            log("时长任务: 获取用户信息失败", "WARN", account.display_name)
            return 0
        next_step = int(user_info.get("okLookVideoSec", 0) or 0)
        if next_step < 1:
            next_step = 1
        if next_step > len(VIDEO_DURATION_STEPS):
            cache.mark_daily_task_done(account.account_id, "duration_completed", True)
            log("今日时长任务全部完成", "SKIP", account.display_name)
            return len(VIDEO_DURATION_STEPS)

        # 随机目标：只做 40%-70% 的剩余档数
        remaining = len(VIDEO_DURATION_STEPS) - next_step + 1
        target = max(1, int(remaining * random.uniform(*DURATION_TARGET_RATIO)))
        log(f"时长任务: 剩余{remaining}档, 随机目标{target}档", "INFO", account.display_name)

        completed = 0
        for step in range(next_step, len(VIDEO_DURATION_STEPS) + 1):
            if not account.is_runnable():
                break
            if completed >= target:
                log(f"时长任务: 已达随机目标{target}档, 停止", "INFO", account.display_name)
                break

            video_sec = VIDEO_DURATION_STEPS[step - 1]
            # 拟人化等待：基础等待 + 随机抖动（模拟真实观看，不全速跳过）
            base_wait = DURATION_BASE_WAIT[step - 1]
            jitter = random.uniform(*DURATION_JITTER)
            total_wait = base_wait + jitter
            wait_min = total_wait / 60
            log(f"模拟观看时长: 第{step}档 {video_sec//60}分钟 (等待 {wait_min:.0f}分钟)", "INFO", account.display_name)
            time.sleep(total_wait)

            # 更新用户观看时长
            update_user_watch_duration(token, account, video_sec, step)
            random_sleep((15.1, 20.5), "模拟观看时长")

            # 领取时长奖励
            try:
                resp = safe_request("GET", f"{BUSINESS_API_BASE}/app/integral/lookVideoSec",
                                    headers=make_headers(token))
                ok, data = check_response(resp, account, cache)
                if ok and data and data.get("code") == 0:
                    min_dur = video_sec // 60
                    log(f"时长任务[{step}/{len(VIDEO_DURATION_STEPS)}] {min_dur}分钟: {data.get('msg', 'success')}",
                        "SUCCESS", account.display_name)
                    completed += 1
                elif data:
                    msg = str(data.get("msg", ""))
                    if "已领取" in msg or "已完成" in msg:
                        log(f"时长任务[{step}/{len(VIDEO_DURATION_STEPS)}]: 今日已完成", "SKIP", account.display_name)
                        break
                    log(f"时长任务[{step}/{len(VIDEO_DURATION_STEPS)}]: {msg}", "WARN", account.display_name)
                    if data.get("code") == 401:
                        account.set_status(AccountStatus.TOKEN_EXPIRED, "Token已过期")
                        break
            except Exception as e:
                log(f"时长任务[{step}] 异常: {e}", "WARN", account.display_name)
            random_sleep((2, 3))

        if completed >= len(VIDEO_DURATION_STEPS):
            cache.mark_daily_task_done(account.account_id, "duration_completed", True)
        return completed
    except Exception as e:
        log(f"时长任务异常: {e}", "WARN", account.display_name)
        return 0


def update_user_watch_count(token, account, look_day_video_num, look_video_num):
    """更新用户观看视频次数记录（与 JS 版一致：先 POST updateUsers，再 GET lookVideoNum）"""
    try:
        user_info = get_user_info(token, account, None) or {}
        data = {
            "userName": user_info.get("userName", ""),
            "avatar": user_info.get("avatar", ""),
            "phone": user_info.get("phone", ""),
            "lookDayVideoNum": look_day_video_num,
            "lookVideoNum": look_video_num,
        }
        safe_request("POST", f"{BUSINESS_API_BASE}/app/user/updateUsers",
                     headers=make_json_headers(token), json=data)
        log("updateUserWatchCount done", "INFO", account.display_name)
    except Exception as e:
        log(f"updateUserWatchCount failed: {e}", "WARN", account.display_name)


def update_user_watch_duration(token: str, account: AccountConfig, video_sec: int, look_video_sec: int):
    """更新用户观看时长记录"""
    try:
        user_info = get_user_info(token, account, None) or {}
        data = {
            "userName": user_info.get("userName", ""),
            "avatar": user_info.get("avatar", ""),
            "phone": user_info.get("phone", ""),
            "videoSec": video_sec,
            "lookVideoSec": look_video_sec,
        }
        resp = safe_request("POST", f"{BUSINESS_API_BASE}/app/user/updateUsers",
                            headers=make_json_headers(token), json=data)
        min_dur = video_sec // 60
        log(f"模拟观看时长: {min_dur}分钟", "INFO", account.display_name)
    except Exception as e:
        log(f"更新观看时长失败: {e}", "WARN", account.display_name)



def get_balance(token: str, account: AccountConfig, cache: TaskCache) -> Optional[float]:
    """获取可提现余额（元）"""
    url = f"{BUSINESS_API_BASE}/app/invite/selectInviteMoney"
    resp = safe_request("GET", url, headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if ok and data and data.get("code") == 0:
        invite_money = data.get("data", {}).get("inviteMoney", {})
        return float(invite_money.get("money", 0) or 0)
    return None


def cash_out(token: str, account: AccountConfig, cache: TaskCache,
             amount: float) -> Tuple[bool, str]:
    """提现到支付宝
    classify=1 表示支付宝提现
    """
    url = f"{BUSINESS_API_BASE}/app/cash/cashMoney"
    resp = safe_request("GET", url, params={"money": amount, "classify": 1},
                        headers=make_headers(token))
    ok, data = safe_check(resp, account, cache)
    if not ok:
        return False, "请求失败"
    if data.get("code") == 0:
        msg = data.get("msg", "提现成功")
        return True, msg
    return False, data.get("msg", "提现失败")


def auto_cash_out(token: str, account: AccountConfig, cache: TaskCache) -> Dict:
    """自动提现：余额 >= 3 元时提现 3 元到支付宝"""
    result = {"attempted": False, "amount": 0, "msg": ""}

    # 查余额
    balance = get_balance(token, account, cache)
    if balance is None:
        log("获取可提现余额失败 (接口返回异常)", "WARN", account.display_name)
        result["msg"] = "获取余额失败"
        return result

    log(f"可提现余额: {balance:.2f} 元", "INFO", account.display_name)

    if balance < 3:
        log(f"余额不足 3 元，不执行提现", "SKIP", account.display_name)
        result["msg"] = f"余额不足 ({balance:.2f}元)"
        return result

    # 提现 3 元
    amount = 3.0
    log(f"余额 {balance:.2f}元 >= 3元，自动提现 {amount} 元...", "INFO", account.display_name)
    ok, msg = cash_out(token, account, cache, amount)

    if ok:
        log(f"提现成功: {msg}", "SUCCESS", account.display_name)
        result["attempted"] = True
        result["amount"] = amount
        result["msg"] = msg
    else:
        log(f"提现失败: {msg}", "WARN", account.display_name)
        result["attempted"] = True
        result["amount"] = 0
        result["msg"] = msg

    return result


def do_daily_tasks(account: AccountConfig, cache: TaskCache) -> Dict:
    result = {
        "sign": False, "resign": 0, "like": 0, "like_reward": False,
        "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
        "cash_out": {"attempted": False, "amount": 0, "msg": ""},
        "status": account.status, "status_message": account.status_message,
    }
    if not account.is_runnable():
        return result

    token = account.token
    if not token:
        account.set_status(AccountStatus.TOKEN_INVALID, "无 Token")
        result["status"] = account.status
        return result

    result["start_integral"] = get_integral(token, account, cache)
    log(f"当前积分: {result['start_integral']}", "INFO", account.display_name)

    # 1. 签到 & 补签
    if not cache.is_daily_task_done(account.account_id, "sign"):
        result["sign"], result["resign"] = do_sign_and_resign(token, account, cache)
        cache.mark_daily_task_done(account.account_id, "sign", True)
    else:
        log("签到任务今日已完成", "SKIP", account.display_name)

    if not account.is_runnable():
        result["end_integral"] = result["start_integral"]
        return result
    random_sleep(TASK_INTERVAL)

    # 2. 吃饭补贴
    result["eat"] = check_and_claim_eat_gold(token, account, cache)

    if not account.is_runnable():
        result["end_integral"] = result["start_integral"]
        return result
    random_sleep(TASK_INTERVAL)

    # 3. 点赞
    if not cache.is_daily_task_done(account.account_id, "like"):
        log("开始点赞任务...", "INFO", account.display_name)
        result["like"] = like_video(token, account, cache, 2)
        if result["like"] >= 2:
            cache.mark_daily_task_done(account.account_id, "like", True)
    else:
        log("点赞任务今日已完成", "SKIP", account.display_name)

    if not account.is_runnable():
        result["end_integral"] = result["start_integral"]
        return result
    random_sleep(TASK_INTERVAL)

    # 4. 领点赞奖励
    if result["like"] >= 2 and not cache.is_daily_task_done(account.account_id, "like_reward"):
        result["like_reward"] = claim_like_reward(token, account, cache)
        if result["like_reward"]:
            cache.mark_daily_task_done(account.account_id, "like_reward", True)

    if not account.is_runnable():
        result["end_integral"] = result["start_integral"]
        return result
    random_sleep(TASK_INTERVAL)

    # 5. 看视频时长
    random_sleep(TASK_INTERVAL)
    watch_duration(token, account, cache)

    # 6. 看广告
    result["video"] = watch_videos(token, account, cache)

    result["end_integral"] = get_integral(token, account, cache)
    earned = result["end_integral"] - result["start_integral"]
    if earned > 0:
        log(f"本次获得: +{earned} 积分", "SUCCESS", account.display_name)

    # 7. 自动提现
    if account.is_runnable():
        random_sleep(TASK_INTERVAL)
        result["cash_out"] = auto_cash_out(token, account, cache)
    else:
        result["cash_out"] = {"attempted": False, "amount": 0, "msg": "账号状态异常"}

    result["status"] = account.status
    return result

# ============================================================================
# 单账号处理
# ============================================================================

def process_account(account: AccountConfig, cache: TaskCache) -> Dict:
    print(f"\n{'='*50}")
    log(f"开始处理账号 (类型: {account.account_type})", "INFO", account.display_name)
    print(f"{'='*50}")

    # 检查今日无效标记
    is_invalid, reason = cache.is_account_invalid_today(account.account_id)
    if is_invalid:
        account.set_status(AccountStatus.TOKEN_INVALID, reason)
        log(f"账号今日已标记无效: {reason}", "SKIP", account.display_name)
        return {
            "sign": False, "resign": 0, "like": 0, "like_reward": False,
            "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
            "cash_out": {"attempted": False, "amount": 0, "msg": reason},
            "status": account.status, "status_message": reason,
        }

    if cache.is_banned(account.account_id):
        account.set_status(AccountStatus.BANNED, "账号已封禁")
        log("账号已封禁", "BANNED", account.display_name)
        return {
            "sign": False, "resign": 0, "like": 0, "like_reward": False,
            "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
            "cash_out": {"attempted": False, "amount": 0, "msg": "账号已封禁"},
            "status": account.status, "status_message": "账号已封禁",
        }

    try:
        if account.account_type == "manual":
            if not account.token:
                account.set_status(AccountStatus.TOKEN_INVALID, "未提供 Token")
                log("未提供 Token", "ERROR", account.display_name)
                return {
                    "sign": False, "resign": 0, "like": 0, "like_reward": False,
                    "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
                    "cash_out": {"attempted": False, "amount": 0, "msg": "未提供 Token"},
                    "status": account.status, "status_message": "未提供 Token",
                }
            log("使用手动提供的 Token", "INFO", account.display_name)

        elif account.account_type == "wx":
            token = cache.get_token(account.account_id)
            if not token:
                log("未找到缓存 token，通过 wechatserver 获取...", "INFO", account.display_name)
                token = refresh_token_wx(account, cache)
                if not token:
                    return {
                        "sign": False, "resign": 0, "like": 0, "like_reward": False,
                        "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
                        "cash_out": {"attempted": False, "amount": 0, "msg": account.status_message},
                        "status": account.status, "status_message": account.status_message,
                    }
                cache.save_token(account.account_id, token)
                account.token = token
            else:
                account.token = token
                log("使用缓存 token", "INFO", account.display_name)

        if not account.token:
            account.set_status(AccountStatus.TOKEN_INVALID, "无法获取 Token")
            return {
                "sign": False, "resign": 0, "like": 0, "like_reward": False,
                "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
                "cash_out": {"attempted": False, "amount": 0, "msg": "无法获取 Token"},
                "status": account.status, "status_message": "无法获取 Token",
            }

        # 验证 token 是否有效
        _ = get_integral(account.token, account, cache)
        if not account.is_runnable():
            if account.status == AccountStatus.TOKEN_EXPIRED and account.account_type == "wx":
                # token 过期，清除缓存后重新获取
                cache.clear_token(account.account_id)
                log("Token 过期，重新通过 wechatserver 获取...", "WARN", account.display_name)
                token = refresh_token_wx(account, cache)
                if token:
                    cache.save_token(account.account_id, token)
                    account.token = token
                    account.set_status(AccountStatus.OK)
                else:
                    return {
                        "sign": False, "resign": 0, "like": 0, "like_reward": False,
                        "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
                        "cash_out": {"attempted": False, "amount": 0, "msg": account.status_message},
                        "status": account.status, "status_message": account.status_message,
                    }
            else:
                return {
                    "sign": False, "resign": 0, "like": 0, "like_reward": False,
                    "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
                    "cash_out": {"attempted": False, "amount": 0, "msg": account.status_message},
                    "status": account.status, "status_message": account.status_message,
                }

        return do_daily_tasks(account, cache)

    except Exception as e:
        account.set_status(AccountStatus.UNKNOWN_ERROR, str(e))
        log(f"账号处理异常: {e}", "ERROR", account.display_name)
        return {
            "sign": False, "resign": 0, "like": 0, "like_reward": False,
            "video": 0, "eat": False, "start_integral": 0, "end_integral": 0,
            "cash_out": {"attempted": False, "amount": 0, "msg": str(e)},
            "status": account.status, "status_message": str(e),
        }

# ============================================================================
# 主函数
# ============================================================================

def main():
    start = datetime.now()
    print(f"=== 开始执行 [{start.strftime('%Y-%m-%d %H:%M:%S')}] ===")
    print(f"📍 小程序AppID: {APPID}")
    if WX_USERKEYS:
        print(f"📍 wechatserver: {WX_SERVER_URL}")
    print("=" * 60)

    accounts = load_accounts()
    cache = TaskCache(CACHE_FILE)

    wx_cnt = sum(1 for a in accounts if a.account_type == "wx")
    manual_cnt = sum(1 for a in accounts if a.account_type == "manual")
    print(f"📱 账号: wechatserver模式={wx_cnt} | 手动Token模式={manual_cnt} | 合计={len(accounts)}")

    slot = get_current_eat_slot()
    if slot:
        print(f"🍽️ 当前时段: {slot['name']} ({slot['start']}:00-{slot['end']}:00)")
    else:
        print("🍽️ 当前不在吃饭补贴时间段")

    print("\n" + "=" * 60)
    all_results = []
    random.shuffle(accounts)

    for i, account in enumerate(accounts):
        if i > 0:
            t = random.uniform(8, 15)
            log(f"切换账号，等待 {t:.1f}s...", "INFO")
            time.sleep(t)
        result = process_account(account, cache)
        all_results.append((account, result))

    print("\n" + "=" * 60)
    print("📊 执行汇总")
    print("=" * 60)

    total_earned = 0
    success_count = 0

    for account, result in all_results:
        earned = result["end_integral"] - result["start_integral"]
        total_earned += earned
        print(f"\n账号: {account.display_name}  [{account.account_type}]")

        s = result["status"]
        if s == AccountStatus.BANNED:
            print("  状态: 🚫 已封禁")
        elif s == AccountStatus.TOKEN_EXPIRED:
            print("  状态: ⏰ Token已过期")
        elif s in (AccountStatus.TOKEN_INVALID, AccountStatus.WX_ERROR):
            print(f"  状态: ❓ {result['status_message']}")
        elif s == AccountStatus.NETWORK_ERROR:
            print("  状态: 🌐 网络错误")
        elif s == AccountStatus.UNKNOWN_ERROR:
            print(f"  状态: ❌ {result['status_message']}")
        else:
            success_count += 1
            print("  状态: ✅ 正常")
            print(f"  签到: {'✅' if result['sign'] else '❌'}")
            if result["resign"] > 0:
                print(f"  补签: +{result['resign']} 次")
            print(f"  点赞: {result['like']}/2 次")
            print(f"  点赞奖励: {'✅' if result['like_reward'] else '❌'}")
            print(f"  吃饭补贴: {'✅' if result['eat'] else '❌'}")
            print(f"  看广告: {result['video']}/{MAX_VIDEO_PER_DAY} 次")
            co = result.get("cash_out", {})
            if co and co.get("attempted"):
                if co.get("amount", 0) > 0:
                    print(f"  提现: ✅ {co['amount']}元 → {co.get('msg', '')}")
                else:
                    print(f"  提现: ❌ {co.get('msg', '')}")
            elif co and co.get("msg") and "余额不足" not in co.get("msg", ""):
                print(f"  提现: ⏭️ {co.get('msg', '')}")
            print(f"  积分: {result['start_integral']} → {result['end_integral']} (+{earned})")

    print(f"\n{'='*50}")
    print(f"✅ 成功: {success_count} | ❌ 失败: {len(accounts)-success_count} | 💰 总获得: +{total_earned}")
    end = datetime.now()
    print(f"=== 执行结束 [{end.strftime('%H:%M:%S')}] 耗时 {(end-start).total_seconds():.1f}s ===")


class Tee:
    """同时写入多个流，用于实时显示+日志收集"""
    def __init__(self, *streams):
        self.streams = streams
    def write(self, data):
        for s in self.streams:
            try:
                s.write(data)
                s.flush()
            except:
                pass
    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except:
                pass
    def getvalue(self):
        for s in self.streams:
            if hasattr(s, 'getvalue'):
                return s.getvalue()
        return ''


if __name__ == "__main__":
    import io

    _log_capture = io.StringIO()
    _tee = Tee(sys.stdout, _log_capture)
    _old_stdout = sys.stdout
    _old_stderr = sys.stderr
    sys.stdout = _tee
    sys.stderr = _tee
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
        try:
            push_notify('牛牛短剧 签到结果', _logs[-2000:])
        except:
            pass


# ========== 已在main中处理推送 ==========

