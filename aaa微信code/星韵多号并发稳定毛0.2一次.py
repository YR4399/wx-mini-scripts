# ========== 推送通知 ==========
import sys as _sys
import os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
try:
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========

"""
星韵(舞心传媒) wechatserver 自动化脚本
合并日常任务(打卡+视频) + 抽奖，wechatserver 自动登录
环境变量:
  XY_ACCOUNT      - 账号配置，userKey 或 3rdsession(>=20位)，多号换行
  XY_SKIP_DAILY   - 设为 1 跳过日常任务，仅抽奖
  XY_LOTTERY_COUNT - 每号抽奖次数，默认 1
  XY_LOGIN_ACTION  - 登录 action，默认 wxLogin
"""

import requests
import json
import time
import random
import datetime
import re
import os
import sys
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# ==================== 配置 ====================
MAX_WORKERS = 5
BASE_URL = "https://gzpengru.weimbo.com/api/index.php?ackey=GZYTAPPLET"
APPID = "wxc86c9aecdb67f876"
LOGIN_ACTION = os.environ.get("XY_LOGIN_ACTION", "wxLogin")
SKIP_DAILY = os.environ.get("XY_SKIP_DAILY", "").strip() == "1"
LOTTERY_COUNT = int(os.environ.get("XY_LOTTERY_COUNT", "1"))

# wechatserver
WX_SERVER = os.environ.get("wx_server_url", "https://wc.smallfawn.top")
WX_AUTH = os.environ.get("wx_auth", "")

# 环境变量账号
ACCOUNT_ENV = os.environ.get('wx_opinion') or os.environ.get("XY_ACCOUNT", "")

print_lock = threading.Lock()


def log_global(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with print_lock:
        print(f"[{ts}] {msg}")


def generate_bound_ua(token):
    rd = random.Random(token)
    os_type = rd.choice(["Android", "iOS"])
    if os_type == "Android":
        android_ver = rd.choice(["10", "11", "12", "13", "14"])
        chrome_ver = f"{rd.randint(86, 120)}.0.{rd.randint(4000, 6000)}.{rd.randint(100, 200)}"
        phone_model = rd.choice(["SM-G9810", "V2055A", "M2012K11AC", "PADT00", "KB2000", "MI 10"])
        return (f"Mozilla/5.0 (Linux; Android {android_ver}; {phone_model} Build/QP1A.190711.020; wv) "
                f"AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/{chrome_ver} "
                f"MicroMessenger/8.0.45.2400 WeChat/arm64 NetType/WIFI Language/zh_CN")
    else:
        ios_ver = rd.choice(["15_0", "16_2", "17_1"])
        return (f"Mozilla/5.0 (iPhone; CPU iPhone OS {ios_ver} like Mac OS X) "
                f"AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
                f"MicroMessenger/8.0.46 NetType/WIFI Language/zh_CN")


def get_wx_code(user_key):
    """通过 wechatserver 获取 wx.login code"""
    try:
        resp = requests.post(
            f"{WX_SERVER}/wx/code",
            json={"appid": APPID, "openid": user_key},
            headers={"AUTH": WX_AUTH, "Content-Type": "application/json"},
            timeout=20
        )
        data = resp.json()
        if data.get("status") and data.get("data", {}).get("code"):
            return data["data"]["code"], None
        return None, data.get("message", "未知错误")
    except Exception as e:
        return None, str(e)


def parse_accounts(raw):
    """解析账号: 序号/8位hex/32位MD5/openid(>=20位)"""
    accounts = []
    # 支持 & 和换行分隔
    raw = re.sub(r'[&\n]', '\n', raw)
    for line in raw.split("\n"):
        s = line.strip()
        if not s:
            continue
        if s.isdigit():
            uk = hashlib.md5((WX_AUTH + s).encode()).hexdigest()[:8]
            accounts.append((uk, "wx"))
        elif len(s) == 8 and all(c in "0123456789abcdef" for c in s.lower()):
            accounts.append((s.lower(), "wx"))
        elif len(s) == 32 and all(c in "0123456789abcdef" for c in s.lower()):
            accounts.append((s.lower(), "wx"))
        elif len(s) >= 20 and s.startswith("o"):
            # 微信 openid 格式 (如 owNAX6j83m4TzrbI...)，走 wechatserver
            accounts.append((s, "wx"))
        elif len(s) >= 20:
            accounts.append((s, "direct"))
        else:
            log_global(f"无法识别账号格式: {s[:10]}...")
    return accounts


class XingYunAccount:
    def __init__(self, token, account_type, index):
        self.token = token
        self.account_type = account_type  # "wx" 或 "direct"(直接用3rdsession)
        self.index = index
        self.ua = generate_bound_ua(token)
        self.session = requests.Session()
        self.session.headers.update({
            "Host": "gzpengru.weimbo.com",
            "Connection": "keep-alive",
            "content-type": "application/json",
            "User-Agent": self.ua,
            "Referer": "https://servicewechat.com/wxc86c9aecdb67f876/9/page-frame.html"
        })
        # 状态
        self.user_name = "未知"
        self.initial_points = 0
        self.final_points = 0
        self.earned_points = 0
        self.is_sign_completed = False
        self.is_video_completed = False

    def log(self, content, level="INFO"):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with print_lock:
            print(f"[{ts}] [账号#{self.index}][{level}] {content}")

    def post(self, payload):
        try:
            time.sleep(random.uniform(1.0, 2.5))
            resp = self.session.post(BASE_URL, json=payload, timeout=12)
            return resp.json() if resp.status_code == 200 else None
        except Exception as e:
            self.log(f"请求异常: {e}", "ERROR")
            return None

    def login_wx(self, user_key):
        """wechatserver 登录: code → wxLogin → 3rdsession"""
        code, err = get_wx_code(user_key)
        if not code:
            self.log(f"wechatserver 获取code失败: {err}", "ERROR")
            return False

        payload = {"action": LOGIN_ACTION, "code": code}
        try:
            resp = self.session.post(BASE_URL, json=payload, timeout=15)

            # 尝试从响应中提取 3rdsession
            session = None

            # 1. 从 Set-Cookie header 提取
            sc = resp.headers.get("Set-Cookie", "")
            m = re.search(r'3rdsession=([^;]+)', sc)
            if m:
                session = m.group(1)

            # 2. 从响应 body 提取
            try:
                body = resp.json()
            except Exception:
                body = None

            if not session and body:
                # 直接返回 Data 为 session
                if isinstance(body.get("Data"), str) and len(body["Data"]) > 10:
                    session = body["Data"]
                elif isinstance(body.get("Data"), dict):
                    session = (body["Data"].get("r3dkey")
                               or body["Data"].get("3rdsession")
                               or body["Data"].get("session")
                               or body["Data"].get("session_id")
                               or body["Data"].get("token"))
                    # 也检查 Data.Data
                    if not session and isinstance(body["Data"].get("Data"), str):
                        session = body["Data"]["Data"]

            if session:
                self.token = session
                self.session.headers["3rdsession"] = session
                self.ua = generate_bound_ua(session)
                self.session.headers["User-Agent"] = self.ua
                self.log(f"登录成功, 3rdsession={session[:16]}...", "SUCCESS")
                return True
            else:
                self.log(f"登录失败，无法提取 3rdsession (action={LOGIN_ACTION})", "ERROR")
                self.log(f"响应: {resp.text[:200]}", "ERROR")
                if LOGIN_ACTION == "wxLogin":
                    self.log("如 action 名不对，请设置环境变量 XY_LOGIN_ACTION", "WARNING")
                return False
        except Exception as e:
            self.log(f"登录请求异常: {e}", "ERROR")
            return False

    def login_direct(self):
        """直接使用 3rdsession"""
        self.session.headers["3rdsession"] = self.token
        self.log(f"使用直连 3rdsession={self.token[:16]}...", "INFO")
        return True

    def get_user_info(self):
        data = self.post({"action": "userInfoData"})
        if data and data.get("Status"):
            ud = data.get("Data", {})
            self.user_name = ud.get("user", {}).get("name", "未知")
            self.initial_points = ud.get("u_money", {}).get("jifen", 0)
            self.log(f"用户: {self.user_name} | 积分: {self.initial_points}", "SUCCESS")
            return True
        self.log("获取用户信息失败（token可能无效）", "ERROR")
        return False

    def check_task_progress(self):
        data = self.post({"action": "getIntegralInfo", "type": "jifen"})
        sign_str = "未知"
        video_str = "0/8"
        if data and data.get("Status"):
            for task in data.get("Data", {}).get("adv_arr", []):
                title = task.get("title", "")
                if task.get("id") == 2:
                    m = re.search(r'\((\d+)/(\d+)\)', title)
                    if m:
                        curr, total = int(m.group(1)), int(m.group(2))
                        sign_str = f"{curr}/{total}"
                        self.is_sign_completed = curr >= total
                elif task.get("id") == 3:
                    m = re.search(r'\((\d+)/(\d+)\)', title)
                    if m:
                        curr, total = int(m.group(1)), int(m.group(2))
                        video_str = f"{curr}/{total}"
                        self.is_video_completed = curr >= total
            self.log(f"任务进度: 打卡[{sign_str}] 视频[{video_str}]")
            return True
        return False

    def do_video_task(self):
        """执行视频任务"""
        if self.is_video_completed:
            return
        while not self.is_video_completed:
            res = self.post({"action": "IntegralGiveReward"})
            if res and res.get("Status"):
                self.log(f"视频任务: {res.get('Data', '')}", "SUCCESS")
            else:
                msg = res.get("Message", "未知") if res else "请求失败"
                if "上限" in msg or "完成" in msg or "今天" in msg or "无视频" in msg:
                    self.log(f"视频任务完成/达上限: {msg}", "WARNING")
                    self.is_video_completed = True
                else:
                    self.log(f"视频等待中: {msg}")
                    time.sleep(3)
            self.check_task_progress()
            time.sleep(1)

    def do_sign_task(self):
        """执行打卡任务（含冷却等待）"""
        if self.is_sign_completed:
            return
        while not self.is_sign_completed:
            # 获取冷却时间
            data = self.post({"action": "getIntegralInfo", "type": "sign"})
            wait_time = 290
            qiands = "未知"
            if data and data.get("Status"):
                sd = data.get("Data", {})
                wait_time = int(sd.get("sign_time", 0))
                qiands = sd.get("qiands", "未知")
                if not (0 < wait_time < 600):
                    wait_time = 290

            if wait_time > 0:
                self.log(f"打卡冷却 {wait_time}s ({qiands})，等待中...")
                # 冷却期间做视频
                start = time.time()
                while time.time() - start < wait_time:
                    if not self.is_video_completed:
                        self.do_video_task()
                    time.sleep(5)

            # 打卡
            res = self.post({"action": "userQiandao"})
            if res and res.get("Status"):
                rd = res.get("Data", {})
                self.log(f"打卡成功! +{rd.get('add_jf', 0)}分 | 总分: {rd.get('user_jf', 0)}", "SUCCESS")
            else:
                msg = res.get("Message", "未知") if res else "无响应"
                self.log(f"打卡: {msg}")
            self.check_task_progress()
            time.sleep(1)

    def do_lottery(self, count=1):
        """执行抽奖"""
        for i in range(count):
            # 先检查积分
            info = self.post({"action": "userInfoData"})
            if info and info.get("Status"):
                pts = info.get("Data", {}).get("u_money", {}).get("jifen", 0)
                if pts <= 0:
                    self.log(f"积分不足({pts})，停止抽奖", "WARNING")
                    break

            act_time = int(time.time())
            res = self.post({"action": "userLuckyDraw", "act_time": act_time})
            if res and res.get("Status"):
                d = res.get("Data", {})
                prize = d.get("title", "未知")
                amount = float(d.get("price", 0))
                self.log(f"抽奖#{i+1}: {prize} | ¥{amount:.2f}", "SUCCESS")
            else:
                msg = res.get("Message", "请求失败") if res else "请求失败"
                if "积分" in msg or "次数" in msg or "用完" in msg:
                    self.log(f"抽奖#{i+1} 失败: {msg}", "WARNING")
                    break
                self.log(f"抽奖#{i+1} 失败: {msg}", "ERROR")
            if i < count - 1:
                time.sleep(random.uniform(2, 4))

    def get_final_points(self):
        data = self.post({"action": "userInfoData"})
        if data and data.get("Status"):
            self.final_points = data.get("Data", {}).get("u_money", {}).get("jifen", 0)
            self.earned_points = self.final_points - self.initial_points
            self.log(f"最终积分: {self.final_points} | 收益: +{self.earned_points}", "SUCCESS")
            return True
        return False

    def run(self, user_key=None):
        """主流程"""
        self.log("开始运行...")

        # 1. 登录
        if self.account_type == "wx":
            if not self.login_wx(user_key):
                return False
        else:
            if not self.login_direct():
                return False

        # 2. 获取用户信息
        if not self.get_user_info():
            return False

        # 3. 日常任务
        if not SKIP_DAILY:
            self.check_task_progress()
            if self.is_sign_completed and self.is_video_completed:
                self.log("今日日常任务已完成", "SUCCESS")
            else:
                self.do_sign_task()  # 内含视频任务
        else:
            self.log("跳过日常任务(仅抽奖模式)", "INFO")

        # 4. 抽奖
        if LOTTERY_COUNT > 0:
            self.do_lottery(LOTTERY_COUNT)

        # 5. 最终统计
        self.get_final_points()
        return True


def send_notify(title, content):
    """发送通知（兼容呆呆面板）"""
    notify_url = os.environ.get("NOTIFY_URL", "")
    if not notify_url:
        return
    try:
        requests.post(notify_url, json={"title": title, "content": content}, timeout=10)
    except Exception:
        pass


def main():
    # 启动信息
    mode = "仅抽奖" if SKIP_DAILY else "日常+抽奖"
    log_global(f"wechatserver={WX_SERVER} 星韵 appid={APPID} 模式={mode}")

    # 解析账号
    if not ACCOUNT_ENV:
        log_global("未配置环境变量 XY_ACCOUNT")
        sys.exit(1)

    accounts_raw = parse_accounts(ACCOUNT_ENV)
    if not accounts_raw:
        log_global("无有效账号")
        sys.exit(1)

    log_global(f"共 {len(accounts_raw)} 个账号 并发={MAX_WORKERS}")

    # 并发执行
    results = []

    def run_account(token, atype, idx, user_key):
        acc = XingYunAccount(token, atype, idx)
        ok = acc.run(user_key if atype == "wx" else None)
        results.append({
            "idx": idx, "name": acc.user_name,
            "init": acc.initial_points, "final": acc.final_points,
            "earned": acc.earned_points, "status": "成功" if ok else "失败"
        })

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = []
        for i, (token, atype) in enumerate(accounts_raw, 1):
            f = executor.submit(run_account, token, atype, i, token)
            futures.append(f)
        for f in as_completed(futures):
            try:
                f.result(timeout=3600)
            except Exception as e:
                log_global(f"账号执行异常: {e}")

    # 汇总
    log_global("\n========== 执行总结 ==========")
    total_earned = 0
    for r in sorted(results, key=lambda x: x["idx"]):
        log_global(f"===== 账号#{r['idx']} =====")
        log_global(f"状态: {r['status']}")
        if r["status"] == "成功":
            log_global(f"用户: {r['name']} | 积分: {r['init']} → {r['final']} (+{r['earned']})")
            total_earned += r["earned"]
    log_global(f"\n总收益: +{total_earned} 积分")

    # 通知
    summary = "\n".join(
        f"账号#{r['idx']}: {r['status']} {'+' + str(r['earned']) + '分' if r['status'] == '成功' else ''}"
        for r in results
    )
    send_notify(f"星韵任务完成 {len(results)}个账号", summary)
    log_global("通知发送完成")


if __name__ == "__main__":
    import io
    _log_capture = io.StringIO()
    _old_stdout = sys.stdout
    _old_stderr = sys.stderr
    sys.stdout = _log_capture
    sys.stderr = _log_capture
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        print(f'脚本异常: {e}')
    finally:
        sys.stdout = _old_stdout
        sys.stderr = _old_stderr
    _logs = _log_capture.getvalue()
    if _logs.strip():
        print(_logs)
        try:
            push_notify('签到结果', _logs[-2000:])
        except:
            pass