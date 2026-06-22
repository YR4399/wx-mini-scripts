# 用法: 配置环境变量后自动运行
# 依赖呆呆面板环境变量:
#   BRIDGE_BASE_URL / wx_server_url / wxcodeurl - WCS 地址
#   BRIDGE_AUTH_KEY / wx_auth / WXAPIKEY - WCS 认证 key
#   LY_M_OPENIDS - 乐云萌账号 OpenID (多个用 & 分隔，不配则读取 wx_opinion)
#
# 示例 (在呆呆面板添加环境变量):
#   LY_M_OPENIDS = owNAX6j83m4TzrbIA5R3iNXM1iY0&owNAX6ue8pWjcCwrfF-A3M9pgMNw&owNAX6vYHRZK81cK3dEFTonp9RzA
#
# 说明:
#   - 全自动登录 + 蓄能，无需手动维护 session_id
#   - device_id 首次运行自动生成，持久化到 LYM_DEVICE_CACHE 文件
#   - 最大 100 分钟/天，连续 15 天未蓄能会失去资格

import json
import os

# 清除代理干扰
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_k, None)
# ===== 功能开关 =====
ENABLE_SIGNIN = False    # 签到
ENABLE_WITHDRAW = False  # 提现
# ===== 功能开关结束 =====

import sys
import time
import random
import hashlib
import urllib.parse
from urllib import request, parse

# ========== 从呆呆面板读取配置 ==========
WX_SERVER_URL = (
    os.environ.get("BRIDGE_BASE_URL") or
    os.environ.get("wx_server_url") or
    os.environ.get("wxcodeurl") or
    "http://172.17.0.3:8787"
)

WX_API_KEY = (
    os.environ.get("BRIDGE_AUTH_KEY") or
    os.environ.get("wx_auth") or
    os.environ.get("WXAPIKEY") or
    os.environ.get("WECHAT_AUTH") or
    os.environ.get("WX_SERVER_APIKEY") or
    ""
)

# 乐云萌账号 OpenID
LYM_OPENIDS_RAW = os.environ.get("LY_M_OPENIDS", "").strip()
if not LYM_OPENIDS_RAW:
    # fallback: 读取 wx_opinion
    LYM_OPENIDS_RAW = os.environ.get("wx_opinion", os.environ.get("WECHAT_ACCOUNTS", "")).strip()

# 设备缓存路径
LYM_DEVICE_CACHE = os.environ.get("LYM_DEVICE_CACHE", "/tmp/leyunmeng_devices.json")

BASE_URL = "https://xcx.leyunmeng.com/"

UA_POOL = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.51(0x18003329) NetType/WIFI Language/zh_CN",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.48(0x18003023) NetType/WIFI Language/zh_CN",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003228) NetType/WIFI Language/zh_CN",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c2d) NetType/WIFI Language/zh_CN",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.52(0x18003432) NetType/WIFI Language/zh_CN",
]

# 默认邀请码 (可从 HAR 抓包确认)
DEFAULT_INVITE_CODE = "7238F2"


def parse_openids(raw):
    """解析 OpenID 字符串 (& 分隔)"""
    if not raw:
        return []
    return [oid.strip() for oid in raw.split("&") if oid.strip()]


# 乐云萌小程序 AppID (从 HAR 抓包确认)
MINI_APPID = "wx4e5a828991c1f911"


def get_wx_code(wx_server_url, wx_api_key, openid):
    """通过 WCS 获取微信 login code (POST + auth header + appid body)"""
    url = wx_server_url.rstrip("/") + "/wx/code"
    data = json.dumps({"appid": MINI_APPID, "openid": openid}).encode("utf-8")
    req = request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "auth": wx_api_key,
            "User-Agent": "Mozilla/5.0",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=15) as response:
            resp = json.loads(response.read().decode())
            if resp.get("status") is True or resp.get("status") == "true":
                # 响应格式: {"status": true, "message": "获取成功", "data": {"code": "xxx"}}
                return resp.get("data", {}).get("code", "")
            else:
                print(f"  [WCS] 获取 code 失败: {resp.get('message', '未知错误')}", file=sys.stderr)
                return ""
    except Exception as e:
        print(f"  [WCS] 请求失败: {e}", file=sys.stderr)
        return ""


def load_device_cache():
    """加载设备缓存"""
    if os.path.exists(LYM_DEVICE_CACHE):
        try:
            with open(LYM_DEVICE_CACHE, 'r') as f:
                return json.load(f)
        except:
            return {}
    return {}


def save_device_cache(cache):
    """保存设备缓存"""
    try:
        with open(LYM_DEVICE_CACHE, 'w') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except:
        pass


def get_nickname(openid, cache):
    """根据 OpenID 获取昵称 (从呆呆面板备注)"""
    # 从 openids 列表推断昵称
    openids = parse_openids(LYM_OPENIDS_RAW)
    idx = openids.index(openid) if openid in openids else -1
    
    nicknames = ["陌白", "陌白白", "ww"]
    if 0 <= idx < len(nicknames):
        return nicknames[idx]
    
    # 从缓存读取
    if openid in cache:
        return cache[openid].get("nickname", "")
    
    return ""


class LYMAutomation:
    def __init__(self, openid, device_id=None):
        self.openid = openid
        self.device_cache = load_device_cache()
        
        # 获取昵称
        self.nickname = get_nickname(openid, self.device_cache)
        if not self.nickname:
            self.nickname = f"账号{openid[:6]}..."
        
        # 从缓存获取或生成 device_id
        if device_id and device_id != "默认值":
            self.device_id = device_id
        else:
            # 按 openid 生成默认 device_id
            self.device_id = str(int(hashlib.md5(openid.encode()).hexdigest(), 16) % 10000000000000000000)
        
        # 优先使用缓存的 device_id
        if openid in self.device_cache:
            cached = self.device_cache[openid]
            if isinstance(cached, dict):
                self.device_id = cached.get("device_id", self.device_id)
                self.session_id = cached.get("session_id", "")
                self.mid = cached.get("mid", "")
                self.last_login = cached.get("last_login", 0)
                print(f"  [缓存] 使用已保存 device_id: {self.device_id}")
            else:
                self.device_id = str(cached)
        else:
            self.session_id = ""
            self.mid = ""
            self.last_login = 0
            print(f"  [缓存] 首次运行，自动生成 device_id: {self.device_id}")
        
        # 选择 UA
        idx = int(hashlib.md5(self.device_id.encode()).hexdigest(), 16) % len(UA_POOL)
        self.ua = UA_POOL[idx]
        
        self.minutes_per_energy = 8
        self.battery_per_energy = 2.0

    def login(self):
        """通过 WCS + wxlogin 登录，获取 session_id"""
        # 检查 session 是否有效 (缓存中保存)
        if self.session_id and time.time() - self.last_login < 86400 * 7:
            res = self.call("/ApiEnergy/status", {"device_id": self.device_id})
            if res.get("status") == 1:
                print(f"  [登录] session_id 有效，无需重新登录")
                return True
            else:
                print(f"  [登录] 旧 session_id 已失效，重新登录...")
                self.session_id = ""

        print(f"\n  [登录] 开始登录...")

        # 1. 从 WCS 获取 wx login code
        wx_code = get_wx_code(WX_SERVER_URL, WX_API_KEY, self.openid)
        if not wx_code:
            print(f"  [登录] 获取微信 code 失败", file=sys.stderr)
            return False

        print(f"  [登录] 获取微信 code 成功: {wx_code[:8]}...")

        # 2. 先尝试 wxlogin (已注册账号，不需要 iv/encryptedData)
        login_body = {
            "code": wx_code,
            "userinfo": {},
            "pid": 0,
            "yqcode": "",
        }
        res = self._post("/ApiIndex/wxlogin", login_body, need_session=False)
        
        if res.get("status") == 1:
            # wxlogin 成功，返回了 session_id
            self.session_id = res.get("session_id", "")
            self.mid = res.get("mid", "")
            print(f"  [登录] wxlogin 登录成功! session_id={self.session_id[:8] if self.session_id else '无'}..., mid={self.mid}")
        elif res.get("status") == 2:
            # 新用户需要注册 (login_bind=1)
            print(f"  [登录] 需要注册 (新用户)，尝试 wxRegister...")
            reg_body = {
                "headimg": "",
                "nickname": "",
                "iv": "",
                "encryptedData": "",
                "code": wx_code,
                "pid": 0,
                "agent_code": "",
                "yqcode": "",
            }
            res = self._post("/ApiIndex/wxRegister", reg_body, need_session=False)
            if res.get("status") != 1:
                print(f"  [登录] wxRegister 失败: {res.get('msg')}", file=sys.stderr)
                return False
            self.session_id = res.get("session_id", "")
            self.mid = res.get("mid", "")
            print(f"  [登录] wxRegister 注册+登录成功! session_id={self.session_id[:8] if self.session_id else '无'}..., mid={self.mid}")
        else:
            print(f"  [登录] 登录失败: {res.get('msg', '未知错误')}", file=sys.stderr)
            return False

        if not self.session_id:
            print(f"  [登录] 未获取到 session_id", file=sys.stderr)
            return False

        self.last_login = int(time.time())

        # 3. 保存登录信息到缓存
        self.device_cache[self.openid] = {
            "device_id": self.device_id,
            "session_id": self.session_id,
            "mid": self.mid,
            "last_login": self.last_login,
            "nickname": self.nickname,
        }
        save_device_cache(self.device_cache)

        return True

    def call(self, s, extra=None):
        """发送 GET 请求"""
        if not self.session_id:
            return {"status": 0, "msg": "未登录"}
        
        params = {
            "s": s,
            "aid": 1,
            "platform": "wx",
            "pid": 0,
            "session_id": self.session_id,
        }
        if extra:
            params.update(extra)

        url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
        req = request.Request(
            url,
            headers={
                "User-Agent": self.ua,
                "Referer": "https://servicewechat.com/wx4e5a828991c1f911/45/page-frame.html",
            },
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode())
        except Exception as e:
            return {"status": 0, "msg": str(e)}

    def _post(self, s, body_dict, extra=None, need_session=True):
        """发送 POST 请求 (JSON body)"""
        if need_session and not self.session_id:
            return {"status": 0, "msg": "未登录"}
        
        params = {
            "s": s,
            "aid": 1,
            "platform": "wx",
            "pid": 0,
            "session_id": self.session_id,
        }
        if extra:
            params.update(extra)

        url = f"{BASE_URL}?{urllib.parse.urlencode(params)}"
        data = json.dumps(body_dict).encode("utf-8")
        req = request.Request(
            url,
            data=data,
            headers={
                "User-Agent": self.ua,
                "Referer": "https://servicewechat.com/wx4e5a828991c1f911/45/page-frame.html",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode())
        except Exception as e:
            return {"status": 0, "msg": str(e)}

    def get_status(self):
        """获取能量状态"""
        res = self.call("/ApiEnergy/status", {"device_id": self.device_id})
        if res.get("status") != 1:
            print(f"  [错误] 获取状态失败: {res.get('msg')}", file=sys.stderr)
            return None

        data = res.get("data") or {}
        energy = data.get("energy")
        if not isinstance(energy, dict):
            print(
                "  [错误] 状态异常: 接口未返回 energy 数据，请检查 session_id 与 device_id 是否为同一账号且未过期",
                file=sys.stderr,
            )
            return None

        settings = data.get("set") if isinstance(data.get("set"), dict) else {}
        data["set"] = settings
        self.minutes_per_energy = settings.get("minutes_per_energy", 8)
        self.battery_per_energy = float(settings.get("battery_percent_per_energy", 2.0))

        today_energy = data.get("today_energy", 0) or 0
        energy["today_energy"] = today_energy

        print(f"  [状态] 今日已产: {today_energy} 元气, 账户可用: {energy.get('available_energy', 0)} 元气")
        print(f"        待领取: {energy.get('unclaimed_energy', 0)} 元气, {'充电中' if data.get('is_charging') else '未充电'}")
        return data

    def start_charge(self, battery):
        """开始蓄能"""
        return self.call(
            "/ApiEnergy/start",
            {"device_id": self.device_id, "battery": battery, "scene": 1001, "energyPlatform": "android"},
        )

    def progress(self, battery):
        """上报进度"""
        return self.call(
            "/ApiEnergy/progress",
            {"device_id": self.device_id, "battery": battery, "scene": 1001},
        )

    def bind_agent(self, invite_code="7238F2"):
        """绑定邀请关系 (首次运行)"""
        return self.call(
            "/ApiEnergy/bindAgent",
            {"device_id": self.device_id, "scene": 1001, "invite_code": invite_code, "lng": "", "lat": ""},
        )

    def claim_energy(self):
        """领取元气（unclaimed → available）"""
        res = self.call("/ApiEnergy/claim", {"device_id": self.device_id})
        if res.get("status") == 1:
            msg = res.get("msg", "")
            if "成功" in msg:
                print(f"  [领取] {msg}")
                return True
            else:
                # "暂无可领取元气" — 不是错误
                return False
        else:
            print(f"  [领取] 失败: {res.get('msg', '未知')}", file=sys.stderr)
            return False


    def sign_in(self):
        """签到"""
        # 检查签到状态
        res = self.call("/ApiSign/index")
        userinfo = res.get("userinfo", {})
        if not isinstance(userinfo, dict) or not userinfo:
            print(f"  [签到] 获取签到状态失败", file=sys.stderr)
            return None
        
        today_sign = userinfo.get("today_sign", userinfo.get("sign", 0))
        if today_sign:
            print(f"  [签到] 今日已签到 (连续{userinfo.get('signcnt', 0)}天)")
            return {"signed": True, "reward": 0}
        
        # 执行签到
        res = self._post("/ApiSign/signin", {})
        if res.get("status") == 1:
            scoreadd = res.get("scoreadd", 0) or 0
            coupon = res.get("coupon_name", "") or res.get("coupon", "")
            print(f"  [签到] 签到成功 +{scoreadd}积分" + (f" 获得{coupon}" if coupon else ""))
            return {"signed": True, "reward": scoreadd, "coupon": coupon, "raw": res}
        else:
            msg = res.get("msg", "")
            if "已签" in str(msg):
                print(f"  [签到] 今日已签到")
                return {"signed": True, "reward": 0}
            print(f"  [签到] 签到失败: {msg}", file=sys.stderr)
            return None

    def lottery_status(self):
        """查询转盘状态"""
        res = self.call("/ApiEnergy/turntable", {"device_id": self.device_id})
        if res.get("status") != 1:
            return None
        prizes = res.get("data", [])
        times = res.get("cost_energy", 0)
        if times <= 0:
            times = 1  # default to 1 draw attempt
        print(f"  [抽奖] 共{len(prizes)}个奖品")
        return {"times": times, "prizes": prizes, "raw": res}

    def lottery_draw(self):
        """执行转盘抽奖"""
        res = self._post("/ApiEnergy/turntableDraw", {})
        if res.get("status") == 1:
            prize = res.get("data", {})
            prize_name = prize.get("prize_name", "奖励")
            prize_value = prize.get("prize_value", "")
            prize_type = prize.get("prize_type", "")
            print(f"  [抽奖] 中奖: {prize_name} ({prize_value}{'元' if prize_type=='cash' else ''})")
            return {"success": True, "prize": prize_name, "value": prize_value, "type": prize_type, "raw": res}
        msg = res.get("msg", "")
        if "次数" in str(msg) or "用完" in str(msg):
            print(f"  [抽奖] 抽奖次数已用完")
            return {"success": False, "reason": "no_times"}
        print(f"  [抽奖] 抽奖失败: {msg}", file=sys.stderr)
        return {"success": False, "reason": msg}

    def withdraw_info(self):
        """查询提现信息 (余额+佣金)"""
        res = self.call("/ApiAgent/commissionWithdraw", {"device_id": self.device_id, "scene": 1089})
        if not res.get("userinfo"):
            print(f"  [提现] 获取提现信息失败: {res}", file=sys.stderr)
            return None
        userinfo = res.get("userinfo", {})
        sysset = res.get("sysset", {})
        balance = float(userinfo.get("money", 0))
        commission = float(userinfo.get("commission", 0))
        coupons = res.get("list", res.get("data", {}).get("list", []))
        daily_limit = res.get("daily_limit_times", sysset.get("comwithdrawcount", 1))
        daily_used = res.get("daily_used_times", 0)
        print(f"  [提现] 余额: {balance:.2f}元, 佣金: {commission:.2f}元, 提现券: {len(coupons)}张")
        return {"balance": balance, "commission": commission, "coupons": coupons, "daily_limit": daily_limit, "daily_used": daily_used}

    def withdraw_do(self, coupon):
        """执行提现"""
        money = float(coupon.get("remain_quota_money", coupon.get("total_quota_money", 0)))
        body = {
            "money": money,
            "paytype": "微信钱包",
            "withdraw_coupon_id": coupon.get("id", 0),
            "coupon_record_id": coupon.get("id", 0),
            "withdraw_coupon_sn": coupon.get("sn", ""),
        }
        res = self._post("/ApiAgent/commissionwithdraw", body)
        if res.get("status") == 1:
            print(f"  [提现] 提现{money:.2f}元成功: {res.get('msg', '')}")
            return {"success": True, "amount": money}
        msg = res.get("msg", "")
        if "次数" in str(msg) or "上限" in str(msg):
            print(f"  [提现] 今日提现已达上限")
            return {"success": False, "reason": "limit"}
        if "余额" in str(msg) or "不足" in str(msg):
            print(f"  [提现] 余额不足")
            return {"success": False, "reason": "insufficient"}
        print(f"  [提现] 提现失败: {msg}", file=sys.stderr)
        return {"success": False, "reason": msg}

    def charge_once(self, invite_code="7238F2"):
        """单次蓄能循环: start -> progress"""
        base = random.randint(20, 39)
        top = min(base + random.randint(10, 14), 96)

        # 检查是否需要绑定 agent
        status = self.call("/ApiEnergy/status", {"device_id": self.device_id})
        if not status or status.get("status") != 1:
            print(f"  [蓄能] 获取状态失败，无法检查绑定")
            return False, "状态获取失败"
        
        energy_data = (status.get("data") or {}).get("energy", {})
        agent_id = energy_data.get("agent_id", 0)
        if agent_id == 0:
            bind_res = self.bind_agent(invite_code)
            if bind_res.get("status") == 1:
                print(f"  [邀请] {bind_res.get('msg', '')}")
            else:
                print(f"  [邀请] 绑定失败: {bind_res.get('msg', '')}", file=sys.stderr)

        st = self.start_charge(base)
        if st.get("status") != 1:
            msg = st.get("msg", "")
            print(f"  [蓄能] start 失败: {msg}")
            return False, msg
        
        charge_id = (st.get("data") or {}).get("charge_id", "")
        print(f"  [蓄能] charge_id={charge_id}, 起始 {base}%, 目标 {top}%")
        
        t0 = time.time()
        b = base
        while b < top:
            time.sleep(random.uniform(4, 7))
            b = min(base + int((time.time() - t0) / 10), top)
            self.progress(b)
        
        time.sleep(2)
        
        res = self.call("/ApiEnergy/status", {"device_id": self.device_id})
        ok = res.get("status") == 1
        is_charging = (res.get("data") or {}).get("is_charging", False)
        
        elapsed = int(time.time() - t0)
        gained = (res.get("data") or {}).get("today_energy", 0)
        print(f"  [蓄能] 耗时 {elapsed}s, {base}%->{top}%, 今日+{gained}元气, 充电中={is_charging}")
        return ok, ""

    def run(self, invite_code="7238F2"):
        """主流程"""
        print(f"\n{'#' * 50}")
        print(f"# 乐云萌 - 自动蓄能")
        print(f"# {self.nickname} (OpenID: {self.openid[:10]}...)")
        print(f"{'#' * 50}")

        # 1. 登录
        if not self.login():
            print(f"[失败] {self.nickname} 登录失败")
            return

        # 2. 签到
        if ENABLE_SIGNIN:
            print(f"\n  [{self.nickname}] 执行签到...")
            sign_result = self.sign_in()
            time.sleep(1)
        else:
            print(f"\n  [{self.nickname}] 签到已关闭")


        # 3. 抽奖
        print(f"\n  [{self.nickname}] 执行抽奖...")
        lottery = self.lottery_status()
        if lottery and lottery.get("times", 0) > 0:
            for _ in range(min(lottery.get("times", 0), 5)):
                result = self.lottery_draw()
                if not result or not result.get("success"):
                    break
                time.sleep(2)
        time.sleep(1)

        # 4. 提现
        if ENABLE_WITHDRAW:
            print(f"\n  [{self.nickname}] 检查提现...")
            wd_info = self.withdraw_info()
            if wd_info and wd_info.get("coupons"):
                for coupon in wd_info["coupons"]:
                    if wd_info.get("daily_used", 0) >= wd_info.get("daily_limit", 1):
                        print(f"  [提现] 今日提现已达上限")
                        break
                    rem = float(coupon.get("remain_quota_money", 0) or 0)
                    if rem <= 0:
                        continue
                    result = self.withdraw_do(coupon)
                    if result and result.get("success"):
                        wd_info["daily_used"] = wd_info.get("daily_used", 0) + 1
                    time.sleep(2)
        else:
            print(f"\n  [{self.nickname}] 提现已关闭")
        time.sleep(1)


        # 5. 检查初始状态
        status = self.get_status()
        if not status:
            print(f"[失败] {self.nickname} 无法获取状态")
            return

        before_energy = status.get("energy", {}).get("available_energy", 0)
        before_today = status.get("today_energy", 0)
        before_unclaimed = status.get("energy", {}).get("unclaimed_energy", 0)
        print(f"  [{self.nickname}] 初始: 可用 {before_energy} 元气, 待领取 {before_unclaimed}, 今日累计 {before_today}")

        # 3. 蓄能循环
        # 用待领取(unclaimed_energy)判断是否有新增，因为 today_energy 在领取前始终为 0
        print(f"\n  [{self.nickname}] 开始蓄能...")
        after_unclaimed = before_unclaimed
        MAX_SESSIONS = 15
        
        for i in range(MAX_SESSIONS):
            ok, msg = self.charge_once(invite_code)
            if not ok:
                print(f"  [蓄能] 第 {i+1} 轮失败, 停止")
                break
            
            time.sleep(3)
            status = self.get_status()
            if not status:
                break
                
            now_unclaimed = status.get("energy", {}).get("unclaimed_energy", after_unclaimed)
            is_charging = status.get("is_charging", False)
            
            # 每轮蓄能后自动领取
            if status.get("energy", {}).get("unclaimed_energy", 0) > 0:
                self.claim_energy()
            
            if now_unclaimed <= after_unclaimed and not is_charging:
                print(f"  [蓄能] 本轮无新增, 可能已达标或已达上限")
                break
            
            after_unclaimed = now_unclaimed
            if i < MAX_SESSIONS - 1:
                time.sleep(random.uniform(5, 10))
        
        print(f"\n  [{self.nickname}] 蓄能结束: 待领取 {before_unclaimed} -> {after_unclaimed}")

        # 7. 最终领取 + 状态
        self.claim_energy()
        final_status = self.get_status()
        if final_status:
            avail = final_status.get("energy", {}).get("available_energy", 0)
            unclaimed = final_status.get("energy", {}).get("unclaimed_energy", 0)
            print(f"  [{self.nickname}] 最终可用: {avail} 元气, 待领取: {unclaimed}, 今日累计: {final_status.get('today_energy', 0)} 元气")

        print(f"  [{'=' * 40}]")
        print(f"   {self.nickname} 任务完成")
        print(f"  {'=' * 40}")


if __name__ == "__main__":
    # 解析所有 OpenID
    openids = parse_openids(LYM_OPENIDS_RAW)
    
    if not openids:
        print("未配置乐云萌账号 (LY_M_OPENIDS)", file=sys.stderr)
        print("请在呆呆面板添加环境变量 LY_M_OPENIDS，格式: openid1&openid2&openid3", file=sys.stderr)
        sys.exit(1)
    
    print("=" * 60)
    print("   乐云萌 - 全自动蓄能脚本")
    print(f"   共 {len(openids)} 个账号")
    print("=" * 60)
    
    # 检查 WCS 配置
    if not WX_API_KEY:
        print("[错误] 未配置 WCS 认证 key (BRIDGE_AUTH_KEY / wx_auth)", file=sys.stderr)
        sys.exit(1)
    
    print(f"[配置] WCS 地址: {WX_SERVER_URL}")
    print(f"[配置] 账号数: {len(openids)}")
    print()
    
    for openid in openids:
        auto = LYMAutomation(openid)
        auto.run(DEFAULT_INVITE_CODE)
        print()
    
    print("=" * 60)
    print("   全部账号执行完成！")
    print("=" * 60)

# ========== PushPlus 推送 ==========
try:
    import urllib.request as _ur, json as _js
    _tok = os.getenv("PLUSPLUS_TOKEN","") or os.getenv("PUSHPLUS_TOKEN","")
    if _tok:
        _b = _js.dumps({"token":_tok,"title":"乐云萌","content":"乐云萌执行完成","template":"txt"}).encode()
        _r = _ur.Request("http://www.pushplus.plus/send",data=_b,method="POST")
        _r.add_header("Content-Type","application/json")
        _rs = _js.loads(_ur.urlopen(_r,timeout=15).read())
        if _rs.get("code")==200: print("PushPlus 推送成功")
        else: print("PushPlus 推送失败:", _rs.get("msg",""))
except Exception as _e: print("推送异常:",_e)
# ========== PushPlus 推送结束 ==========
