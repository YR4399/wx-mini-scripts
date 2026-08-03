#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
奔腾YOMI Python版
使用手机号#密码格式，自动登录
"""

import os
import sys
import json
import time
import random
import hashlib
import requests
import threading
from datetime import datetime
from urllib.parse import urlencode, quote
import base64

# ==================== 配置区域 ====================
# 从环境变量读取，格式: 手机号#密码，多账号用换行分隔
envPrefix = "bt"
ACCOUNTS_STR = os.getenv(f"{envPrefix}Cookie", "")  # 格式: 手机号#密码
SEND_POST = os.getenv(f"{envPrefix}SendPost", "true").lower() == "true"  # 是否执行发帖任务
MAX_THREAD = int(os.getenv(f"{envPrefix}ThreadNum", 10))  # 最大线程数

# 🔴 新增：积分筛选配置
MAX_POINTS = int(os.getenv(f"{envPrefix}MaxPoints", 10000))  # 积分阈值，默认10000
EXPORT_DAYS = 3  # 保留最近几天的导出文件
# 常量配置
DEFAULT_TIMEOUT = int(os.getenv(f"{envPrefix}Timeout", 25))  # 超时放宽, 该服务响应慢(~7.5s)
DEFAULT_RETRY = 5

# 签名密钥
SIGN_SECRET_KEY = "A22A90B0504033E3944A483CEB79B698"

# 图片和内容API
# 原图床 tu.ltyuanfang.cn 已宕机(443 超时, 2026-08-02 实测), 换 picsum.photos(302->fastly 真实图片)
IMG_API = "https://picsum.photos/600/400"
CONTENT_API = "https://api.xygeng.cn/one"

# 主机
HOST = "yomi.fawcar.com.cn"

# 回复前缀
POST_PREFIX = ["一汽奔腾", "奔腾YOMI", "奔腾yomi"]

# RSA公钥（用于密码加密）
RSA_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDw2f4yWk8QybdL1fPgtVX/a15S
jDJsRV+BLLDFZ0cSSWCkqTQ/TSD1xw50F0gb9YmWE6xuN/ov6CKdEgMSLpyLAwmX
eBMg2p9mma4dl2pl3JUDFOgBUvWWZtAGruNrbrklijYDW18LEsAy4364T+/Iwn01
K2JjoW/o3CBIjN9ONwIDAQAB
-----END PUBLIC KEY-----"""
# ================================================


class Env:
    """环境基础类，模拟JS的Env功能"""
    
    def __init__(self, name):
        self.name = name
        self.userList = []
        self.notifyStr = []
        self.startTime = time.time()
        self.log_prefix = ""
        self.ts_len = 13
        self.retryNum = DEFAULT_RETRY
        
    def log(self, *args, **kwargs):
        """日志输出"""
        console = kwargs.get('console', True)
        prefix = kwargs.get('prefix', False)
        time_flag = kwargs.get('time', False)
        
        log_msg = []
        for arg in args:
            if isinstance(arg, (dict, list)):
                log_msg.append(json.dumps(arg, ensure_ascii=False))
            else:
                log_msg.append(str(arg))
        
        final_msg = " ".join(log_msg)
        
        if time_flag:
            final_msg = f"[{self.time('HH:mm:ss')}] {final_msg}"
        
        if prefix and self.log_prefix:
            final_msg = f"{self.log_prefix} {final_msg}"
        
        if console:
            print(final_msg)
    
    def time(self, fmt="HH:mm:ss", timestamp=None):
        """时间格式化"""
        if timestamp:
            dt = datetime.fromtimestamp(timestamp / 1000 if timestamp > 1e10 else timestamp)
        else:
            dt = datetime.now()
        
        fmt = fmt.replace("yyyy", str(dt.year))
        fmt = fmt.replace("MM", f"{dt.month:02d}")
        fmt = fmt.replace("dd", f"{dt.day:02d}")
        fmt = fmt.replace("HH", f"{dt.hour:02d}")
        fmt = fmt.replace("mm", f"{dt.minute:02d}")
        fmt = fmt.replace("ss", f"{dt.second:02d}")
        fmt = fmt.replace("S", f"{dt.microsecond // 1000:03d}")
        
        return fmt
    
    def ts(self, length=13):
        """获取时间戳"""
        now = time.time()
        if length == 10:
            return int(now)
        else:
            return int(now * 1000)
    
    def randomNum(self, min_val, max_val):
        """随机整数"""
        return random.randint(min_val, max_val)
    
    def randomPattern(self, pattern, chars="abcdef0123456789"):
        """随机模式，如UUID格式"""
        result = ""
        for c in pattern:
            if c == 'x':
                result += random.choice(chars)
            elif c == 'X':
                result += random.choice(chars).upper()
            else:
                result += c
        return result
    
    def randomString(self, length, chars="abcdef0123456789"):
        """随机字符串"""
        return ''.join(random.choice(chars) for _ in range(length))
    
    def wait(self, seconds):
        """等待"""
        time.sleep(seconds)
    
    async def randomWait(self, min_sec, max_sec, **kwargs):
        """随机等待"""
        wait_time = random.uniform(min_sec, max_sec)
        # self.log(f"随机等待{wait_time:.2f}秒", console=kwargs.get('console', True))
        self.wait(wait_time)
    
    def md5(self, text):
        """MD5加密"""
        return hashlib.md5(text.encode('utf-8')).hexdigest()
    
    def queryStr(self, obj):
        """对象转查询字符串"""
        if not obj:
            return ""
        return '&'.join([f"{k}={v}" for k, v in obj.items() if v is not None and v != ""])
    
    def readEnv(self, config):
        """读取环境变量，初始化用户列表"""
        global ACCOUNTS_STR

        self.accounts = ACCOUNTS_STR.strip() if ACCOUNTS_STR else ""
        # 初始化 accountArr 为空列表（关键修复）
        self.accountArr = []
        if self.accounts:
            # 分割多个账号
            for line in self.accounts.split('\n'):
                line = line.strip()
                if line and line not in self.accountArr:  # 🔴 手动去重，保留顺序
                    self.accountArr.append(line)
        
        # 去重
        # self.accountArr = list(set([c for c in self.accountArr if c]))
        
        # 创建用户对象
        self.userList = []  # 确保 userList 被初始化
        for idx, account in enumerate(self.accountArr):
            user = {
                'userIdx': idx + 1,
                'userAccount': account,
                'valid': True
            }
            if 'Class' in config:
                user_obj = config['Class'](user)
                self.userList.append(user_obj)
            else:
                self.userList.append(user)
        
        if not self.userList:
            self.log(f"\n⚠️ 未填写账号变量[btCookie]，请设置手机号#密码")
            self.log(f"格式示例: btCookie=\"13800138000#password\"")
            self.log(f"多账号用换行分隔")
            return False
        
        # self.log("\n-----------")
        # self.log(f"并发: False", console=not False)
        # self.log(f"最大并发数: {MAX_THREAD}", console=False)
        # self.log("-----------")
        self.log(f"\n共{len(self.userList)}个账号")
        
        return True

    def cleanup_old_files(self, days=EXPORT_DAYS):
        """清理指定天数前的导出文件"""
        try:
            current_time = time.time()
            for filename in os.listdir('.'):
                # 匹配以 [ 开头，包含 奔腾积分，以 .txt 结尾的文件
                if filename.startswith('[') and '奔腾积分' in filename and filename.endswith('.txt'):
                    file_path = os.path.join('.', filename)
                    file_mtime = os.path.getmtime(file_path)
                    # 如果文件超过指定天数，删除
                    if (current_time - file_mtime) > (days * 24 * 3600):
                        os.remove(file_path)
                        self.log(f"删除过期文件: {filename}")
        except Exception as e:
            self.log(f"清理文件出错: {e}")

    def export_high_points_accounts(self, accounts_data):
        """导出高积分账号
        Args:
            accounts_data: list of dict, 每个元素包含 {'phone': '手机号', 'points': 积分}
        """
        try:
            # 先清理旧文件
            self.cleanup_old_files()
            # 🔴 修复：将积分转换为整数再比较
            high_points = []
            for acc in accounts_data:
                try:
                    # 确保积分是整数类型
                    points = int(acc['points']) if acc['points'] else 0
                    if points > MAX_POINTS:
                        # 保存时使用原始格式，但比较用整数
                        acc_for_export = acc.copy()
                        acc_for_export['points'] = points  # 可以保存为整数或字符串，这里保持整数
                        high_points.append(acc_for_export)
                except (ValueError, TypeError):
                    self.log(f"账号 {acc.get('phone', '未知')} 积分格式错误: {acc['points']}")
                    continue

            if not high_points:
                self.log(f"没有积分大于 {MAX_POINTS} 的账号")
                return
            # 生成文件名： [当前日期]奔腾大于{MAX_POINTS}的账号.txt
            today = datetime.now().strftime("%Y%m%d")
            filename = f"[{today}]奔腾积分大于{MAX_POINTS}的账号.txt"

            # 写入文件
            with open(filename, 'w', encoding='utf-8') as f:
                for acc in high_points:
                    f.write(f"{acc['phone']}----{acc['points']}\n")
            self.log(f"已导出 {len(high_points)} 个积分大于 {MAX_POINTS} 的账号到文件: {filename}")
        except Exception as e:
            self.log(f"导出文件出错: {e}")
            import traceback
            traceback.print_exc()  # 打印详细错误信息


class BasicClass:
    """基础类，提供HTTP请求等功能"""
    
    def __init__(self, config):
        self.retryNum = config.get('DEFAULT_RETRY', DEFAULT_RETRY)
        self.userIdx = 0
        self.userList = []
        self.ts_len = 13
        self.env = None
        
        # 初始化会话
        self.session = requests.Session()
        self.default_headers = {}
    
    def set_env(self, env):
        """设置环境对象"""
        self.env = env
    
    def log(self, *args, **kwargs):
        """日志输出"""
        if self.env:
            self.env.log(*args, **kwargs)
        else:
            print(*args)
    
    def ts(self, length=13):
        """获取时间戳"""
        if self.env:
            return self.env.ts(length)
        now = time.time()
        return int(now * 1000) if length == 13 else int(now)
    
    def randomNum(self, min_val, max_val):
        """随机数"""
        if self.env:
            return self.env.randomNum(min_val, max_val)
        return random.randint(min_val, max_val)
    
    def randomPattern(self, pattern):
        """随机模式"""
        if self.env:
            return self.env.randomPattern(pattern)
        result = ""
        for c in pattern:
            if c == 'x':
                result += random.choice("abcdef0123456789")
            elif c == 'X':
                result += random.choice("abcdef0123456789").upper()
            else:
                result += c
        return result
    
    def time(self, fmt="HH:mm:ss"):
        """时间格式化"""
        if self.env:
            return self.env.time(fmt)
        return datetime.now().strftime(fmt.replace("HH", "%H").replace("mm", "%M").replace("ss", "%S"))
    
    async def randomWait(self, min_sec, max_sec, **kwargs):
        """随机等待"""
        if self.env:
            await self.env.randomWait(min_sec, max_sec, **kwargs)
        else:
            wait_time = random.uniform(min_sec, max_sec)
            print(f"随机等待{wait_time:.2f}秒")
            time.sleep(wait_time)
    
    def getSignHeaders(self, request_obj):
        """生成签名头"""
        timestamp = self.ts(13)
        nonce = self.randomPattern("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
        
        # 生成签名
        sign_data = {
            "Timestamp": timestamp,
            "Nonce": nonce,
            "Secretkey": SIGN_SECRET_KEY
        }
        query_str = self.queryStr(sign_data)
        sign = self.env.md5(query_str) if self.env else hashlib.md5(query_str.encode()).hexdigest()
        
        if 'headers' not in request_obj:
            request_obj['headers'] = {}
        
        request_obj['headers']['Timestamp'] = str(timestamp)
        request_obj['headers']['Nonce'] = nonce
        request_obj['headers']['Aign'] = sign
        
        return request_obj
    
    def queryStr(self, obj):
        """对象转查询字符串"""
        if self.env:
            return self.env.queryStr(obj)
        parts = []
        for k, v in obj.items():
            if v is not None and v != "":
                if isinstance(v, (dict, list)):
                    v = json.dumps(v, ensure_ascii=False)
                parts.append(f"{k}={v}")
        return '&'.join(parts)
    
    async def request(self, req_obj):
        """发送HTTP请求"""
        headers = self.default_headers.copy()
        if 'headers' in req_obj:
            headers.update(req_obj['headers'])
        req_obj['headers'] = headers
        
        url = req_obj.get('url')
        method = req_obj.get('method', 'GET').upper()
        fn_name = req_obj.get('fn', url)
        
        retry_count = 0
        max_retry = self.retryNum
        
        # 打印请求信息
        # self.log("\n🔍 ====== 完整请求信息 ======", console=True)
        # self.log(f"URL: {url}", console=True)
        # self.log(f"Method: {method}", console=True)
        # self.log(f"Headers: {json.dumps(req_obj['headers'], indent=2, ensure_ascii=False)}", console=True)
        # if 'json' in req_obj:
        #     self.log(f"Body: {json.dumps(req_obj['json'], indent=2, ensure_ascii=False)}", console=True)
        # elif 'data' in req_obj:
        #     self.log(f"Body: {req_obj['data']}", console=True)
        # self.log("==========================\n", console=True)
        
        while retry_count < max_retry:
            retry_count += 1
            # 重试时刷新签名头(新 Timestamp/Nonce/Aign), 避免服务端"请勿重复请求"拦截
            try:
                if 'Aign' in req_obj.get('headers', {}):
                    self.getSignHeaders(req_obj)
            except Exception:
                pass
            try:
                request_kwargs = {
                    'method': method,
                    'url': url,
                    'headers': req_obj['headers'],
                    'timeout': DEFAULT_TIMEOUT,
                    'allow_redirects': False
                }
                
                if 'json' in req_obj:
                    request_kwargs['json'] = req_obj['json']
                elif 'data' in req_obj:
                    request_kwargs['data'] = req_obj['data']
                
                response = self.session.request(**request_kwargs)
                
                result = {
                    'statusCode': response.status_code,
                    'headers': dict(response.headers),
                    'body': response.text
                }
                
                try:
                    result['body'] = response.json()
                except:
                    pass
                
                return result
                
            except requests.exceptions.Timeout:
                self.log(f"[{fn_name}]请求超时，重试第{retry_count}次")
            except requests.exceptions.ConnectionError as e:
                if any(code in str(e) for code in ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', '10054', 'ConnectionReset', 'Connection aborted', '远程主机强迫关闭']):
                    self.log(f"[{fn_name}]连接重置，重试第{retry_count}次")
                else:
                    self.log(f"[{fn_name}]请求错误: {e}")
                    break
            except Exception as e:
                self.log(f"[{fn_name}]请求错误: {e}，重试第{retry_count}次")
            
            if retry_count < max_retry:
                time.sleep(1)
        
        return {
            'statusCode': -1,
            'headers': {},
            'body': None
        }
    
    async def http(self, req_obj):
        """HTTP请求快捷方式，返回body"""
        result = await self.request(req_obj)
        return result.get('body')


def encryptPwd(password):
    """RSA加密密码"""
    try:
        from Crypto.PublicKey import RSA
        from Crypto.Cipher import PKCS1_v1_5
        import base64
        
        key = RSA.importKey(RSA_PUBLIC_KEY)
        cipher = PKCS1_v1_5.new(key)
        ciphertext = cipher.encrypt(password.encode('utf-8'))
        return base64.b64encode(ciphertext).decode('utf-8')
    except ImportError:
        print("警告: 未安装RSA加密库，使用模拟加密")
        # 模拟加密结果（实际使用时需要正确实现）
        return base64.b64encode(password.encode()).decode()


class UserInfo(BasicClass):
    """用户信息类，处理用户相关操作"""
    
    def __init__(self, user_data):
        super().__init__({})
        
        self.userIdx = user_data.get('userIdx', 0)
        self.userAccount = user_data.get('userAccount', '')
        self.valid = user_data.get('valid', True)
        
        # 解析账号: 手机号#密码
        parts = self.userAccount.split('#')
        if len(parts) >= 2:
            self.phone = parts[0]
            self.password = parts[1]
        else:
            self.phone = ''
            self.password = ''
            self.valid = False
        
        # 登录后获取的token信息
        self.id_token = ''
        self.aid = ''
        self.uid = ''
        self.nickName = ''
        self.point = 0
        self.growthValue = 0
        self.token2 = ''
        
        # 设备信息
        self.deviceId = ''
        self.deviceModel = ''
        
        # 任务相关
        self.taskList = []
        self.artList = []
        self.artList1 = []
        self.imgUrl = ''
        self.postTitle = ''
        self.postContent = ''
        
        # 登录状态
        self.logged_in = False
        
        # 初始化设备信息（在登录前）
        self.initDevice()
    
    def initDevice(self):
        """初始化设备信息（登录前）"""
        self.deviceId = self.randomPattern("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
        self.deviceModel = f"Redmi Note {self.randomNum(5, 13)} Pro"
    
    def taskInit(self):
        """任务初始化（登录后设置headers）"""
        self.default_headers = {
            "host": HOST,
            "Id-Token": self.id_token or "",
            "User-Id": self.uid or "",
            "User-Aid": self.aid or "",
            "User-Code": self.phone or "",
            "Tsp-Token2": self.token2 or "vehicleownership.adaptation.token",
            "Device-Type": self.deviceModel or "Redmi Note 7 Pro",
            "V-Origin": "Android",
            "APP-Version": "5.3.7",
            "User-Agent": "okhttp/4.4.0 Mozilla/5.0 (Linux; Android 10; Redmi Note 7 Pro Build/QKQ1.190915.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.101 Mobile Safari/537.36 BTYomi_Android"
        }
    
    async def login(self):
        """
        登录函数，使用账号密码获取token
        """
        try:
            self.log(f"账号{self.userIdx} 正在登录...", prefix=True)

            self.taskInit()  # 先初始化headers，即使没有token
            
            # 加密密码
            encrypted_pwd = encryptPwd(self.password)
            
            login_data = {
                "fn": "login",
                "method": "post",
                "url": f"https://{HOST}/btyomi/usercenter/app/v1/v2/baseLogin",
                "json": {
                    "password": encrypted_pwd,
                    "account": self.phone,
                    "tspLoginRequest": {
                        "model": self.deviceModel,
                        "deviceId": self.deviceId,
                        "brand": "xiaomi"
                    }
                }
            }
            
            # 添加签名头
            login_data = self.getSignHeaders(login_data)
            
            # 发送请求
            result = await self.http(login_data)
            
            if result and result.get('code') == "000000":
                data = result.get('data', {})
                self.id_token = data.get('id_token', '')
                self.uid = data.get('userId', '')
                self.nickName = data.get('userCode', '')
                self.aid = data.get('aid', '')
                self.token2 = data.get('token2', '')
                
                # 初始化headers
                self.taskInit()
                self.logged_in = True
                
                self.log(f"登录成功，用户: {self.nickName}", prefix=True)
                return True
            else:
                msg = result.get('msg', '登录失败') if result else '登录失败'
                self.log(f"登录失败: {msg}", prefix=True)
                self.valid = False
                return False
                
        except Exception as e:
            self.log(f"登录异常: {e}", prefix=True)
            self.valid = False
            return False
    
    async def userInfo(self):
        """获取用户信息"""
        if not self.logged_in:
            return False
            
        success = False
        try:
            req_data = {
                "fn": "userInfo",
                "method": "get",
                "url": f"https://{HOST}/btyomi/usercenter/app/v1/v2/getMyUserInfo?userPlat=1"
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                data = result.get('data', {})
                self.nickName = data.get('usercode', '')
                self.point = data.get('integral', 0)
                self.growthValue = data.get('growthValue', 0)
                success = True
                # self.log(f"获取用户信息成功，积分: {self.point}, 成长值: {self.growthValue}")
            else:
                msg = result.get('msg', '未知错误') if result else '请求失败'
                self.log(f"获取用户信息失败: {msg}")
                
        except Exception as e:
            print(f"userInfo异常: {e}")
        finally:
            self.valid = success
            return success
    
    async def get_taskList(self):
        """获取任务列表"""
        if not self.logged_in:
            return
            
        try:
            timestamp = self.ts()
            req_data = {
                "fn": "get_taskList",
                "method": "get",
                "url": f"https://{HOST}/serverApi/member/app/v1/member/getNoviceTaskList?{timestamp}={timestamp}"
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                data = result.get('data', [])
                self.taskList = [task for task in data if task.get('taskBigType') == '日常任务']
                # self.log(f"获取到{len(self.taskList)}个日常任务")
            else:
                msg = result.get('msg', '获取任务列表失败') if result else '请求失败'
                self.log(msg)
                
        except Exception as e:
            print(f"get_taskList异常: {e}")
    
    async def get_artList(self):
        """获取文章列表"""
        if not self.logged_in:
            return
            
        try:
            page = self.randomNum(1, 5)
            req_data = {
                "fn": "get_artList",
                "method": "get",
                "url": f"https://{HOST}/btyomi/circle/app/v1/circle/getArticles?acttype=HTTYPE&page={page}&pageSize=20"
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                self.artList = result.get('data', [])
                # self.log(f"获取到{len(self.artList)}篇文章")
            else:
                msg = result.get('msg', '获取文章列表失败') if result else '请求失败'
                self.log(msg)
                
        except Exception as e:
            print(f"get_artList异常: {e}")
    
    async def addComment(self, article):
        """添加评论"""
        if not self.logged_in:
            return
            
        try:
            pkey = article.get('pkey', '')
            title = article.get('varticletitle', '')
            
            comment = random.choice(POST_PREFIX) + ", " + title[:8] + ", 加油前行!"
            if len(comment) < 10:
                comment += self.time("MM-dd HH:mm")
            
            req_data = {
                "fn": "addComment",
                "method": "post",
                "url": f"https://{HOST}/serverApi/circle/app/v1/circle/addComment",
                "json": {
                    "artcleid": pkey,
                    "commentPkey": "",
                    "commentUserId": "",
                    "content": comment,
                    "imgurl": ""
                }
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                self.log(f"回复[{comment}]成功")
            else:
                msg = result.get('msg', '回复失败') if result else '请求失败'
                self.log(msg)
                
        except Exception as e:
            print(f"addComment异常: {e}")
    
    async def finishTask(self, task):
        """完成任务"""
        if not self.logged_in:
            return
            
        try:
            task_id = task.get('taskId', '')
            tactics_code = task.get('tacticsCode', '')
            money = task.get('money', '')
            task_name = task.get('taskName', '')
            
            req_data = {
                "fn": "finishTask",
                "method": "get",
                "url": f"https://{HOST}/btyomi/member/app/v1/member/finishTask?taskId={task_id}&tacticsCode={tactics_code}&money={money}&changeDesc={quote(task_name)}"
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                self.log(f"{task_name}成功")
            else:
                msg = result.get('msg', '完成任务失败') if result else '请求失败'
                self.log(msg)
                
        except Exception as e:
            print(f"finishTask异常: {e}")
    
    async def getImage(self):
        """获取图片 (302 重定向拿真实图片 URL)"""
        try:
            # 不走 self.request(): 那会带上 default_headers(奔腾 API 头/host:yomi.fawcar.com.cn),
            # 外部图床会因 Host/UA 不对返回 403(Cloudflare)。用裸 session 请求只拿 Location。
            resp = self.session.get(IMG_API, allow_redirects=False, timeout=DEFAULT_TIMEOUT)
            location = resp.headers.get('Location')
            if location:
                self.imgUrl = location
            else:
                print(f"getImage: 无 Location (status={resp.status_code})")
                    
        except Exception as e:
            print(f"getImage异常: {e}")
    
    async def getContent(self):
        """获取内容"""
        try:
            req_data = {
                "fn": "getContent",
                "method": "get",
                "url": CONTENT_API,
                "headers": {
                    "host": "api.xygeng.cn"
                }
            }
            
            result = await self.http(req_data)
            
            if result and result.get('code') == 200:
                data = result.get('data', {})
                tag = data.get('tag', '')
                origin = data.get('origin', '')
                content = data.get('content', '')
                
                self.postTitle = f"{tag}{origin}"
                self.postContent = content
                
                if len(self.postTitle) < 5:
                    self.postTitle += self.time("MM-dd HH:mm")
                    
        except Exception as e:
            print(f"getContent异常: {e}")
    
    async def sendPost(self):
        """发送帖子"""
        if not self.logged_in:
            return
            
        try:
            await self.getImage()
            await self.getContent()
            
            if not self.imgUrl or not self.postTitle:
                self.log("获取评论图片或内容失败")
                return
            
            req_data = {
                "fn": "sendPost",
                "method": "post",
                "url": f"https://{HOST}/serverApi/circle/app/v1/circle/addArticle",
                "json": {
                    "varticletype": "BTWTYPE",
                    "posdes": "",
                    "varticlecategory": "14",
                    "imgurl": self.imgUrl,
                    "varticlebody": f"<p>{self.postContent}<img src=\"{self.imgUrl}\"></p><p><br></p><p><br></p>",
                    "varticletitle": self.postTitle
                }
            }
            
            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)
            
            if result and result.get('code') == "000000":
                # self.log(f"发帖[{self.postContent[:8]}]成功")
                self.log(f"发帖成功")
            else:
                msg = result.get('msg', '发帖失败') if result else '请求失败'
                self.log(msg)
                
        except Exception as e:
            print(f"sendPost异常: {e}")

    async def get_artList1(self):
        """获取自己文章列表
        Returns:
            list: 包含所有帖子pkey的列表，无帖子时返回空列表
        """
        if not self.logged_in:
            return []

        try:
            req_data = {
                "fn": "get_artList1",
                "method": "get",
                "url": f"https://{HOST}/btyomi/service/app/v1/functionInfo/getMyRelease?page=1&pageSize=10"
            }

            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)

            if result and result.get('code') == "000000":
                data = result.get('data', [])
                if not data:  # 明确处理空数据的情况
                    self.log("暂无已发布的帖子", prefix=True)
                    return []
                # 提取所有帖子的pkey
                pkeys = [item.get('pkey') for item in data if item.get('pkey')]
                self.log(f"获取到 {len(pkeys)} 篇自己的帖子", prefix=True)
                return pkeys
            else:
                error_msg = result.get('msg', '获取文章列表失败') if result else '请求失败'
                self.log(error_msg, prefix=True)
                return []

        except Exception as e:
            print(f"get_artList1异常: {e}")
            return []

    async def deletePost(self, pkey):
        """删除单个帖子
        Args:
            pkey: 帖子的pkey值
        Returns:
            bool: 是否删除成功
        """
        if not self.logged_in or not pkey:
            return False

        try:
            req_data = {
                "fn": "deletePost",
                "method": "get",
                "url": f"https://{HOST}/btyomi/service/app/v1/functionInfo/deleteMyRelease?pkey={pkey}"
            }

            req_data = self.getSignHeaders(req_data)
            result = await self.http(req_data)

            # 根据抓包结果，成功时返回 {"code": "000000", "msg": "删除成功", "data": null}
            if result and result.get('code') == "000000":
                self.log(f"帖子 {pkey} 删除成功", prefix=True)
                return True
            else:
                error_msg = result.get('msg', '删除失败') if result else '请求失败'
                self.log(f"帖子 {pkey} 删除失败: {error_msg}", prefix=True)
                return False

        except Exception as e:
            print(f"deletePost异常: {e}")
            return False

    async def deleteAllPosts(self):
        """删除所有帖子
        Returns:
            tuple: (成功数, 总数)
        """
        if not self.logged_in:
            return (0, 0)
        self.log("开始检查帖子...", prefix=True)
        # 获取自己的帖子列表
        pkeys = await self.get_artList1()
        if not pkeys:
            self.log("没有帖子需要删除", prefix=True)
            return (0, 0)
        # self.log(f"找到 {len(pkeys)} 个帖子，开始删除...", prefix=True)
        success_count = 0
        for i, pkey in enumerate(pkeys):
            self.log(f"正在删除第 {i+1}/{len(pkeys)} 个帖子", prefix=True)
            if await self.deletePost(pkey):
                success_count += 1
            if i < len(pkeys) - 1:
                await self.randomWait(1, 2)
        self.log(f"帖子删除完成: 成功 {success_count}/{len(pkeys)}", prefix=True)
        return (success_count, len(pkeys))

    async def dailyTask(self):
        """执行日常任务"""
        if not self.logged_in:
            return
            
        try:
            await self.get_taskList()
            
            for task in self.taskList:
                task_name = task.get('taskName', '')
                task_status = task.get('taskStatus', 0)

                # 任务状态: 0=已完成, 1=未完成
                if str(task_status) == "0":
                    self.log(f"任务 [{task_name}] 已完成，跳过")
                    continue
                
                need_count = 1
                # original_task_name = task_name

                # 处理回复任务（如 "回复(3/5)"）
                if "回复" in task_name:
                    import re
                    match = re.search(r'\((\d+)/(\d+)\)', task_name)
                    if match:
                        current = int(match.group(1))
                        total = int(match.group(2))
                        need_count = total - current
                        task_name = "回复"
                        self.log(f"回复任务还需执行 {need_count} 次")
                # 根据任务类型执行
                if task_name == "回复":
                    await self.get_artList()
                    for i in range(need_count):
                        # self.log(f"执行第 {i+1}/{need_count} 次回复")
                        if self.artList:
                            article = random.choice(self.artList)
                            await self.addComment(article)
                            if i < need_count - 1:  # 最后一次不需要等待
                                await self.randomWait(3, 5)
                
                elif task_name == "转发内容至朋友圈":
                    task1 = task.copy()
                    task1['taskId'] = 15
                    task1['tacticsCode'] = "PR-BT-Circle_friends_1"
                    await self.finishTask(task1)
                    await self.randomWait(3, 5)
                    
                    task2 = task.copy()
                    task2['taskId'] = 20
                    task2['tacticsCode'] = "PR-BT-Circle_friends_2"
                    await self.finishTask(task2)
                    await self.randomWait(3, 5)
                
                elif task_name == "去奔腾吧发帖":
                    if SEND_POST:
                        # self.log("执行发帖任务")
                        await self.sendPost()
                    else:
                        self.log("发帖任务已禁用 (SEND_POST=false)")
                # else:
                #     self.log(f"此任务类型不做: {original_task_name}")
        except Exception as e:
            print(f"dailyTask异常: {e}")
            import traceback
            traceback.print_exc()
    
    async def userTask(self, params=None):
        """用户任务主函数"""
        try:
            self.log(f"\n====== 开始处理账号{self.userIdx} ======", prefix=True)
            
            # 登录
            login_success = await self.login()
            if not login_success:
                self.log("登录失败，跳过该账号", prefix=True)
                return
            
            # 获取用户信息
            await self.userInfo()
            if self.point:
                self.log(f"获取用户信息成功，积分: {self.point}, 成长值: {self.growthValue}")

            
            self.log(f"\n******* 【账号{self.userIdx}】{self.nickName or ''} ******* ", 
                     console=True, prefixless=True, timeless=True)
            
            # 执行日常任务
            await self.dailyTask()

            # 🔴 删除所有帖子
            success, total = await self.deleteAllPosts()
            if success > 0:
                self.log(f"共删除 {success}/{total} 个帖子")

            # 再次获取用户信息，显示更新后的积分
            await self.userInfo()
            
            if self.point:
                self.log(f"最终积分: {self.point}, 成长值: {self.growthValue}")


                
        except Exception as e:
            print(f"userTask异常: {e}")

    async def collect_points_info(self):
        """收集账号积分信息"""
        if not self.logged_in:
            return None
        await self.userInfo()
        if self.point:
            return {
                'phone': self.phone,
                'points': int(self.point) if self.point else 0,  # 🔴 确保转换为整数
                'nickName': self.nickName,
                'userIdx': self.userIdx
            }
        return None


# ==================== 主程序 ====================
async def main():
    """主函数"""
    global env
    
    env = Env("奔腾YOMI")
    
    config = {
        "Class": UserInfo
    }
    
    if not env.readEnv(config):
        return

    # 用于存储所有账号的积分信息
    all_accounts_points = []
    
    # 顺序执行每个账号的任务
    for user in env.userList:
        try:
            user.set_env(env)
            # 执行任务
            await user.userTask()

            # 收集积分信息
            points_info = await user.collect_points_info()
            if points_info:
                all_accounts_points.append(points_info)
            print("\n" + "="*50 + "\n")  # 账号分隔线
        except Exception as e:
            print(f"执行账号任务出错: {e}")

    # 🔴 所有账号执行完后，导出高积分账号
    env.export_high_points_accounts(all_accounts_points)
    
    elapsed = time.time() - env.startTime
    env.log(f"\n[奔腾YOMI], 结束! 🕛 {elapsed:.2f} 秒", time=True, prefixless=True)


if __name__ == "__main__":
    import asyncio
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n程序被用户中断")
    except Exception as e:
        print(f"程序异常: {e}")