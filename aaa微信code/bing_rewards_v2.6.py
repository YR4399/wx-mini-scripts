#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎯 Bing Rewards 自动化脚本 --v2.6

变量名：
bing_ck_1、bing_ck_2、bing_ck_3、bing_ck_4... （必需）
bing_token_1、bing_token_2、bing_token_3、bing_token_4... （可选，用于阅读任务）

下面url抓取CK，必须抓取到 tifacfaatcs 和认证字段，否则cookie无效
1. 登录 https://cn.bing.com/

2. 登录https://rewards.bing.com/welcome?rh=C21C0DC9&ref=rafsrchae&form=ML2XE3&OCID=ML2XE3&PUBL=RewardsDO&CREA=ML2XE3 
3. 确认两个地址登录的是同一个账号，抓CK

🔑 阅读任务需要配置刷新令牌：
1. 安装"Bing Rewards 自动获取刷新令牌"油猴脚本
2. 访问 https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&response_type=code&redirect_uri=https://login.live.com/oauth20_desktop.srf
3. 登录后，使用"Bing Rewards 自动获取刷新令牌"油猴脚本，自动获取刷新令牌
4. 设置环境变量 bing_token_1、bing_token_2、bing_token_3...

cron: 10 0-22 * * *
"""

from curl_cffi import requests as curl_requests
import random
import string
import re
import time
import json
import os
from datetime import datetime, date
from urllib.parse import quote, unquote, parse_qsl, urlencode, urlsplit, urlunsplit
import threading
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass
from functools import wraps
import traceback
import secrets
import uuid

SCRIPT_VERSION = "v2.6"

# ==================== 用户配置区域 ====================
# 在这里修改您的配置参数
# 
# 📝 配置说明：
# 1. 推送配置：设置Telegram和企业微信推送参数
# 2. 任务执行配置：调整搜索延迟、重试次数等执行参数
# 3. 缓存配置：设置缓存文件相关参数
# 
# 💡 修改建议：
# - 搜索延迟建议保持在25-35秒之间，避免过于频繁
# - 任务延迟建议保持在2-4秒之间，给系统响应时间
# - 重试次数建议不超过5次，避免过度重试
# - 请求超时建议15-30秒，根据网络情况调整
# - 重复运行次数建议3-5次，避免过度重复执行
# - 单轮电脑搜索最多执行次数，根据日志失败次数请自行灵活调整



# 任务执行配置
TASK_CONFIG = {
    'SEARCH_DELAY_MIN': 25,          # 搜索延迟最小值（秒）
    'SEARCH_DELAY_MAX': 35,          # 搜索延迟最大值（秒）
    'SEARCH_MAX_PER_ROUND': 20,      # 单轮电脑搜索最多执行次数
    'MAX_RETRIES': 3,                # 最大重试次数
    'RETRY_DELAY': 3,                # 重试延迟（秒）
    'REQUEST_TIMEOUT': 15,           # 请求超时时间（秒）
    'HOT_WORDS_MAX_COUNT': 20,       # 热搜词最大数量
    'MAX_REPEAT_COUNT': 3,           # 最大重复运行次数
}

# 缓存配置
CACHE_CONFIG = {
    'CACHE_FILE': "bing_cache.json",  # 缓存文件名
    'CACHE_ENABLED': True,            # 是否启用缓存
}

# 使用缓存配置
CACHE_ENABLED = CACHE_CONFIG['CACHE_ENABLED']


# ==================== 配置管理 ====================
@dataclass
class Config:
    """配置类，统一管理所有配置项"""
    # 搜索配置
    SEARCH_DELAY_MIN: int = TASK_CONFIG['SEARCH_DELAY_MIN']
    SEARCH_DELAY_MAX: int = TASK_CONFIG['SEARCH_DELAY_MAX']
    SEARCH_MAX_PER_ROUND: int = TASK_CONFIG['SEARCH_MAX_PER_ROUND']
    
    # 重试配置
    MAX_RETRIES: int = TASK_CONFIG['MAX_RETRIES']
    RETRY_DELAY: int = TASK_CONFIG['RETRY_DELAY']
    
    # 文件配置
    CACHE_FILE: str = CACHE_CONFIG['CACHE_FILE']
    
    # API配置
    REQUEST_TIMEOUT: int = TASK_CONFIG['REQUEST_TIMEOUT']
    HOT_WORDS_MAX_COUNT: int = TASK_CONFIG['HOT_WORDS_MAX_COUNT']
    DESKTOP_IMPERSONATE: str = "chrome146"
    MOBILE_IMPERSONATE: str = "safari260_ios"
    
    # 热搜API配置
    HOT_WORDS_APIS: List[Tuple[str, List[str]]] = None
    DEFAULT_HOT_WORDS: List[str] = None
    
    def __post_init__(self):
        if self.HOT_WORDS_APIS is None:
            self.HOT_WORDS_APIS = [
                ("https://dailyapi.eray.cc/", ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"]),
                ("https://hot.baiwumm.com/api/", ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq", "netease", "zhihu"]),
                ("https://cnxiaobai.com/DailyHotApi/", ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"]),
                ("https://hotapi.nntool.cc/", ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"]),
            ]
        
        if self.DEFAULT_HOT_WORDS is None:
            self.DEFAULT_HOT_WORDS = [
                "盛年不重来，一日难再晨", "千里之行，始于足下", "少年易学老难成，一寸光阴不可轻",
                "敏而好学，不耻下问", "海内存知已，天涯若比邻", "三人行，必有我师焉",
                "莫愁前路无知已，天下谁人不识君", "人生贵相知，何用金与钱", "天生我材必有用",
                '海纳百川有容乃大；壁立千仞无欲则刚', "穷则独善其身，达则兼济天下", "读书破万卷，下笔如有神",
            ]

config = Config()

# ==================== 账号管理 ====================
@dataclass
class AccountInfo:
    """账号信息类"""
    index: int
    alias: str
    cookies: str
    refresh_token: str = ""

class AccountManager:
    """账号管理器 - 读取环境变量中的账号配置"""
    
    @staticmethod
    def get_accounts() -> List[AccountInfo]:
        """获取所有账号配置"""
        accounts = []
        index = 1
        consecutive_empty = 0  # 连续空配置计数器
        max_consecutive_empty = 10  # 允许最多连续5个空配置
        max_check_index = 50  # 最大检查到第50个账号
        
        while index <= max_check_index:
            cookies = os.getenv(f"bing_ck_{index}")
            refresh_token = os.getenv(f"bing_token_{index}", "")
            
            # 如果既没有cookies也没有refresh_token
            if not cookies and not refresh_token:
                consecutive_empty += 1
                # 如果连续空配置超过限制，则停止搜索
                if consecutive_empty >= max_consecutive_empty:
                    break
                index += 1
                continue
            else:
                # 重置连续空配置计数器
                consecutive_empty = 0
            
            # 如果只有refresh_token没有cookies，跳过该账号
            if not cookies:
                print_log("账号配置", f"账号{index} 缺少cookies配置，跳过", index)
                # 发送缺少cookies配置的通知
                global_notification_manager.send_missing_cookies_config(index)
                index += 1
                continue
            
            alias = f"账号{index}"
            accounts.append(AccountInfo(
                index=index,
                alias=alias,
                cookies=cookies,
                refresh_token=refresh_token
            ))
            
            index += 1
        
        # 从令牌缓存文件加载保存的令牌
        for account in accounts:
            cached_token = global_token_cache_manager.get_cached_token(account.alias, account.index)
            if cached_token:
                account.refresh_token = cached_token
        
        # 如果没有有效账号，发送总结性通知
        if not accounts:
            global_notification_manager.send_no_valid_accounts()
        
        return accounts


# ==================== 日志系统 ====================

class LogIcons:
    """日志状态图标"""
    # 基础状态
    INFO = "📊"
    SUCCESS = "✅"
    FAILED = "❌"
    WARNING = "⚠️"
    SKIP = "⏭️"
    START = "🚀"
    COMPLETE = "🎉"
    
    # 任务类型
    SEARCH_PC = "💻"
    SEARCH_MOBILE = "📱"
    SEARCH_PROGRESS = "🔍"
    DAILY_TASK = "📅"
    MORE_TASK = "🎯"
    READ_TASK = "📖"
    
    # 账号相关
    ACCOUNT = "👤"
    POINTS = "💰"
    EMAIL = "📧"
    
    # 系统相关
    INIT = "⚙️"
    CACHE = "💾"
    TOKEN = "🔑"
    NOTIFY = "📢"

class LogFormatter:
    """日志格式化器"""
    
    @staticmethod
    def create_progress_bar(current: int, total: int, width: int = 8) -> str: 
        """创建进度条"""
        if total <= 0:
            return "∷" * width + f" 0/0"
        
        filled = int((current / total) * width)
        filled = min(filled, width)  # 确保不超过宽度
        
        bar = "█" * filled + "∷" * (width - filled)
        return f"{bar} {current}/{total}"
    
    @staticmethod
    def format_points_change(start: int, end: int) -> str:
        """格式化积分变化"""
        change = end - start
        if change > 0:
            return f"{start} → {end} (+{change})"
        elif change < 0:
            return f"{start} → {end} ({change})"
        else:
            return f"{start} (无变化)"

class LogLevel:
    """日志级别"""
    DEBUG = 0
    INFO = 1
    SUCCESS = 2
    WARNING = 3
    ERROR = 4

class EnhancedLogger:
    """增强的日志记录器 - 多线程安全版本"""
    
    def __init__(self, min_level: int = LogLevel.INFO):
        self.min_level = min_level
        self.formatter = LogFormatter()
        self.lock = threading.Lock()  # 添加线程锁
    
    def _get_timestamp(self) -> str:
        """获取时间戳"""
        return datetime.now().strftime("%H:%M:%S")
    
    def _format_account_prefix(self, account_index: Optional[int]) -> str:
        """格式化账号前缀"""
        if account_index is not None:
            return f"[账号{account_index}]"
        return "[系统]"
    
    def _log(self, level: int, icon: str, title: str, msg: str, account_index: Optional[int] = None):
        """内部日志方法 - 线程安全"""
        if level < self.min_level:
            return
            
        with self.lock:  # 确保线程安全
            timestamp = self._get_timestamp()
            account_prefix = self._format_account_prefix(account_index)
            log_message = f"{timestamp} {account_prefix} {icon} {title}: {msg or ''}"
            print(log_message, flush=True)
    
    # ==================== 基础日志方法 ====================
    def info(self, title: str, msg: str, account_index: Optional[int] = None):
        """信息日志"""
        self._log(LogLevel.INFO, LogIcons.INFO, title, msg, account_index)
    
    def success(self, title: str, msg: str, account_index: Optional[int] = None):
        """成功日志"""
        self._log(LogLevel.SUCCESS, LogIcons.SUCCESS, title, msg, account_index)
    
    def warning(self, title: str, msg: str, account_index: Optional[int] = None):
        """警告日志"""
        self._log(LogLevel.WARNING, LogIcons.WARNING, title, msg, account_index)
    
    def error(self, title: str, msg: str, account_index: Optional[int] = None):
        """错误日志"""
        self._log(LogLevel.ERROR, LogIcons.FAILED, title, msg, account_index)
    
    def skip(self, title: str, msg: str, account_index: Optional[int] = None):
        """跳过日志"""
        self._log(LogLevel.INFO, LogIcons.SKIP, title, msg, account_index)
    
    # ==================== 任务相关日志方法 ====================
    def account_start(self, email: str, initial_points: int, account_index: int):
        """账号开始处理"""
        # 邮箱脱敏显示：用户名前4位+**+完整域名
        if '@' in email:
            username, domain = email.split('@', 1)
            # 用户名显示前4位+**
            masked_username = username[:2] + "**" if len(username) > 4 else username + "**"
            # 保留完整域名
            masked_email = f"{masked_username}@{domain}"
        else:
            # 如果没有@符号，简单处理
            masked_email = email[:2] + "**" if len(email) > 4 else email
        
        msg = f"{masked_email} ({initial_points})"
        self._log(LogLevel.INFO, LogIcons.START, "初始化", msg, account_index)
    
    # ==================== 搜索相关日志方法 ====================
    def search_start(self, search_type: str, required: int, account_index: int, planned: Optional[int] = None):
        """搜索开始"""
        icon = LogIcons.SEARCH_PC if search_type == "电脑" else LogIcons.SEARCH_MOBILE
        actual = planned if planned is not None else required
        msg = f"理论需{required}次，本轮执行{actual}次"
        self._log(LogLevel.INFO, icon, f"{search_type}搜索开始", msg, account_index)
    
    def search_progress(self, search_type: str, current: int, total: int, delay: int, account_index: int):
        """搜索进度"""
        progress_bar = self.formatter.create_progress_bar(current, total)
        msg = f"{progress_bar}"
        self._log(LogLevel.INFO, LogIcons.SEARCH_PROGRESS, f"{search_type}搜索中", msg, account_index)
        self._log(LogLevel.INFO, LogIcons.INFO, f"{search_type}搜索", f"第 {current} 次搜索成功，等待 {delay} 秒", account_index)

    def search_progress_bar(self, search_type: str, current: int, total: int, account_index: int):
        """仅记录搜索进度条，不附带成功文案。"""
        progress_bar = self.formatter.create_progress_bar(current, total)
        self._log(LogLevel.INFO, LogIcons.SEARCH_PROGRESS, f"{search_type}搜索中", progress_bar, account_index)
    
    def search_complete(self, search_type: str, attempts: int, account_index: int, success: bool = True):
        """搜索完成"""
        icon = LogIcons.SEARCH_PC if search_type == "电脑" else LogIcons.SEARCH_MOBILE
        if success:
            msg = f"任务已完成，执行了{attempts}次搜索"
            self._log(LogLevel.SUCCESS, LogIcons.SUCCESS, f"{search_type}搜索", msg, account_index)
        else:
            msg = f"任务未完成，执行了{attempts}次搜索"
            self._log(LogLevel.WARNING, LogIcons.WARNING, f"{search_type}搜索", msg, account_index)
    
    def search_progress_summary(self, search_type: str, count: int, start_progress: int, end_progress: int, account_index: int, success_count: Optional[int] = None, failed_count: Optional[int] = None, ignored_count: int = 0):
        """搜索进度总结"""
        msg = f"已完成{count}次，进度: {start_progress} → {end_progress}"
        if success_count is not None and failed_count is not None:
            msg = f"成功{success_count}次，失败{failed_count}次，进度: {start_progress} → {end_progress}"
            if ignored_count > 0:
                msg = f"成功{success_count}次，失败{failed_count}次，忽略{ignored_count}次，进度: {start_progress} → {end_progress}"
        self._log(LogLevel.INFO, LogIcons.SEARCH_PROGRESS, f"{search_type}搜索", msg, account_index)
    
    def search_skip(self, search_type: str, reason: str, account_index: int):
        """搜索跳过"""
        icon = LogIcons.SEARCH_PC if search_type == "电脑" else LogIcons.SEARCH_MOBILE
        self._log(LogLevel.INFO, LogIcons.SKIP, f"{search_type}搜索", f"跳过 ({reason})", account_index)
    


# 创建全局日志实例
logger = EnhancedLogger()

def print_log(title: str, msg: str, account_index: Optional[int] = None):
    """保持向后兼容的日志函数"""
    # 自动识别日志类型并使用对应的图标
    title_lower = title.lower()
    msg_text = msg if isinstance(msg, str) else (str(msg) if msg is not None else "")
    msg_lower = msg_text.lower()
    
    # 根据标题和消息内容选择合适的日志方法
    # 特殊处理：系统提示类消息优先识别为警告
    if ("提示" in title or "建议" in title or "提示" in msg_lower or "建议" in msg_lower):
        logger.warning(title, msg, account_index)
    # 优先检查失败/错误/未完成情况
    elif ("失败" in title or "错误" in title or "失败" in msg_lower or "错误" in msg_lower or "❌" in msg_text or 
        ("未完成" in msg_lower and "找到" not in msg_lower) or "终止" in msg_lower or "取消" in msg_lower):
        logger.error(title, msg, account_index)
    elif ("成功" in title or "完成" in title or "成功" in msg_lower or ("完成" in msg_lower and "未完成" not in msg_lower) or "✅" in msg_text):
        logger.success(title, msg, account_index)
    elif ("跳过" in title or "skip" in title_lower or "跳过" in msg_lower):
        logger.skip(title, msg, account_index)
    elif ("警告" in title or "warning" in title_lower or "警告" in msg_lower):
        logger.warning(title, msg, account_index)
    # 特殊处理：包含"找到"的消息通常是信息性的，使用信息图标
    elif "找到" in msg_lower:
        logger.info(title, msg, account_index)
    else:
        logger.info(title, msg, account_index)

# ==================== 异常处理装饰器 ====================
def retry_on_failure(max_retries: int = config.MAX_RETRIES, delay: int = config.RETRY_DELAY):
    """重试装饰器"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            
            # 获取更友好的函数名显示
            func_name = func.__name__
            if func_name == 'make_request':
                func_name = "网络请求"
            elif func_name == 'get_access_token':
                func_name = "令牌获取"
            elif func_name == 'get_read_progress':
                func_name = "阅读进度"
            elif func_name == 'submit_read_activity':
                func_name = "阅读请求"
            elif func_name == 'get_rewards_points':
                func_name = "积分查询"
            
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if attempt < max_retries - 1:
                        account_index = kwargs.get('account_index')
                        if account_index is not None:
                            print_log(f"{func_name}重试", f"第{attempt + 1}次尝试失败，{delay}秒后重试...", account_index)
                        else:
                            print_log(f"{func_name}重试", f"第{attempt + 1}次尝试失败，{delay}秒后重试...")
                        time.sleep(delay)
                    else:
                        account_index = kwargs.get('account_index')
                        if account_index is not None:
                            print_log(f"{func_name}失败", f"重试{max_retries}次后仍失败: {e}", account_index)
                        else:
                            print_log(f"{func_name}失败", f"重试{max_retries}次后仍失败: {e}")
            raise last_exception
        return wrapper
    return decorator

# ==================== 通知系统 ====================

class NotificationTemplates:
    """通知模板管理器 - 统一管理所有通知内容"""
    
    # Cookie获取地址
    COOKIE_URLS = "https://rewards.bing.com/dashboard"
    
    @staticmethod
    def get_cookie_urls_text() -> str:
        """获取Cookie获取地址的格式化文本"""
        return f"   {NotificationTemplates.COOKIE_URLS}"
    
    @staticmethod
    def get_current_time() -> str:
        """获取当前时间格式化字符串"""
        return datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    @classmethod
    def missing_cookies_config(cls, account_index: int) -> tuple[str, str]:
        """缺少cookies配置的通知模板"""
        title = "🚨 Microsoft Rewards 配置缺失"
        content = (
            f"账号{account_index} 缺少cookies配置\n\n"
            f"错误时间: {cls.get_current_time()}\n"
            f"需要处理: 为账号{account_index}添加环境变量 bing_ck_{account_index}\n\n"
            f"配置说明:\n"
            f"1. 设置环境变量: bing_ck_{account_index}=你的完整cookie字符串\n"
            f"2. Cookie获取地址:\n"
            f"{cls.get_cookie_urls_text()}"
        )
        return title, content
    
    @classmethod
    def cookie_missing_required_field(cls, account_index: int, field_name: str) -> tuple[str, str]:
        """Cookie缺少必需字段的通知模板"""
        title = "🚨 Microsoft Rewards Cookie配置错误"
        content = (
            f"账号{account_index} 的Cookie缺少必需字段: {field_name}\n\n"
            f"错误时间: {cls.get_current_time()}\n"
            f"需要处理: 重新获取账号{account_index}的完整Cookie\n\n"
            f"Cookie获取地址:\n"
            f"{cls.get_cookie_urls_text()}"
        )
        return title, content
    
    @classmethod
    def cookie_missing_auth_field(cls, account_index: int) -> tuple[str, str]:
        """Cookie缺少认证字段的通知模板"""
        title = "🚨 Microsoft Rewards Cookie认证字段缺失"
        content = (
            f"账号{account_index} 的Cookie缺少认证字段（需要包含 .MSA.Auth）\n\n"
            f"错误时间: {cls.get_current_time()}\n"
            f"需要处理: 重新获取账号{account_index}的完整Cookie\n\n"
            f"Cookie获取地址:\n"
            f"{cls.get_cookie_urls_text()}"
        )
        return title, content
    
    @classmethod
    def no_valid_accounts(cls) -> tuple[str, str]:
        """无有效账号配置的通知模板"""
        title = "🚨 Microsoft Rewards 无有效账号配置"
        content = (
            "所有账号配置均存在问题，无法启动任务！\n\n"
            f"检查时间: {cls.get_current_time()}\n\n"
            "常见问题及解决方案:\n"
            "1. 环境变量未设置: 检查 bing_ck_1, bing_ck_2 等\n"
            "2. Cookie格式错误: 不要有多余的空格或者换行符，引号需要转义\n"
            "3. Cookie不完整: 确保Cookie复制完整\n\n"
            f"Cookie获取地址:\n"
            f"{cls.get_cookie_urls_text()}"
        )
        return title, content
    
    @classmethod
    def cookie_invalid(cls, account_index: Optional[int] = None) -> tuple[str, str]:
        """Cookie失效的通知模板"""
        account_info = f"账号{account_index} " if account_index else ""
        title = "🚨 Microsoft Rewards Cookie失效"
        content = (
            f"{account_info}Cookie已失效，无法获取积分和邮箱，请重新获取\n\n"
            f"失效时间: {cls.get_current_time()}\n"
            f"需要处理: 重新获取{account_info}的完整Cookie\n\n"
            f"Cookie获取地址:\n"
            f"{cls.get_cookie_urls_text()}"
        )
        return title, content
    
    @classmethod
    def token_invalid(cls, account_index: Optional[int] = None) -> tuple[str, str]:
        """Token失效的通知模板"""
        account_info = f"账号{account_index} " if account_index else ""
        title = "🚨 Microsoft Rewards Token失效"
        content = (
            f"{account_info}Refresh Token已失效，需要重新获取\n\n"
            f"失效时间: {cls.get_current_time()}\n"
            f"需要处理: 重新获取{account_info}的Refresh Token\n\n"
            "获取方法:\n"
            "1. 访问 https://login.live.com/oauth20_authorize.srf\n"
            "2. 使用Microsoft账号登录\n"
            "3. 获取授权码并换取Refresh Token"
        )
        return title, content
    
    @classmethod
    def task_summary(cls, summaries: List[str]) -> tuple[str, str]:
        """任务完成总结的通知模板"""
        title = "✅ Microsoft Rewards 任务完成"
        content = "\n\n".join(summaries)
        return title, content

class NotificationManager:
    """通知管理器"""
    
    def __init__(self):
        self.notify_client = self._init_notify_client()
    
    def _init_notify_client(self):
        """初始化通知客户端"""
        try:
            import notify
            # 检查是否已经配置了推送参数
            if hasattr(notify, 'notify_function') and notify.notify_function:
                return notify
            else:
                # 如果没有配置推送参数，使用默认的notify配置
                return notify
        except ImportError:
            return self._create_mock_notify()
    
    def _create_mock_notify(self):
        """创建模拟通知客户端"""
        class MockNotify:
            def send(self, title, content):
                print("\n--- [通知] ---")
                print(f"标题: {title}")
                print(f"内容:\n{content}")
                print("-------------------------------")
        return MockNotify()
    
    def send(self, title: str, content: str):
        """发送通知"""
        self.notify_client.send(title, content)
    
    # 便捷的通知方法
    def send_missing_cookies_config(self, account_index: int):
        """发送缺少cookies配置的通知"""
        title, content = NotificationTemplates.missing_cookies_config(account_index)
        self.send(title, content)
    
    def send_cookie_missing_required_field(self, account_index: int, field_name: str):
        """发送Cookie缺少必需字段的通知"""
        title, content = NotificationTemplates.cookie_missing_required_field(account_index, field_name)
        self.send(title, content)
    
    def send_cookie_missing_auth_field(self, account_index: int):
        """发送Cookie缺少认证字段的通知"""
        title, content = NotificationTemplates.cookie_missing_auth_field(account_index)
        self.send(title, content)
    
    def send_no_valid_accounts(self):
        """发送无有效账号配置的通知"""
        title, content = NotificationTemplates.no_valid_accounts()
        self.send(title, content)
    
    def send_cookie_invalid(self, account_index: Optional[int] = None):
        """发送Cookie失效的通知"""
        title, content = NotificationTemplates.cookie_invalid(account_index)
        self.send(title, content)
    
    def send_token_invalid(self, account_index: Optional[int] = None):
        """发送Token失效的通知"""
        title, content = NotificationTemplates.token_invalid(account_index)
        self.send(title, content)
    
    def send_task_summary(self, summaries: List[str]):
        """发送任务完成总结的通知"""
        title, content = NotificationTemplates.task_summary(summaries)
        self.send(title, content)

global_notification_manager = NotificationManager()  # 全局通知管理器，用于账号验证阶段

# ==================== 缓存管理 ====================
class CacheManager:
    """缓存管理器"""
    
    def __init__(self, cache_file: str = config.CACHE_FILE):
        self.cache_file = cache_file
        self.lock = threading.Lock()
    
    def load_cache(self) -> Dict[str, Any]:
        """加载缓存数据（返回统一缓存文件的全部数据）"""
        return self._load_unified_cache()

    def save_cache(self, data: Dict[str, Any]):
        """保存缓存数据到统一缓存文件"""
        try:
            with self.lock:
                # 读取现有的统一缓存数据
                all_cache_data = self._load_unified_cache()
                
                # 清理整个缓存文件中的过期推送记录
                today = date.today().isoformat()
                all_cache_data = self._clean_expired_data(all_cache_data, today)
                
                # 更新传入的数据
                for key, value in data.items():
                    all_cache_data[key] = value
                
                # 保存到统一缓存文件
                self._save_unified_cache(all_cache_data)
                
        except Exception as e:
            print_log("缓存错误", f"保存缓存失败: {e}")
    
    def _load_unified_cache(self) -> Dict[str, Any]:
        """加载统一缓存文件"""
        return global_token_cache_manager._load_all_cache_data()
    
    def _save_unified_cache(self, data: Dict[str, Any]):
        """保存到统一缓存文件"""
        global_token_cache_manager._save_all_cache_data(data)
    
    def _clean_expired_data(self, data: Dict[str, Any], today: str) -> Dict[str, Any]:
        """清理非当天的旧缓存键，并统一为固定按天字段。"""
        cleaned: Dict[str, Any] = {}
        for k, v in data.items():
            # 移除历史动态日期键
            if k.startswith('push_') or k.startswith('tasks_complete_'):
                continue
            # 移除历史冗余兼容字段
            if k in ('push', 'push_date', 'tasks_complete', 'tasks_complete_date'):
                continue
            cleaned[k] = v

        # 仅保留当天固定字段
        if cleaned.get('daily_date') != today:
            cleaned.pop('daily_push', None)
            cleaned.pop('daily_tasks_complete', None)
            cleaned['daily_date'] = today

        return cleaned
    @staticmethod
    def _to_non_negative_int(value: Any, default: int = 0) -> int:
        """将值安全转换为非负整数"""
        try:
            parsed = int(value)
            return parsed if parsed >= 0 else default
        except (TypeError, ValueError):
            return default
    
    def _get_legacy_tasks_complete_count(self, data: Dict[str, Any], today: str) -> int:
        """读取旧版 tasks_complete 字段（仅当天有效）"""
        if data.get("tasks_complete_date") != today:
            return 0
        return self._to_non_negative_int(data.get("tasks_complete", 0), 0)
    
    def has_pushed_today(self) -> bool:
        """是否今日已推送。"""
        today = date.today().isoformat()
        data = self.load_cache()

        # 固定字段优先
        if data.get("daily_date") == today:
            return bool(data.get("daily_push", False))

        # 兼容旧字段（仅迁移读取）
        if data.get(f"push_{today}", False):
            return True
        return bool(data.get("push", False) and data.get("push_date") == today)
    def mark_pushed_today(self):
        """标记今日已推送。"""
        today = date.today().isoformat()
        with self.lock:
            all_cache_data = self._load_unified_cache()
            all_cache_data = self._clean_expired_data(all_cache_data, today)
            all_cache_data["daily_date"] = today
            all_cache_data["daily_push"] = True
            self._save_unified_cache(all_cache_data)
    def get_tasks_complete_count(self) -> int:
        """获取今日任务完成次数。"""
        today = date.today().isoformat()
        data = self.load_cache()

        # 固定字段优先
        if data.get("daily_date") == today:
            return self._to_non_negative_int(data.get("daily_tasks_complete", 0), 0)

        # 兼容旧字段（仅迁移读取）
        today_count = data.get(f"tasks_complete_{today}")
        if today_count is not None:
            return self._to_non_negative_int(today_count, 0)

        return self._get_legacy_tasks_complete_count(data, today)
    def increment_tasks_complete_count(self):
        """Increase today's completed-task counter."""
        today = date.today().isoformat()
        with self.lock:
            all_cache_data = self._load_unified_cache()
            all_cache_data = self._clean_expired_data(all_cache_data, today)
            current_count = self._to_non_negative_int(all_cache_data.get("daily_tasks_complete", 0), 0)

            new_count = current_count + 1

            if new_count > TASK_CONFIG['MAX_REPEAT_COUNT']:
                print_log("TASK_COUNT", f"Reached max {TASK_CONFIG['MAX_REPEAT_COUNT']}, skip increment", None)
                return

            all_cache_data["daily_date"] = today
            all_cache_data["daily_tasks_complete"] = new_count
            self._save_unified_cache(all_cache_data)

        print_log("RUN_COUNT", f"{new_count}/{TASK_CONFIG['MAX_REPEAT_COUNT']}", None)

        if new_count >= TASK_CONFIG['MAX_REPEAT_COUNT']:
            print_log("RUN_COUNT", "Reached max", None)
    def should_skip_execution(self) -> bool:
        """检查是否应该跳过脚本执行（任务已完成指定次数）"""
        return self.get_tasks_complete_count() >= TASK_CONFIG['MAX_REPEAT_COUNT']
    


global_cache_manager = CacheManager()  # 全局缓存管理器，用于推送状态检查

# ==================== Refresh Token 缓存管理 ====================
class TokenCacheManager:
    """Refresh Token 缓存管理器"""
    
    def __init__(self, token_file: str = config.CACHE_FILE):
        self.token_file = token_file
        self.lock = threading.Lock()
        self._cached_tokens = {}  # 内存缓存，避免重复保存
    
    def _load_all_cache_data(self) -> Dict[str, Any]:
        """加载统一缓存文件的所有数据"""
        if not os.path.exists(self.token_file):
            return {}
        
        try:
            with open(self.token_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:  # 如果文件为空，返回空字典
                    return {}
                return json.loads(content)
        except json.JSONDecodeError as e:
            print_log("缓存错误", f"JSON格式错误: {e}，尝试修复文件")
            # 尝试修复损坏的JSON文件
            self._repair_json_file()
            return {}
        except Exception as e:
            print_log("缓存错误", f"读取失败: {e}")
            return {}
    
    def _save_all_cache_data(self, data: Dict[str, Any]):
        """保存数据到统一缓存文件"""
        try:
            # 使用线程安全的临时文件名（添加线程ID和随机数）
            thread_id = threading.get_ident()
            random_suffix = random.randint(1000, 9999)
            temp_file = f"{self.token_file}.tmp.{thread_id}.{random_suffix}"
            
            try:
                # 原子性保存到文件（先写临时文件，再重命名）
                with open(temp_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                
                # 原子性重命名
                import shutil
                shutil.move(temp_file, self.token_file)
                
            except Exception as file_error:
                # 清理临时文件
                try:
                    if os.path.exists(temp_file):
                        os.remove(temp_file)
                except:
                    pass
                raise file_error
                
        except Exception as e:
            print_log("缓存错误", f"保存失败: {e}")
    

    
    def save_token(self, account_alias: str, refresh_token: str, account_index: Optional[int] = None):
        """保存刷新令牌到统一缓存文件"""
        try:
            # 检查是否已经缓存过相同的令牌
            cache_key = f"{account_alias}_{refresh_token}"
            if cache_key in self._cached_tokens:
                return  # 已经缓存过，跳过
            
            with self.lock:
                # 确保目录存在
                os.makedirs(os.path.dirname(self.token_file) if os.path.dirname(self.token_file) else '.', exist_ok=True)
                
                # 读取现有缓存数据（包含推送状态等）
                all_cache_data = self._load_all_cache_data()
                
                # 获取或初始化tokens部分
                if 'tokens' not in all_cache_data:
                    all_cache_data['tokens'] = {}
                
                # 检查是否与现有令牌相同
                existing_token = all_cache_data['tokens'].get(account_alias, {}).get("refreshToken")
                if existing_token == refresh_token:
                    # 标记为已缓存，避免重复尝试
                    self._cached_tokens[cache_key] = True
                    return  # 令牌没有变化，跳过
                
                # 更新令牌
                all_cache_data['tokens'][account_alias] = {
                    "refreshToken": refresh_token,
                    "updatedAt": datetime.now().isoformat()
                }
                
                # 保存到统一缓存文件
                self._save_all_cache_data(all_cache_data)
                
                # 标记为已缓存
                self._cached_tokens[cache_key] = True
                
                print_log("令牌缓存", "更新成功", account_index)
                
        except Exception as e:
            print_log("令牌缓存", f"更新失败: {e}", account_index)
    
    def get_cached_token(self, account_alias: str, account_index: Optional[int] = None) -> Optional[str]:
        """获取缓存的刷新令牌"""
        try:
            all_cache_data = self._load_all_cache_data()
            tokens = all_cache_data.get('tokens', {})
            account_data = tokens.get(account_alias)
            if account_data and account_data.get("refreshToken"):
                return account_data["refreshToken"]
            return None
        except Exception as e:
            print_log("令牌缓存", f"读取失败: {e}", account_index)
            return None
    
    def _repair_json_file(self):
        """尝试修复损坏的JSON文件"""
        try:
            # 备份损坏的文件
            backup_file = self.token_file + f".backup_{int(time.time())}"
            if os.path.exists(self.token_file):
                import shutil
                shutil.copy2(self.token_file, backup_file)
                print_log("令牌缓存", f"已备份损坏文件到: {backup_file}")
            
            # 创建新的空文件
            with open(self.token_file, "w", encoding="utf-8") as f:
                json.dump({}, f, ensure_ascii=False, indent=2)
            
            print_log("令牌缓存", "已重新创建令牌缓存文件")
        except Exception as e:
            print_log("令牌缓存", f"修复文件失败: {e}")

global_token_cache_manager = TokenCacheManager()  # 全局令牌缓存管理器，用于账号验证阶段

# ==================== 提前检查重复运行次数 ====================
# 在热搜词管理器初始化之前检查是否应该跳过执行
try:
    current_complete_count = global_cache_manager.get_tasks_complete_count()
    
    # 强制检查计数是否超过设定次数
    if current_complete_count >= TASK_CONFIG['MAX_REPEAT_COUNT']:
        print_log("脚本跳过", f"已重复运行{current_complete_count}次，跳过执行")
        exit(0)
    elif current_complete_count > 0:
        print_log("系统提示", f"已重复运行{current_complete_count}/{TASK_CONFIG['MAX_REPEAT_COUNT']}次", None)
except Exception as e:
    # 如果检查失败，继续执行
    print_log("检查警告", f"检查重复运行次数失败: {e}", None)

# ==================== 热搜词管理 ====================
class HotWordsManager:
    """热搜词管理器"""
    
    def __init__(self):
        self.hot_words = self._fetch_hot_words()
    
    @retry_on_failure(max_retries=2, delay=1)
    def _fetch_hot_words(self, max_count: int = config.HOT_WORDS_MAX_COUNT) -> List[str]:
        """获取热搜词"""
        apis_shuffled = config.HOT_WORDS_APIS[:]
        random.shuffle(apis_shuffled)
        
        for base_url, sources in apis_shuffled:
            sources_shuffled = sources[:]
            random.shuffle(sources_shuffled)
            
            for source in sources_shuffled:
                api_url = base_url + source
                try:
                    resp = curl_requests.get(
                        api_url,
                        timeout=10,
                        impersonate=config.DESKTOP_IMPERSONATE
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        if isinstance(data, dict) and 'data' in data and data['data']:
                            all_titles = [item.get('title') for item in data['data'] if item.get('title')]
                            if all_titles:
                                print_log("热搜词", f"成功获取热搜词 {len(all_titles)} 条，来源: {api_url}")
                                random.shuffle(all_titles)
                                return all_titles[:max_count]
                except Exception:
                    continue
        
        print_log("热搜词", "全部热搜API失效，使用默认搜索词。")
        default_words = config.DEFAULT_HOT_WORDS[:max_count]
        random.shuffle(default_words)
        return default_words
    
    def get_random_word(self) -> str:
        """获取随机热搜词"""
        return random.choice(self.hot_words) if self.hot_words else random.choice(config.DEFAULT_HOT_WORDS)

    def refresh_hot_words(self):
        """刷新热搜词池，供长流程搜索中途更换搜索词使用"""
        self.hot_words = self._fetch_hot_words()

hot_words_manager = HotWordsManager()

# ==================== HTTP请求管理 ====================
class RequestManager:
    """HTTP请求管理器 - 支持独立Session"""
    
    def __init__(self):
        """初始化请求管理器，创建独立的Session"""
        self.desktop_session = curl_requests.Session()
        self.mobile_session = curl_requests.Session()

    @staticmethod
    def _clean_headers(headers: Dict[str, Optional[str]]) -> Dict[str, str]:
        """移除值为空的请求头，避免发送无效字段。"""
        return {
            str(key): str(value)
            for key, value in headers.items()
            if value is not None and value != ""
        }

    def _get_session(self, profile: str):
        """根据请求画像返回对应的 Session。"""
        if profile == "mobile":
            return self.mobile_session
        return self.desktop_session

    @staticmethod
    def _get_impersonate(profile: str) -> str:
        """根据请求画像返回 curl_cffi 指纹。"""
        if profile == "mobile":
            return config.MOBILE_IMPERSONATE
        return config.DESKTOP_IMPERSONATE

    def get_browser_headers(
        self,
        cookies: str = "",
        referer: str = "https://rewards.bing.com/",
        origin: Optional[str] = None,
        accept: str = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        accept_language: str = "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        extra: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """获取桌面端浏览器请求头。"""
        headers: Dict[str, Optional[str]] = {
            "Accept": accept,
            "Accept-Language": accept_language,
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Referer": referer,
            "Origin": origin,
            "Cookie": cookies
        }
        if extra:
            headers.update(extra)
        return self._clean_headers(headers)

    def get_mobile_headers(
        self,
        cookies: str = "",
        referer: str = "https://bingapp.microsoft.com/",
        origin: Optional[str] = "https://bingapp.microsoft.com",
        accept: str = "application/json, text/plain, */*",
        accept_language: str = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        extra: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """获取移动端请求头。"""
        headers: Dict[str, Optional[str]] = {
            "Accept": accept,
            "Accept-Language": accept_language,
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Referer": referer,
            "Origin": origin,
            "Cookie": cookies
        }
        if extra:
            headers.update(extra)
        return self._clean_headers(headers)

    def get_rewards_app_headers(
        self,
        access_token: str,
        partner_id: str = "startapp",
        app_id: str = "SAAndroid/32.2.430730002",
        country: str = "cn",
        language: str = "zh",
        flights: str = "rwgobig",
        content_type: Optional[str] = None,
        extra: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """获取 Rewards 移动端接口通用请求头。"""
        headers = self.get_mobile_headers(
            extra={
                "Authorization": f"Bearer {access_token}",
                "x-rewards-partnerid": partner_id,
                "x-rewards-appid": app_id,
                "x-rewards-country": country,
                "x-rewards-language": language,
                "x-rewards-flights": flights,
                "Content-Type": content_type
            }
        )
        if extra:
            headers.update(self._clean_headers(extra))
        return headers

    def get_edge_rewards_headers(
        self,
        access_token: str,
        content_type: Optional[str] = None,
        extra: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """获取 Edge 桌面端 Rewards 接口请求头。"""
        headers = self.get_browser_headers(
            referer="https://rewards.bing.com/earn",
            origin="https://rewards.bing.com",
            accept="application/json, text/plain, */*",
            extra={
                "Authorization": f"Bearer {access_token}",
                "X-Rewards-PartnerId": "EdgeHub",
                "X-Rewards-AppId": "EdgeDesktop",
                "X-Rewards-Country": "CN",
                "X-Rewards-Language": "zh-CN",
                "Content-Type": content_type
            }
        )
        if extra:
            headers.update(self._clean_headers(extra))
        return headers

    def get_rsc_headers(
        self,
        cookies: str,
        accept_language: str,
        referer: str = "https://rewards.bing.com/earn",
        origin: Optional[str] = None,
        extra: Optional[Dict[str, str]] = None
    ) -> Dict[str, str]:
        """获取 RSC 请求头。"""
        headers = self.get_browser_headers(
            cookies=cookies,
            referer=referer,
            origin=origin,
            accept="*/*",
            accept_language=accept_language,
            extra={"rsc": "1"}
        )
        if extra:
            headers.update(self._clean_headers(extra))
        return headers

    @retry_on_failure(max_retries=2)
    def make_request(self, method: str, url: str, headers: Dict[str, str], 
                 params: Optional[Dict] = None, data: Optional[str] = None,
                 timeout: int = config.REQUEST_TIMEOUT, account_index: Optional[int] = None,
                 allow_redirects: bool = True, profile: str = "desktop") -> Any:
        """统一的HTTP请求方法，底层使用 curl_cffi 并按端类型切换浏览器指纹。"""
        method_upper = method.upper()
        if method_upper not in ("GET", "POST"):
            raise ValueError(f"不支持的HTTP方法: {method}")
        session = self._get_session(profile)
        request_kwargs: Dict[str, Any] = {
            "headers": headers,
            "params": params,
            "timeout": timeout,
            "allow_redirects": allow_redirects,
            "impersonate": self._get_impersonate(profile)
        }
        if method_upper == "POST":
            content_type = str(headers.get("Content-Type", "") or "").lower()
            if content_type.startswith("application/json") and data is not None:
                if isinstance(data, (dict, list)):
                    request_kwargs["json"] = data
                else:
                    try:
                        request_kwargs["json"] = json.loads(data)
                    except Exception:
                        request_kwargs["data"] = data
            else:
                request_kwargs["data"] = data
        return session.request(method_upper, url, **request_kwargs)
    
    def close(self):
        """关闭Session"""
        for attr_name in ("desktop_session", "mobile_session"):
            session = getattr(self, attr_name, None)
            if session is not None:
                session.close()

# ==================== 主要业务逻辑类 ====================
class RewardsService:
    """Microsoft Rewards服务类 - 增强版本支持令牌缓存和独立Session"""
    
    # ==================== 1. 基础设施方法 ====================
    def __init__(self):
        """初始化服务，创建独立的请求管理器和通知管理器"""
        self.request_manager = RequestManager()
        self.notification_manager = NotificationManager()  # 每个实例独立的通知管理器
        # 为每个实例创建独立的缓存管理器，避免文件锁竞争
        self.cache_manager = CacheManager()
        self.token_cache_manager = TokenCacheManager()
        # 电脑搜索诊断日志去重：同一账号仅打印一次详细诊断
        self._pc_search_diag_logged_accounts: set = set()
        self.last_pc_search_result: Optional[Dict[str, Any]] = None
        self._last_pc_search_report_earned: Optional[int] = None
        self._pc_search_bootstrap_active: bool = False
    
    def __del__(self):
        """析构函数，确保Session被正确关闭"""
        if hasattr(self, 'request_manager'):
            self.request_manager.close()
    
    # ==================== 2. 核心数据获取方法 ====================
    @retry_on_failure()
    def get_rewards_points(self, cookies: str, account_index: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """查询当前积分、账号信息和获取token"""
        headers = self.request_manager.get_browser_headers(
            cookies=cookies,
            referer='https://rewards.bing.com/earn',
            accept='*/*'
        )
        
        url = 'https://rewards.bing.com/dashboard'
        
        response = self.request_manager.make_request('GET', url, headers, account_index=account_index, allow_redirects=True)
        if 'login.live.com' in response.url:
            print_log("账号信息", "已跳转到登录页面，Cookie失效", account_index)
            self._send_cookie_invalid_notification(account_index)
            return None
        elif response.status_code != 200:
            raise Exception(f"积分页请求失败，状态码: {response.status_code}")
        
        content = response.text
        
        # 提取积分和邮箱
        points_pattern = r'\\?"balance\\?"\s*:\s*(\d+)'
        email_pattern = r'\\?"children\\?"\s*:\s*\\?"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\\?"'
        
        points_match = re.search(points_pattern, content)
        email_match = re.search(email_pattern, content)
        
        available_points = int(points_match.group(1)) if points_match else None
        email = email_match.group(1) if email_match else None
        if available_points is not None:
            return {
                'points': available_points,
                'email': email or '未知邮箱'
            }

    # ==================== 3. 令牌相关方法 ====================
    @retry_on_failure()
    def get_access_token(self, refresh_token: str, account_alias: str = "", account_index: Optional[int] = None, silent: bool = False) -> Optional[str]:
        """获取访问令牌用于阅读任务 - 支持令牌自动更新"""
        try:
            data = {
                'client_id': '0000000040170455',
                'refresh_token': refresh_token,
                'scope': 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
                'grant_type': 'refresh_token'
            }
            
            headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
            }
            headers = self.request_manager.get_browser_headers(
                referer='https://login.live.com/oauth20_desktop.srf',
                origin='https://login.live.com',
                accept='*/*',
                extra=headers
            )
            
            response = self.request_manager.make_request(
                'POST', 'https://login.live.com/oauth20_token.srf', 
                headers, data=data, account_index=account_index
            )
            
            if response.status_code == 200:
                token_data = response.json()
                if 'access_token' in token_data:
                    if (not silent and CACHE_ENABLED and 'refresh_token' in token_data and 
                        token_data['refresh_token'] != refresh_token and account_alias):
                        self.token_cache_manager.save_token(account_alias, token_data['refresh_token'], account_index)
                    
                    return token_data['access_token']
            
            # 静默模式下不处理错误通知
            if silent:
                return None
            
            # 检查是否为令牌失效错误
            if response.status_code in [400, 401, 403]:
                try:
                    error_data = response.json()
                    error_description = error_data.get('error_description', '').lower()
                    error_code = error_data.get('error', '').lower()
                    
                    # 常见的令牌失效错误标识
                    token_invalid_indicators = [
                        'invalid_grant', 'expired_token', 'refresh_token', 
                        'invalid_request', 'unauthorized', 'invalid refresh token'
                    ]
                    
                    if any(indicator in error_description or indicator in error_code for indicator in token_invalid_indicators):
                        print_log("令牌获取", "刷新令牌已失效，尝试读取环境变量", account_index)
                        
                        # 尝试从环境变量重新读取令牌
                        new_token = os.getenv(f"bing_token_{account_index}")
                        if new_token and new_token.strip() and new_token != refresh_token:
                            print_log("令牌获取", f"从环境变量获取到新令牌，重试", account_index)
                            # 使用新令牌重试
                            return self.get_access_token(new_token.strip(), account_alias, account_index, silent)
                        else:
                            print_log("令牌获取", "环境变量中无新令牌，发送失效通知", account_index)
                            self._send_token_invalid_notification(account_index)
                            return None
                except:
                    pass
            
            print_log("令牌获取", f"获取访问令牌失败，状态码: {response.status_code}", account_index)
            return None
            
        except Exception as e:
            # 静默模式下不处理错误通知
            if silent:
                return None
                
            # 检查异常是否包含令牌失效的信息
            error_message = str(e).lower()
            token_invalid_indicators = [
                'invalid_grant', 'expired_token', 'refresh_token', 
                'unauthorized', '401', '403', 'invalid refresh token'
            ]
            
            if any(indicator in error_message for indicator in token_invalid_indicators):
                print_log("令牌获取", "刷新令牌已失效（异常检测），尝试读取环境变量", account_index)
                
                # 尝试从环境变量重新读取令牌
                new_token = os.getenv(f"bing_token_{account_index}")
                if new_token and new_token.strip() and new_token != refresh_token:
                    print_log("令牌获取", f"从环境变量获取到新令牌，重试", account_index)
                    # 使用新令牌重试
                    return self.get_access_token(new_token.strip(), account_alias, account_index, silent)
                else:
                    print_log("令牌获取", "环境变量中无新令牌，发送失效通知", account_index)
                    self._send_token_invalid_notification(account_index)
            else:
                print_log("令牌获取", f"获取访问令牌异常: {e}", account_index)
            return None
    
    @retry_on_failure()
    def get_read_progress(self, access_token: str, account_index: Optional[int] = None) -> Dict[str, int]:
        """获取阅读任务进度"""
        try:
            headers = self.request_manager.get_rewards_app_headers(access_token)
            
            response = self.request_manager.make_request(
                'GET', 
                'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                headers, account_index=account_index, profile="mobile"
            )
            
            if response.status_code == 200:
                data = response.json()
                if 'response' in data and 'promotions' in data['response']:
                    for promotion in data['response']['promotions']:
                        if (promotion.get('attributes', {}).get('offerid') == 
                            'ENUS_readarticle3_30points'):
                            # 获取max和progress值
                            max_value = promotion['attributes'].get('max')
                            progress_value = promotion['attributes'].get('progress')
                            
                            # 检查值是否有效
                            if max_value is not None and progress_value is not None:
                                try:
                                    return {
                                        'max': int(max_value),
                                        'progress': int(progress_value)
                                    }
                                except (ValueError, TypeError):
                                    # 如果转换失败，继续查找其他任务或抛出异常
                                    print_log("阅读进度", f"数据格式错误: max={max_value}, progress={progress_value}", account_index)
                                    continue
                            else:
                                # 如果值为空，记录日志并继续查找
                                print_log("阅读进度", f"数据为空: max={max_value}, progress={progress_value}", account_index)
                                continue
                    
                    # 如果没有找到有效的阅读任务数据，抛出异常让重试机制处理
                    print_log("阅读进度", "未找到有效的阅读任务数据，将重试", account_index)
                    raise ValueError("未找到有效的阅读任务数据")
                else:
                    # 如果响应结构不正确，抛出异常
                    print_log("阅读进度", "API响应结构不正确，将重试", account_index)
                    raise ValueError("API响应结构不正确")
            
            # 如果状态码不是200，抛出异常让重试机制处理
            print_log("阅读进度", f"获取阅读进度失败，状态码: {response.status_code}", account_index)
            raise Exception(f"HTTP状态码错误: {response.status_code}")
            
        except Exception as e:
            # 重新抛出异常，让重试装饰器处理
            print_log("阅读进度", f"获取阅读进度异常: {e}", account_index)
            raise

    # ==================== 4. 搜索任务相关方法 ====================
    def _get_mobile_info_promotions(
        self,
        access_token: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[List[Dict[str, Any]]]:
        """通过移动端信息接口获取 promotions 列表。"""
        try:
            headers = self.request_manager.get_rewards_app_headers(access_token)
            response = self.request_manager.make_request(
                "GET",
                "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
                headers,
                account_index=account_index,
                profile="mobile"
            )
            if response.status_code != 200:
                if not silent:
                    print_log("移动端信息", f"接口请求失败，状态码: {response.status_code}", account_index)
                return None

            data = response.json()
            promotions = data.get("response", {}).get("promotions", [])
            if not isinstance(promotions, list):
                if not silent:
                    print_log("移动端信息", "接口返回结构异常：promotions不是数组", account_index)
                return None
            return promotions
        except Exception as e:
            if not silent:
                print_log("移动端信息", f"接口请求异常: {e}", account_index)
            return None

    def get_visible_streak_promotions(
        self,
        access_token: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Dict[str, bool]:
        """检查移动端 promotions 中是否存在可见的 Edge/BingAPP 连签任务。"""
        promotions = self._get_mobile_info_promotions(access_token, account_index, silent=silent)
        if not promotions:
            return {"edge": False, "app": False}

        visible = {"edge": False, "app": False}

        for item in promotions:
            edge_candidate = self._build_streak_candidate(item, "edge")
            if edge_candidate.get("score", 0) >= 10:
                visible["edge"] = True

            app_candidate = self._build_streak_candidate(item, "app")
            if app_candidate.get("score", 0) >= 10:
                visible["app"] = True

            if visible["edge"] and visible["app"]:
                break

        return visible

    def has_visible_streak_promotions(
        self,
        access_token: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> bool:
        """兼容旧调用：任一连签任务可见即返回 True。"""
        visible = self.get_visible_streak_promotions(access_token, account_index, silent=silent)
        return bool(visible.get("edge") or visible.get("app"))

    def _parse_earn_streak_cards(self, rsc_text: str) -> List[Dict[str, Any]]:
        """解析 earn RSC 中 type=streak 的可见连签任务块。"""
        streak_items: List[Dict[str, Any]] = []
        seen_keys: set = set()
        parse_texts: List[str] = [rsc_text]
        if "\\\"type\\\"" in rsc_text or "\\\"partner\\\"" in rsc_text:
            parse_texts.append(rsc_text.replace("\\\"", "\""))

        for parse_text in parse_texts:
            for match in re.finditer(r'"type"\s*:\s*"streak"', parse_text, flags=re.IGNORECASE):
                obj_text = self._extract_enclosing_json_object(parse_text, match.start())
                if not obj_text:
                    continue
                try:
                    item = json.loads(obj_text)
                except Exception:
                    continue
                if not isinstance(item, dict):
                    continue

                model = item.get("model", {}) or {}
                streak_model = model.get("streak", {}) if isinstance(model, dict) else {}
                if not isinstance(streak_model, dict):
                    continue

                partner = str(streak_model.get("partner", "") or "").strip().lower()
                title = str(streak_model.get("title", "") or "").strip().lower()
                activity_title = str(streak_model.get("activityTitle", "") or "").strip().lower()
                activities_label = str(streak_model.get("activitiesLabel", "") or "").strip().lower()
                destination = str(streak_model.get("destinationUrl", "") or "").strip().lower()
                dedup_key = "||".join([partner, title, activity_title, activities_label, destination])
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)
                streak_items.append(item)

        return streak_items

    def get_visible_streaks_from_earn_rsc(
        self,
        cookies: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Dict[str, bool]:
        """从 earn RSC 中判断 Edge/APP 连签任务是否可见。"""
        try:
            rsc_text = self._fetch_rsc_stream(
                "https://rewards.bing.com/earn",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index,
                referer="https://rewards.bing.com/earn"
            )
        except Exception as e:
            if not silent:
                print_log("连胜任务检测", f"RSC 可见性检查失败: {e}", account_index)
            return {"edge": False, "app": False}

        visible = {"edge": False, "app": False}
        for item in self._parse_earn_streak_cards(rsc_text):
            edge_candidate = self._build_streak_candidate(item, "edge")
            if (
                edge_candidate.get("score", 0) >= 10
                and not edge_candidate.get("hidden")
                and edge_candidate.get("enabled", True)
            ):
                visible["edge"] = True

            app_candidate = self._build_streak_candidate(item, "app")
            if (
                app_candidate.get("score", 0) >= 10
                and not app_candidate.get("hidden")
                and app_candidate.get("enabled", True)
            ):
                visible["app"] = True

            if visible["edge"] and visible["app"]:
                break

        return visible

    def get_visible_streak_status(
        self,
        cookies: str,
        access_token: Optional[str] = None,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Dict[str, bool]:
        """综合 RSC 与移动端 promotions 判断 Edge/APP 连签任务是否可见。"""
        visible = self.get_visible_streaks_from_earn_rsc(cookies, account_index, silent=silent)
        if access_token:
            promo_visible = self.get_visible_streak_promotions(access_token, account_index, silent=silent)
            visible = {
                "edge": bool(visible.get("edge") or promo_visible.get("edge")),
                "app": bool(visible.get("app") or promo_visible.get("app"))
            }
        return visible

    def _build_streak_candidate(self, item: Any, target: str) -> Dict[str, Any]:
        """基于 promotions 中的 type=model.streak 结构构建 streak 候选信息。"""
        if not isinstance(item, dict):
            return {"score": 0, "match_kind": "", "hidden": False, "enabled": True}

        def _to_bool(value: Any) -> bool:
            if isinstance(value, bool):
                return value
            if value is None:
                return False
            return str(value).strip().lower() in ("true", "1", "yes", "y")

        attrs = item.get("attributes", {}) or {}
        model = item.get("model", {}) or {}
        streak_model = model.get("streak", {}) if isinstance(model, dict) else {}
        if not isinstance(streak_model, dict):
            streak_model = {}

        offerid = str(attrs.get("offerid", item.get("offerid", "")) or "").strip()
        item_name = str(item.get("name", "") or "").strip().lower()
        item_type = str(item.get("type", "") or "").strip().lower()
        hidden = (
            _to_bool(attrs.get("hidden"))
            or _to_bool(attrs.get("isHidden"))
            or _to_bool(item.get("hidden"))
            or _to_bool(item.get("isHidden"))
        )
        streak_title = str(streak_model.get("title", "") or "").strip().lower()
        streak_activity_title = str(streak_model.get("activityTitle", "") or "").strip().lower()
        streak_activities_label = str(streak_model.get("activitiesLabel", "") or "").strip().lower()
        streak_partner = str(streak_model.get("partner", "") or "").strip().lower()
        streak_destination = str(streak_model.get("destinationUrl", "") or "").strip().lower()
        streak_activation_offerid = str(streak_model.get("activationOfferId", "") or "").strip().lower()
        streak_is_enabled = streak_model.get("isEnabled")
        offerid_lower = offerid.lower()

        score = 0
        match_kind = ""

        if item_type == "streak":
            score += 2

        if target == "edge":
            if offerid_lower == "dailycheckin_edge":
                score += 6
                match_kind = "offerid"
            if item_name == "edge_browsing_streak_flight":
                score += 5
                if not match_kind:
                    match_kind = "item_name"
            if streak_title == "dailycheckin_edge_title":
                score += 8
                match_kind = "streak_title"
            if streak_activity_title == "edge_activitytitle":
                score += 6
                if not match_kind:
                    match_kind = "activity_title"
            if streak_activities_label == "minutes_progresslabel":
                score += 4
                if not match_kind:
                    match_kind = "activities_label"
            if streak_partner == "edge":
                score += 5
                if not match_kind:
                    match_kind = "partner"
            if "rewards-browsing-streak" in streak_destination:
                score += 7
                if not match_kind:
                    match_kind = "destination"
            if "edge_flight" in streak_activation_offerid:
                score += 4
                if not match_kind:
                    match_kind = "activation_offerid"
        elif target == "app":
            if offerid_lower == "dailycheckin_sapphire":
                score += 6
                match_kind = "offerid"
            if item_name in ("mobile_checkin_streak", "bingapp_checkin_streak_flight"):
                score += 5
                if not match_kind:
                    match_kind = "item_name"
            if streak_title == "dailycheckin_sapphire_title":
                score += 8
                match_kind = "streak_title"
            if streak_activity_title == "bingapp_activitytitle":
                score += 6
                if not match_kind:
                    match_kind = "activity_title"
            if streak_activities_label == "checkin_progresslabel":
                score += 4
                if not match_kind:
                    match_kind = "activities_label"
            if streak_partner == "bingapp":
                score += 5
                if not match_kind:
                    match_kind = "partner"
            if "bingapp.microsoft.com/bing" in streak_destination:
                score += 7
                if not match_kind:
                    match_kind = "destination"

        return {
            "score": score,
            "match_kind": match_kind,
            "hidden": hidden,
            "enabled": streak_is_enabled is not False,
            "item": item,
            "attrs": attrs,
            "streak_model": streak_model,
            "offerid": offerid,
            "item_name": item_name,
            "item_type": item_type,
            "partner": streak_partner,
            "activities_label": streak_activities_label,
        }

    def get_pc_search_status_from_mobile_promotions(
        self,
        access_token: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[Dict[str, Any]]:
        """从移动端信息接口中提取电脑搜索进度。"""
        promotions = self._get_mobile_info_promotions(access_token, account_index, silent=silent)
        if not promotions:
            return None

        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(str(value)))
            except Exception:
                return default

        def _to_bool(value: Any) -> bool:
            if isinstance(value, bool):
                return value
            if value is None:
                return False
            return str(value).strip().lower() in ("true", "1", "yes", "y")

        per_search_points = 3
        for item in promotions:
            if not isinstance(item, dict):
                continue
            if str(item.get("name", "")).strip() != "level_info":
                continue
            attrs = item.get("attributes", {}) or {}
            per_search_points = _to_int(
                attrs.get("points_per_pc_search", attrs.get("points_per_pc_search_new_levels", 3)),
                3
            )
            if per_search_points <= 0:
                per_search_points = 3
            break

        candidate: Optional[Dict[str, Any]] = None
        for item in promotions:
            if not isinstance(item, dict):
                continue
            attrs = item.get("attributes", {}) or {}
            class_tag = str(attrs.get("Classification.Tag", "")).strip()
            answer_tag = str(attrs.get("AnswerScenario.Tag", "")).strip()
            offerid = str(attrs.get("offerid", "")).strip()
            item_name = str(item.get("name", "")).strip()
            promo_type = str(attrs.get("type", "")).strip().lower()
            if (
                class_tag == "PCSearch"
                or answer_tag == "PCSearch"
                or item_name.endswith("_search_PC")
                or (promo_type == "search" and "search" in offerid.lower() and "pc" in item_name.lower())
            ):
                candidate = item
                break

        if not candidate:
            if not silent:
                print_log("电脑搜索", "移动端信息中未匹配到PC搜索任务", account_index)
            return None

        attrs = candidate.get("attributes", {}) or {}
        current = _to_int(attrs.get("progress", attrs.get("pointprogress", 0)), 0)
        maximum = _to_int(attrs.get("max", attrs.get("pointmax", 0)), 0)
        complete_flag = _to_bool(attrs.get("complete"))
        is_complete = complete_flag or (maximum > 0 and current >= maximum)

        if is_complete and maximum > 0 and current < maximum:
            current = maximum

        return {
            "current": max(0, current),
            "maximum": max(0, maximum),
            "complete": is_complete,
            "per_search_points": max(1, per_search_points),
            "offerid": str(attrs.get("offerid", "") or ""),
            "title": str(attrs.get("title", "") or "电脑搜索"),
            "source": "mobile_promotions"
        }

    def get_pc_search_status_from_earn_rsc(
        self,
        cookies: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[Dict[str, Any]]:
        """从 earn RSC 的 pointbreakdown 中提取电脑搜索进度。"""
        try:
            rsc_text = self._fetch_rsc_stream(
                "https://rewards.bing.com/earn",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index,
                referer="https://rewards.bing.com/earn"
            )
            status = self._parse_earn_point_breakdown(rsc_text)
            if status:
                return status
            if not silent:
                print_log("电脑搜索", "earn RSC 中未匹配到 pointbreakdown.pc 进度", account_index)
            return None
        except Exception as e:
            if not silent:
                print_log("电脑搜索", f"earn RSC 进度查询失败: {e}", account_index)
            return None

    def get_mobile_info_summary(
        self,
        access_token: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[Dict[str, int]]:
        """从移动端信息接口汇总今日积分/每日活动/继续赚取。"""
        promotions = self._get_mobile_info_promotions(access_token, account_index, silent=silent)
        if not promotions:
            return None

        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(str(value)))
            except Exception:
                return default

        def _to_bool(value: Any, default: bool = False) -> bool:
            if isinstance(value, bool):
                return value
            if value is None:
                return default
            lowered = str(value).strip().lower()
            if lowered in ("true", "1", "yes", "y"):
                return True
            if lowered in ("false", "0", "no", "n"):
                return False
            return default

        def _is_completed(attrs: Dict[str, Any], item: Dict[str, Any]) -> bool:
            if _to_bool(attrs.get("complete"), default=False) or _to_bool(item.get("complete"), default=False):
                return True
            state_text = str(attrs.get("state", attrs.get("State", "")) or "").strip().lower()
            if state_text == "complete":
                return True

            progress_candidates = [
                attrs.get("progress"),
                attrs.get("pointprogress"),
                attrs.get("activityprogress"),
                attrs.get("activity_progress")
            ]
            max_candidates = [
                attrs.get("max"),
                attrs.get("pointmax"),
                attrs.get("activitymax"),
                attrs.get("activity_max")
            ]
            progress_value = next((_to_int(v, -1) for v in progress_candidates if v is not None), -1)
            max_value = next((_to_int(v, -1) for v in max_candidates if v is not None), -1)
            return max_value > 0 and progress_value >= max_value

        def _is_today_daily_set(attrs: Dict[str, Any], today_str: str) -> bool:
            ds = str(attrs.get("daily_set_date", "") or "").strip()
            if not ds:
                return False
            if ds == today_str:
                return True
            for fmt in ("%m/%d/%Y", "%-m/%-d/%Y"):
                try:
                    return datetime.strptime(ds, fmt).strftime("%m/%d/%Y") == today_str
                except Exception:
                    continue
            return False

        def _is_more_activity(item: Dict[str, Any], attrs: Dict[str, Any]) -> bool:
            offerid = str(attrs.get("offerid", item.get("offerid", "")) or "").strip()
            if not offerid:
                return False

            if _to_bool(attrs.get("hidden"), default=False):
                return False

            if _to_bool(attrs.get("is_unlocked"), default=True) is False:
                return False

            max_value = _to_int(attrs.get("max", attrs.get("pointmax", 0)), 0)
            if max_value <= 0:
                return False

            if _is_today_daily_set(attrs, today_mmddyyyy):
                return False

            class_tag = str(attrs.get("Classification.Tag", "")).strip()
            answer_tag = str(attrs.get("AnswerScenario.Tag", "")).strip()
            promo_type = str(attrs.get("type", "")).strip().lower()
            item_name = str(item.get("name", "")).strip().lower()
            if class_tag == "PCSearch" or answer_tag == "PCSearch" or promo_type == "search" or item_name.endswith("_search_pc"):
                return False

            if offerid == "ENUS_readarticle3_30points":
                return False

            if offerid.startswith("DailyCheckIn_") or "edge_browsing_streak" in item_name:
                return False

            if promo_type in ("checkin", "daily_checkin", "streak"):
                return False

            return True

        today_mmddyyyy = date.today().strftime("%m/%d/%Y")
        today_points = 0
        daily_completed = 0
        daily_total = 0
        more_completed = 0
        more_total = 0

        for item in promotions:
            if not isinstance(item, dict):
                continue
            attrs = item.get("attributes", {}) or {}
            name = str(item.get("name", "") or "").strip()

            if name == "level_info":
                today_points = _to_int(attrs.get("todays_points", today_points), today_points)

            if _is_today_daily_set(attrs, today_mmddyyyy):
                daily_total += 1
                if _is_completed(attrs, item):
                    daily_completed += 1
                continue

            if _is_more_activity(item, attrs):
                more_total += 1
                if _is_completed(attrs, item):
                    more_completed += 1

        return {
            "today_points": max(0, today_points),
            "daily_completed": max(0, daily_completed),
            "daily_total": max(0, daily_total),
            "more_completed": max(0, more_completed),
            "more_total": max(0, more_total)
        }

    def _extract_report_activity_insights(self, html_text: str) -> Optional[Dict[str, Any]]:
        """从 reportActivity 返回的 HTML 中提取对排查最有用的 Rewards 状态字段。"""
        if not html_text or "ModernRewards.ReportActivity" not in html_text:
            return None

        object_match = re.search(
            r"new\s+ModernRewards\.ReportActivity\((\{.*?\})\)\s*;",
            html_text,
            flags=re.DOTALL
        )
        source_text = object_match.group(1) if object_match else html_text

        def _extract_value(key: str) -> Any:
            pattern = rf'"{re.escape(key)}"\s*:\s*("(?P<quoted>(?:\\.|[^"\\])*)"|(?P<raw>true|false|null|-?\d+(?:\.\d+)?))'
            match = re.search(pattern, source_text, flags=re.IGNORECASE)
            if not match:
                return None

            quoted = match.group("quoted")
            if quoted is not None:
                try:
                    return json.loads(f'"{quoted}"')
                except Exception:
                    return quoted

            raw = match.group("raw")
            if raw is None:
                return None

            lowered = raw.lower()
            if lowered == "true":
                return True
            if lowered == "false":
                return False
            if lowered == "null":
                return None

            try:
                if "." in raw:
                    return float(raw)
                return int(raw)
            except Exception:
                return raw

        insights = {
            "balance": _extract_value("Balance"),
            "rewards_balance": _extract_value("RewardsBalance"),
            "previous_balance": _extract_value("PreviousBalance"),
            "search_earned": _extract_value("DailySearchPointsEarned"),
            "search_limit": _extract_value("DailySearchPointsLimit"),
            "rewards_increment": _extract_value("RewardsIncrement"),
            "checkin_progress": _extract_value("DailyCheckInProgress"),
            "checkin_animate": _extract_value("DailyCheckInAnimate"),
            "is_authenticated": _extract_value("IsAuthenticated"),
            "is_reward_user": _extract_value("IsRewardUser"),
            "is_level2": _extract_value("IsLevel2"),
            "new_level": _extract_value("NewLevel"),
            "show_animation": _extract_value("ShowAnimation"),
            "is_suspended": _extract_value("IsSuspended"),
        }

        if not any(value is not None for value in insights.values()):
            return None
        return insights

    def _log_report_activity_insights(self, html_text: str, account_index: Optional[int] = None):
        """将 reportActivity 的关键状态压缩成一条便于排查的日志。"""
        insights = self._extract_report_activity_insights(html_text)
        if not insights:
            return

        parts: List[str] = []
        search_earned = insights.get("search_earned")
        search_limit = insights.get("search_limit")
        is_suspended = insights.get("is_suspended")

        if search_earned is not None and search_limit is not None:
            search_status = f"搜索积分 {search_earned}/{search_limit}"
            if isinstance(search_earned, (int, float)) and isinstance(search_limit, (int, float)) and search_limit > 0:
                if search_earned >= search_limit:
                    search_status += " (已满)"
            parts.append(search_status)
            if isinstance(search_earned, (int, float)):
                current_earned = int(search_earned)
                if isinstance(self._last_pc_search_report_earned, int):
                    delta_earned = current_earned - self._last_pc_search_report_earned
                    if delta_earned >= 0:
                        parts.append(f"累计变化 +{delta_earned}")
                        if delta_earned > 3:
                            parts.append("可能含延迟入账")
                self._last_pc_search_report_earned = current_earned

        if is_suspended:
            parts.append("账号状态=Suspended")

        if parts:
            print_log("搜索报告", " | ".join(parts), account_index)

    def _classify_pc_search_report(self, insights: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """按累计搜索分变化对电脑搜索结果进行分类。"""
        if not isinstance(insights, dict):
            return {"ok": False, "state": "no_data"}

        search_earned = insights.get("search_earned")
        if not isinstance(search_earned, (int, float)):
            return {"ok": False, "state": "no_data"}

        current_earned = int(search_earned)
        previous_earned = self._last_pc_search_report_earned
        if self._pc_search_bootstrap_active:
            if current_earned > 0:
                return {"ok": False, "state": "bootstrap_exit", "current": current_earned}
            return {"ok": False, "state": "bootstrap_wait", "current": current_earned}

        if not isinstance(previous_earned, int):
            return {"ok": False, "state": "no_baseline", "current": current_earned}

        if current_earned > previous_earned:
            return {
                "ok": True,
                "state": "advanced",
                "current": current_earned,
                "delta": current_earned - previous_earned
            }

        return {
            "ok": False,
            "state": "duplicate",
            "current": current_earned,
            "delta": current_earned - previous_earned
        }

    @retry_on_failure(max_retries=2, delay=1)
    def perform_pc_search(self, cookies: str, account_index: Optional[int] = None) -> bool:
        """执行电脑搜索，固定使用 cn.bing.com，动态 form，ver 从页面提取"""
        self.last_pc_search_result = None

        # ========== 1. 动态重构Cookie ==========
        cookie_dict = {}
        for item in cookies.split('; '):
            if '=' in item:
                k, v = item.split('=', 1)
                cookie_dict[k] = v
        for k in ['_EDGE_S', '_Rwho', '_RwBf']:
            cookie_dict.pop(k, None)
        today = datetime.now().strftime('%Y-%m-%d')
        cookie_dict['_Rwho'] = f'u=d&ts={today}'
        new_cookies = '; '.join([f'{k}={v}' for k, v in cookie_dict.items()])

        # ========== 2. 生成随机 form 参数（6位大写字母+数字，至少一位数字） ==========
        def random_form():
            letters = string.ascii_uppercase
            digits = string.digits

            # 先保证一个数字
            result = [random.choice(digits)]

            # 剩下5位从全部字符选
            pool = letters + digits
            result += [random.choice(pool) for _ in range(5)]

            # 打乱顺序
            random.shuffle(result)

            return ''.join(result)

        form = random_form()

        q = hot_words_manager.get_random_word()
        params = {
            "q": q,
            "FORM": form
        }
        headers = self.request_manager.get_browser_headers(
            cookies=new_cookies,
            referer=f"https://cn.bing.com/?FORM={form}"
        )

        try:
            # ========== 3. 执行搜索请求（cn.bing.com，不自动跟随重定向） ==========
            search_url = "https://cn.bing.com/search"
            response = self.request_manager.make_request(
                'GET', search_url, headers, params=params,
                timeout=config.REQUEST_TIMEOUT, account_index=account_index,
                allow_redirects=False
            )

            if response.status_code != 200:
                print_log("电脑搜索", f"搜索失败，状态码: {response.status_code}", account_index)
                return False

            final_url = response.url  # 保持 cn.bing.com 的 URL

            # ========== 4. 提取 IG 和 AppVer ==========
            html_content = response.text
            # 提取 IG
            ig_match = re.search(r'IG\s*:\s*"([^"]+)"', html_content)
            ig_value = ig_match.group(1) if ig_match else secrets.token_hex(16).upper()[:32]
            if not ig_match:
                print_log("电脑搜索", "未找到 IG，使用随机值", account_index)

            # 提取 AppVer（用于 ncheader）
            ver_match = re.search(r'_G\.AppVer\s*=\s*"(\d+)"', html_content)
            ver_value = ver_match.group(1) if ver_match else "88888888"
            if not ver_match:
                print_log("电脑搜索", "未找到 AppVer，使用默认值", account_index)

            # 可选提取 IID（用于日志，实际请求用硬编码）
            iid_match = re.search(r'data_iid\s*=\s*"([^"]+)"', html_content)
            iid_value = iid_match.group(1) if iid_match else "SERP.5047"
            if not iid_match:
                print_log("电脑搜索", "未找到 IID，使用默认值", account_index)

            # ========== 5. 固定使用 cn.bing.com 作为基础域名 ==========
            base_url = "https://cn.bing.com"

            # ========== 6. 发送 ncheader 请求（IID 固定为 SERP.5047） ==========
            ncheader_url = f"{base_url}/rewardsapp/ncheader?ver={ver_value}&IID=SERP.5047&IG={ig_value}&ajaxreq=1"
            ncheader_headers = self.request_manager.get_browser_headers(
                cookies=new_cookies,
                referer=final_url,
                origin=base_url,
                accept="*/*",
                extra={"Content-Type": "application/x-www-form-urlencoded"}
            )
            ncheader_data = "wb=1%3bi%3d1%3bv%3d1"
            try:
                self.request_manager.make_request('POST', ncheader_url, ncheader_headers, data=ncheader_data, account_index=account_index)
            except Exception as e:
                print_log("电脑搜索", f"ncheader 请求失败: {e}，继续尝试 report", account_index)

            # ========== 7. 发送报告活动请求 ==========
            report_url = f"{base_url}/rewardsapp/reportActivity?IG={ig_value}&IID={iid_value}&q={quote(q)}&ajaxreq=1"
            post_headers = self.request_manager.get_browser_headers(
                cookies=new_cookies,
                referer=final_url,
                origin=base_url,
                accept="*/*",
                extra={"Content-Type": "application/x-www-form-urlencoded"}
            )
            post_data = f"url={quote(final_url, safe='')}&V=web"
            report_response = self.request_manager.make_request('POST', report_url, post_headers, data=post_data, account_index=account_index)

            if 200 <= report_response.status_code < 400:
                report_text = report_response.text or ""
                insights = self._extract_report_activity_insights(report_text)
                classification = self._classify_pc_search_report(insights)
                self.last_pc_search_result = {
                    "ok": bool(classification.get("ok")),
                    "state": str(classification.get("state", "") or ""),
                    "classification": classification,
                    "insights": insights
                }
                self._log_report_activity_insights(report_text, account_index)
                return bool(self.last_pc_search_result["ok"])
            else:
                raise Exception(f"报告活动失败，状态码: {report_response.status_code}")

        except Exception as e:
            print_log("电脑搜索", f"搜索失败: {e}", account_index)
            raise
    
    # ==================== 5. APP签到相关方法 ====================
    @retry_on_failure()
    def app_sign_in(self, access_token: str, account_index: Optional[int] = None) -> int:
        """执行App端每日签到任务
        
        Args:
            access_token: 访问令牌
            account_index: 账号索引
            
        Returns:
            签到获得的积分数，失败返回-1
        """
        try:
            # 构造请求头，使用Bearer token认证
            headers = self.request_manager.get_rewards_app_headers(
                access_token,
                app_id="SAAndroid/32.7.440115006",
                content_type="application/json",
                extra={"X-Rewards-IsMobile": "true"}
            )
            
            random_uuid = uuid.uuid4()
            
            # 构造符合API格式的请求数据
            payload = {
                "amount": 1,
                "id": f'{random_uuid}',
                "attributes": {},
                "type": 103,
                "country": "cn",
                "risk_context": {},
                "channel": "SAAndroid"
            }
            
            # 添加随机延时，模拟人类操作
            time.sleep(random.uniform(2, 4))
            
            # 发送签到请求
            response = self.request_manager.make_request(
                'POST',
                'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                headers,
                data=json.dumps(payload),
                account_index=account_index,
                profile="mobile"
            )

            if response.status_code == 200:
                result = response.json()
                points_earned = result.get("response", {}).get("activity", {}).get("p", 0)
                time.sleep(random.uniform(2, 4))
                return points_earned
            else:
                try:
                    error_data = response.json()
                    error_msg = error_data.get('error', {}).get('description', '')
                    if 'already' in error_msg.lower() or 'duplicate' in error_msg.lower():
                        return 0
                except:
                    pass
                
                print_log("APP签到", f"签到执行失败: {response.status_code}", account_index)
                return -1
                
        except Exception as e:
            error_message = str(e).lower()
            if 'already' in error_message or 'duplicate' in error_message:
                return 0
            
            print_log("APP签到", f"签到执行异常: {e}", account_index)
            return -1

    def _normalize_edge_streak_status(
        self,
        edge_candidate: Dict[str, Any],
        source: str
    ) -> Optional[Dict[str, Any]]:
        """将 Edge streak 候选对象标准化为统一状态结构。"""
        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(str(value)))
            except Exception:
                return default

        def _to_bool(value: Any) -> bool:
            if isinstance(value, bool):
                return value
            if value is None:
                return False
            return str(value).strip().lower() in ("true", "1", "yes", "y")

        if not edge_candidate:
            return None

        edge_item = edge_candidate.get("item", {}) or {}
        attrs = edge_candidate.get("attrs", {}) or {}
        streak_model = edge_candidate.get("streak_model", {}) or {}
        edge_match_kind = str(edge_candidate.get("match_kind", "") or "")
        edge_match_score = int(edge_candidate.get("score", 0) or 0)

        progress = _to_int(
            streak_model.get("activitiesCompleted", streak_model.get("completedAmount", -1)),
            -1
        )
        if progress < 0:
            progress = _to_int(
                attrs.get("progress", attrs.get("pointprogress", attrs.get("activityprogress", -1))),
                -1
            )

        maximum = _to_int(
            streak_model.get("activitiesTotal", streak_model.get("completedMax", 0)),
            0
        )
        if maximum <= 0:
            maximum = _to_int(
                attrs.get("max", attrs.get("pointmax", attrs.get("activitymax", 0))),
                0
            )

        report_per_minutes = _to_int(
            attrs.get("report_per_minutes", attrs.get("reportPerMinutes", 5)),
            5
        )
        if report_per_minutes <= 0:
            report_per_minutes = 5

        complete = (
            _to_bool(streak_model.get("isCurrentDayCompleted"))
            or _to_bool(attrs.get("complete"))
            or (maximum > 0 and progress >= maximum)
        )

        activities_label = str(
            streak_model.get(
                "activitiesLabel",
                attrs.get("activities_label", attrs.get("activitiesLabel", ""))
            ) or ""
        )
        partner = str(streak_model.get("partner", attrs.get("partner", "")) or "")
        item_name = str(edge_item.get("name", "") or "")
        offerid = str(attrs.get("offerid", edge_item.get("offerid", "")) or "")

        actionable = True
        invalid_reason = ""
        if maximum < 0 or progress < -1:
            actionable = False
            invalid_reason = "异常负进度"
        elif edge_match_score < 10:
            actionable = False
            invalid_reason = "未匹配到有效的 Edge streak 任务"
        elif edge_match_kind in ("partner", "") and not offerid:
            actionable = False
            invalid_reason = "仅弱匹配"

        return {
            "complete": complete,
            "progress": progress,
            "max": maximum,
            "report_per_minutes": report_per_minutes,
            "activities_label": activities_label,
            "partner": partner,
            "offerid": offerid,
            "item_name": item_name,
            "match_kind": edge_match_kind,
            "match_score": edge_match_score,
            "actionable": actionable,
            "invalid_reason": invalid_reason,
            "source": source
        }

    def _get_edge_checkin_status_from_rsc(
        self,
        cookies: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[Dict[str, Any]]:
        """通过 earn RSC 查询 Edge 连续浏览任务状态。"""
        try:
            rsc_text = self._fetch_rsc_stream(
                "https://rewards.bing.com/earn",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index,
                referer="https://rewards.bing.com/earn"
            )
            edge_candidate = None
            edge_match_score = -1
            for item in self._parse_earn_streak_cards(rsc_text):
                candidate = self._build_streak_candidate(item, "edge")
                if candidate.get("hidden"):
                    continue
                if not candidate.get("enabled", True):
                    continue
                score = int(candidate.get("score", 0) or 0)
                if score > edge_match_score and score >= 10:
                    edge_candidate = candidate
                    edge_match_score = score

            if not edge_candidate:
                if not silent:
                    print_log("Edge浏览打卡", "earn RSC 未匹配到 DailyCheckIn_Edge 任务状态", account_index)
                return None

            return self._normalize_edge_streak_status(edge_candidate, "earn_rsc")
        except Exception as e:
            if not silent:
                print_log("Edge浏览打卡", f"earn RSC 状态查询异常: {e}", account_index)
            return None

    def _get_edge_checkin_status_from_promotions(self, access_token: str, account_index: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """通过 dapi/me?channel=edge 查询 Edge 连续浏览任务状态。"""
        headers = self.request_manager.get_edge_rewards_headers(
            access_token,
            content_type="application/json"
        )

        try:
            response = self.request_manager.make_request(
                "GET",
                "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=edge",
                headers,
                account_index=account_index
            )
            if response.status_code != 200:
                print_log("Edge浏览打卡", f"状态查询失败，状态码: {response.status_code}", account_index)
                return None

            data = response.json()
            promotions = data.get("response", {}).get("promotions", [])
            if not isinstance(promotions, list):
                print_log("Edge浏览打卡", "状态查询返回结构异常：promotions不是数组", account_index)
                return None

            edge_candidate = None
            edge_match_score = -1
            for item in promotions:
                candidate = self._build_streak_candidate(item, "edge")
                if candidate.get("hidden"):
                    continue
                if not candidate.get("enabled", True):
                    continue
                score = int(candidate.get("score", 0) or 0)
                if score > edge_match_score and score >= 10:
                    edge_candidate = candidate
                    edge_match_score = score

            if not edge_candidate:
                print_log("Edge浏览打卡", "未匹配到 DailyCheckIn_Edge 任务状态", account_index)
                return None
            return self._normalize_edge_streak_status(edge_candidate, "edge_promotions")
        except Exception as e:
            print_log("Edge浏览打卡", f"状态查询异常: {e}", account_index)
            return None

    def _get_edge_checkin_status(
        self,
        access_token: Optional[str] = None,
        account_index: Optional[int] = None,
        cookies: str = ""
    ) -> Optional[Dict[str, Any]]:
        """优先通过 earn RSC，其次通过 dapi/me?channel=edge 查询 Edge 连续浏览任务状态。"""
        if cookies:
            rsc_status = self._get_edge_checkin_status_from_rsc(cookies, account_index, silent=True)
            if rsc_status:
                return rsc_status
        if access_token:
            return self._get_edge_checkin_status_from_promotions(access_token, account_index)
        return None

    def complete_edge_checkin(self, access_token: str, account_index: Optional[int] = None, cookies: str = "") -> int:
        """执行 Edge 浏览连续打卡：状态查询优先使用 earn RSC，复查回退 dapi/me?channel=edge。"""
        target_minutes = 30
        max_exec_guard = 12

        def _safe_int(value: Any, default: int = 0) -> int:
            try:
                return int(value)
            except Exception:
                return default

        def _calc_remaining_by_status(status: Optional[Dict[str, Any]]) -> Tuple[int, str, int, int]:
            if not status:
                return 6, "fallback", -1, 0

            if status.get("complete") is True:
                return 0, "completed", _safe_int(status.get("progress", 0), 0), _safe_int(status.get("max", 0), 0)

            progress = _safe_int(status.get("progress", -1), -1)
            maximum = _safe_int(status.get("max", 0), 0)
            report_per_minutes = _safe_int(status.get("report_per_minutes", 5), 5)
            if report_per_minutes <= 0:
                report_per_minutes = 5
            activities_label = str(status.get("activities_label", "") or "").strip().lower()

            progress_mode = "fallback"
            if "minute" in activities_label:
                progress_mode = "minutes"
            elif "checkin" in activities_label or "search" in activities_label:
                progress_mode = "steps"
            elif 0 < maximum <= 12:
                progress_mode = "steps"
            elif 0 < maximum <= target_minutes:
                progress_mode = "minutes"
            elif progress > target_minutes:
                progress_mode = "steps"

            if progress_mode == "minutes":
                total_minutes = maximum if maximum > 0 else target_minutes
                if progress >= total_minutes >= 0:
                    return 0, progress_mode, progress, total_minutes
                if progress < 0:
                    return 6, "fallback", progress, total_minutes
                remaining_minutes = max(0, total_minutes - progress)
                remaining_requests = max(1, (remaining_minutes + report_per_minutes - 1) // report_per_minutes)
                remaining_requests = min(max_exec_guard, remaining_requests)
                return remaining_requests, progress_mode, progress, total_minutes

            total_steps = maximum if maximum > 0 else 6
            if progress >= total_steps >= 0:
                return 0, progress_mode, progress, total_steps
            if progress < 0:
                return 6, "fallback", progress, total_steps
            remaining_requests = max(1, total_steps - progress)
            remaining_requests = min(6, remaining_requests)
            return remaining_requests, progress_mode, progress, total_steps

        edge_status = self._get_edge_checkin_status(access_token, account_index, cookies)
        if edge_status and edge_status.get("actionable") is False:
            invalid_reason = str(edge_status.get("invalid_reason", "") or "状态疑似被屏蔽或结构异常")
            offerid_text = str(edge_status.get("offerid", "") or "")
            item_name_text = str(edge_status.get("item_name", "") or "")
            print_log(
                "Edge浏览打卡",
                f"状态无效，跳过执行: {invalid_reason} | offerid={offerid_text or '?'} | item={item_name_text or '?'}",
                account_index
            )
            return -3

        remaining_requests, mode, progress, total = _calc_remaining_by_status(edge_status)
        if edge_status:
            print_log("Edge浏览打卡", f"当前进度 {progress}/{total if total > 0 else '?'}", account_index)
        if remaining_requests == 0:
            return 0
        if mode == "minutes":
            print_log("Edge浏览打卡", f"状态查询[{mode}]: 进度 {progress}/{total} 分钟，计划执行 {remaining_requests} 次", account_index)
        elif mode == "steps":
            print_log("Edge浏览打卡", f"状态查询[{mode}]: 进度 {progress}/{total} 次，计划执行 {remaining_requests} 次", account_index)
        else:
            print_log("Edge浏览打卡", "状态查询失败或无有效进度，按默认 6 次执行", account_index)

        headers = self.request_manager.get_edge_rewards_headers(
            access_token,
            content_type="application/json"
        )
        payload = {
            "amount": 1,
            "attributes": {"offerid": "DailyCheckIn_Edge"},
            "request_user_info": True,
            "type": "29"
        }

        last_points = 0
        executed = 0
        remaining_to_run = remaining_requests
        while remaining_to_run > 0 and executed < max_exec_guard:
            try:
                response = self.request_manager.make_request(
                    'POST',
                    'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                    headers,
                    data=json.dumps(payload),
                    account_index=account_index
                )
                if response.status_code != 200:
                    print_log("Edge浏览打卡", f"第 {executed + 1}/{executed + remaining_to_run} 次执行失败，状态码: {response.status_code}", account_index)
                    return -1

                current_points = last_points
                try:
                    result = response.json()
                except Exception:
                    result = None

                if isinstance(result, dict):
                    response_block = result.get("response", {})
                    if isinstance(response_block, dict):
                        activity_block = response_block.get("activity", {})
                        if isinstance(activity_block, dict):
                            points_raw = activity_block.get("p", last_points)
                            try:
                                current_points = int(points_raw)
                            except Exception:
                                current_points = last_points
                        else:
                            print_log("Edge浏览打卡", f"第 {executed + 1}/{executed + remaining_to_run} 次返回缺少 activity 字段，按当前进度继续", account_index)
                    else:
                        print_log("Edge浏览打卡", f"第 {executed + 1}/{executed + remaining_to_run} 次返回缺少 response 字段，按当前进度继续", account_index)
                else:
                    body_preview = (response.text or "").replace("\r", " ").replace("\n", " ")
                    print_log("Edge浏览打卡", f"第 {executed + 1}/{executed + remaining_to_run} 次返回结构异常（非JSON对象），片段: {body_preview[:300]}", account_index)

                executed += 1
                remaining_to_run = max(0, remaining_to_run - 1)
                last_points = current_points
                latest_status = self._get_edge_checkin_status(access_token, account_index, cookies)
                next_remaining, next_mode, next_progress, next_total = _calc_remaining_by_status(latest_status)
                if next_remaining == 0:
                    if next_mode == "minutes":
                        print_log("Edge浏览打卡", f"第 {executed} 次后复查完成，进度 {next_progress}/{next_total} 分钟", account_index)
                    elif next_mode == "steps":
                        print_log("Edge浏览打卡", f"第 {executed} 次后复查完成，进度 {next_progress}/{next_total} 次", account_index)
                    return last_points if last_points > 0 else 0

                if next_mode != "fallback":
                    remaining_to_run = min(remaining_to_run, next_remaining) if remaining_to_run > 0 else next_remaining
                print_log(
                    "Edge浏览打卡",
                    f"第 {executed}/{executed + remaining_to_run} 次执行成功，复查剩余约 {next_remaining} 次",
                    account_index
                )
            except Exception as e:
                print_log("Edge浏览打卡", f"第 {executed + 1}/{executed + remaining_to_run} 次执行异常: {e}", account_index)
                return -1

            if remaining_to_run > 0:
                time.sleep(305)

        verify_status = self._get_edge_checkin_status(access_token, account_index, cookies)
        if verify_status and verify_status.get("complete") is True:
            return last_points if last_points > 0 else 0

        if last_points == 0:
            print_log("Edge浏览打卡", "积分增加0，复查未确认完成", account_index)
            return -1

        return last_points

    # ==================== 6. 阅读任务相关方法 ====================
    @retry_on_failure()
    def submit_read_activity(self, access_token: str, account_index: Optional[int] = None) -> bool:
        """执行阅读活动请求"""
        try:
            headers = self.request_manager.get_rewards_app_headers(
                access_token,
                content_type='application/json'
            )
            
            payload = {
                'amount': 1,
                'country': 'cn',
                "id": secrets.token_hex(32),
                'type': 101,
                'attributes': {
                    'offerid': 'ENUS_readarticle3_30points'
                }
            }
            
            response = self.request_manager.make_request(
                'POST',
                'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                headers,
                data=json.dumps(payload), account_index=account_index, profile="mobile"
            )
            
            if response.status_code == 200:
                return True
            else:
                print_log("阅读活动", f"文章阅读执行失败，状态码: {response.status_code}", account_index)
                return False
                
        except Exception as e:
            if hasattr(e, 'response') and e.response:
                try:
                    error_data = e.response.json()
                    if (error_data.get('error', {}).get('description', '').find('already') != -1):
                        print_log("阅读活动", "文章阅读任务已完成", account_index)
                        return True
                except:
                    pass
            
            print_log("阅读活动", f"文章阅读执行异常: {e}", account_index)
            return False
    
    def complete_read_tasks(self, refresh_token: str, account_alias: str = "", account_index: Optional[int] = None, access_token: Optional[str] = None) -> int:
        """完成阅读任务 - 支持令牌缓存和令牌复用"""
        if not refresh_token and not access_token:
            print_log("阅读任务", "未提供刷新令牌或访问令牌，跳过阅读任务", account_index)
            return 0
        
        try:
            # 如果没有提供访问令牌，则获取新的访问令牌
            if not access_token:
                access_token = self.get_access_token(refresh_token, account_alias, account_index)
                if not access_token:
                    print_log("阅读任务", "无法获取访问令牌，跳过阅读任务", account_index)
                    return 0
            
            # 获取阅读进度
            try:
                progress_data = self.get_read_progress(access_token, account_index)
                max_reads = progress_data['max']
                current_progress = progress_data['progress']
            except Exception as e:
                print_log("阅读任务", f"获取阅读进度失败: {e}，跳过阅读任务", account_index)
                return 0
            
            if current_progress >= max_reads:
                return current_progress
            print_log("阅读任务", f"当前阅读进度: {current_progress}/{max_reads}", account_index)

            max_attempts = max_reads - current_progress
            
            for i in range(max_attempts):
                print_log("阅读任务", f"执行第 {i + 1} 次阅读任务", account_index)
                
                if self.submit_read_activity(access_token, account_index):
                    delay = random.uniform(10, 20)
                    print_log("阅读任务", f"阅读执行成功，等待 {delay:.1f} 秒", account_index)
                    time.sleep(delay)
                    
                    try:
                        progress_data = self.get_read_progress(access_token, account_index)
                        new_progress = progress_data['progress']
                    except Exception as e:
                        print_log("阅读任务", f"重新获取进度失败: {e}，继续执行", account_index)
                        continue
                    
                    if new_progress > current_progress:
                        current_progress = new_progress
                        print_log("阅读任务", f"阅读进度更新: {current_progress}/{max_reads}", account_index)
                        
                        if current_progress >= max_reads:
                            break
                else:
                    print_log("阅读任务", f"第 {i + 1} 次阅读执行失败", account_index)
                    time.sleep(random.uniform(2, 5))
            
            print_log("阅读任务", f"阅读任务执行完成，最终进度: {current_progress}/{max_reads}", account_index)
            return current_progress
            
        except Exception as e:
            print_log("阅读任务", f"阅读任务执行异常: {e}", account_index)
            return 0

    # ==================== 新RSC offer任务实现 ====================
    def _build_rsc_get_headers(
        self,
        cookies: str,
        accept_language: str,
        referer: str = "https://rewards.bing.com/earn"
    ) -> Dict[str, str]:
        """构造 RSC GET 请求头。"""
        return self.request_manager.get_rsc_headers(
            cookies=cookies,
            accept_language=accept_language,
            referer=referer
        )

    def _generate_rsc_key(self, length: int = 16) -> str:
        """生成新的 RSC 随机参数，支持大小写字母、数字和下划线。"""
        alphabet = string.ascii_letters + string.digits + "_"
        return "".join(secrets.choice(alphabet) for _ in range(max(8, length)))

    def _build_rsc_url(self, url: str) -> str:
        """为 RSC 页面请求注入新的 _rsc 参数，并移除旧值。"""
        parsed = urlsplit(url)
        query_pairs = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != "_rsc"]
        query_pairs.append(("_rsc", self._generate_rsc_key()))
        return urlunsplit((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urlencode(query_pairs),
            parsed.fragment
        ))

    def _fetch_rsc_stream(
        self,
        url: str,
        cookies: str,
        accept_language: str,
        account_index: Optional[int] = None,
        referer: str = "https://rewards.bing.com/earn"
    ) -> str:
        """拉取 RSC 文本流（最多重试3次）。"""
        headers = self._build_rsc_get_headers(cookies, accept_language, referer=referer)
        max_attempts = 3
        last_error_msg = ""
        last_excerpt = ""
        last_request_url = url

        for attempt in range(1, max_attempts + 1):
            try:
                request_url = self._build_rsc_url(url)
                last_request_url = request_url
                response = self.request_manager.make_request(
                    "GET",
                    request_url,
                    headers,
                    timeout=30,
                    account_index=account_index
                )

                # RSC 响应偶发 charset 标注不准，统一按 UTF-8 解码避免中文乱码
                try:
                    text = response.content.decode("utf-8")
                except Exception:
                    text = response.text or ""

                last_excerpt = (text or "")[:500]

                if response.status_code != 200:
                    last_error_msg = f"状态码: {response.status_code}"
                    if attempt < max_attempts:
                        print_log("RSC请求", f"第{attempt}次失败[{request_url}]，{last_error_msg}，准备重试", account_index)
                        time.sleep(attempt)
                        continue
                    break

                if not (text and text.strip()):
                    last_error_msg = "返回内容为空"
                    if attempt < max_attempts:
                        print_log("RSC请求", f"第{attempt}次失败[{request_url}]，{last_error_msg}，准备重试", account_index)
                        time.sleep(attempt)
                        continue
                    break

                return text

            except Exception as e:
                last_error_msg = str(e)
                # 尝试从异常对象里提取响应内容片段
                try:
                    err_resp = getattr(e, "response", None)
                    if err_resp is not None:
                        try:
                            err_text = err_resp.content.decode("utf-8")
                        except Exception:
                            err_text = err_resp.text or ""
                        last_excerpt = (err_text or "")[:500]
                except Exception:
                    pass

                if attempt < max_attempts:
                    print_log("RSC请求", f"第{attempt}次异常[{last_request_url}]：{e}，准备重试", account_index)
                    time.sleep(attempt)
                    continue
                break

        # 第3次仍失败：打印返回内容前500字符
        excerpt_text = last_excerpt if last_excerpt else "<空>"
        print_log("RSC请求", f"重试{max_attempts}次后仍失败[{last_request_url}]：{last_error_msg}", account_index)
        print_log("RSC请求", f"返回内容前500字符: {excerpt_text}", account_index)
        raise RuntimeError(f"RSC请求失败[{last_request_url}]，{last_error_msg}")

    def _extract_json_blocks_by_key(self, text: str, key: str, open_char: str) -> List[str]:
        """从文本中提取指定 key 对应的 JSON 块（数组或对象）。"""
        if open_char == "[":
            close_char = "]"
        elif open_char == "{":
            close_char = "}"
        else:
            return []

        marker = f"\"{key}\""
        blocks: List[str] = []
        cursor = 0

        while True:
            idx = text.find(marker, cursor)
            if idx == -1:
                break
            colon = text.find(":", idx + len(marker))
            if colon == -1:
                break

            i = colon + 1
            text_len = len(text)
            while i < text_len and text[i] in (" ", "\t", "\r", "\n"):
                i += 1

            if i >= text_len or text[i] != open_char:
                cursor = idx + len(marker)
                continue

            depth = 0
            in_string = False
            escaped = False
            end_pos = -1

            for j in range(i, text_len):
                ch = text[j]
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == "\"":
                        in_string = False
                else:
                    if ch == "\"":
                        in_string = True
                    elif ch == open_char:
                        depth += 1
                    elif ch == close_char:
                        depth -= 1
                        if depth == 0:
                            end_pos = j
                            break

            if end_pos != -1:
                blocks.append(text[i:end_pos + 1])
                cursor = end_pos + 1
            else:
                break

        return blocks

    def _extract_enclosing_json_object(self, text: str, key_pos: int) -> Optional[str]:
        """给定 key 位置，提取其所在的最小包裹 JSON 对象文本。"""
        search_pos = key_pos
        while True:
            start = text.rfind("{", 0, search_pos + 1)
            if start == -1:
                return None

            depth = 0
            in_string = False
            escaped = False
            end = -1
            for i in range(start, len(text)):
                ch = text[i]
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == "\"":
                        in_string = False
                else:
                    if ch == "\"":
                        in_string = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            end = i
                            break

            if end != -1 and start <= key_pos <= end:
                return text[start:end + 1]

            search_pos = start - 1

    def _parse_offer_tasks_from_items(self, items: List[Any], source: str) -> List[Dict[str, Any]]:
        tasks: List[Dict[str, Any]] = []

        def _to_optional_bool(value: Any) -> Optional[bool]:
            """仅在值明确表达 true/false 时返回布尔，否则返回 None。"""
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return bool(value)
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in ("true", "1", "yes"):
                    return True
                if lowered in ("false", "0", "no"):
                    return False
            return None

        for item in items:
            if not isinstance(item, dict):
                continue

            offerid = item.get("offerId") or item.get("offerid")
            offer_hash = item.get("hash")
            if not offerid or not offer_hash:
                continue

            is_completed = item.get("isCompleted")
            if is_completed is None:
                is_completed = item.get("complete")
            is_completed_opt = _to_optional_bool(is_completed)
            is_completed = bool(is_completed_opt is True)

            is_locked_opt = _to_optional_bool(item.get("isLocked"))
            is_locked = bool(is_locked_opt is True)

            # 仅在 isUnlocked 明确为 false 时才判定为锁定；$undefined/空值视为未知，不强行锁定。
            is_unlocked_opt = _to_optional_bool(item.get("isUnlocked"))
            if is_unlocked_opt is False:
                is_locked = True

            is_promotional_opt = _to_optional_bool(item.get("isPromotional"))
            is_promotional = bool(is_promotional_opt is True)

            points_raw = item.get("points", item.get("pointProgressMax", 0))
            try:
                points = int(float(points_raw))
            except Exception:
                points = 0

            title = item.get("title") or item.get("name") or offerid
            destination = str(item.get("destination", "") or "")
            endpoint = "https://rewards.bing.com/earn" if source == "earn" else "https://rewards.bing.com/dashboard"
            tasks.append({
                "source": source,
                "endpoint": endpoint,
                "offerid": offerid,
                "hash": offer_hash,
                "title": title,
                "complete": is_completed,
                "locked": is_locked,
                "is_promotional": is_promotional,
                "points": points,
                "destination": destination,
                "daily_set_date": str(
                    item.get("daily_set_date")
                    or item.get("dailySetDate")
                    or item.get("date")
                    or ""
                ),
            })
        return tasks

    def _parse_earn_activity_cards(self, rsc_text: str) -> List[Dict[str, Any]]:
        """解析 earn RSC 中的 activityCards 任务。"""
        tasks: List[Dict[str, Any]] = []
        for block in self._extract_json_blocks_by_key(rsc_text, "activityCards", "["):
            try:
                cards = json.loads(block)
            except Exception:
                continue
            if isinstance(cards, list):
                tasks.extend(self._parse_offer_tasks_from_items(cards, "earn"))
        return tasks

    def _parse_earn_point_breakdown(self, rsc_text: str) -> Optional[Dict[str, Any]]:
        """解析 earn RSC 中 pointbreakdown 的 PC 搜索进度。"""
        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(str(value)))
            except Exception:
                return default

        best_candidate: Optional[Dict[str, Any]] = None
        best_score = (-1, -1, -1)

        for block in self._extract_json_blocks_by_key(rsc_text, "pointsCounters", "{"):
            try:
                counters = json.loads(block)
            except Exception:
                continue
            if not isinstance(counters, dict):
                continue

            pc_info = counters.get("pc")
            if not isinstance(pc_info, dict):
                continue

            current = _to_int(pc_info.get("progress", pc_info.get("current", 0)), 0)
            maximum = _to_int(pc_info.get("max", pc_info.get("maximum", 0)), 0)
            total_points = _to_int(counters.get("totalPoints", counters.get("total_points", -1)), -1)
            is_complete = maximum > 0 and current >= maximum

            candidate = {
                "current": max(0, current),
                "maximum": max(0, maximum),
                "complete": is_complete,
                "per_search_points": 3,
                "offerid": "earn_pointbreakdown_pc",
                "title": "电脑搜索",
                "total_points": max(-1, total_points),
                "source": "earn_rsc"
            }
            score = (candidate["maximum"], candidate["current"], candidate["total_points"])
            if score > best_score:
                best_candidate = candidate
                best_score = score

        return best_candidate

    def _parse_dashboard_dailyset_items(self, rsc_text: str) -> List[Dict[str, Any]]:
        """解析 dashboard RSC 中的 dailySetItems 任务。"""
        tasks: List[Dict[str, Any]] = []
        for block in self._extract_json_blocks_by_key(rsc_text, "dailySetItems", "["):
            try:
                items = json.loads(block)
            except Exception:
                continue
            if isinstance(items, list):
                tasks.extend(self._parse_offer_tasks_from_items(items, "dashboard"))
        return tasks

    def _parse_dashboard_point_claim(self, rsc_text: str) -> Optional[Dict[str, Any]]:
        """解析 dashboard RSC 中的 pointClaim 可领取积分信息。"""
        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(str(value)))
            except Exception:
                return default

        def _parse_point_claim_object(claim: Any, state: str = "object") -> Optional[Dict[str, Any]]:
            if claim is None:
                return {"points": 0, "entries": [], "state": "null"}
            if not isinstance(claim, dict):
                return None

            raw_entries = claim.get("entries")
            entries: List[Dict[str, Any]] = []
            if isinstance(raw_entries, list):
                for entry in raw_entries:
                    if not isinstance(entry, dict):
                        continue
                    entry_points = _to_int(entry.get("points", 0), 0)
                    entries.append({
                        "category": str(entry.get("category", "") or ""),
                        "date": str(entry.get("date", "") or ""),
                        "expiryDate": str(entry.get("expiryDate", "") or ""),
                        "points": max(0, entry_points)
                    })

            points = _to_int(claim.get("points", 0), 0)
            if points <= 0 and entries:
                points = sum(max(0, int(item.get("points", 0))) for item in entries)

            return {
                "points": max(0, points),
                "entries": entries,
                "state": state
            }

        parse_texts: List[str] = [rsc_text]
        unescaped_text = rsc_text.replace("\\\"", "\"")
        if unescaped_text != rsc_text:
            parse_texts.append(unescaped_text)

        # 优先识别 pointsclaim 组件中的 pointClaim:null，避免被误判为检查失败。
        explicit_none_patterns = [
            r'"type"\s*:\s*"pointsclaim"[\s\S]{0,1600}?"pointClaim"\s*:\s*null',
            r'"pointClaim"\s*:\s*null[\s\S]{0,1600}?"type"\s*:\s*"pointsclaim"'
        ]
        for parse_text in parse_texts:
            if any(re.search(pattern, parse_text, flags=re.IGNORECASE) for pattern in explicit_none_patterns):
                return {"points": 0, "entries": [], "state": "null"}

        for parse_text in parse_texts:
            for match in re.finditer(r'"type"\s*:\s*"pointsclaim"', parse_text, flags=re.IGNORECASE):
                obj_text = self._extract_enclosing_json_object(parse_text, match.start())
                if not obj_text:
                    continue
                try:
                    parsed = json.loads(obj_text)
                except Exception:
                    continue
                if not isinstance(parsed, dict):
                    continue

                model = parsed.get("model", {}) or {}
                if isinstance(model, dict) and "pointClaim" in model:
                    parsed_claim = _parse_point_claim_object(model.get("pointClaim"), "pointsclaim_model")
                    if parsed_claim is not None:
                        return parsed_claim

                if "pointClaim" in parsed:
                    parsed_claim = _parse_point_claim_object(parsed.get("pointClaim"), "pointsclaim_root")
                    if parsed_claim is not None:
                        return parsed_claim

        for parse_text in parse_texts:
            if re.search(r'"pointClaim"\s*:\s*null', parse_text):
                return {"points": 0, "entries": [], "state": "null"}

        best_candidate: Optional[Dict[str, Any]] = None
        best_score = (-1, -1)
        matched_block = False

        for parse_text in parse_texts:
            for block in self._extract_json_blocks_by_key(parse_text, "pointClaim", "{"):
                try:
                    claim = json.loads(block)
                except Exception:
                    continue

                candidate = _parse_point_claim_object(claim)
                if candidate is None:
                    continue

                matched_block = True
                score = (candidate["points"], len(candidate["entries"]))
                if score > best_score:
                    best_candidate = candidate
                    best_score = score

        if best_candidate is not None:
            return best_candidate
        if matched_block:
            return {"points": 0, "entries": [], "state": "empty"}
        return None

    def get_dashboard_point_claim_state(
        self,
        cookies: str,
        account_index: Optional[int] = None,
        silent: bool = False
    ) -> Optional[Dict[str, Any]]:
        """获取 dashboard RSC 中的可领取积分状态。"""
        try:
            rsc_text = self._fetch_rsc_stream(
                "https://rewards.bing.com/dashboard",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index=account_index,
                referer="https://rewards.bing.com/dashboard"
            )
            return self._parse_dashboard_point_claim(rsc_text)
        except Exception as e:
            return None

    def claim_dashboard_points_if_needed(
        self,
        cookies: str,
        account_index: Optional[int] = None
    ) -> Dict[str, Any]:
        """如 dashboard RSC 存在可领取积分，则执行领取。"""
        result: Dict[str, Any] = {
            "status": "check_failed",
            "claimable_points": 0,
            "claimed_points": 0,
            "entries": [],
            "response": "",
            "check_error": ""
        }

        claim_state = self.get_dashboard_point_claim_state(cookies, account_index=account_index, silent=True)
        if claim_state is None:
            result["check_error"] = "dashboard RSC 读取失败"
            return result

        claimable_points = 0
        try:
            claimable_points = int(claim_state.get("points", 0) or 0)
        except Exception:
            claimable_points = 0

        result["claimable_points"] = max(0, claimable_points)
        result["entries"] = list(claim_state.get("entries", []) or [])
        result["state"] = str(claim_state.get("state", "object") or "object")

        if result["claimable_points"] <= 0:
            result["status"] = "none"
            return result

        headers = {
            "Content-Type": "text/plain;charset=UTF-8",
            "next-action": "00cf5ba7699f0e920ffcff223f9e48fea78fd49784",
        }
        headers = self.request_manager.get_browser_headers(
            cookies=cookies,
            referer="https://rewards.bing.com/dashboard",
            origin="https://rewards.bing.com",
            accept="text/x-component",
            extra=headers
        )

        try:
            response = self.request_manager.make_request(
                "POST",
                "https://rewards.bing.com/dashboard",
                headers,
                data="[]",
                account_index=account_index
            )

            try:
                body = response.content.decode("utf-8")
            except Exception:
                body = response.text or ""
            result["response"] = body

            if response.status_code != 200:
                result["status"] = "failed"
                return result

            normalized = re.sub(r"\s+", "", body.lower())
            if re.search(r"(^|[^0-9])1:true([^0-9]|$)", normalized):
                result["status"] = "success"
                result["claimed_points"] = result["claimable_points"]
                return result
            if re.search(r"(^|[^0-9])1:false([^0-9]|$)", normalized):
                result["status"] = "failed"
                return result

            result["status"] = "unknown"
            return result
        except Exception as e:
            result["status"] = "failed"
            result["response"] = str(e)
            return result

    def _merge_offer_tasks(self, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """按 (source, offerid) 合并任务，避免中英双语重复执行。"""
        def _to_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(value))
            except Exception:
                return default

        merged: Dict[str, Dict[str, Any]] = {}
        for task in tasks:
            key = f"{task['source']}::{task['offerid']}"
            if key not in merged:
                merged[key] = dict(task)
                continue

            existing = merged[key]
            existing["complete"] = bool(existing.get("complete", False) or task.get("complete", False))
            existing["locked"] = bool(existing.get("locked", False) or task.get("locked", False))
            existing["is_promotional"] = bool(existing.get("is_promotional", False) or task.get("is_promotional", False))
            if _to_int(existing.get("points", 0)) <= 0 and _to_int(task.get("points", 0)) > 0:
                existing["points"] = _to_int(task.get("points", 0))
            if not existing.get("destination") and task.get("destination"):
                existing["destination"] = task.get("destination")
            if not existing.get("daily_set_date") and task.get("daily_set_date"):
                existing["daily_set_date"] = task.get("daily_set_date")
            if not existing.get("hash") and task.get("hash"):
                existing["hash"] = task["hash"]
            if existing.get("hash") and task.get("hash") and existing["hash"] != task["hash"]:
                existing["hash"] = task["hash"]
            if (not existing.get("title") or existing.get("title") == existing.get("offerid")) and task.get("title"):
                existing["title"] = task["title"]

        return list(merged.values())

    def _extract_punchcard_parents_from_earn_rsc(self, rsc_text: str) -> List[Dict[str, str]]:
        """提取 punchcard 主任务（offerid + href）。"""
        parents: Dict[str, str] = {}
        for href, href_offerid in re.findall(r'"href"\s*:\s*"(/earn/quest/?([A-Za-z0-9_%\-]*punchcard))"', rsc_text):
            offerid = unquote(href_offerid)
            if "punchcard" in offerid.lower():
                parents[offerid] = unquote(href)

        # 兜底：从 offerId 提取 parent，但 href 不存在时跳过
        for offerid in re.findall(r'"offerId"\s*:\s*"([^"]*punchcard[^"]*)"', rsc_text, flags=re.IGNORECASE):
            if offerid not in parents:
                maybe_href = f"/earn/quest{offerid}"
                if f"\"{maybe_href}\"" in rsc_text:
                    parents[offerid] = maybe_href

        return [{"offerid": k, "href": v} for k, v in parents.items()]

    def _fetch_punchcard_child_tasks(
        self,
        cookies: str,
        parent_offerid: str,
        parent_href: str,
        parent_name: Optional[str] = None,
        account_index: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """拉取 punchcard 页面并提取子任务。"""
        display_parent = parent_name or parent_offerid
        candidate_hrefs: List[str] = []
        if parent_href:
            candidate_hrefs.append(parent_href)

        alt_no_slash = f"/earn/quest{parent_offerid}"
        alt_with_slash = f"/earn/quest/{parent_offerid}"
        if alt_no_slash not in candidate_hrefs:
            candidate_hrefs.append(alt_no_slash)
        if alt_with_slash not in candidate_hrefs:
            candidate_hrefs.append(alt_with_slash)

        rsc_text = ""
        used_href = parent_href
        last_error: Optional[Exception] = None
        tried_urls: List[str] = []
        for href in candidate_hrefs:
            for attempt_index in range(2):
                try:
                    referer = f"https://rewards.bing.com{href}"
                    url = f"https://rewards.bing.com{href}"
                    tried_urls.append(self._build_rsc_url(url))
                    rsc_text = self._fetch_rsc_stream(
                        url,
                        cookies,
                        "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
                        account_index=account_index,
                        referer=referer
                    )
                    used_href = href
                    if href != parent_href or attempt_index > 0:
                        print_log("Punch Card", f"任务页回退成功: href={href}, attempt={attempt_index + 1}", account_index)
                    break
                except Exception as e:
                    last_error = e
                    continue
            if rsc_text:
                break

        if not rsc_text:
            tried_desc = " | ".join(tried_urls[-6:]) if tried_urls else "无"
            print_log("Punch Card", f"获取任务页失败[{display_parent}]: {last_error}", account_index)
            print_log("Punch Card", f"已尝试URL: {tried_desc}", account_index)
            return []

        tasks: List[Dict[str, Any]] = []
        seen: set = set()
        parse_texts: List[str] = [rsc_text]
        if "\\\"offerId\\\"" in rsc_text or "\\\"aria-label\\\"" in rsc_text:
            parse_texts.append(rsc_text.replace("\\\"", "\""))

        # 优先用强规则直接提取子任务（避免非标准 JSON 造成解析失败）
        direct_pattern = re.compile(
            r'"aria-label"\s*:\s*"([^"]+)"[\s\S]{0,800}?'
            r'"href"\s*:\s*"([^"]+)"[\s\S]{0,800}?'
            r'"offerId"\s*:\s*"([^"]*pcchild[^"]*punchcard[^"]*)"[\s\S]{0,300}?'
            r'"hash"\s*:\s*"([^"]+)"[\s\S]{0,300}?'
            r'"isCompleted"\s*:\s*(true|false)[\s\S]{0,120}?'
            r'"isLocked"\s*:\s*(true|false)',
            flags=re.IGNORECASE | re.DOTALL
        )
        for parse_text in parse_texts:
            for aria_label, href, offerid, offer_hash, is_completed, is_locked in direct_pattern.findall(parse_text):
                dedup_key = f"{offerid}:{offer_hash}"
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                target_href = href if isinstance(href, str) and href.startswith("/") else used_href
                tasks.append({
                    "source": "punchcard",
                    "endpoint": f"https://rewards.bing.com{target_href}",
                    "parent_offerid": parent_offerid,
                    "parent_href": used_href,
                    "referer": f"https://rewards.bing.com{target_href}",
                    "title": aria_label,
                    "href": href,
                    "offerid": offerid,
                    "hash": offer_hash,
                    "complete": str(is_completed).lower() == "true",
                    "locked": str(is_locked).lower() == "true",
                })

        # direct_pattern 没提全时，再走对象/邻域兜底
        for parse_text in parse_texts:
            for match in re.finditer(r'"offerId"\s*:\s*"([^"]*punchcard[^"]*)"', parse_text, flags=re.IGNORECASE):
                offerid = match.group(1)
                if "pcchild" not in offerid.lower():
                    continue
                key_pos = match.start()
                obj_text = self._extract_enclosing_json_object(parse_text, key_pos)
                obj_data: Dict[str, Any] = {}
                if obj_text:
                    try:
                        parsed = json.loads(obj_text)
                        if isinstance(parsed, dict):
                            obj_data = parsed
                    except Exception:
                        obj_data = {}

                # JSON 解析失败时，回退到邻域正则提取
                if not obj_data:
                    win_start = max(0, key_pos - 500)
                    win_end = min(len(parse_text), key_pos + 1000)
                    window = parse_text[win_start:win_end]
                    offerid_escaped = re.escape(offerid)

                    # 优先按当前 offerId 锚定，避免提取到相邻卡片的字段
                    anchored = re.search(
                        r'"aria-label"\s*:\s*"([^"]+)"\s*,\s*"href"\s*:\s*"([^"]+)"\s*,\s*"offerId"\s*:\s*"'
                        + offerid_escaped
                        + r'"\s*,\s*"hash"\s*:\s*"([^"]+)"\s*,\s*"isCompleted"\s*:\s*(true|false)\s*,\s*"isLocked"\s*:\s*(true|false)',
                        window,
                        flags=re.IGNORECASE | re.DOTALL
                    )

                    if anchored:
                        obj_data = {
                            "offerId": offerid,
                            "aria-label": anchored.group(1),
                            "href": anchored.group(2),
                            "hash": anchored.group(3),
                            "isCompleted": anchored.group(4).lower() == "true",
                            "isLocked": anchored.group(5).lower() == "true",
                        }
                    else:
                        # 再次回退为宽松模式（仍保留当前 offerId），尽量不中断流程
                        hash_match = re.search(r'"offerId"\s*:\s*"' + offerid_escaped + r'"\s*,\s*"hash"\s*:\s*"([^"]+)"', window, flags=re.IGNORECASE | re.DOTALL)
                        completed_match = re.search(r'"offerId"\s*:\s*"' + offerid_escaped + r'".{0,220}"isCompleted"\s*:\s*(true|false)', window, flags=re.IGNORECASE | re.DOTALL)
                        locked_match = re.search(r'"offerId"\s*:\s*"' + offerid_escaped + r'".{0,260}"isLocked"\s*:\s*(true|false)', window, flags=re.IGNORECASE | re.DOTALL)
                        title_match = re.search(r'"aria-label"\s*:\s*"([^"]+)"', window)
                        href_match = re.search(r'"href"\s*:\s*"([^"]+)"', window)
                        obj_data = {
                            "offerId": offerid,
                            "aria-label": title_match.group(1) if title_match else offerid,
                            "href": href_match.group(1) if href_match else "",
                            "hash": hash_match.group(1) if hash_match else "",
                            "isCompleted": (completed_match.group(1).lower() == "true") if completed_match else False,
                            "isLocked": (locked_match.group(1).lower() == "true") if locked_match else False,
                        }

                offer_hash = obj_data.get("hash")
                if not offer_hash:
                    continue

                dedup_key = f"{offerid}:{offer_hash}"
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                aria_label = obj_data.get("aria-label") or obj_data.get("title") or offerid
                href = obj_data.get("href", "")
                is_completed = obj_data.get("isCompleted", False)
                is_locked = obj_data.get("isLocked", False)
                if isinstance(is_completed, str):
                    is_completed = is_completed.lower() == "true"
                if isinstance(is_locked, str):
                    is_locked = is_locked.lower() == "true"
                target_href = href if isinstance(href, str) and href.startswith("/") else used_href

                tasks.append({
                    "source": "punchcard",
                    "endpoint": f"https://rewards.bing.com{target_href}",
                    "parent_offerid": parent_offerid,
                    "parent_href": used_href,
                    "referer": f"https://rewards.bing.com{target_href}",
                    "title": aria_label,
                    "href": href,
                    "offerid": offerid,
                    "hash": offer_hash,
                    "complete": bool(is_completed),
                    "locked": bool(is_locked),
                })

        if not tasks:
            print_log("Punch Card", f"{display_parent} 未找到可执行任务", account_index)
        return tasks

    def _submit_rsc_offer_activity(
        self,
        cookies: str,
        endpoint: str,
        offerid: str,
        offer_hash: str,
        account_index: Optional[int] = None,
        referer: str = "https://rewards.bing.com/earn",
        task_name: Optional[str] = None
    ) -> int:
        """执行 RSC offer 任务，成功返回 1。"""
        try:
            display_name = task_name or offerid

            def _escape_text(value: str) -> str:
                return str(value).replace("\\", "\\\\").replace('"', '\\"')

            offer_hash_text = _escape_text(offer_hash)
            offerid_text = _escape_text(offerid)
            payload = f"[\"{offer_hash_text}\",11,{{\"offerid\":\"{offerid_text}\",\"isPromotional\":\"$undefined\",\"timezoneOffset\":\"-480\"}}]"

            headers = {
                "Content-Type": "text/plain;charset=UTF-8",
                "next-action": "70babbc81d2724f60d29a95c03b3d739cba77cea92",
            }
            headers = self.request_manager.get_browser_headers(
                cookies=cookies,
                referer=referer,
                origin="https://rewards.bing.com",
                accept="text/x-component",
                extra=headers
            )

            response = self.request_manager.make_request(
                "POST",
                endpoint,
                headers,
                data=payload,
                account_index=account_index
            )

            if response.status_code != 200:
                print_log("提交额外活动", f"执行失败: {display_name}，状态码: {response.status_code}", account_index)
                return -1

            body = response.text or ""
            normalized = re.sub(r"\s+", "", body.lower())
            if re.search(r"(^|[^0-9])1:true([^0-9]|$)", normalized):
                return 1
            if re.search(r"(^|[^0-9])1:false([^0-9]|$)", normalized):
                return -1

            snippet = body.replace("\r", " ").replace("\n", " ")[:300]
            print_log("提交额外活动", f"执行响应结构异常: {display_name}，未识别完成标记，片段: {snippet}", account_index)
            return -1
        except Exception as e:
            print_log("提交额外活动", f"执行异常: {task_name or offerid}，{e}", account_index)
            return -1
    def complete_all_offers(self, cookies: str, account_index: Optional[int] = None) -> List[str]:
        """基于 earn/dashboard RSC 数据执行 offerid 任务。"""
        completed_ids: List[str] = []

        try:
            earn_zh = self._fetch_rsc_stream(
                "https://rewards.bing.com/earn",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index
            )
            earn_en = self._fetch_rsc_stream(
                "https://rewards.bing.com/earn",
                cookies,
                "en-US,en;q=0.9",
                account_index
            )
            dash_rsc = self._fetch_rsc_stream(
                "https://rewards.bing.com/dashboard",
                cookies,
                "zh-CN,zh;q=0.9",
                account_index,
                referer="https://rewards.bing.com/dashboard"
            )
        except Exception as e:
            print_log("额外活动", f"获取数据失败: {e}", account_index)
            return completed_ids

        earn_tasks = self._parse_earn_activity_cards(earn_zh) + self._parse_earn_activity_cards(earn_en)
        dashboard_tasks = self._parse_dashboard_dailyset_items(dash_rsc)
        all_tasks = self._merge_offer_tasks(earn_tasks + dashboard_tasks)
        offer_title_map: Dict[str, str] = {}
        for t in all_tasks:
            oid = str(t.get("offerid", "") or "")
            title = str(t.get("title", "") or "")
            if oid and title and oid not in offer_title_map:
                offer_title_map[oid] = title

        if not all_tasks:
            print_log("额外活动", "未解析到 activityCards/dailySetItems 任务，继续检查 punchcard", account_index)

        def _safe_int(value: Any, default: int = 0) -> int:
            try:
                return int(float(value))
            except Exception:
                return default

        def _is_today_daily_set_task(task: Dict[str, Any]) -> bool:
            """Dashboard DailySet 仅执行当天任务；无日期字段时默认放行。"""
            if str(task.get("source", "")) != "dashboard":
                return False
            offerid_text = str(task.get("offerid", "") or "")
            if "Gamification_DailySet_" not in offerid_text:
                return False

            ds = str(task.get("daily_set_date", "") or "").strip()
            if not ds:
                return False

            today_obj = date.today()
            today_std = today_obj.strftime("%m/%d/%Y")
            if ds == today_std:
                return True

            for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
                try:
                    return datetime.strptime(ds, fmt).date() == today_obj
                except Exception:
                    continue
            return False

        filter_stats = {
            "completed": 0,
            "locked": 0,
            "missing_offerid_or_hash": 0,
            "no_points_or_promo_or_redeem": 0,
            "not_today_dailyset": 0,
            "punchcard_parent": 0,
            "pending": 0
        }
        pending_tasks: List[Dict[str, Any]] = []
        for t in all_tasks:
            if t.get("complete", False):
                filter_stats["completed"] += 1
                continue
            if t.get("locked", False):
                filter_stats["locked"] += 1
                continue
            if not t.get("offerid") or not t.get("hash"):
                filter_stats["missing_offerid_or_hash"] += 1
                continue
            if (
                _safe_int(t.get("points", 0)) <= 0
                or t.get("is_promotional", False)
                or "/redeem/" in str(t.get("destination", "")).lower()
            ):
                filter_stats["no_points_or_promo_or_redeem"] += 1
                continue
            if "punchcard" in str(t.get("offerid", "")).lower():
                filter_stats["punchcard_parent"] += 1
                continue
            if str(t.get("source", "")) == "dashboard" and "Gamification_DailySet_" in str(t.get("offerid", "")):
                if not _is_today_daily_set_task(t):
                    filter_stats["not_today_dailyset"] += 1
                    continue

            filter_stats["pending"] += 1
            pending_tasks.append(t)

        skipped_promo_count = filter_stats["no_points_or_promo_or_redeem"]
        if skipped_promo_count:
            print_log("额外活动", f"已跳过 {skipped_promo_count} 个促销/零分/兑换活动", account_index)
        if filter_stats["not_today_dailyset"] > 0:
            print_log("额外活动", f"已跳过 {filter_stats['not_today_dailyset']} 个非今日任务", account_index)
        print_log(
            "额外活动",
            f"共解析任务 {len(all_tasks)} 个，待执行 {len(pending_tasks)} 个（earn: {len(earn_tasks)}，dashboard: {len(dashboard_tasks)}）",
            account_index
        )
        print_log(
            "额外活动",
            (
                f"过滤明细: 已完成 {filter_stats['completed']}，未解锁 {filter_stats['locked']}，"
                f"缺少关键字段 {filter_stats['missing_offerid_or_hash']}，促销/零分/兑换 {filter_stats['no_points_or_promo_or_redeem']}，"
                f"Punch Card主任务 {filter_stats['punchcard_parent']}"
            ),
            account_index
        )

        for idx, task in enumerate(pending_tasks, 1):
            offerid = task["offerid"]
            title = task.get("title") or offerid
            source = task.get("source", "earn")
            endpoint = task["endpoint"]
            offer_hash = task["hash"]

            print_log("额外活动", f"正在处理 ({idx}/{len(pending_tasks)}) [{source}] {title}", account_index)
            result = self._submit_rsc_offer_activity(
                cookies,
                endpoint,
                offerid,
                offer_hash,
                account_index,
                referer=endpoint,
                task_name=title
            )
            if result > 0:
                completed_ids.append(f"{source}:{offerid}")
                print_log("额外活动", f"✅ 完成: {title}", account_index)
            else:
                print_log("额外活动", f"❌ 未完成: {title}", account_index)

            time.sleep(random.uniform(2, 4))

        # punchcard 任务链路（从 earn 接口提取 parent punchcard，再拉 quest 接口解析子任务）
        punchcard_parents = self._extract_punchcard_parents_from_earn_rsc(earn_zh) + self._extract_punchcard_parents_from_earn_rsc(earn_en)
        merged_parent_map: Dict[str, str] = {}
        for parent in punchcard_parents:
            poid = parent.get("offerid", "")
            phref = parent.get("href", "")
            if poid and phref:
                merged_parent_map[poid] = phref

        if merged_parent_map:
            print_log("Punch Card", f"发现 {len(merged_parent_map)} 个主任务", account_index)

        for parent_offerid, parent_href in merged_parent_map.items():
            parent_title = offer_title_map.get(parent_offerid, parent_offerid)
            child_tasks = self._fetch_punchcard_child_tasks(
                cookies, parent_offerid, parent_href, parent_name=parent_title, account_index=account_index
            )
            if not child_tasks:
                print_log("Punch Card", f"跳过: {parent_title}", account_index)
                continue

            print_log("Punch Card", f"{parent_title} 找到 {len(child_tasks)} 个可执行任务", account_index)
            for idx, task in enumerate(child_tasks, 1):
                offerid = task["offerid"]
                title = task.get("title") or offerid
                is_completed = bool(task.get("complete", False))
                is_locked = bool(task.get("locked", False))

                if is_completed:
                    print_log("Punch Card", f"跳过 ({idx}/{len(child_tasks)}) 已完成: {title}", account_index)
                    continue
                if is_locked:
                    print_log("Punch Card", f"跳过 ({idx}/{len(child_tasks)}) 未解锁: {title}", account_index)
                    continue

                print_log("Punch Card", f"执行({idx}/{len(child_tasks)}): {title}", account_index)
                result = self._submit_rsc_offer_activity(
                    cookies,
                    task["endpoint"],
                    offerid,
                    task["hash"],
                    account_index=account_index,
                    referer=task["referer"],
                    task_name=title
                )
                if result > 0:
                    completed_ids.append(f"Punch Card:{offerid}")
                    print_log("Punch Card", f"✅ 完成: {title}", account_index)
                else:
                    print_log("Punch Card", f"❌ 失败: {title}", account_index)
                time.sleep(random.uniform(2, 4))

        return completed_ids

    # ==================== 8. 通知方法 ====================
    def _send_cookie_invalid_notification(self, account_index: Optional[int] = None):
        """发送Cookie失效的独立通知"""
        try:
            self.notification_manager.send_cookie_invalid(account_index)
            print_log("Cookie通知", f"已发送账号{account_index}的Cookie失效通知", account_index)
        except Exception as e:
            print_log("Cookie通知", f"发送Cookie失效通知失败: {e}", account_index)
    
    def _send_token_invalid_notification(self, account_index: Optional[int] = None):
        """发送刷新令牌失效的独立通知"""
        try:
            title = f"🚨 Microsoft Rewards 刷新令牌失效警告"
            content = f"账号{account_index} 的刷新令牌已失效，阅读任务无法执行！\n\n"
            content += f"失效时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            content += f"需要处理: 重新获取账号{account_index}的刷新令牌\n\n"
            content += f"刷新令牌获取步骤:\n"
            content += f"1. 安装 <Bing Rewards 自动获取刷新令牌> 油猴脚本\n"
            content += f"2. 访问 https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&response_type=code&redirect_uri=https://login.live.com/oauth20_desktop.srf\n"
            content += f"3. 登录后，使用 <Bing Rewards 自动获取刷新令牌> 油猴脚本，自动获取刷新令牌\n"
            content += f"4. 更新环境变量 bing_token_{account_index} 为获取到的刷新令牌\n"
            content += f"5. 重新运行脚本\n"
            self.notification_manager.send(title, content)
            print_log("令牌通知", f"已发送账号{account_index}的刷新令牌失效通知", account_index)
        except Exception as e:
            print_log("令牌通知", f"发送刷新令牌失效通知失败: {e}", account_index)

# ==================== 主程序类 ====================
class RewardsBot:
    """Microsoft Rewards 自动化机器人主类 - 多账号分离版本"""
    
    def __init__(self):
        self.accounts = AccountManager.get_accounts()
        
        if not self.accounts:
            print_log("启动错误", "没有检测到任何账号配置，程序退出")
            print_log("配置提示", "请设置环境变量: bing_ck_1, bing_ck_2... 和可选的 bing_token_1, bing_token_2...")
            exit(1)
        
        print_log("脚本版本", f"运行版本 {SCRIPT_VERSION}")
        print_log("初始化", f"检测到 {len(self.accounts)} 个账号，即将开始...")
        
        # 统计有效刷新令牌数量
        valid_tokens = sum(1 for account in self.accounts if account.refresh_token)
        if valid_tokens > 0:
            print_log("初始化", f"检测到 {valid_tokens} 个令牌，启用APP阅读和Edge浏览打卡...")

    def process_single_account(self, account: AccountInfo, service: RewardsService, stop_event: threading.Event) -> Optional[str]:
        """处理单个账号的完整流程"""
        try:
            account_index = account.index
            cookies = account.cookies
            
            # 获取账号信息
            initial_data = service.get_rewards_points(cookies, account_index)
            if not initial_data:
                print_log("账号处理", "获取账号信息失败，跳过此账号", account_index)
                return None
            
            email = initial_data.get('email', '未知邮箱')
            current_points = initial_data['points']  # 当前即时积分
            logger.account_start(email, current_points, account_index)
            service._last_pc_search_report_earned = None
            service._pc_search_bootstrap_active = False

            # 获取访问令牌（用于阅读、额外活动和Edge浏览打卡）
            access_token = None
            app_sign_in_points = -2
            edge_checkin_points = -2
            point_claim_status = "not_run"
            point_claim_points = 0
            read_completed = 0
            streak_visibility = {"edge": False, "app": False}

            def _recheck_streak_visibility(stage_name: str) -> Dict[str, bool]:
                """在关键阶段前复查 Edge/APP 连签可见性。"""
                nonlocal access_token, streak_visibility
                if streak_visibility.get("edge") and streak_visibility.get("app"):
                    return streak_visibility
                retry_token = access_token
                if account.refresh_token:
                    retry_token = service.get_access_token(
                        account.refresh_token,
                        account.alias,
                        account_index,
                        silent=True
                    ) or access_token
                    if retry_token:
                        access_token = retry_token

                latest_visibility = service.get_visible_streak_status(
                    cookies,
                    retry_token,
                    account_index,
                    silent=True
                )
                recovered_labels = []
                if (not streak_visibility.get("app")) and latest_visibility.get("app"):
                    recovered_labels.append("APP签到")
                if (not streak_visibility.get("edge")) and latest_visibility.get("edge"):
                    recovered_labels.append("Edge浏览")
                streak_visibility = {
                    "edge": bool(streak_visibility.get("edge") or latest_visibility.get("edge")),
                    "app": bool(streak_visibility.get("app") or latest_visibility.get("app"))
                }
                if recovered_labels:
                    logger.success("连胜任务检测", f"{stage_name}复查命中: {'、'.join(recovered_labels)}", account_index)
                return streak_visibility
            
            if account.refresh_token:
                access_token = service.get_access_token(account.refresh_token, account.alias, account_index)
                
                if access_token:
                    streak_visibility = service.get_visible_streak_status(cookies, access_token, account_index, silent=True)
                    if not (streak_visibility.get("edge") or streak_visibility.get("app")):
                        logger.warning("连胜任务检测", "首次未发现可见的 streak 任务块，疑似被屏蔽，后续阶段将复查", account_index)

                    # 先执行阅读任务（按用户期望优先）
                    read_completed = service.complete_read_tasks(account.refresh_token, account.alias, account_index, access_token)
                    logger.success("阅读任务", f"已完成 ({read_completed}/30)", account_index)

                    if not streak_visibility.get("app"):
                        _recheck_streak_visibility("APP签到前")

                    if streak_visibility.get("app"):
                        app_sign_in_points = service.app_sign_in(access_token, account_index)
                        if app_sign_in_points > 0:
                            logger.success("APP签到", f"签到成功，获得 {app_sign_in_points} 积分", account_index)
                        elif app_sign_in_points == 0:
                            logger.success("APP签到", "今日已签到", account_index)
                        else:
                            logger.warning("APP签到", "签到失败", account_index)
                    else:
                        app_sign_in_points = -3
                        logger.skip("APP签到", "可能被屏蔽 (已跳过)", account_index)
                else:
                    app_sign_in_points = -2
                    logger.skip("阅读任务", "无法获取访问令牌", account_index)
                    logger.skip("APP签到", "无法获取访问令牌", account_index)
            else:
                app_sign_in_points = -2
                logger.skip("阅读任务", "未配置刷新令牌", account_index)
                logger.skip("APP签到", "未配置刷新令牌", account_index)
                streak_visibility = service.get_visible_streak_status(cookies, None, account_index, silent=True)
                if not (streak_visibility.get("edge") or streak_visibility.get("app")):
                    logger.warning("连胜任务检测", "首次未发现可见的 streak 任务块，疑似被屏蔽，后续阶段将复查", account_index)

            # 初始化变量，避免未定义错误
            daily_completed = 0
            daily_total = 0
            more_completed = 0
            more_total = 0
            
            # 执行额外任务：RSC offerid 仅依赖 cookies
            extra_completed_count = 0
            completed_offers = service.complete_all_offers(cookies, account_index=account_index)
            extra_completed_count = len(completed_offers)
            if completed_offers:
                logger.success("额外活动", f"已执行 {extra_completed_count} 个任务", account_index)
            
            # 先执行 Edge 浏览连续打卡任务
            if not streak_visibility.get("edge"):
                _recheck_streak_visibility("Edge浏览前")
            if not streak_visibility.get("edge"):
                edge_checkin_points = -3
                logger.skip("Edge浏览打卡", "可能被屏蔽 (已跳过)", account_index)
            elif account.refresh_token:
                edge_access_token = service.get_access_token(account.refresh_token, account.alias, account_index, silent=True) or access_token
                if edge_access_token:
                    access_token = edge_access_token
                    edge_checkin_points = service.complete_edge_checkin(edge_access_token, account_index, cookies)
                    if edge_checkin_points > 0:
                        logger.success("Edge浏览打卡", f"完成并获得 {edge_checkin_points} 积分", account_index)
                    elif edge_checkin_points == 0:
                        logger.success("Edge浏览打卡", "任务已完成", account_index)
                    elif edge_checkin_points == -3:
                        logger.skip("Edge浏览打卡", "状态疑似被屏蔽或无效，已跳过", account_index)
                    else:
                        logger.warning("Edge浏览打卡", "任务执行失败", account_index)
                else:
                    logger.skip("Edge浏览打卡", "无法获取访问令牌", account_index)
            else:
                edge_checkin_points = -2
                logger.skip("Edge浏览打卡", "未配置刷新令牌", account_index)

            # 电脑搜索放到最后，避免搜索计数异常影响额外任务和 Edge 浏览
            search_completed = self._perform_search_tasks(cookies, account_index, service, stop_event, access_token)

            point_claim_result = service.claim_dashboard_points_if_needed(cookies, account_index)
            point_claim_status = str(point_claim_result.get("status", "check_failed") or "check_failed")
            point_claim_points = int(point_claim_result.get("claimed_points", 0) or 0)
            claimable_points = int(point_claim_result.get("claimable_points", 0) or 0)
            claim_response = str(point_claim_result.get("response", "") or "")

            if point_claim_status == "success":
                logger.success("领取积分", f"成功领取 {point_claim_points} 积分", account_index)
            elif point_claim_status == "none":
                logger.info("领取积分", "没有可领取的积分", account_index)
            elif point_claim_status == "check_failed":
                check_error = str(point_claim_result.get("check_error", "") or "")
                if check_error:
                    logger.warning("领取积分", f"dashboard RSC 检查失败，未执行领取: {check_error}", account_index)
                else:
                    logger.warning("领取积分", "dashboard RSC 检查失败，未执行领取", account_index)
            elif point_claim_status == "failed":
                if claim_response:
                    logger.warning("领取积分", f"领取失败，待领取 {claimable_points} 积分，响应: {claim_response[:300]}", account_index)
                else:
                    logger.warning("领取积分", f"领取失败，待领取 {claimable_points} 积分", account_index)
            else:
                logger.warning("领取积分", f"领取结果未知，待领取 {claimable_points} 积分，响应: {claim_response[:300]}", account_index)
            
            # 获取最终积分
            final_data = service.get_rewards_points(cookies, account_index)
            if final_data and final_data['points'] is not None:
                final_points = final_data['points']

                # 通过移动端信息接口汇总今日积分/每日活动/继续赚取
                summary_token = access_token
                if not summary_token and account.refresh_token:
                    summary_token = service.get_access_token(account.refresh_token, account.alias, account_index, silent=True)

                mobile_summary = service.get_mobile_info_summary(summary_token, account_index, silent=True) if summary_token else None
                today_total_earned = mobile_summary.get("today_points", 0) if mobile_summary else 0
                daily_completed = mobile_summary.get("daily_completed", 0) if mobile_summary else 0
                daily_total = mobile_summary.get("daily_total", 0) if mobile_summary else 0
                more_completed = mobile_summary.get("more_completed", 0) if mobile_summary else 0
                more_total = mobile_summary.get("more_total", 0) if mobile_summary else 0

                logger.success("每日活动", f"已完成({daily_completed}/{daily_total})", account_index)
                logger.success("继续赚取", f"已完成({more_completed}/{more_total})", account_index)

                if search_completed and not stop_event.is_set():
                    self._log_account_complete(final_points, today_total_earned, account_index)
                else:
                    logger.warning("任务状态", f"本轮仍有任务未完成，当前积分 {final_points} ({today_total_earned})", account_index)
                
                # 生成详细的任务摘要
                summary = self._format_account_summary(
                    email, final_points,
                    daily_completed, daily_total, more_completed, more_total, read_completed,
                    account_index, cookies, account, service,
                    today_total_earned, app_sign_in_points, edge_checkin_points, access_token,
                    extra_completed_count=extra_completed_count,
                    point_claim_status=point_claim_status,
                    point_claim_points=point_claim_points
                )
                return summary
            else:
                print_log("脚本完成", "无法获取最终积分", account_index)
                return None
        
        except SystemExit:
            return None
        except Exception as e:
            error_details = traceback.format_exc()
            print_log("账号处理错误", f"处理账号时发生异常: {e}", account_index)
            print_log("错误详情", f"详细错误信息: {error_details}", account_index)
            return None
    
    def _perform_search_tasks(
        self,
        cookies: str,
        account_index: int,
        service: RewardsService,
        stop_event: threading.Event,
        access_token: Optional[str]
    ) -> bool:
        """执行电脑搜索任务：按当前剩余进度执行单轮搜索，不做补跑。"""
        def _safe_int(value: Any, default: int = 0) -> int:
            try:
                return int(value)
            except Exception:
                return default

        def _query_status_with_retry(stage: str, retries: int = 3, delay_seconds: int = 2) -> Optional[Dict[str, Any]]:
            for attempt in range(1, retries + 1):
                if access_token:
                    status_data = service.get_pc_search_status_from_mobile_promotions(access_token, account_index, silent=True)
                    if status_data:
                        return status_data
                status_data = service.get_pc_search_status_from_earn_rsc(cookies, account_index, silent=True)
                if status_data:
                    logger.info(
                        "电脑搜索",
                        f"{stage}进度改用 earn 页面 pointbreakdown 回退 ({status_data.get('current', 0)}/{status_data.get('maximum', 0)})",
                        account_index
                    )
                    return status_data
                if attempt < retries:
                    logger.warning("电脑搜索", f"{stage}进度查询失败，{delay_seconds}秒后重试({attempt}/{retries})", account_index)
                    time.sleep(delay_seconds)
            return None

        status = _query_status_with_retry("初始")
        if not status:
            if not access_token:
                required_searches = 20
                success_count = 0
                failed_count = 0
                planned_searches = min(required_searches, max(1, int(config.SEARCH_MAX_PER_ROUND)))
                logger.search_start("电脑", required_searches, account_index, planned_searches)
                for i in range(planned_searches):
                    delay = random.randint(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX)
                    if service.perform_pc_search(cookies, account_index):
                        success_count += 1
                        logger.search_progress("电脑", i + 1, planned_searches, delay, account_index)
                        time.sleep(delay)
                    else:
                        failed_count += 1
                        print_log("电脑搜索", f"第{i + 1}次搜索失败，等待 {delay} 秒", account_index)
                        time.sleep(delay)
                logger.search_progress_summary("电脑", planned_searches, 0, 0, account_index, success_count, failed_count, 0)
                logger.warning("电脑搜索", f"缺少刷新令牌且 earn 页面无进度数据，本轮按固定{planned_searches}次执行", account_index)
                return True

            stop_event.set()
            logger.warning("电脑搜索", "无法从移动端信息或 earn 页面获取搜索进度", account_index)
            return False

        pc_current = _safe_int(status.get("current", 0), 0)
        pc_max = _safe_int(status.get("maximum", 0), 0)
        per_search_points = _safe_int(status.get("per_search_points", 3), 3)
        if per_search_points <= 0:
            per_search_points = 3

        if bool(status.get("complete", False)):
            logger.success("电脑搜索", f"已完成 ({pc_current}/{pc_max})", account_index)
            return True

        service._pc_search_bootstrap_active = (pc_current == 0)
        service._last_pc_search_report_earned = pc_current
        round_start_progress = pc_current
        total_attempts = 0
        success_count = 0
        failed_count = 0
        ignored_count = 0

        if pc_max > 0:
            remaining_points = max(0, pc_max - pc_current)
            required_searches = (remaining_points + per_search_points - 1) // per_search_points if remaining_points > 0 else 0
        else:
            required_searches = 20
            print_log("电脑搜索", f"移动端信息未返回有效上限，本轮最多执行{max(1, int(config.SEARCH_MAX_PER_ROUND))}次", account_index)

        if required_searches > 0:
            planned_searches = min(required_searches, max(1, int(config.SEARCH_MAX_PER_ROUND)))
        else:
            planned_searches = 0

        if planned_searches > 0:
            logger.search_start("电脑", required_searches, account_index, planned_searches)
            for i in range(planned_searches):
                delay = random.randint(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX)
                search_ok = service.perform_pc_search(cookies, account_index)
                result_state = ""
                if isinstance(service.last_pc_search_result, dict):
                    result_state = str(service.last_pc_search_result.get("state", "") or "")

                if result_state == "bootstrap_wait":
                    ignored_count += 1
                    logger.search_progress_bar("电脑", i + 1, planned_searches, account_index)
                    print_log("电脑搜索", f"第{i + 1}次处于启动窗口，搜索积分仍未开始累计", account_index)
                    time.sleep(delay)
                    continue

                if result_state == "bootstrap_exit":
                    service._pc_search_bootstrap_active = False
                    ignored_count += 1
                    if isinstance(service.last_pc_search_result, dict):
                        classification = service.last_pc_search_result.get("classification", {}) or {}
                        current_value = classification.get("current", "?")
                    else:
                        current_value = "?"
                    logger.search_progress_bar("电脑", i + 1, planned_searches, account_index)
                    print_log("电脑搜索", f"第{i + 1}次结束启动窗口，累计搜索积分进入正常区间 ({current_value}/{pc_max})", account_index)
                    time.sleep(delay)
                    continue

                if search_ok:
                    success_count += 1
                    logger.search_progress("电脑", i + 1, planned_searches, delay, account_index)
                    time.sleep(delay)
                else:
                    failed_count += 1
                    print_log("电脑搜索", f"第{i + 1}次搜索失败（累计搜索积分未变化），等待 {delay} 秒", account_index)
                    time.sleep(delay)
            total_attempts = planned_searches
        else:
            logger.info("电脑搜索", f"当前进度 {pc_current}/{pc_max}，无需继续搜索", account_index)

        latest_status = _query_status_with_retry("本轮后")
        if not latest_status:
            stop_event.set()
            logger.warning("电脑搜索", "本轮执行后无法获取移动端或 earn 页面进度", account_index)
            return False

        status = latest_status
        pc_current = _safe_int(status.get("current", pc_current), pc_current)
        pc_max = _safe_int(status.get("maximum", pc_max), pc_max)
        logger.search_progress_summary("电脑", planned_searches, round_start_progress, pc_current, account_index, success_count, failed_count, ignored_count)

        if bool(status.get("complete", False)):
            logger.search_complete("电脑", total_attempts, account_index, True)
            return True

        logger.info("电脑搜索", f"单轮执行结束，当前进度 {pc_current}/{pc_max}，等待下次整体运行继续", account_index)
        stop_event.set()
        return False

    def _log_account_complete(self, final_points: int, today_earned: int, account_index: int):
        """记录账号任务完成日志"""
        msg = f"{final_points} ({today_earned})"
        logger._log(2, "🎉", "任务完成", msg, account_index)  # 2 = LogLevel.SUCCESS

    def _format_account_summary(self, email: str, final_points: int,
                               daily_completed: int, daily_total: int, more_completed: int, more_total: int, read_completed: int,
                               account_index: int, cookies: str, account: AccountInfo, service: RewardsService,
                               today_total_earned: int = 0, app_sign_in_points: int = -2, edge_checkin_points: int = -2, access_token: Optional[str] = None,
                               extra_completed_count: int = 0, point_claim_status: str = "not_run",
                               point_claim_points: int = 0) -> str:
        """格式化账号摘要（仅保留当前稳定任务项）。"""
        lines = [
            f"账号{account_index} - {email}",
            f"📊当前积分: {final_points} ({today_total_earned})"
        ]

        if extra_completed_count > 0:
            lines.append(f"🎁额外活动: 已执行 {extra_completed_count} 个任务")

        if app_sign_in_points > 0:
            lines.append(f"✅APP签到: 已完成 (+{app_sign_in_points})")
        elif app_sign_in_points == 0:
            lines.append("✅APP签到: 今日已签到")
        elif app_sign_in_points == -3:
            lines.append("⏭️APP签到: 可能被屏蔽 (已跳过)")
        elif app_sign_in_points == -2:
            lines.append("❌APP签到: 未执行或未配置")
        else:
            lines.append("❌APP签到: 失败或未配置")

        if edge_checkin_points > 0:
            lines.append(f"✅Edge浏览打卡: 已完成 (+{edge_checkin_points})")
        elif edge_checkin_points == 0:
            lines.append("✅Edge浏览打卡: 今日已完成")
        elif edge_checkin_points == -3:
            lines.append("⏭️Edge浏览打卡: 可能被屏蔽 (已跳过)")
        elif edge_checkin_points == -2:
            lines.append("❌Edge浏览打卡: 未执行或未配置")
        else:
            lines.append("❌Edge浏览打卡: 失败")

        if point_claim_status == "success":
            lines.append(f"✅领取积分: 已领取 (+{point_claim_points})")
        elif point_claim_status == "none":
            lines.append("⏭️领取积分: 没有可领取的积分")
        elif point_claim_status == "check_failed":
            lines.append("❌领取积分: dashboard RSC 检查失败")
        elif point_claim_status == "failed":
            lines.append("❌领取积分: 执行失败")
        elif point_claim_status == "unknown":
            lines.append("⚠️领取积分: 返回结果未知")

        lines.append(f"📅每日活动: {daily_completed}/{daily_total}")
        lines.append(f"🎯继续赚取: {more_completed}/{more_total}")

        read_progress_text = f"📖阅读任务: {read_completed}/30"
        if account.refresh_token:
            try:
                token_to_use = access_token
                if not token_to_use:
                    token_to_use = service.get_access_token(account.refresh_token, account.alias, account_index, silent=True)
                if token_to_use:
                    progress_data = service.get_read_progress(token_to_use, account_index)
                    if isinstance(progress_data, dict):
                        read_progress_text = f"📖阅读任务: {progress_data.get('progress', 0)}/{progress_data.get('max', 30)}"
            except Exception:
                pass
        lines.append(read_progress_text)

        try:
            token_to_use = access_token
            if not token_to_use and account.refresh_token:
                token_to_use = service.get_access_token(account.refresh_token, account.alias, account_index, silent=True)

            pc_status = service.get_pc_search_status_from_mobile_promotions(token_to_use, account_index, silent=True) if token_to_use else None
            if not pc_status:
                pc_status = service.get_pc_search_status_from_earn_rsc(cookies, account_index, silent=True)

            if pc_status:
                source = str(pc_status.get("source", "") or "")
                source_suffix = " (Earn页)" if source == "earn_rsc" else ""
                lines.append(f"💻电脑搜索: {pc_status.get('current', 0)}/{pc_status.get('maximum', 0)}{source_suffix}")
            else:
                if token_to_use:
                    lines.append("💻电脑搜索: 移动端信息和Earn页都无数据")
                else:
                    lines.append("💻电脑搜索: 无可用令牌，Earn页也无数据")
        except Exception:
            lines.append("💻电脑搜索: 状态获取失败")

        return '\n'.join(lines)
    
    def run(self):
        """运行主程序"""
        account_summaries = {}  # 使用字典保存账号摘要，key为账号索引
        threads = []
        summaries_lock = threading.Lock()
        # 为每个线程创建独立的停止事件，避免全局共享
        thread_stop_events = {}
        
        def thread_worker(account: AccountInfo):
            # 为每个线程创建独立的RewardsService实例，避免共享状态
            service = RewardsService()
            # 为每个线程创建独立的停止事件
            thread_stop_events[account.index] = threading.Event()
            try:
                summary = self.process_single_account(account, service, thread_stop_events[account.index])
                if summary:
                    with summaries_lock:
                        account_summaries[account.index] = summary
            except SystemExit:
                # 搜索任务失败导致的线程终止，不记录为错误
                pass
            except Exception as e:
                print_log(f"账号{account.index}错误", f"处理账号时发生异常: {e}", account.index)
            finally:
                # 确保Service实例被正确清理
                if hasattr(service, 'request_manager'):
                    service.request_manager.close()
        
        # 启动所有账号的处理线程
        for account in self.accounts:
            t = threading.Thread(target=thread_worker, args=(account,))
            threads.append(t)
            t.start()
        
        # 等待所有线程完成
        for t in threads:
            t.join()
        
        # 按账号索引排序并转换为列表
        sorted_summaries = []
        if account_summaries:
            # 按账号索引排序
            for account_index in sorted(account_summaries.keys()):
                sorted_summaries.append(account_summaries[account_index])
        
        # 检查是否有线程因搜索失败而停止
        any_search_failed = any(event.is_set() for event in thread_stop_events.values())
        
        # 推送结果
        self._send_notification(sorted_summaries, any_search_failed)
    
    def _send_notification(self, summaries: List[str], any_search_failed: bool):
        """发送通知"""
        if any_search_failed:
            print(f"\n\n{'='*17} [任务未全部完成] {'='*17}")
            print_log(f"系统提示", f"搜索任务未全部完成")
            print_log(f"系统提示", f"建议每 30+ 分钟重新运行一次")
            print_log(f"统一推送", "任务未全部完成，取消推送")
            print(f"{'='*17} [任务未全部完成] {'='*17}")
            return
        else:   
            print(f"\n\n{'='*17} [全部任务完成] {'='*17}")
            
            # 增加任务完成计数
            global_cache_manager.increment_tasks_complete_count()
            
            if summaries:
                content = "\n\n".join(summaries)
                
                if global_cache_manager.has_pushed_today():
                    print_log("统一推送", "今天已经推送过，取消本次推送。")
                else:
                    print_log("统一推送", "准备发送所有账号的汇总消息...")
                    try:
                        title = f"Microsoft Rewards 任务总结 ({date.today().strftime('%Y-%m-%d')})"
                        global_notification_manager.send(title, content)
                        print_log("推送成功", "汇总消息已发送。")
                        global_cache_manager.mark_pushed_today()
                    except Exception as e:
                        print_log("推送失败", f"发送汇总消息时出错: {e}")
            else:
                print_log("统一推送", "没有可供推送的账号信息。")
                return
            
            # 无论是否推送，都在日志末尾打印内容摘要
            print(f"{'='*17} [全部任务完成] {'='*17}")
            print(f"\n\n{content}")

# ==================== 主程序入口 ====================
def main():
    """主程序入口"""
    try:
        bot = RewardsBot()
        bot.run()
    except KeyboardInterrupt:
        print_log("程序中断", "用户中断程序执行")
    except Exception as e:
        print_log("程序错误", f"程序执行出错: {e}")

if __name__ == "__main__":
    main() 
