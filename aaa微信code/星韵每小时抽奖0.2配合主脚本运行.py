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

'''
本脚本仅供学习研究使用，严禁用于任何商业、刷量、违规获利等行为。
使用本脚本所产生的一切风险、账号封禁、法律责任及后果，均由使用者自行承担。
作者仅提供代码参考，不承担任何相关责任。使用即代表您已阅读并同意本声明。
脚本更新链接 记得转存实时更新：https://pan.quark.cn/s/c6416fe69380
'''
# Python脚本，依赖requests库，请先执行安装命令：pip install requests
# 适用应用：微信小程序
# 访问入口：http://mx.qrurl.net/h5/wxa/link?sid=26308RmwS5t (请务必通过此链接进入，确保任务关联,即使注册也点一下确保脚本运行)
#星韵脚本也在网盘里面哦
# 配置说明：
# 环境变量名称：xyyx
# 变量值填写规则：抓取 gzpengru.weimbo.com 域名下请求头(headers)中的 3rdsession 值
# 多账号配置：每个账号的 3rdsession 单独占一行，直接换行填写即可
# 使用说明：脚本单次运行仅抽1次奖，如需每小时执行，可配置系统cron（例：0 * * * * python /path/to/script.py）
import requests
import time
import random
import datetime
import threading
import os

# 全局锁，保证日志输出有序
print_lock = threading.Lock()

def generate_bound_ua(token):
    """生成和token绑定的随机User-Agent"""
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
                f"AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.46 NetType/WIFI Language/zh_CN")

class SingleLottery:
    """单次抽奖模块（仅抽1次，无积分则停止）"""
    def __init__(self, token, index=1):
        self.token = token
        self.index = index
        self.ua = generate_bound_ua(token)
        self.headers = {
            "Host": "gzpengru.weimbo.com",
            "Connection": "keep-alive",
            "3rdsession": self.token,
            "content-type": "application/json",
            "User-Agent": self.ua,
            "Referer": "https://servicewechat.com/wxc86c9aecdb67f876/9/page-frame.html"
        }
        self.base_url = "https://gzpengru.weimbo.com/api/index.php?ackey=GZYTAPPLET"
        self.has_points = True  # 标记是否有积分

    def log(self, content):
        """极简日志输出（仅保留核心信息）"""
        time_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with print_lock:
            print(f"[{time_str}] 账号{self.index} | {content}")

    def post_request(self, payload):
        """带超时和随机延时的POST请求"""
        try:
            time.sleep(random.uniform(1.0, 2.0))
            response = requests.post(
                self.base_url, 
                headers=self.headers, 
                json=payload, 
                timeout=10
            )
            return response.json() if response.status_code == 200 else None
        except Exception as e:
            self.log(f"请求异常: {str(e)}")
            return None

    def check_points(self):
        """检查账号是否有可用积分（无积分则标记并停止）"""
        self.log("检查可用积分...")
        payload = {"action": "userInfoData"}
        res = self.post_request(payload)
        
        if res and res.get("Status"):
            points = res.get("Data", {}).get("u_money", {}).get("jifen", 0)
            if points <= 0:
                self.log(f"无可用积分（当前积分：{points}），停止抽奖")
                self.has_points = False
            else:
                self.log(f"可用积分：{points}，开始抽奖")
        else:
            self.log("积分查询失败，默认停止抽奖")
            self.has_points = False

    def execute_lottery(self):
        """执行单次抽奖（核心逻辑）"""
        # 先检查积分
        self.check_points()
        if not self.has_points:
            return
        
        # 构造抽奖参数
        act_time = int(time.time())
        payload = {
            "action": "userLuckyDraw",
            "act_time": act_time
        }
        
        # 发送抽奖请求
        res = self.post_request(payload)
        if res and res.get("Status"):
            data = res.get("Data", {})
            prize = data.get("title", "未知奖品")
            amount = float(data.get("price", 0))
            self.log(f"抽奖结果：{prize} | 金额：¥{amount:.2f}")
        else:
            msg = res.get("Message", "请求失败") if res else "请求失败"
            # 识别无积分/次数用尽的场景
            if "积分" in msg or "次数" in msg or "用完" in msg:
                self.log(f"抽奖失败：{msg}（无可用积分/次数）")
            else:
                self.log(f"抽奖失败：{msg}")

# ---------------------- 主程序入口 ----------------------
def main():
    # 1. 读取环境变量中的token
    tokens_str = os.environ.get('wx_opinion', '') or os.environ.get('xyyx', '')
    if not tokens_str:
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 错误：未配置环境变量 xyyx，请填写3rdsession值")
        return
    
    tokens = [t.strip() for t in tokens_str.split("\n") if t.strip()]
    if not tokens:
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 错误：环境变量 xyyx 中无有效token")
        return
    
    # 2. 打印启动信息
    print(f"\n[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 启动单次抽奖任务")
    print(f"检测到有效账号数：{len(tokens)} 个")
    print("="*50)
    
    # 3. 为每个账号执行单次抽奖（多线程并发）
    def run_account_lottery(token, idx):
        lottery = SingleLottery(token, idx)
        lottery.execute_lottery()
    
    threads = []
    for idx, token in enumerate(tokens, 1):
        t = threading.Thread(target=run_account_lottery, args=(token, idx))
        threads.append(t)
        t.start()
    
    # 等待所有线程完成
    for t in threads:
        t.join()
    
    # 4. 任务结束
    print("="*50)
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 所有账号抽奖任务执行完毕")

if __name__ == "__main__":
    print("小程序链接:http://mx.qrurl.net/h5/wxa/link?sid=26308RmwS5t")
    print("你转存了嘛！https://pan.quark.cn/s/c6416fe69380")
    main()

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
