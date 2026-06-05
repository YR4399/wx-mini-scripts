# ========== SSL和代理修复 ==========
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========


"""
WPS小程序签到+浏览任务+抽奖自动化脚本
通过wechatserver自动wx.login code登录(EC P-256签名), 无需手动cookie

环境变量:
  WPS_ACCOUNT - 账号userKey(openid), 多号换行
  wx_server_url - wechatserver地址
  wx_auth - wechatserver认证key

API要点:
  - 登录: POST account.wps.cn/passport/secure/api/easy_login
         {type:"wxapp", appid:"wxe5f87d6a233b5aab", auth_code, public_key, auth_code_sign, slv:"none"}
         返回cookie: kso_sid, wps_sid, uid, cv, exp等
  - 签到: POST /activity/clock_in/v1/clock_in  {"client_type":1}
  - 任务概览: GET /activity/clock_in/v1/task/outline?mp_id=app_op_act&auth_code=xxx
  - 浏览: start_browse → sleep(15-25s) → finish_browse
  - 抽奖: POST personal-act.wps.cn/activity-rubik/activity/component_action (lottery_v2.exec)
"""

import requests
import json
import time
import random
import datetime
import os
import sys
import re
import threading
import base64
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature



# ==================== 配置 ====================
MAX_WORKERS = 1
APPID = "wx2f333d84a103825d"           # 打卡小程序(获取auth_code用于任务API)
LOGIN_APPID = "wxe5f87d6a233b5aab"     # WPS账号系统(easy_login登录专用)
BUS_URL = "https://personal-bus.wps.cn/activity/clock_in/v1"
ACT_URL = "https://personal-act.wps.cn"
LOGIN_URL = "https://account.wps.cn/passport/secure/api/easy_login"

# 抽奖固定参数
LOTTERY_ACTIVITY = "HD2024082815116866"
LOTTERY_PAGE = "YM2024082815122017"
LOTTERY_COMPONENT = "ZJ2025092916516585"
LOTTERY_NODE = "FN1766995952bvx3"

# 浏览任务 browse_app_id -> finish_browse mp_id 映射
BROWSE_MP_MAP = {
    "wx5890bb82aed1dd7a": "app_resume_assistant",
    "wxb7690f02223a7ab2": "app_collection",
    "wx6335953a0fca4249": "app_paper_check",
    "wxd6e92aac1658a43e": "app_docer_article",
    # 以下默认走 app_op_act
    "wx13cd99d542d173c1": "app_op_act",
    "wxe30a622cc9cdc70b": "app_op_act",
}

# wechatserver
WX_SERVER = os.environ.get("wx_server_url", "https://wc.smallfawn.top")
WX_AUTH = os.environ.get("wx_auth", "")

ACCOUNT_ENV = os.environ.get('wx_opinion') or os.environ.get("WPS_ACCOUNT", "")

print_lock = threading.Lock()

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)"


def log_global(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with print_lock:
        print(f"[{ts}] {msg}")


def get_wx_code(user_key, appid=APPID, retries=3, timeout=60):
    """通过wechatserver获取wx.login code, 带重试"""
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(
                f"{WX_SERVER}/wx/code",
                json={"appid": appid, "openid": user_key},
                headers={"AUTH": WX_AUTH, "Content-Type": "application/json"},
                timeout=timeout,
                verify=False)
            data = resp.json()
            if data.get("status") and data.get("data", {}).get("code"):
                return data["data"]["code"], None
            return None, data.get("message", "未知错误")
        except requests.exceptions.Timeout:
            if attempt < retries:
                log_global(f"获取code超时(attempt {attempt}/{retries}), 重试...")
                time.sleep(2)
                continue
            return None, f"超时({timeout}s, 已重试{retries}次)"
        except Exception as e:
            return None, str(e)


def generate_ec_sign(auth_code):
    """生成EC P-256密钥对并签名auth_code, 返回(public_key_jwk_str, auth_code_sign)"""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # 公钥 → JWK
    pub_numbers = public_key.public_numbers()
    x_bytes = pub_numbers.x.to_bytes(32, "big")
    y_bytes = pub_numbers.y.to_bytes(32, "big")
    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": base64.urlsafe_b64encode(x_bytes).rstrip(b"=").decode(),
        "y": base64.urlsafe_b64encode(y_bytes).rstrip(b"=").decode(),
    }

    # 签名 auth_code (SHA256)
    der_sig = private_key.sign(auth_code.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    auth_code_sign = base64.urlsafe_b64encode(raw_sig).rstrip(b"=").decode()

    return json.dumps(jwk), auth_code_sign


def parse_accounts(raw):
    """解析账号, 支持 & 分隔, 支持8位hex userKey 或微信openid(以o开头>=20位)"""
    raw = re.sub(r"[&\n]", "\n", raw)
    accounts = []
    for line in raw.split("\n"):
        s = line.strip()
        if not s:
            continue
        # 8位hex userKey
        if len(s) == 8 and all(c in "0123456789abcdef" for c in s.lower()):
            accounts.append(s.lower())
        # 微信openid (以o开头, >=20位)
        elif s.startswith("o") and len(s) >= 20:
            accounts.append(s)
        else:
            accounts.append(s)
    return accounts


class WPSAccount:
    def __init__(self, user_key, index):
        self.user_key = user_key
        self.index = index
        self.uid = ""
        self.nickname = ""
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update({
            "User-Agent": UA,
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Referer": f"https://servicewechat.com/{APPID}/248/page-frame.html",
        })

    def log(self, content, level="INFO"):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with print_lock:
            print(f"[{ts}] [账号#{self.index}][{level}] {content}")

    def request(self, method, url, **kwargs):
        try:
            resp = self.session.request(method, url, timeout=15, **kwargs)
            try:
                return resp.json()
            except Exception:
                return {"status_code": resp.status_code, "text": resp.text[:200]}
        except Exception as e:
            self.log(f"请求异常: {e}", "ERROR")
            return None

    def get_auth_code(self, appid=APPID):
        """获取auth_code(wx.login code)"""
        code, err = get_wx_code(self.user_key, appid)
        if not code:
            self.log(f"获取auth_code失败: {err}", "ERROR")
        return code

    def do_login(self):
        """通过wx.login code + EC P-256签名登录WPS, 获取cookie"""
        self.log("开始wx.login code登录...")

        # 1. 获取wx.login code (easy_login必须用LOGIN_APPID)
        auth_code, err = get_wx_code(self.user_key, LOGIN_APPID)
        if not auth_code:
            self.log(f"获取wx.login code失败: {err}", "ERROR")
            return False

        # 2. 生成EC签名
        pub_key_jwk, auth_code_sign = generate_ec_sign(auth_code)

        # 3. 构造wpsua cookie
        device_id = uuid.uuid4().hex[:16]
        wpsua = base64.b64encode(
            f"WPSUA/1.0(vip_clock:1.0.0; windows:Windows 10 x64; wpsmass{device_id}:v1)".encode()
        ).decode()

        # 4. 发送easy_login请求
        login_body = {
            "type": "wxapp",
            "appid": LOGIN_APPID,
            "auth_code": auth_code,
            "public_key": pub_key_jwk,
            "auth_code_sign": auth_code_sign,
            "slv": "none",
        }

        try:
            resp = self.session.post(
                LOGIN_URL,
                json=login_body,
                timeout=20,
                headers={"Cookie": f"csrf=1234567890; wpsua={wpsua}"},
            )
            data = resp.json()

            # 从response cookies提取登录凭证
            cookies = {}
            for c in resp.cookies:
                cookies[c.name] = c.value

            kso_sid = cookies.get("kso_sid", "")
            wps_sid = cookies.get("wps_sid", "")
            uid = cookies.get("uid", "")
            cv = cookies.get("cv", "")

            if not kso_sid and not wps_sid:
                self.log(f"登录失败: {data.get('msg', data.get('result', '未知'))}", "ERROR")
                return False

            # session已自动保存response cookies, 补充csrf
            self.session.cookies.set("csrf", "1234567890", domain="wps.cn")
            self.uid = uid

            self.log(f"WPS登录成功! uid={uid}", "SUCCESS")
            return True

        except Exception as e:
            self.log(f"登录异常: {e}", "ERROR")
            return False

    def check_login(self):
        """检查WPS登录状态并获取信息"""
        data = self.request("POST", "https://account.wps.cn/p/auth/check", json={})
        if data and data.get("result") != "userNotLogin":
            account = data.get("account", "")
            mobile = data.get("mobile", "")
            name = account or mobile or self.uid
            self.nickname = name
            self.log(f"已登录: {name}", "SUCCESS")
            return True
        msg = data.get("msg", "未知") if data else "无响应"
        self.log(f"登录检查失败: {msg}", "ERROR")
        return False

    def do_clock_in(self):
        """签到"""
        data = self.request("POST", f"{BUS_URL}/clock_in", json={"client_type": 1})
        if data and data.get("result") == "ok":
            days = data.get("data", {}).get("continuous_days", 0)
            self.log(f"签到成功! 连续{days}天", "SUCCESS")
            return True
        msg = data.get("msg", "未知") if data else "无响应"
        self.log(f"签到: {msg}")
        return False

    def get_info(self):
        """获取签到信息"""
        data = self.request("GET", f"{BUS_URL}/info",
                           params={"client_type": 1, "page_index": 0, "page_size": 1})
        if data and data.get("result") == "ok":
            d = data.get("data", {})
            days = d.get("continuous_days", 0)
            total = d.get("clock_in_total_num", 0)
            rewards = d.get("reward_list", {}).get("list", [])
            self.log(f"签到信息: 连续{days}天 | 总参与{total}人 | 待领奖励{len(rewards)}个")
            return d
        return None

    def get_lottery_times(self):
        """获取抽奖次数"""
        data = self.request("GET", f"{BUS_URL}/task/lottery_times",
                           params={"position": "wx_xcx_clock_activity"})
        if data and data.get("result") == "ok":
            times = data.get("data", 0)
            self.log(f"抽奖次数: {times}")
            return times
        return 0

    def get_outline(self):
        """获取任务概览"""
        code = self.get_auth_code()
        if not code:
            return None
        data = self.request("GET", f"{BUS_URL}/task/outline",
                           params={"mp_id": "app_op_act", "auth_code": code})
        if data and data.get("result") == "ok":
            browse = data.get("data", {}).get("browse", [])
            subscribe = data.get("data", {}).get("subscribe", [])
            done = sum(1 for b in browse if b.get("status") == 1)
            self.log(f"任务概览: 浏览{done}/{len(browse)} | 订阅{len(subscribe)}个")
            return data.get("data", {})
        return None

    def do_browse_task(self, app_id):
        """执行单个浏览任务: start_browse → 等待 → finish_browse"""
        # start_browse
        code1 = self.get_auth_code()
        if not code1:
            return False
        data = self.request("POST", f"{BUS_URL}/task/start_browse", json={
            "mp_id": "app_op_act",
            "auth_code": code1,
            "browse_app_id": app_id,
            "client_type": "wechat",
            "version": "new"
        })
        if not data or data.get("result") != "ok":
            msg = data.get("msg", "未知") if data else "无响应"
            if "已完成" in msg:
                self.log(f"浏览[{app_id[:8]}] 已完成，跳过")
                return True
            self.log(f"开始浏览[{app_id[:8]}] 失败: {msg}", "ERROR")
            return False

        # 等待模拟浏览
        wait = random.uniform(15, 25)
        self.log(f"浏览[{app_id[:8]}] 等待{wait:.0f}s...")
        time.sleep(wait)

        # finish_browse
        code2 = self.get_auth_code()
        if not code2:
            return False
        mp_id = BROWSE_MP_MAP.get(app_id, "app_op_act")
        data = self.request("POST", f"{BUS_URL}/task/finish_browse", json={
            "mp_id": mp_id,
            "app_id": app_id,
            "auth_code": code2,
            "user_id": int(self.uid) if self.uid else 0
        })
        if data and data.get("result") == "ok":
            self.log(f"浏览[{app_id[:8]}] 完成!", "SUCCESS")
            return True
        msg = data.get("msg", "未知") if data else "无响应"
        self.log(f"完成浏览[{app_id[:8]}] 失败: {msg}", "ERROR")
        return False

    def do_all_browse_tasks(self):
        """执行所有浏览任务"""
        outline = self.get_outline()
        if not outline:
            return 0
        browse = outline.get("browse", [])
        if not browse:
            return 0

        done_count = 0
        for task in browse:
            app_id = task.get("app_id", "")
            status = task.get("status", 0)
            if status == 1:
                self.log(f"浏览[{app_id[:8]}] 已完成，跳过")
                done_count += 1
                continue
            if self.do_browse_task(app_id):
                done_count += 1
        self.log(f"浏览任务: {done_count}/{len(browse)} 完成")
        return done_count

    def do_subscribe(self):
        """尝试订阅任务"""
        code = self.get_auth_code()
        if not code:
            return
        data = self.request("POST", f"{BUS_URL}/task/subscribe", json={
            "mp_id": "app_op_act",
            "auth_code": code,
            "subscribe_app_id": APPID,
            "version": "new"
        })
        msg = data.get("msg", "未知") if data else "无响应"
        self.log(f"订阅任务: {msg}")

    def do_lottery(self, times):
        """执行抽奖"""
        if times <= 0:
            self.log("无抽奖次数")
            return
        success = 0
        for i in range(times):
            data = self.request("POST", f"{ACT_URL}/activity-rubik/activity/component_action", json={
                "component_uniq_number": {
                    "activity_number": LOTTERY_ACTIVITY,
                    "page_number": LOTTERY_PAGE,
                    "component_number": LOTTERY_COMPONENT,
                    "component_node_id": LOTTERY_NODE,
                    "filter_params": {"virtualPayEnabled": "1"}
                },
                "component_type": 45,
                "component_action": "lottery_v2.exec",
                "lottery_v2": {"session_id": 1}
            })
            if data and data.get("result") == "ok":
                lv = data.get("data", {}).get("lottery_v2", {})
                reward = lv.get("reward_name", "未知")
                rtype = lv.get("reward_type", "")
                self.log(f"抽奖#{i+1}: {reward} (type={rtype})", "SUCCESS" if rtype != "pity" else "INFO")
                if lv.get("success"):
                    success += 1
            else:
                msg = data.get("msg", "未知") if data else "无响应"
                self.log(f"抽奖#{i+1} 失败: {msg}", "ERROR")
                break
            time.sleep(random.uniform(1, 3))
        self.log(f"抽奖完成: {success}/{times}次")

    def run(self):
        """主流程"""
        self.log("开始运行...")

        # 1. wx.login code登录
        if not self.do_login():
            return False

        # 2. 验证登录
        if not self.check_login():
            self.log("登录验证失败", "ERROR")
            return False

        # 3. 获取签到信息
        self.get_info()

        # 4. 签到
        self.do_clock_in()

        # 5. 浏览任务
        self.do_all_browse_tasks()

        # 6. 订阅任务(可能失败,不影响)
        self.do_subscribe()

        # 7. 抽奖
        times = self.get_lottery_times()
        self.do_lottery(times)

        # 8. 最终信息
        self.get_info()
        return True


def send_notify(title, content):
    notify_url = os.environ.get("NOTIFY_URL", "")
    if not notify_url:
        return
    try:
        requests.post(notify_url, json={"title": title, "content": content}, timeout=10, verify=False)
    except Exception:
        pass


def main():
    log_global("WPS小程序签到脚本启动 (code登录版)")

    if not ACCOUNT_ENV:
        log_global("未配置环境变量 WPS_ACCOUNT")
        log_global("格式: userKey(openid), 多号换行")
        sys.exit(1)

    accounts = parse_accounts(ACCOUNT_ENV)

    if not accounts:
        log_global("无有效账号")
        sys.exit(1)

    log_global(f"共 {len(accounts)} 个账号 并发={MAX_WORKERS}")

    results = []

    def run_account(user_key, idx):
        acc = WPSAccount(user_key, idx)
        ok = acc.run()
        results.append({"idx": idx, "name": acc.nickname, "uid": acc.uid, "status": "成功" if ok else "失败"})

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = []
        for uk, idx in zip(accounts, range(1, len(accounts) + 1)):
            f = executor.submit(run_account, uk, idx)
            futures.append(f)
        for f in as_completed(futures):
            try:
                f.result(timeout=600)
            except Exception as e:
                log_global(f"账号执行异常: {e}")

    # 汇总
    log_global("\n========== 执行总结 ==========")
    for r in sorted(results, key=lambda x: x["idx"]):
        log_global(f"===== 账号#{r['idx']} =====")
        log_global(f"用户: {r['name']} | uid: {r['uid']} | 状态: {r['status']}")

    summary = "\n".join(f"账号#{r['idx']}: {r['status']}" for r in results)
    send_notify("WPS签到完成", summary)
    log_global("通知发送完成")

if __name__ == "__main__":
    main()
