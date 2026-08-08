"""
八富生活 看广告赚金币（WCS 登录版）
Cron: 35 6 * * *
环境变量: wx_opinion (多账号用&分隔)
  例: owNAX6j83m4TzrbIA5R3iNXM1iY0&owNAX6ue8pWjcCwrfF-A3M9pgMNw
"""

import os
import sys
import re
import json
import time
import random
import base64
from datetime import datetime

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_ORIG_REQUEST = requests.Session.request


def _patched_request(self, *args, **kwargs):
    kwargs.setdefault("verify", False)
    return _ORIG_REQUEST(self, *args, **kwargs)


requests.Session.request = _patched_request


def _mount_retry(session, retries=2):
    retry = urllib3.util.retry.Retry(
        total=retries, backoff_factor=0.5,
        status_forcelist=[502, 503, 504],
        allowed_methods=frozenset(["GET", "POST"]),
    )
    adapter = requests.adapters.HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)


# ---------- 配置 ----------
APPID = "wxb9be8e4f98c3fbe5"
PORTAL = "https://bafunet.com/portal-server"
# 广告位：新版接口直接使用十进制 adpid（旧版从 wx reward adunit 子串算出的 2920100423 已失效）
ADPID = "2919867719"
TENANT_ID = "1992418264477876226"
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30(0x18001e22) "
      "NetType/WIFI Language/zh_CN")

AD_WATCH_SECONDS = 30
AD_GAP_MIN = 5
AD_GAP_EXTRA = 3
AD_CHECK_GAP = 2

# WCS 配置
wx_server_url = os.getenv("wx_server_url", "http://smallcat-client:8787")
wx_auth = os.getenv("wx_auth", "1509ea7aca117dcbb7e635c0c007d528")

# 推送
PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")

INVITER_CODE = os.getenv("BFSH_INVITER_CODE", "U75803F7")
FORCE_REBIND = os.getenv("BFSH_FORCE_REBIND", "1") != "0"
DRY_RUN = os.getenv("DRY_RUN", "") == "1"

# 八富生活会话 cookie（JSESSIONID）：由 SunnyNet 抓「手机真登录」后获得。
# 多个账号用 & 分隔，顺序与 wx_opinion 对齐；有则直接复用会话、跳过 WCS；
# 缺省或会话失效则回落 WCS 登录。免 AppSecret、免假 wxCode。
BFSH_JSESSIONID = os.getenv("BFSH_JSESSIONID", "")
_bfsh_sids = [c.strip() for c in BFSH_JSESSIONID.split("&") if c.strip()]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, "bfsh_wcs_token.json")


def log(msg=""):
    print(msg, flush=True)


def mask_str(s, n=4):
    s = str(s or "")
    return s[:n] + "****" + s[-n:] if len(s) > n * 2 else s[:n] + "****"


# =====================================================================
# Feistel 签名
# =====================================================================
MASK32 = (1 << 32) - 1
MASK64 = (1 << 64) - 1
DELTA = 0x9E3779B97F4A7C15


def _rotl32(x, r):
    return ((x << r) | (x >> (32 - r))) & MASK32


def _rotl64(x, r):
    return ((x << r) | (x >> (64 - r))) & MASK64


def _feistel_round(v, k):
    u = (v ^ (k & MASK32)) & MASK32
    u = _rotl32(u, 7)
    u = (0x9E3779B9 * u) & MASK32
    u = (u ^ (u >> 13)) & MASK32
    u = _rotl32(u, 3)
    return u & MASK32


def feistel_encrypt(ad_id, user_id) -> str:
    ad_id = int(ad_id) & MASK64
    user_id = int(user_id) & MASK64
    keys = [user_id]
    cur = user_id
    for g in range(1, 12):
        cur = (_rotl64(cur, 13) ^ (DELTA * g)) & MASK64
        keys.append(cur)
    f = (ad_id >> 32) & MASK32
    a = ad_id & MASK32
    for g in range(12):
        v = (f ^ _feistel_round(a, keys[g])) & MASK32
        f = a
        a = v
    result = ((a << 32) | f) & MASK64
    if result >= (1 << 63):
        result -= (1 << 64)
    return str(result)


# =====================================================================
# 广告人机验证（captchaToken）
# 中文 → 验证码图片文件名映射（图片文件名为英文）
# =====================================================================
CN2EN = {
    "苹果": "apple", "星星": "star", "花": "flower", "帽子": "hat", "狗": "dog",
    "自行车": "bicycle", "出租车": "taxi", "树": "tree", "猫": "cat", "鸟": "bird",
    "鱼": "fish", "蝴蝶": "butterfly", "香蕉": "banana", "西瓜": "watermelon",
    "汽车": "car", "房子": "house", "伞": "umbrella", "飞机": "airplane",
    "轮船": "ship", "船": "ship", "月亮": "moon", "太阳": "sun", "云": "cloud",
    "山": "mountain", "足球": "football", "红绿灯": "traffic_light", "火车": "train",
    "公交车": "bus", "摩托车": "motorcycle", "鹿": "deer", "兔子": "rabbit",
    "猴子": "monkey", "熊猫": "panda", "老虎": "tiger", "狮子": "lion",
    "大象": "elephant", "骆驼": "camel", "马": "horse", "牛": "cow", "羊": "sheep",
    "猪": "pig", "鸡": "chicken", "鸭": "duck", "鹅": "goose", "乌龟": "turtle",
    "青蛙": "frog", "蛇": "snake", "蜘蛛": "spider", "蜜蜂": "bee", "蚂蚁": "ant",
    "蜻蜓": "dragonfly", "瓢虫": "ladybug", "蜗牛": "snail", "螃蟹": "crab",
    "龙虾": "lobster", "虾": "shrimp", "海豚": "dolphin", "鲸鱼": "whale",
    "鲨鱼": "shark", "章鱼": "octopus", "水母": "jellyfish", "海星": "starfish",
    "蛋糕": "cake", "冰淇淋": "icecream", "冰激凌": "icecream", "棒棒糖": "lollipop",
    "杯子": "cup", "水杯": "cup", "瓶子": "bottle", "闹钟": "alarm_clock",
    "手机": "phone", "电视": "tv", "电脑": "computer", "台灯": "lamp",
    "椅子": "chair", "桌子": "table", "床": "bed", "窗户": "window",
    "门": "door", "书": "book", "铅笔": "pencil", "尺子": "ruler",
    "剪刀": "scissors", "钥匙": "key", "钱包": "wallet", "背包": "backpack",
    "鞋": "shoe", "鞋子": "shoe", "袜子": "sock", "手套": "glove",
    "围巾": "scarf", "眼镜": "glasses", "雨伞": "umbrella", "气球": "balloon",
    "风筝": "kite", "篮球": "basketball", "排球": "volleyball", "乒乓球": "pingpong",
    "网球": "tennis", "棒球": "baseball", "吉他": "guitar", "钢琴": "piano",
    "小提琴": "violin", "鼓": "drum", "话筒": "microphone", "麦克风": "microphone",
    "喇叭": "speaker", "相机": "camera", "摄像机": "video_camera", "冰箱": "refrigerator",
    "洗衣机": "washing_machine", "空调": "air_conditioner", "风扇": "fan",
    "吹风机": "hair_dryer", "熨斗": "iron", "热水壶": "kettle", "锅": "pot",
    "碗": "bowl", "盘子": "plate", "筷子": "chopsticks", "勺子": "spoon",
    "刀": "knife", "叉子": "fork", "煎蛋": "fried_egg", "鸡蛋": "egg",
    "汉堡": "hamburger", "薯条": "fries", "披萨": "pizza", "热狗": "hotdog",
    "面条": "noodles", "米饭": "rice", "面包": "bread", "饼干": "cookie",
    "糖果": "candy", "巧克力": "chocolate", "牛奶": "milk", "咖啡": "coffee",
    "茶": "tea", "果汁": "juice", "可乐": "cola", "雪糕": "icecream",
    "玉米": "corn", "胡萝卜": "carrot", "蘑菇": "mushroom", "西红柿": "tomato",
    "土豆": "potato", "青椒": "pepper", "洋葱": "onion", "白菜": "cabbage",
    "葡萄": "grape", "草莓": "strawberry", "樱桃": "cherry", "桃子": "peach",
    "梨": "pear", "橘子": "orange", "柠檬": "lemon", "菠萝": "pineapple",
    "芒果": "mango", "椰子": "coconut", "猕猴桃": "kiwi", "火": "fire",
    "水": "water", "石头": "stone", "花盆": "flowerpot", "灯笼": "lantern",
    "红包": "red_envelope", "钟": "clock", "电话": "telephone", "铅笔刀": "sharpener",
    "橡皮": "eraser", "牙刷": "toothbrush", "牙膏": "toothpaste", "梳子": "comb",
    "镜子": "mirror", "剃须刀": "shaver", "刮胡刀": "shaver", "口红": "lipstick",
    "香水": "perfume", "戒指": "ring", "项链": "necklace", "手表": "watch",
    "耳环": "earrings", "纽扣": "button", "针": "needle", "线": "thread",
    "锤子": "hammer", "螺丝刀": "screwdriver", "扳手": "wrench", "斧头": "axe",
    "锯子": "saw", "梯子": "ladder", "扫帚": "broom", "拖把": "mop",
    "垃圾桶": "trash_can", "垃圾箱": "trash_bin", "灭火器": "fire_extinguisher",
    "警车": "police_car", "救护车": "ambulance", "消防车": "fire_truck",
    "卡车": "truck", "挖土机": "excavator", "推土机": "bulldozer", "拖拉机": "tractor",
    "直升机": "helicopter", "火箭": "rocket", "热气球": "hot_air_balloon",
    "帆船": "sailboat", "潜艇": "submarine", "独木舟": "canoe", "竹筏": "raft",
    "鱿鱼": "squid", "海豹": "seal", "企鹅": "penguin", "猫头鹰": "owl",
    "鹦鹉": "parrot", "鸽子": "dove", "老鹰": "eagle", "孔雀": "peacock",
    "天鹅": "swan", "长颈鹿": "giraffe", "斑马": "zebra", "犀牛": "rhino",
    "河马": "hippo", "刺猬": "hedgehog", "松鼠": "squirrel", "仓鼠": "hamster",
    "老鼠": "mouse", "蝙蝠": "bat", "恐龙": "dinosaur", "独角兽": "unicorn",
    "绵羊": "sheep", "山羊": "goat", "毛驴": "donkey", "豹子": "leopard",
    "狼": "wolf", "狐狸": "fox", "熊": "bear", "猩猩": "gorilla",
    "公鸡": "rooster", "母鸡": "hen", "小鸡": "chick", "玫瑰": "rose",
    "向日葵": "sunflower", "仙人掌": "cactus", "竹子": "bamboo", "莲花": "lotus",
    "苹果树": "apple_tree", "松树": "pine", "圣诞树": "christmas_tree", "稻草人": "scarecrow",
    "圣诞老人": "santa", "雪人": "snowman", "南瓜": "pumpkin", "鬼": "ghost",
    "骷髅": "skull", "皇冠": "crown", "奖杯": "trophy", "金牌": "gold_medal",
    "钻石": "diamond", "宝石": "gem", "珍珠": "pearl", "珊瑚": "coral",
    "贝壳": "shell", "无烟": "no_smoking", "禁止吸烟": "no_smoking",
}


def parse_captcha_question(question, images):
    """从验证码题目和图片文件名推导点击顺序的索引列表（需3个）"""
    parts = re.split(r"[：→>、,，\s]+", question)
    idxs = []
    for p in parts:
        p = p.strip()
        if p and p in CN2EN:
            target = CN2EN[p]
            for i, img in enumerate(images):
                name = img.split("/")[-1].split(".")[0].lower()
                if name in (target, target.replace("_", ""), target.replace("_", "-")):
                    idxs.append(i)
                    break
    return idxs


# =====================================================================
# WCS 接口
# =====================================================================
def get_console_auth():
    """Login WCS console and get auth token (fallback when static auth fails)"""
    try:
        r = requests.post(
            f"{wx_server_url}/api/client/login",
            json={"username": os.getenv("wx_console_user", "yr1314"),
                  "password": os.getenv("wx_console_pass", "yr123123")},
            timeout=15,
            proxies={"http": None, "https": None},
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("status"):
                return d.get("data", {}).get("auth", "")
    except Exception:
        pass
    return ""
def get_wx_code(openid):
    auth = get_console_auth() or wx_auth
    """通过 WCS /wx/code 获取微信登录 code"""
    try:
        r = requests.post(
            f"{wx_server_url}/wx/code",
            json={"appid": APPID, "openid": openid},
            headers={"auth": auth},
            timeout=60,
            proxies={"http": None, "https": None},
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("status"):
                return d.get("data", {}).get("code")
            log(f"  ⚠️ WCS 返回: {d}")
    except Exception as e:
        log(f"  ⚠️ WCS 请求异常: {e}")
    return None

def get_phone_code(openid):
    auth = get_console_auth() or wx_auth
    """通过 WCS /wx/getphonenumber 获取手机号授权 code（用于 phoneLogin）"""
    try:
        r = requests.post(
            f"{wx_server_url}/wx/getphonenumber",
            json={"appid": APPID, "openid": openid},
            headers={"auth": auth},
            timeout=60,
            proxies={"http": None, "https": None},
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("status"):
                code = d.get("data", {}).get("code")
                if code:
                    return code
    except Exception as e:
        log(f"  ⚠️ WCS /wx/getphonenumber 异常: {e}")
    return None


# =====================================================================
# 缓存
# =====================================================================
def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(data):
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# =====================================================================
# 账号类
# =====================================================================
class BfshAccount:
    def __init__(self, openid, jsessionid=""):
        self.openid = openid
        self.jsessionid_cookie = jsessionid
        self.display_name = mask_str(openid, 4)
        self.jsessionid = ""
        self.tenant_id = ""
        self.user_id = ""
        self.phone = ""
        self.nickname = ""
        self.code = None
        self.err = ""
        self.session = requests.Session()
        _mount_retry(self.session)
        self.cache = {}

    def _url(self, path):
        base = PORTAL + path
        if self.jsessionid:
            if "?" in base:
                base = base.replace("?", f";jsessionid={self.jsessionid}?", 1)
            else:
                base += f";jsessionid={self.jsessionid}"
        return base

    def _headers(self):
        h = {
            "User-Agent": UA,
            "xweb_xhr": "1",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "*/*",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Referer": f"https://servicewechat.com/{APPID}/26/page-frame.html",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        if self.tenant_id:
            h["X-Tenant-ID"] = self.tenant_id
        return h

    def _req(self, method, path, params=None, json=None):
        url = self._url(path)
        try:
            r = self.session.request(method, url, params=params, json=json,
                                      headers=self._headers(), timeout=20,
                                      proxies={"http": None, "https": None})
        except Exception as e:
            return None, {}, str(e)
        # Capture new jsessionid from response headers
        new_sid = r.headers.get("sid") or r.headers.get("Sid")
        if new_sid and new_sid != self.jsessionid:
            self.jsessionid = new_sid
            self.session.cookies.clear()
            # 保留外部注入的 JSESSIONID 会话 cookie（避免被清空导致掉登录）
            if self.jsessionid_cookie:
                self.session.cookies.set("JSESSIONID", self.jsessionid_cookie,
                                         domain="bafunet.com", path="/portal-server")
        try:
            data = r.json()
        except Exception:
            data = {"_error": f"非JSON:{r.status_code}", "_text": r.text[:200]}
        return data, r.headers, None

    def _cache_valid(self, cache):
        """检查缓存是否有效"""
        if self.openid not in cache:
            return False
        c = cache[self.openid]
        jsid = c.get("jsessionid", "")
        uid = c.get("user_id", "")
        if not jsid or not uid:
            return False
        self.jsessionid = jsid
        self.user_id = uid
        self.tenant_id = c.get("tenant_id", "")
        self.phone = c.get("phone", "")
        self.nickname = c.get("nickname", "")
        info = self._get_base_info()
        if info and info.get("id"):
            return True
        return False

    def _get_base_info(self):
        data, _, _ = self._req("GET", "/user/getBaseInfoAnon")
        if data and data.get("code") == 200 and data.get("data"):
            return data["data"]
        return None

    def login(self):
        self.cache = load_cache()
        cache = self.cache

        # 0. 外部注入的 JSESSIONID 会话（免 WCS / 免 AppSecret）
        if self.jsessionid_cookie:
            self.jsessionid = self.jsessionid_cookie
            self.session.cookies.set("JSESSIONID", self.jsessionid_cookie,
                                     domain="bafunet.com", path="/portal-server")
            info = self._get_base_info()
            if info and info.get("id"):
                self.user_id = str(info["id"])
                self.phone = info.get("phone", "")
                self.nickname = info.get("nickname", "") or info.get("phone", "")
                cfg, _, _ = self._req("GET", "/user/getMallConfigAnon",
                                      params={"code": "1001", "clientType": "mp-weixin"})
                if cfg and cfg.get("code") == 200 and cfg.get("data"):
                    self.tenant_id = cfg["data"].get("$tenantId", "") or ""
                log(f"  ✅ JSESSIONID 会话登录成功 | user_id={self.user_id} | {self.nickname}")
                cache[self.openid] = {
                    "jsessionid": self.jsessionid,
                    "tenant_id": self.tenant_id,
                    "user_id": self.user_id,
                    "phone": self.phone,
                    "nickname": self.nickname,
                }
                save_cache(cache)
                return True
            log(f"  ⚠️ JSESSIONID 会话已失效，回落 WCS 登录")

        # 1. 先尝试缓存
        if self._cache_valid(cache):
            log("  ✅ 缓存有效")
            return True
        log("  🔄 缓存失效，重新登录")

        # 2. 获取微信登录 code
        code = get_wx_code(self.openid)
        if not code:
            self.err = "无法获取微信登录 code（检查 WCS 配置）"
            log(f"  ❌ {self.err}")
            return False
        self.code = code
        log(f"  ✅ 获取到 code: {mask_str(code, 6)}")

        # 3. 加载租户信息（getOpenidAnon 接口已于 2026-08 下线返回500;
        #    实测直接 phoneLogin 即可正确登录且不会错绑账号, 故不再调用）
        cfg, _, _ = self._req("GET", "/user/getMallConfigAnon",
                               params={"code": "1001", "clientType": "mp-weixin"})
        if cfg and cfg.get("code") == 200 and cfg.get("data"):
            self.tenant_id = cfg["data"].get("$tenantId", "") or ""
        log(f"  ✅ 租户: {self.tenant_id[:10]}...")

        # 5. 手机号登录（type 字段会导致 bafunet 端 Jackson 反序列化 500，去掉）
        phone_code = get_phone_code(self.openid)
        if not phone_code:
            self.err = "无法获取手机号授权 code"
            log(f"  ❌ {self.err}")
            return False
        payload = {"wxCode": phone_code, "parentId": "", "clientType": "mp-weixin"}
        data, _, _ = self._req("POST", "/phoneLogin", json=payload)
        if data and data.get("code") == 200:
            log("  ✅ phoneLogin 成功")
            # phoneLogin 后获取新的 jsessionid（服务端返回的 sid header）
        else:
            self.err = f"phoneLogin 失败: {data}"
            log(f"  ❌ {self.err}")
            return False

        # 6. 获取用户信息
        info = self._get_base_info()
        if info and info.get("id"):
            self.user_id = str(info["id"])
            self.phone = info.get("phone", "")
            self.nickname = info.get("nickname", "") or info.get("phone", "")
            log(f"  ✅ 登录成功 | user_id={self.user_id} | {self.nickname}")
        else:
            # 尝试再查一次（phoneLogin 可能更新 session）
            info = self._get_base_info()
            if info and info.get("id"):
                self.user_id = str(info["id"])
                self.phone = info.get("phone", "")
                self.nickname = info.get("nickname", "") or info.get("phone", "")
                log(f"  ✅ 登录成功 | user_id={self.user_id} | {self.nickname}")
            else:
                self.err = "未获取到用户 id"
                log(f"  ❌ {self.err}")
                return False

        # 7. 保存缓存
        cache[self.openid] = {
            "jsessionid": self.jsessionid,
            "tenant_id": self.tenant_id,
            "user_id": self.user_id,
            "phone": self.phone,
            "nickname": self.nickname,
        }
        save_cache(cache)
        return True

    # ---------- 广告人机验证（captchaToken） ----------
    def _load_cached_ct(self):
        c = self.cache.get(self.openid, {})
        ct = c.get("captchaToken")
        if ct:
            parts = ct.split("|")
            if len(parts) >= 2 and parts[1] == datetime.now().strftime("%Y%m%d"):
                return ct
        return None

    def _fetch_captcha_token(self):
        """自动过广告人机验证，返回 captchaToken（当天有效）；失败返回 None。
        校验用 code 走 WCS /wx/code（与 YYB GO 等价，对八富 appid 已验证可用）。"""
        for attempt in range(3):
            data, _, err = self._req("GET", "/ad/captcha/issue")
            if err or data.get("_error"):
                log(f"  ⚠️ issue 请求异常: {err or data.get('_error')}")
                return None
            if data.get("code") != 200:
                log(f"  ⚠️ issue 失败: {data.get('msg')}")
                return None
            d = data.get("data") or {}
            token = d.get("token")
            question = d.get("question", "")
            images = d.get("images") or []
            idxs = parse_captcha_question(question, images)
            log(f"  🔍 验证码: {question} | 点击索引={idxs}")
            if len(idxs) != 3:
                log("  ⚠️ 无法解析出3个点击索引，重试")
                time.sleep(1)
                continue
            code = get_wx_code(self.openid)
            if not code:
                log(f"  ⚠️ 获取微信 code 失败（WCS）")
                return None
            t0 = time.time() * 1000
            time.sleep(1.5)
            params = {
                "token": token,
                "clicks": ",".join(str(i) for i in idxs),
                "duration": str(int(time.time() * 1000 - t0)),
                "code": code,
            }
            data2, _, err2 = self._req("POST", "/ad/captcha/verify", params=params, json={})
            if err2 or data2.get("_error"):
                log(f"  ⚠️ verify 请求异常: {err2 or data2.get('_error')}")
                return None
            if data2.get("code") == 200:
                ct = (data2.get("data") or {}).get("captchaToken")
                if ct:
                    self.cache.setdefault(self.openid, {})["captchaToken"] = ct
                    save_cache(self.cache)
                    log(f"  ✅ 验证码通过")
                    return ct
            log(f"  ⚠️ verify 失败: {data2.get('msg')}")
            time.sleep(1)
        return None

    def _use_captcha_token(self):
        ct = self._load_cached_ct()
        if ct:
            log(f"  🎫 使用缓存 captchaToken")
            return ct
        return self._fetch_captcha_token()

    def check_limit(self, adpid):
        ct = self._use_captcha_token()
        if not ct:
            return None
        data, _, err = self._req("GET", "/ad/checkLimit",
                                 params={"adpid": adpid, "captchaToken": ct})
        if err or data.get("_error"):
            return None
        if data.get("code") != 200:
            log(f"  ⚠️ checkLimit 返回: {data.get('msg', data.get('code'))}")
            return None
        d = data.get("data") or {}
        return {
            "count": int(d.get("count", 0) or 0),
            "limited": bool(d.get("limited", False)),
            "totalAds": int(d.get("totalAds", 10) or 10),
            "adProfit": d.get("adProfit", 0),
            "needLogin": bool(d.get("needLogin", False)),
            "needCaptcha": bool(d.get("needCaptcha", False)),
            "id": d.get("id"),
            "msg": data.get("msg") or data.get("message") or "",
        }

    def complete(self, ad_id):
        if not self.user_id:
            return False, "缺少 user_id"
        ct = self._use_captcha_token()
        if not ct:
            return False, "无captchaToken"
        token = feistel_encrypt(ad_id, self.user_id)
        params = {
            "token": token,
            "adpid": ADPID,
            "captchaToken": ct,
        }
        data, _, err = self._req("POST", "/ad/complete", params=params, json={})
        if err or data.get("_error"):
            return False, f"req_err:{err}"
        if data.get("code") == 200:
            d = data.get("data", {})
            log(f"  📺 complete 成功 | count={d.get('count')} adProfit={d.get('adProfit')} limited={d.get('limited')}")
            return True, ""
        msg = data.get("msg") or f"code={data.get('code')}"
        if "验证" in msg or "人机" in msg:
            log(f"  🔄 captchaToken 失效，重新获取")
            ct_new = self._fetch_captcha_token()
            if ct_new:
                params["captchaToken"] = ct_new
                data, _, err = self._req("POST", "/ad/complete", params=params, json={})
                if data and data.get("code") == 200:
                    return True, ""
                msg = data.get("msg") or f"code={data.get('code')}" if data else "重试失败"
        log(f"  ⚠️ complete 失败: {msg}")
        return False, msg

    def _get_inviter(self):
        data, _, _ = self._req("GET", "/user/getInviter")
        if not data or data.get("_error"):
            return "error", ""
        code = data.get("code")
        if code == 200 and data.get("data"):
            return "bound", data["data"]
        if code in (401, "401"):
            return "unauth", None
        return "unbound", None

    def _set_inviter(self, code=INVITER_CODE):
        data, _, _ = self._req("POST", "/user/setInviter", params={"code": code})
        if not data or data.get("_error"):
            return False, ""
        if data.get("code") == 200:
            return True, data.get("msg") or "ok"
        return False, data.get("msg") or str(data.get("code"))

    def ensure_inviter(self):
        kind, payload = self._get_inviter()
        if kind == "unauth":
            self.login()
            kind, payload = self._get_inviter()
        if kind == "error":
            log(f"  ⚠️ 查询邀请人失败: {payload}")
            return "查询失败"
        already = payload if kind == "bound" else None
        if already and not FORCE_REBIND:
            name = already.get("nickname") or already.get("phone") or "?"
            log(f"  🤝 已绑定: {name}")
            return f"已绑定:{name}"
        if DRY_RUN:
            return "待绑定(查)"
        ok, msg = self._set_inviter()
        if ok:
            k2, d2 = self._get_inviter()
            if k2 == "bound":
                nm = d2.get("nickname") or d2.get("phone") or "?"
                log(f"  ✅ 已绑定邀请人: {nm}")
                return f"已绑定:{nm}"
            return "绑定存疑"
        if "hasCycleInvite" in str(msg):
            log(f"  ℹ️ 本账号即邀请码持有者（{INVITER_CODE}），无需绑定")
            return "本人邀请码"
        if "errorReq" in str(msg):
            return "不可改绑"
        log(f"  ⚠️ 绑定邀请人失败: {msg}")
        return f"绑定失败:{msg}"

    def run(self):
        result = {"name": self.display_name, "watched": 0}
        if not self.login():
            log(f"  ❌ 登录失败: {self.err or '登录失败'}")
            result["errors"] = [self.err or "登录失败"]
            return result

        result["inviter"] = self.ensure_inviter()

        adpid = ADPID
        log(f"  🔑 会话就绪 | user_id={self.user_id} | adpid={adpid}"
            + (f" | {self.nickname}" if self.nickname else ""))

        watched = 0
        while True:
            info = self.check_limit(adpid)
            if info is None:
                result.setdefault("errors", []).append("查询广告上限失败")
                break

            if "首次验证" in (info.get("msg") or ""):
                log(f"  ⚠️ 需完成首次验证（{info.get('msg')}）")
                log("  💡 请在微信小程序「八富生活」内手动看一次广告解除限制")
                result["skipped"] = "需完成首次验证(小程序内手动看广告)"
                break

            count = info["count"]
            total = info["totalAds"]
            log(f"  📺 广告状态: 已看 {count}/{total} | 单条收益={info['adProfit']} "
                f"| needLogin={info['needLogin']} needCaptcha={info['needCaptcha']}")

            if info.get("needCaptcha"):
                log("  🔄 needCaptcha=true，重新获取 captchaToken")
                if not self._fetch_captcha_token():
                    result.setdefault("errors", []).append("重新获取 captchaToken 失败")
                    break
                continue

            if info["limited"] or count >= total:
                log("  ✅ 今日广告已达上限，结束")
                break

            if DRY_RUN:
                remaining = max(0, total - count)
                log(f"  🔍 DRY_RUN: 将观看 {remaining} 个广告（不实际等待/完成）")
                result["watched"] = remaining
                result["dry_run"] = True
                break

            if info["needLogin"]:
                fresh = get_wx_code(self.openid)
                if fresh:
                    self.code = fresh
                    log("  🔑 取得新鲜 wx.login code 用于完成")
                else:
                    result.setdefault("errors", []).append("needLogin 且无法获取 code")
                    break

            ad_task_id = info["id"]
            log(f"  📺 开始观看广告 (adId={ad_task_id})...")

            watch_time = AD_WATCH_SECONDS + random.uniform(1, 5)
            log(f"  ⏳ 等待 {watch_time:.0f} 秒（模拟广告播放）...")
            time.sleep(watch_time)

            ok, msg = self.complete(ad_task_id)
            if ok:
                watched += 1
                log(f"  ✅ 完成第 {watched} 个广告: {msg}")
            elif "时间不足" in str(msg) or "不足" in str(msg):
                log(f"  ⚠️ 服务端返回: {msg}")
                result.setdefault("errors", []).append(f"时间不足:{msg}")
                time.sleep(random.uniform(AD_GAP_MIN, AD_GAP_MIN + AD_GAP_EXTRA))
                continue
            else:
                log(f"  ⚠️ 完成失败: {msg}")
                result.setdefault("errors", []).append(f"广告完成失败:{msg}")
                time.sleep(random.uniform(AD_GAP_MIN, AD_GAP_MIN + AD_GAP_EXTRA))
                continue

            gap = random.uniform(AD_GAP_MIN, AD_GAP_MIN + AD_GAP_EXTRA)
            time.sleep(gap)

        result["watched"] = watched
        return result


def _get_adpid():
    return ADPID


# =====================================================================
# 推送
# =====================================================================
def push_summary(results):
    if not PLUSPLUS_TOKEN:
        log("  ℹ️ 未配置 PLUSPLUS_TOKEN，跳过推送")
        return
    lines = ["📣 八富生活 看广告赚金币 汇总"]
    lines.append("─" * 28)
    for r in results:
        name = r.get("name", "?")
        line = f"🍺 {name}"
        if r.get("skipped"):
            line += f"  ⏭️ {r['skipped']}"
        elif r.get("errors"):
            line += "  ⚠️ " + "; ".join(r["errors"])
        else:
            line += f"  观看{r.get('watched', 0)}个广告✓"
        inviter = r.get("inviter")
        if inviter:
            line += f" | 邀请人:{inviter}"
        lines.append(line)
        lines.append("─" * 28)
    text = "\n".join(lines)
    log(text)
    try:
        resp = requests.post(
            "https://www.pushplus.plus/send",
            json={"token": PLUSPLUS_TOKEN, "title": "八富生活", "content": text, "template": "txt"},
            timeout=10,
            proxies={"http": None, "https": None},
        )
        if resp.json().get("code") == 200:
            log("  ✅ 推送成功")
        else:
            log(f"  ⚠️ 推送失败: {resp.text[:120]}")
    except Exception as e:
        log(f"  ⚠️ 推送异常: {e}")


# =====================================================================
# 入口
# =====================================================================
def main():
    log("🚀 开始八富生活 看广告赚金币 自动任务 (WCS版)")
    adpid = _get_adpid()
    log(f"🎯 广告位 adpid={adpid}")

    # 从 wx_opinion 解析多账号
    wx_opinion = os.getenv("wx_opinion", "").strip()
    if not wx_opinion:
        log("❌ 未配置 wx_opinion 环境变量")
        return

    openids = [x.strip() for x in wx_opinion.split("&") if x.strip()]
    log(f"📋 共 {len(openids)} 个账号")

    results = []
    for idx, openid in enumerate(openids, 1):
        log(f"\n========== 账号 [{idx}] {mask_str(openid, 4)} ==========")
        a = BfshAccount(openid, jsessionid=_bfsh_sids[idx - 1] if (idx - 1) < len(_bfsh_sids) else "")
        try:
            r = a.run()
        except Exception as e:
            r = {"name": a.display_name, "errors": [f"异常: {e}"]}
            log(f"  ❌ 异常: {e}")
        results.append(r)

    push_summary(results)
    log("\n🏁 全部账号处理完成")


if __name__ == "__main__":
    main()
