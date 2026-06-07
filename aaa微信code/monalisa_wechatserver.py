from __future__ import annotations
# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========


#!/usr/bin/env python3
"""
蒙娜丽莎小程序自动签到 - wechatserver 自动登录版 (无缓存)
环境变量:
  MONALISA_ACCOUNT - 账号配置，userKey（多账号 & 分隔）
                    可填序号(如1,2,3)自动算MD5，或直接填8位hex
                    示例: "1&2&3" 或 "34d20cec&8b26bd0c"
  wx_server_url    - wechatserver 地址，呆呆面板自动注入
  wx_auth          - wechatserver APIKEY，呆呆面板自动注入
  DDDDOCR_API_URL  - ddddocr 验证码识别地址（默认脚本内地址）
  MONALISA_DEBUG   - 设为 1 开启调试日志
"""


import hashlib
import logging
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    print("[ERROR] 缺少依赖 requests, 请执行: pip install requests")
    sys.exit(1)

try:
    sys.path.append("/ql/scripts")
    sys.path.append("/ql/data/scripts")
    from notify import send


except Exception:
    def send(title: str, content: str) -> None:
        pass


# ═══════════════════════════════════════════════════════════
# 常量配置
# ═══════════════════════════════════════════════════════════

BASE_URL = "https://mcs.monalisagroup.com.cn/member/doAction"
APP_ID = "wxce6a8f654e81b7a4"
BRAND = "MON"

MAX_RETRY = 3
RETRY_DELAY = 2
ACCOUNT_DELAY = 3
REQUEST_TIMEOUT = 30

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201"
)
REFERER = f"https://servicewechat.com/{APP_ID}/483/page-frame.html"

HEADERS = {
    "User-Agent": UA,
    "Content-Type": "application/x-www-form-urlencoded",
    "xweb_xhr": "1",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Referer": REFERER,
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Connection": "keep-alive",
}

# wechatserver 配置（兼容呆呆面板注入的小写环境变量）
WX_SERVER_URL = os.getenv("wx_server_url") or os.getenv("WX_SERVER_URL", "http://localhost:8787")
WX_SERVER_APIKEY = os.getenv("wx_auth") or os.getenv("WX_SERVER_APIKEY", "")

# 验证码识别配置
# CAPTCHA_TYPE: 2captcha / ddddocr（默认 ddddocr）
CAPTCHA_TYPE = os.getenv("CAPTCHA_TYPE", "2captcha")
DDDDOCR_API_URL = os.getenv("DDDDOCR_API_URL", "http://120.245.78.80:43839/calculate")
TWOCAPTCHA_API_KEY = os.getenv("TWOCAPTCHA_API_KEY", "56c8245006ed3a5bbd407639dbc7cf8c")


# ═══════════════════════════════════════════════════════════
# Logger
# ═══════════════════════════════════════════════════════════

def _build_logger() -> logging.Logger:
    lvl = logging.DEBUG if os.getenv("MONALISA_DEBUG") == "1" else logging.INFO
    lg = logging.getLogger("monalisa")
    lg.setLevel(lvl)
    if not lg.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        lg.addHandler(h)
    return lg


LOG = _build_logger()


# ═══════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════

def _solve_math_captcha(text: str) -> str:
    """将算术验证码文本（如 '7+8=?'）计算为纯数字答案"""
    text = text.rstrip("?= \t")
    # 匹配 a+b, a-b, a*b, a/b
    m = re.match(r"^\s*(\d+)\s*([+\-*/×÷])\s*(\d+)\s*$", text)
    if m:
        a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
        if op == "+":
            return str(a + b)
        elif op == "-":
            return str(a - b)
        elif op in ("*", "×"):
            return str(a * b)
        elif op in ("/", "÷") and b != 0:
            return str(a // b)
    return text


# ═══════════════════════════════════════════════════════════
# 账号解析（与名创/溪云/天机观保持一致）
# ═══════════════════════════════════════════════════════════

def _derive_user_key(account_num: int) -> str:
    """根据账号序号计算 userKey = MD5(APIKEY + num)[:8]"""
    if not WX_SERVER_APIKEY:
        raise ValueError("未配置 WX_SERVER_APIKEY，无法自动计算 userKey")
    return hashlib.md5((WX_SERVER_APIKEY + str(account_num)).encode()).hexdigest()[:8]


def parse_accounts(raw: str) -> list[str]:
    """解析账号配置，返回 userKey 列表
    支持格式:
      - 序号(如1,2,3): 自动计算 userKey = MD5(APIKEY + num)[:8]
      - 8位hex: 直接作为 userKey（旧版 wechatserver）
      - 32位MD5: 截取前8位
      - openid格式(如owNAX6...): 直接作为 userKey（新版 wechatserver）
    """
    keys: list[str] = []
    for idx, chunk in enumerate(raw.split("&"), 1):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.isdigit():
            keys.append(_derive_user_key(int(chunk)))
        elif len(chunk) == 8 and all(c in "0123456789abcdef" for c in chunk.lower()):
            keys.append(chunk.lower())
        elif len(chunk) == 32 and all(c in "0123456789abcdef" for c in chunk.lower()):
            keys.append(chunk.lower()[:8])
        elif len(chunk) >= 20 and all(c.isalnum() or c in "-_" for c in chunk):
            # openid 格式 (如 owNAX6j83m4TzrbIA5R3iNXM1iY0)
            keys.append(chunk)
        else:
            raise ValueError(
                f"账号#{idx} 格式错误: '{chunk}'，请填序号(如1)、8位hex、openid"
            )
    return keys


# ═══════════════════════════════════════════════════════════
# wechatserver 交互
# ═══════════════════════════════════════════════════════════

def get_wx_code(session: requests.Session, user_key: str, max_retries: int = 3, retry_delay: float = 3.0) -> str:
    """从 wechatserver 获取 wx.login code，失败/超时自动重试"""
    body = {
        "userKey": user_key,
        "openid": user_key,
        "appid": APP_ID,
    }
    headers = {
        "Content-Type": "application/json",
        "AUTH": WX_SERVER_APIKEY,
    }
    last_error = None
    for attempt in range(max_retries):
        try:
            LOG.debug("[%s] 获取code (attempt %d/%d)", user_key, attempt + 1, max_retries)
            resp = session.post(
                f"{WX_SERVER_URL}/wx/code", json=body, headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"wechatserver HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            code = data.get("code") or data.get("data", {}).get("code") or ""
            if not code:
                raise RuntimeError(f"wechatserver 未返回 code: {json.dumps(data, ensure_ascii=False)[:300]}")
            LOG.debug("[%s] 获取 code 成功", user_key)
            return code
        except requests.exceptions.Timeout as e:
            last_error = e
            LOG.warning("[%s] /wx/code 超时 (attempt %d/%d)", user_key, attempt + 1, max_retries)
        except requests.exceptions.RequestException as e:
            last_error = e
            LOG.warning("[%s] /wx/code 请求失败 (attempt %d/%d): %s", user_key, attempt + 1, max_retries, e)
        except RuntimeError as e:
            last_error = e
            LOG.warning("[%s] /wx/code 返回异常 (attempt %d/%d): %s", user_key, attempt + 1, max_retries, e)
        if attempt < max_retries - 1:
            time.sleep(retry_delay)

    raise RuntimeError(f"获取 code 失败，已重试 {max_retries} 次") from last_error


# ═══════════════════════════════════════════════════════════
# 蒙娜丽莎业务
# ═══════════════════════════════════════════════════════════

class MonalisaSign:
    def __init__(self, user_key: str):
        self.user_key = user_key
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update(HEADERS)

        self.token_str = None
        self.customer_id = None
        self.customer_name = None
        self.store_id = None
        self.organization_id = None
        self.web_chat_id = None

    def _post_action(self, data: dict) -> dict:
        """发送 doAction 请求"""
        resp = self.session.post(BASE_URL, data=data, timeout=REQUEST_TIMEOUT)
        return resp.json()

    # ── 登录 ──

    def login(self) -> bool:
        """wechatserver 获取 code → 绑定用户"""
        # 获取 code
        try:
            code = get_wx_code(self.session, self.user_key)
            LOG.info("[%s] 获取 code 成功", self.user_key)
        except Exception as e:
            LOG.error("[%s] 获取 code 失败: %s", self.user_key, e)
            return False

        # 绑定用户
        data = {
            "brand": BRAND,
            "action": "addCustomer",
            "webChatName": self.user_key,
            "customerName": self.user_key,
            "code": code,
            "telephone": "",
            "remarks": "",
            "operationType": "",
            "storeID": "",
            "address": "-",
            "Province": "",
            "City": "",
            "Region": "",
        }

        for attempt in range(3):
            try:
                LOG.info("[%s] 绑定用户，尝试 %d/3", self.user_key, attempt + 1)
                result = self._post_action(data)

                if result.get("status") == 2:
                    user_info = result.get("resultInfo", [])[0]
                    self.customer_id = user_info.get("CustomerID")
                    self.web_chat_id = user_info.get("WebChatID")
                    self.customer_name = user_info.get("CustomerName", self.user_key)
                    self.store_id = user_info.get("StoreID")
                    self.organization_id = user_info.get("OrganizationID")
                    self.token_str = result.get("tokenStr")
                    LOG.info(
                        "[%s] 绑定成功 - ID: %s, 昵称: %s, 积分: %s",
                        self.user_key, self.customer_id, self.customer_name,
                        user_info.get("Integral"),
                    )
                    return True
                else:
                    LOG.error(
                        "[%s] 绑定失败，status: %s, msg: %s",
                        self.user_key, result.get("status"), result.get("msg", "未知错误"),
                    )
                    if attempt < 2:
                        time.sleep(3)
                    else:
                        return False

            except requests.exceptions.Timeout:
                LOG.warning("[%s] 绑定超时，尝试 %d/3", self.user_key, attempt + 1)
                if attempt < 2:
                    time.sleep(5)
                else:
                    return False
            except Exception as e:
                LOG.error("[%s] 绑定异常: %s", self.user_key, e)
                if attempt < 2:
                    time.sleep(3)
                else:
                    return False

        return False

    # ── 签到相关 ──

    def check_attendance_status(self) -> dict | None:
        """检查今日签到状态"""
        if not self.customer_id:
            return None
        try:
            data = {"brand": BRAND, "action": "continuousAttendance", "CustomerID": self.customer_id}
            result = self._post_action(data)

            if result.get("status") == 0:
                info = result.get("resultInfo", {})
                if isinstance(info, dict):
                    todays = info.get("todays", 0)
                    continuous = info.get("continuityDay", 0)
                elif isinstance(info, list) and info and isinstance(info[0], dict):
                    todays = info[0].get("todays", 0)
                    continuous = info[0].get("continuityDay", 0)
                else:
                    todays = 0
                    continuous = 0
                return {"today_signed": (todays == 1), "continuous_days": continuous}
            return None
        except Exception as e:
            LOG.error("[%s] 检查签到状态失败: %s", self.user_key, e)
            return None

    def generate_captcha(self) -> tuple[str | None, int]:
        """生成验证码，返回 (base64图片, status_code)
        status=0   → 成功，返回 (captcha, 0)
        status=-200 → 账号不可签到（已签到/积分不足/状态异常），返回 (None, -200)
        其他 → 未知错误，返回 (None, status)
        """
        if not self.token_str:
            return None, -1
        try:
            data = {
                "brand": BRAND, "action": "generateCaptcha",
                "tokenStr": self.token_str, "CustomerID": self.customer_id,
            }
            result = self._post_action(data)
            status = result.get("status")
            if status == 0:
                captcha = result.get("resultInfo")
                LOG.debug("[%s] 验证码数据类型: %s, 长度: %s, 前100字符: %s",
                          self.user_key, type(captcha).__name__,
                          len(str(captcha)) if captcha else 0,
                          str(captcha)[:100] if captcha else "None")
                return captcha, 0
            else:
                integral_status = result.get("integralStatus")
                LOG.warning("[%s] 生成验证码失败: status=%s integralStatus=%s",
                           self.user_key, status, integral_status)
                return None, status
        except Exception as e:
            LOG.error("[%s] 生成验证码错误: %s", self.user_key, e)
            return None, -1

    @staticmethod
    def recognize_captcha(base64_image: str) -> str | None:
        """调用验证码识别服务"""
        # 去掉 data URI 前缀
        if "," in base64_image:
            base64_image = base64_image.split(",", 1)[1]
        if not base64_image or len(base64_image) < 100:
            LOG.error("验证码数据为空或过短 (len=%d)", len(base64_image) if base64_image else 0)
            return None

        if CAPTCHA_TYPE == "2captcha":
            return MonalisaSign._recognize_2captcha(base64_image)
        return MonalisaSign._recognize_ddddocr(base64_image)

    @staticmethod
    def _recognize_ddddocr(base64_image: str) -> str | None:
        """ddddocr 识别"""
        try:
            resp = requests.post(
                DDDDOCR_API_URL,
                json={"image": base64_image},
                timeout=10,
            verify=False)
            if resp.status_code == 200:
                data = resp.json()
                answer = data.get("result") or data.get("data") or data.get("text")
                if answer is not None:
                    return str(answer).strip()
            return None
        except Exception as e:
            LOG.error("ddddocr 识别异常: %s", e)
            return None

    @staticmethod
    def _recognize_2captcha(base64_image: str) -> str | None:
        """2captcha 识别（in.php 提交 → res.php 轮询结果）"""
        if not TWOCAPTCHA_API_KEY:
            LOG.error("CAPTCHA_TYPE=2captcha 但未设置 TWOCAPTCHA_API_KEY")
            return None
        try:
            # 1. 提交任务
            submit = requests.post(
                "https://api.2captcha.com/in.php",
                data={
                    "key": TWOCAPTCHA_API_KEY,
                    "method": "base64",
                    "body": base64_image,
                    "json": 1,
                },
                timeout=30,
            verify=False)

            submit_data = submit.json()
            if submit_data.get("status") != 1:
                LOG.error("2captcha 提交失败: %s", submit_data.get("request", "未知错误"))
                return None

            task_id = submit_data["request"]
            LOG.debug("2captcha 任务提交成功: %s", task_id)

            # 2. 轮询结果（最多120秒）
            for _ in range(24):
                time.sleep(5)
                resp = requests.get(
                    "https://api.2captcha.com/res.php",
                    params={"key": TWOCAPTCHA_API_KEY, "action": "get", "id": task_id, "json": 1},
                    timeout=30,
                verify=False)

                resp_data = resp.json()
                if resp_data.get("status") == 1:
                    answer = resp_data["request"].strip()
                    LOG.debug("2captcha 原始结果: %s", answer)
                    answer = _solve_math_captcha(answer)
                    return answer

                if resp_data.get("request") != "CAPCHA_NOT_READY":
                    LOG.error("2captcha 识别失败: %s", resp_data.get("request", ""))
                    return None

            LOG.error("2captcha 轮询超时 (120s)")
            return None
        except Exception as e:
            LOG.error("2captcha 异常: %s", e)
            return None

    def do_sign(self, correct_answer: str) -> dict:
        """执行签到"""
        data = {
            "brand": BRAND, "action": "sign",
            "CustomerID": self.customer_id, "CustomerName": self.customer_name,
            "StoreID": self.store_id or "", "OrganizationID": self.organization_id or "",
            "Brand": BRAND, "tokenStr": self.token_str, "correctAnswer": correct_answer,
        }
        try:
            return self._post_action(data)
        except Exception as e:
            return {"status": -1, "msg": str(e)}

    def sign_with_retry(self, captcha_base64: str) -> dict | None:
        """带重试的签到流程"""
        current_captcha = captcha_base64

        for attempt in range(MAX_RETRY):
            LOG.info("[%s] 签到尝试 %d/%d", self.user_key, attempt + 1, MAX_RETRY)

            answer = self.recognize_captcha(current_captcha)
            if not answer:
                LOG.error("[%s] 验证码识别失败", self.user_key)
                if attempt < MAX_RETRY - 1:
                    time.sleep(RETRY_DELAY)
                    new_cap, _ = self.generate_captcha()
                    if new_cap:
                        current_captcha = new_cap
                continue

            LOG.info("[%s] 验证码答案: %s", self.user_key, answer)
            result = self.do_sign(answer)
            status = result.get("status")

            if status == 0:
                LOG.info("[%s] 签到成功！", self.user_key)
                return result
            elif status == 7:
                LOG.warning("[%s] 验证码错误或已签到", self.user_key)
                return result
            else:
                LOG.error("[%s] 签到失败，status: %s", self.user_key, status)
                if attempt < MAX_RETRY - 1:
                    time.sleep(RETRY_DELAY)
                    new_cap, _ = self.generate_captcha()
                    if new_cap:
                        current_captcha = new_cap
                else:
                    return None

        return None

    def get_points(self) -> int:
        """获取当前积分"""
        if not self.web_chat_id:
            return 0
        try:
            data = {"brand": BRAND, "action": "getCustomer", "webChatID": self.web_chat_id}
            result = self._post_action(data)
            if result.get("status") == 0:
                info = result.get("resultInfo")
                if isinstance(info, list) and info:
                    return info[0].get("points", info[0].get("Integral", 0))
                elif isinstance(info, dict):
                    return info.get("points", info.get("Integral", 0))
        except Exception as e:
            LOG.error("[%s] 获取积分失败: %s", self.user_key, e)
        return 0

    # ── 主流程 ──

    def run(self) -> bool | None:
        LOG.info("===== %s =====", self.user_key)

        # 直接登录，不使用缓存
        LOG.info("[%s] 开始登录...", self.user_key)
        if not self.login():
            LOG.error("[%s] 登录失败", self.user_key)
            return False

        LOG.info("[%s] 用户ID: %s, 昵称: %s", self.user_key, self.customer_id, self.customer_name)

        # 检查今日是否已签到
        attendance = self.check_attendance_status()
        if attendance and attendance.get("today_signed"):
            days = attendance.get("continuous_days", 0)
            points = self.get_points()
            msg = f"[{self.user_key}] 今日已签到 (连续{days}天) 积分: {points}"
            LOG.info(msg)
            return True

        # 生成验证码
        LOG.info("[%s] 生成验证码...", self.user_key)
        captcha, captcha_status = self.generate_captcha()
        if captcha is None:
            if captcha_status == -200:
                # -200 表示账号不可签到（已签到/状态异常/未满足条件），重新确认
                LOG.warning("[%s] 验证码生成被拒(status=-200)，重新检查签到状态...", self.user_key)
                attendance_retry = self.check_attendance_status()
                if attendance_retry and attendance_retry.get("today_signed"):
                    days = attendance_retry.get("continuous_days", 0)
                    points = self.get_points()
                    LOG.info("[%s] 确认今日已签到 (连续%d天) 积分: %s", self.user_key, days, points)
                    return True
                # attendance 也说没签到 → 账号状态异常，跳过不记失败
                LOG.warning("[%s] 账号不可签到(状态异常)，跳过", self.user_key)
                return None
            # 非 -200 的真正错误
            LOG.error("[%s] 生成验证码失败", self.user_key)
            return False

        # 签到
        sign_result = self.sign_with_retry(captcha)
        if not sign_result:
            LOG.error("[%s] 签到失败", self.user_key)
            return False

        status = sign_result.get("status")
        if status == 0:
            earned = sign_result.get("resultInfo", 0)
            LOG.info("[%s] 签到成功！获得 %s 积分", self.user_key, earned)
        elif status == 7:
            attendance = self.check_attendance_status()
            if attendance and attendance.get("today_signed"):
                LOG.info("[%s] 确认今日已签到", self.user_key)
            else:
                LOG.error("[%s] 验证码错误，签到失败", self.user_key)
                return False
        else:
            LOG.error("[%s] 签到失败，status: %s", self.user_key, status)
            return False

        days = attendance.get("continuous_days", 0) if attendance else 0
        points = self.get_points()
        LOG.info("[%s] 连续签到 %d 天，总积分: %s", self.user_key, days, points)

        return True


# ═══════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════

def main():
    if not WX_SERVER_APIKEY:
        LOG.error("未配置环境变量 WX_SERVER_APIKEY（呆呆面板自动注入 wx_auth）")
        return 1

    raw = os.getenv("wx_opinion") or os.getenv("MONALISA_ACCOUNT", "").strip()
    if not raw:
        LOG.error("未配置环境变量 MONALISA_ACCOUNT")
        LOG.error("格式: userKey（多账号 & 分隔）")
        LOG.error("  可填序号(如1,2,3)自动算MD5，或直接填8位hex")
        LOG.error("  示例: MONALISA_ACCOUNT=\"1&2&3\"")
        return 1

    try:
        accounts = parse_accounts(raw)
    except ValueError as e:
        LOG.error("账号配置错误: %s", e)
        return 1
    if not accounts:
        LOG.error("账号解析为空")
        return 1

    LOG.info(
        "蒙娜丽莎 | wechatserver=%s appid=%s 共%d个账号",
        WX_SERVER_URL, APP_ID, len(accounts),
    )

    success_count = 0
    fail_count = 0
    skip_count = 0
    results: list[str] = []

    for idx, user_key in enumerate(accounts, 1):
        label = f"账号#{idx}({user_key})"
        try:
            signer = MonalisaSign(user_key)
            result = signer.run()
            if result is None:
                skip_count += 1
                results.append(f"⚠ {label} 不可签到(跳过)")
            elif result:
                success_count += 1
                results.append(f"✅ {label} 签到成功")
            else:
                fail_count += 1
                results.append(f"❌ {label} 签到失败")
        except Exception as e:
            fail_count += 1
            results.append(f"❌ {label} 异常: {e}")
            LOG.exception("[%s] 异常", label)

        if idx < len(accounts):
            time.sleep(ACCOUNT_DELAY)

    parts = [f"✅ 成功: {success_count}"]
    if fail_count > 0:
        parts.append(f"❌ 失败: {fail_count}")
    if skip_count > 0:
        parts.append(f"⚠ 跳过: {skip_count}")
    parts.append(f"共: {len(accounts)}")
    summary = f"蒙娜丽莎签到完成\n{'  '.join(parts)}"
    print("\n" + "=" * 50)
    print(summary)
    print("=" * 50)

    try:
        send("蒙娜丽莎", summary + "\n\n" + "\n".join(results))
    except Exception:
        pass

    # 设置 PushPlus 推送内容
    globals()['_PUSH_TITLE'] = summary[:80]
    globals()['_PUSH_SUMMARY'] = summary + "\n\n" + "\n".join(results)

    return 0 if fail_count == 0 else 1  # 跳过不计入失败

if __name__ == "__main__":
    main()

# ========== PushPlus 推送 ==========
try:
    import urllib.request as _ur
    import json as _js
    _token = os.getenv('PLUSPLUS_TOKEN', '') or os.getenv('PUSHPLUS_TOKEN', '')
    if _token:
        _content = globals().get('_PUSH_SUMMARY', '蒙娜丽莎执行完成')
        _title = globals().get('_PUSH_TITLE', '蒙娜丽莎')
        _body = _js.dumps({'token': _token, 'title': _title, 'content': _content, 'template': 'txt'}).encode()
        _req = _ur.Request('http://www.pushplus.plus/send', data=_body, method='POST')
        _req.add_header('Content-Type', 'application/json')
        _resp = _ur.urlopen(_req, timeout=15)
        _r = _js.loads(_resp.read())
        if _r.get('code') == 200: print('PushPlus 推送成功')
        else: print(f'PushPlus 推送失败: {_r.get("msg", "")}')
except Exception as _e: print(f'推送异常: {_e}')
# ========== PushPlus 推送结束 ==========
