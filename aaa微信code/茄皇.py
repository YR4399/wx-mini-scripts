# cron: 25 10 * * *


# ==================== 推送 ====================
from std_report import report
# new Env('统一快乐星球茄皇（五期）')
#
# code 版环境变量：
#   wx_opinion：WCS 账号标识，多账号用 & 分隔
#   wx_server_url：WCS 服务地址，默认 https://wc.smallfawn.top
#   wx_auth：WCS 鉴权
#
# wid 和目标小程序 openId 会通过 loginX 自动获取，并缓存到 qiehuang_ck_cache.json。
# 缓存命中时直接复用 wid/openId 登录番茄服务（无需再调 WCS），仅在缓存失效时回源刷新。

import base64
import json
import math
import os
import random
import time

import sys
import requests
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from notify import send

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    CRYPTO_BACKEND = "cryptography"
except ImportError:
    try:
        from Crypto.Cipher import AES, PKCS1_OAEP
        from Crypto.Hash import SHA256
        from Crypto.PublicKey import RSA

        CRYPTO_BACKEND = "pycryptodome"
    except ImportError:
        CRYPTO_BACKEND = None


BASE_URL = "https://farmgames.ioutu.cn"
APP_ID = "wx532ecb3bdaaf92f9"
WCS_URL = os.getenv("wx_server_url", "https://wc.smallfawn.top").rstrip("/")
WCS_AUTH = os.getenv("wx_auth", "").strip()
WEIMOB_LOGIN_URL = "https://xapi.weimob.com/fe/mapi/user/loginX"
WEIMOB_CID = "176205957"
WEIMOB_BOS_ID = "4020112618957"
WEIMOB_VID = "6013753979957"

# ---- CK 缓存配置 ----
APP_NAME = "统一快乐星球茄皇（五期）"
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qiehuang_ck_cache.json")
# 缓存有效期（秒）：wid/openId 对同一微信用户长期稳定，默认 30 天；到期或登录失效则回源刷新
CACHE_TTL = int(os.getenv("qiehuang_cache_ttl", str(30 * 24 * 3600)))

PUBLIC_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA70sK419vy3MabW3lEGlk"
    "7Zh1u78OdnVlioVazp5Y46eBh+/TDqo/wZ9VrQ/4MmAtoP0vJ2vmwP5gqO3WPoj"
    "b07WddXfF1eU+5M+Rj3s0eSRrvZvBcGZ3qK0dOgZJScK66IDQazt/c4xqhDcsI"
    "tIyNRahUqB/IKc6E80GZJvMvFtZVSCseAXC0mAJXhi1AdUOlP+3Pv0fiUVejTJp"
    "1j7LBNWJ7Z5/8mRcclQH0vmxsdYsaV3qZiJ2d/CfNoKcwmI2IWmeZy8NP5U8Hn"
    "0AsxPEwjdHoEqG/iy/SoA46TZL+RLtWqUSHXpaKR/VFN0rbl25SE91X8FTfLqyD"
    "8LfGMCwRQIDAQAB"
)
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.75(0x18004b42) NetType/WIFI Language/zh_CN "
    "miniProgram/wx532ecb3bdaaf92f9"
)
SUPPORTED_TASK_TYPES = {"SIGN", "BROWSE", "SHARE"}
FRIEND_TASK_TYPE = "FRIEND_STEAL_ENERGY"
FRIEND_STATUS_CLAIMABLE = "0"

# ---- 装饰元素 ----
LINE = "━━━━━━━━━━━━━━━━━━━━"
ICON = {
    "app": "🍅",
    "account": "👤",
    "login": "🔑",
    "ok": "✅",
    "status": "📊",
    "gift": "🎁",
    "done": "✔️",
    "skip": "⏭️",
    "warn": "⚠️",
    "friend": "🤝",
    "energy": "⚡",
    "grow": "🌱",
    "final": "🏁",
    "summary": "📈",
    "cache": "💾",
    "refresh": "🔄",
    "fail": "❌",
    "phone": "📱",
}


# ============================================================
#           小程序指纹 / UA 生成（移植自 Node 版 JS 脚本）
# ============================================================
DEVICE_POOL = [
    {"brand": "Xiaomi", "model": "2201123C", "market": "MI 12", "android": "13", "build": "TKQ1.220829.002"},
    {"brand": "Xiaomi", "model": "2304FPN6DC", "market": "MI 13", "android": "14", "build": "UKQ1.230804.001"},
    {"brand": "Xiaomi", "model": "23116PN5BC", "market": "MI 14", "android": "15", "build": "AQ3A.240912.001"},
    {"brand": "Redmi", "model": "23113RKC6C", "market": "Redmi K70", "android": "14", "build": "UKQ1.230917.001"},
    {"brand": "Redmi", "model": "22101316C", "market": "Redmi Note 12", "android": "13", "build": "TKQ1.221114.001"},
    {"brand": "HUAWEI", "model": "ALN-AL00", "market": "Mate 60", "android": "12", "build": "HUAWEIALN-AL00"},
    {"brand": "HUAWEI", "model": "BRA-AL00", "market": "P60", "android": "12", "build": "HUAWEIBRA-AL00"},
    {"brand": "OPPO", "model": "PGFM10", "market": "Find X6", "android": "14", "build": "UKQ1.230924.001"},
    {"brand": "vivo", "model": "V2309A", "market": "X100", "android": "14", "build": "UP1A.231005.007"},
    {"brand": "vivo", "model": "V2324A", "market": "X100 Pro", "android": "15", "build": "AP3A.240905.015"},
    {"brand": "samsung", "model": "SM-S9180", "market": "Galaxy S23 Ultra", "android": "14", "build": "UP1A.231005.007"},
    {"brand": "OnePlus", "model": "PJE110", "market": "OnePlus 12", "android": "14", "build": "UKQ1.230924.001"},
    {"brand": "HONOR", "model": "REA-AN00", "market": "Magic6", "android": "14", "build": "HONORREA-AN00"},
    {"brand": "realme", "model": "RMX3888", "market": "GT5 Pro", "android": "14", "build": "UKQ1.230924.001"},
]
WECHAT_VERSIONS = [
    {"ver": "8.0.49.2600", "hex": "2800313A", "sdk": "20240102"},
    {"ver": "8.0.50.2701", "hex": "2800321D", "sdk": "20240206"},
    {"ver": "8.0.51.2720", "hex": "28003310", "sdk": "20240305"},
    {"ver": "8.0.52.2740", "hex": "28003414", "sdk": "20240402"},
    {"ver": "8.0.53.2760", "hex": "28003518", "sdk": "20240507"},
    {"ver": "8.0.54.2780", "hex": "2800361C", "sdk": "20240604"},
]
CHROME_VERSIONS = ["108.0.5359.156", "114.0.5735.196", "119.0.6045.193",
                   "120.0.6099.210", "121.0.6167.178", "122.0.6261.119"]


def _random_hex(n):
    return os.urandom(n).hex()


def build_mini_program_fingerprint():
    """生成贴近微信小程序 XWeb / Android webview 环境的 UA 与设备指纹。

    同一次运行内对同一账号保持稳定（会话级），每次进程启动随机选一台设备。
    """
    device = random.choice(DEVICE_POOL)
    wechat = random.choice(WECHAT_VERSIONS)
    chrome = random.choice(CHROME_VERSIONS)
    mmwebid = str(random.randint(1800, 9999))
    xweb = str(random.randint(11700, 12950))
    net_type = random.choice(["WIFI", "WIFI", "WIFI", "5G", "4G"])
    language = random.choice(["zh_CN", "zh_CN", "zh_CN", "zh_TW"])
    wmpf = "WMPF/" + random.choice(["1.0.0", "1.1.0", "1.2.0", "1.3.0"])
    platform = "android"
    user_agent = (
        "Mozilla/5.0 (Linux; Android {android}; {market} Build/{build}; wv) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/{chrome} "
        "Mobile Safari/537.36 XWEB/{xweb} MMWEBSDK/{sdk} MMWEBID/{mmwebid} "
        "MicroMessenger/{ver}({hex}) WeChat/arm64 Weixin NetType/{net} "
        "Language/{lang} ABI/arm64 MiniProgramEnv/{platform} {wmpf}"
    ).format(
        android=device["android"], market=device["market"], build=device["build"],
        chrome=chrome, xweb=xweb, sdk=wechat["sdk"], mmwebid=mmwebid,
        ver=wechat["ver"], hex=wechat["hex"], net=net_type, lang=language,
        platform=platform, wmpf=wmpf,
    )
    return {
        "user_agent": user_agent,
        "brand": device["brand"],
        "model": device["market"],
        "android": device["android"],
        "wechat": wechat["ver"],
        "client_id": "{}-{}-{}-{}-{}".format(
            _random_hex(8), _random_hex(4), _random_hex(4), _random_hex(4), _random_hex(12)
        ),
        "session_id": _random_hex(16),
    }


# ============================================================
#              高斯抖动延迟（移植自 Node 版，更像真人节奏）
# ============================================================
HUMAN_DELAY_PROFILE = {
    "query": (450, 1400),
    "action": (900, 2600),
    "heavy": (1200, 3200),
    "browse": (2500, 6500),
    "think": (800, 2200),
    "account": (3500, 9000),
    "default": (600, 1800),
}


def gauss_delay(mean, std=None, minv=None, maxv=None):
    """高斯（正态）抖动延迟：均值 mean，标准差默认 mean*0.25，截断到 [minv, maxv]。"""
    if std is None:
        std = mean * 0.25
    if minv is None:
        minv = mean * 0.45
    if maxv is None:
        maxv = mean * 2.2
    # Box-Muller 变换
    u = 0.0
    while u == 0.0:
        u = random.random()
    v = 0.0
    while v == 0.0:
        v = random.random()
    z = math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)
    val = mean + z * std
    val = max(minv, min(maxv, val))
    return int(round(val))


def human_delay(kind="default"):
    """按档位做人工延迟（毫秒级高斯抖动），返回实际睡眠毫秒数。

    kind: query | action | heavy | browse | think | account | default
    """
    minv, maxv = HUMAN_DELAY_PROFILE.get(kind, HUMAN_DELAY_PROFILE["default"])
    mean = (minv + maxv) / 2
    ms = gauss_delay(mean, (maxv - minv) / 4, minv, maxv)
    time.sleep(ms / 1000.0)
    if os.getenv("QH_DEBUG_DELAY") == "1":
        print(f"  ⏱ 延迟({kind}) ~{ms}ms")
    return ms


def split_accounts(raw):
    return [item.strip() for item in str(raw or "").replace("&", "\n").splitlines() if item.strip()]


def parse_users():
    return split_accounts(os.getenv("wx_opinion", ""))


def nested_value(data, paths):
    for path in paths:
        value = data
        for key in path:
            if not isinstance(value, dict) or key not in value:
                value = None
                break
            value = value[key]
        if value not in (None, ""):
            return value
    return None


# ============================================================
#                      CK 缓存读写
# ============================================================
def load_cache():
    """读取 wid/openId 缓存；损坏时返回空字典，不影响主流程。"""
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as fp:
            data = json.load(fp)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:
        print(f"{ICON['warn']} 读取缓存失败（忽略）：{exc}")
        return {}


def save_cache(cache):
    """原子写入缓存，避免并发/中断产生半截文件。"""
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            json.dump(cache, fp, ensure_ascii=False, indent=2)
        os.replace(tmp, CACHE_FILE)
    except Exception as exc:
        print(f"{ICON['warn']} 写入缓存失败（忽略）：{exc}")


def get_cached_identity(cache, wcs_open_id):
    """命中且未过期则返回 (wid, open_id)，否则 None。"""
    entry = cache.get(wcs_open_id)
    if not isinstance(entry, dict):
        return None
    wid = entry.get("wid")
    open_id = entry.get("open_id")
    ts = entry.get("ts", 0)
    if not wid or not open_id:
        return None
    if CACHE_TTL > 0 and (time.time() - float(ts)) > CACHE_TTL:
        return None
    return str(wid), str(open_id)


def put_cached_identity(cache, wcs_open_id, wid, open_id):
    cache[wcs_open_id] = {
        "wid": str(wid),
        "open_id": str(open_id),
        "ts": int(time.time()),
    }


def drop_cached_identity(cache, wcs_open_id):
    cache.pop(wcs_open_id, None)


def get_wx_code(wcs_open_id):
    headers = {"Content-Type": "application/json"}
    if WCS_AUTH:
        headers.update({"auth": WCS_AUTH, "X-License-Key": WCS_AUTH})
    response = requests.post(
        f"{WCS_URL}/wx/code",
        json={"appid": APP_ID, "openid": wcs_open_id},
        headers=headers,
        timeout=20,
    )
    response.raise_for_status()
    result = response.json()
    code = nested_value(
        result,
        [
            ("data", "data", "code"),
            ("data", "data", "loginCode"),
            ("data", "data", "wxcode"),
            ("data", "code"),
            ("data", "loginCode"),
            ("data", "wxcode"),
            ("result", "data", "code"),
            ("result", "data", "wxcode"),
            ("result", "code"),
            ("code",),
            ("loginCode",),
            ("wxcode",),
        ],
    )
    if not isinstance(code, str) or len(code.strip()) < 10:
        raise RuntimeError(f"WCS 未返回有效 code：{str(result)[:180]}")
    return code.strip()


def login_weimob_by_code(code):
    payload = {
        "basicInfo": {
            "cid": WEIMOB_CID,
            "vid": WEIMOB_VID,
            "tcode": "weimob",
            "bosId": WEIMOB_BOS_ID,
        },
        "extendInfo": {"source": 1},
        "parentVid": 0,
        "is_pre_fetch_open": True,
        "env": "production",
        "storeId": "0",
        "appid": APP_ID,
        "pid": WEIMOB_BOS_ID,
        "code": code,
        "queryAuthConfig": True,
        "relevanceAuthRequest": None,
    }
    response = requests.post(
        WEIMOB_LOGIN_URL,
        json=payload,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": f"https://servicewechat.com/{APP_ID}/288/page-frame.html",
            "Content-Type": "application/json",
            "x-biz-id": "1",
            "cloud-pid": WEIMOB_BOS_ID,
            "weimob-cid": WEIMOB_CID,
            "weimob-bosid": WEIMOB_BOS_ID,
            "x-req-from": "cms",
            "cloud-project-name": "tongyixiangmu",
            "weimob-pid": WEIMOB_BOS_ID,
        },
        timeout=20,
    )
    response.raise_for_status()
    result = response.json()
    data = result.get("data") or {}
    errcode = result.get("errcode")
    wid = data.get("wid")
    open_id = data.get("openId") or data.get("openid")
    if str(errcode) != "0" or not wid or not open_id:
        message = result.get("errmsg") or "未返回 wid/openId"
        raise RuntimeError(f"code 登录失败：{message}；{str(result)[:180]}")
    return str(wid), str(open_id)


def resolve_identity(wcs_open_id):
    """回源：WCS 换 code → 微盟 loginX 换取 (wid, openId)。code 一次性，重试须换新 code。"""
    last_error = None
    for attempt in range(1, 4):
        try:
            return login_weimob_by_code(get_wx_code(wcs_open_id))
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(2)
    raise RuntimeError(f"WCS/code 登录失败（已重试 3 次）：{last_error}")


def encrypt_payload(payload):
    """Match the H5 client: RSA-OAEP-SHA256 + AES-256-GCM."""
    if CRYPTO_BACKEND is None:
        raise RuntimeError(
            "缺少加密依赖，请安装 cryptography（pip install cryptography）"
        )

    plaintext = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    aes_key = os.urandom(32)
    iv = os.urandom(12)
    public_key_der = base64.b64decode(PUBLIC_KEY)

    if CRYPTO_BACKEND == "cryptography":
        public_key = serialization.load_der_public_key(public_key_der)
        encrypted_data = AESGCM(aes_key).encrypt(iv, plaintext, None)
        encrypted_key = public_key.encrypt(
            aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
    else:
        cipher = AES.new(aes_key, AES.MODE_GCM, nonce=iv)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        encrypted_data = ciphertext + tag
        public_key = RSA.import_key(public_key_der)
        encrypted_key = PKCS1_OAEP.new(public_key, hashAlgo=SHA256).encrypt(aes_key)

    return {
        "data": base64.b64encode(encrypted_data).decode(),
        "key": base64.b64encode(encrypted_key).decode(),
        "iv": base64.b64encode(iv).decode(),
    }


class TomatoClient:
    def __init__(self, wid, open_id):
        self.wid = wid
        self.open_id = open_id
        self.tomato_user_id = None
        # 每个账号构造时随机生成一台设备指纹（会话级稳定），用于伪造更真实的小程序 UA
        self.fp = build_mini_program_fingerprint()
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": self.fp["user_agent"],
                "Content-Type": "application/json",
                "Origin": BASE_URL,
                "Referer": f"{BASE_URL}/?wid={wid}&openId={open_id}",
                "X-Requested-With": "com.tencent.mm",
                "sec-ch-ua-platform": '"Android"',
                "sec-ch-ua-mobile": "?1",
            }
        )

    def request(self, method, path, payload=None, encrypted=True, retry=2):
        url = f"{BASE_URL}{path}"
        for attempt in range(retry + 1):
            kwargs = {"timeout": 20}
            if payload:
                kwargs["json"] = encrypt_payload(payload) if encrypted else payload
                if encrypted:
                    kwargs["headers"] = {"X-Request-Encrypted": "true"}
            response = self.session.request(method, url, **kwargs)
            if response.status_code == 429 and attempt < retry:
                retry_after = response.headers.get("Retry-After", "2")
                try:
                    wait_seconds = max(1.0, float(retry_after))
                except ValueError:
                    wait_seconds = 2.0
                time.sleep(wait_seconds + attempt)
                continue
            response.raise_for_status()
            try:
                result = response.json()
            except ValueError as exc:
                raise RuntimeError(f"接口返回非 JSON 数据：{response.text[:200]}") from exc

            msg = str(result.get("msg", ""))
            if result.get("code") == 200:
                return result
            if attempt < retry and (
                response.status_code == 429 or "频繁" in msg or "稍后" in msg
            ):
                time.sleep(2.5 + attempt * 1.5)
                continue
            raise RuntimeError(msg or f"接口返回 code={result.get('code')}")
        raise RuntimeError("请求重试后仍未成功")

    def login(self):
        result = self.request(
            "POST",
            "/api/web/open/tomato/login",
            {
                "shareTomatoUserId": None,
                "openId": self.open_id,
                "wid": self.wid,
                "queryCardStatus": True,
            },
        )
        data = result.get("data") or {}
        token = data.get("token")
        if not token:
            raise RuntimeError("登录响应中没有 token")
        self.session.headers["Authorization"] = token
        self.tomato_user_id = data.get("tomatoUserId")
        return data

    def home(self):
        return self.request("GET", "/api/web/member/tomato/home").get("data") or {}

    def tasks(self):
        return self.request("GET", "/api/web/member/tomato/tasks").get("data") or []

    def complete_task(self, task):
        task_type = task.get("taskType")
        payload = {"taskType": task_type}
        # The normal task popup always includes browseTarget, even for SIGN.
        # SHARE uses its own frontend action and only sends taskType.
        if task_type != "SHARE":
            payload["browseTarget"] = task.get("browseTarget") or ""
        elif self.tomato_user_id:
            try:
                self.request(
                    "POST",
                    "/api/web/member/tomato/miniprogram/qrcode/create",
                    {
                        "page": "packages/wm-cloud-qiehuang/home/index",
                        "scene": str(self.tomato_user_id),
                    },
                )
            except Exception:
                # The official client also falls back to an empty QR URL.
                pass
        return self.request(
            "POST", "/api/web/member/tomato/tasks/complete", payload
        ).get("data") or {}

    def friends(self, page_size=20):
        friends = []
        page_num = 1
        while True:
            result = self.request(
                "GET",
                f"/api/web/member/tomato/friends?pageNum={page_num}&pageSize={page_size}",
            )
            rows = result.get("rows") or []
            friends.extend(rows)
            total = int(result.get("total") or 0)
            if not rows or (total and len(friends) >= total) or len(rows) < page_size:
                break
            page_num += 1
        return friends

    def friend_home(self, friend_user_id):
        return self.request(
            "GET",
            f"/api/web/member/tomato/friends/{friend_user_id}/home",
        ).get("data") or {}

    def steal_friend_energy(self, friend_user_id):
        return self.request(
            "POST",
            "/api/web/member/tomato/friends/steal",
            {"friendTomatoUserId": friend_user_id},
        ).get("data")

    def use_energy(self):
        # The official client sends this endpoint with an empty, unencrypted body.
        return self.request(
            "POST", "/api/web/member/tomato/energy/use", encrypted=False
        ).get("data") or {}


def short_open_id(open_id):
    return f"{open_id[:6]}...{open_id[-4:]}" if len(open_id) > 12 else open_id


def home_line(data, prefix="当前状态"):
    return (
        f"{prefix}：能量 {data.get('energyBalance', 0)}，"
        f"番茄 {data.get('tomatoBalance', 0)}，"
        f"{data.get('stageName', '未知阶段')} "
        f"{data.get('currentExp', 0)}/{data.get('stageRequiredExp', 0)}"
    )


def process_user(client, index, source_tag):
    """执行单账号任务流程；client 已构造但尚未登录。"""
    logs = [
        f"{ICON['account']} 账号{index}｜wid={client.wid}｜openId={short_open_id(client.open_id)}",
        f"{ICON['cache']} 身份来源：{source_tag}",
        f"{ICON['phone']} 设备指纹：{client.fp['brand']} {client.fp['model']} / "
        f"Android {client.fp['android']} / 微信 {client.fp['wechat']}",
    ]

    login_data = client.login()
    logs.append(f"{ICON['ok']} 登录成功：{login_data.get('nickName') or '未设置昵称'}")
    human_delay("think")
    home = client.home()
    logs.append(f"{ICON['status']} {home_line(home)}")

    completed = 0
    skipped = 0
    friend_task = None
    for task in client.tasks():
        name = task.get("taskName") or task.get("taskCode") or "未知任务"
        task_type = task.get("taskType")
        if task_type == FRIEND_TASK_TYPE:
            friend_task = task
            if str(task.get("completed")) == "1":
                logs.append(f"{ICON['done']} 任务已完成：{name}")
            continue
        if str(task.get("completed")) == "1":
            logs.append(f"{ICON['done']} 任务已完成：{name}")
            continue
        if task_type not in SUPPORTED_TASK_TYPES:
            skipped += 1
            logs.append(f"{ICON['skip']} 跳过任务：{name}（需在小程序内操作）")
            continue
        try:
            result = client.complete_task(task)
            reward = result.get("rewardText") or task.get("rewardText") or "已领取"
            logs.append(f"{ICON['gift']} 任务完成：{name} · {reward}")
            completed += 1
        except Exception as exc:
            logs.append(f"{ICON['warn']} 任务失败：{name} · {exc}")
        human_delay("think")

    try:
        claimable_friends = [
            friend
            for friend in client.friends()
            if str(friend.get("friendStatus")) == FRIEND_STATUS_CLAIMABLE
            and friend.get("friendTomatoUserId")
        ]
        stolen_count = 0
        stolen_energy = 0
        failed_count = 0
        for friend in claimable_friends:
            friend_user_id = friend["friendTomatoUserId"]
            try:
                friend_home = client.friend_home(friend_user_id)
                amount = int(friend_home.get("stealAmount") or 0)
                if str(friend_home.get("canSteal")) != "1" or amount <= 0:
                    continue
                client.steal_friend_energy(friend_user_id)
                stolen_count += 1
                stolen_energy += amount
            except Exception:
                failed_count += 1
            human_delay("think")

        if stolen_count:
            detail = f"{ICON['friend']} 好友能量：成功收取 {stolen_count} 位好友，共 {stolen_energy} 能量"
            if failed_count:
                detail += f"，失败 {failed_count} 位"
            logs.append(detail)
            if friend_task and str(friend_task.get("completed")) != "1":
                completed += 1
        elif failed_count:
            logs.append(f"{ICON['friend']} 好友能量：收取失败 {failed_count} 位")
        else:
            logs.append(f"{ICON['friend']} 好友能量：暂无可收取能量")
    except Exception as exc:
        logs.append(f"{ICON['warn']} 好友能量失败：{exc}")

    home = client.home()
    logs.append(f"{ICON['status']} {home_line(home, '任务后状态')}")
    energy = int(home.get("energyBalance") or 0)
    if energy > 0:
        before_tomato = int(home.get("tomatoBalance") or 0)
        try:
            grown = client.use_energy()
            after_tomato = int(grown.get("tomatoBalance") or 0)
            gained = int(grown.get("gainedTomatoAmount") or 0)
            if not gained:
                gained = max(0, after_tomato - before_tomato)
            logs.append(
                f"{ICON['energy']} 使用能量：消耗 {grown.get('usedEnergyAmount', energy)}，"
                f"成长到 {grown.get('stageName', '未知阶段')} "
                f"{grown.get('currentExp', 0)}/{grown.get('stageRequiredExp', 0)}，"
                f"获得番茄 {gained}"
            )
            home = grown
        except Exception as exc:
            logs.append(f"{ICON['warn']} 使用能量失败：{exc}")
    else:
        logs.append(f"{ICON['energy']} 使用能量：当前没有可用能量")

    logs.append(f"{ICON['final']} {home_line(home, '最终状态')}")
    logs.append(f"{ICON['summary']} 本次完成任务 {completed} 个，跳过 {skipped} 个")
    try:
        gained = int(home.get("gainedTomatoAmount") or 0)
    except Exception:
        gained = 0
    summary = {
        "nick": login_data.get("nickName") or "",
        "tomato": int(home.get("tomatoBalance") or 0),
        "gained": gained,
        "completed": completed,
    }
    return logs, summary


def run_single_account(index, wcs_open_id, cache):
    """
    单账号执行，含 CK 缓存策略：
      1. 命中缓存 → 直接用 (wid, openId) 登录番茄服务（跳过 WCS）
      2. 缓存登录失败 → 判定 CK 失效，回源 WCS 刷新后重试一次
      3. 无缓存 → 直接回源 WCS 并写入缓存
    """
    cached = get_cached_identity(cache, wcs_open_id)

    if cached:
        wid, open_id = cached
        try:
            client = TomatoClient(wid, open_id)
            logs, summary = process_user(client, index, f"{ICON['cache']} 缓存命中")
            put_cached_identity(cache, wcs_open_id, wid, open_id)  # 刷新时间戳
            return logs, summary
        except Exception as exc:
            print(f"{ICON['refresh']} 账号{index} 缓存 CK 失效（{exc}），回源 WCS 刷新…")
            drop_cached_identity(cache, wcs_open_id)

    # 回源刷新
    wid, open_id = resolve_identity(wcs_open_id)
    print(f"{ICON['ok']} 账号{index} WCS 回源成功：wid={wid}，openId={short_open_id(open_id)}")
    client = TomatoClient(wid, open_id)
    logs, summary = process_user(client, index, f"{ICON['refresh']} WCS 回源刷新")
    put_cached_identity(cache, wcs_open_id, wid, open_id)
    return logs, summary


def render_report(all_logs, stats):
    lines = [
        f"{ICON['app']} {APP_NAME}",
        f"{ICON['summary']} 账号 {stats['total']} 个｜成功 {stats['ok']}｜失败 {stats['fail']}"
        f"｜缓存命中 {stats['cache_hit']}｜回源 {stats['refresh']}",
    ]
    for logs in all_logs:
        lines.append(LINE)
        lines.extend(logs)
    lines.append(LINE)
    lines.append(f"{ICON['app']} 执行完毕 · {time.strftime('%Y-%m-%d %H:%M:%S')}")
    return "\n".join(lines)


def safe_send(title, message):
    try:
        if report:
            report(title, [{'name': title, 'sign': message, 'earned': None, 'total': None, 'streak': None, 'tasks': None, 'lottery': None, 'taskEarned': None}])
    except Exception as exc:
        print(f"{ICON['warn']} 通知发送失败（不影响脚本执行结果）：{exc}")


def main():
    users = parse_users()
    if CRYPTO_BACKEND is None:
        message = f"{ICON['fail']} 缺少加密依赖，请安装 cryptography：pip install cryptography"
        print(message)
        safe_send(f"{ICON['app']} {APP_NAME}", message)
        return
    if not users:
        message = f"{ICON['fail']} 没有可用账号：未读取到 wx_opinion 环境变量"
        print(message)
        safe_send(f"{ICON['app']} {APP_NAME}", message)
        return

    cache = load_cache()
    all_logs = []
    stats = {"total": len(users), "ok": 0, "fail": 0, "cache_hit": 0, "refresh": 0}

    _rows = []
    for index, wcs_open_id in enumerate(users, 1):
        print(f"\n{LINE}\n{ICON['app']} 开始处理账号 {index}\n{LINE}")
        had_cache = get_cached_identity(cache, wcs_open_id) is not None
        _summary = None
        try:
            logs, _summary = run_single_account(index, wcs_open_id, cache)
            stats["ok"] += 1
            # 判定最终身份来源（缓存条目仍在且此前命中 = 缓存命中；否则为回源）
            if had_cache and any("缓存命中" in l for l in logs):
                stats["cache_hit"] += 1
            else:
                stats["refresh"] += 1
        except Exception as exc:
            stats["fail"] += 1
            logs = [
                f"{ICON['account']} 账号{index}",
                f"{ICON['fail']} 处理失败：{exc}",
            ]
        all_logs.append(logs)
        print("\n".join(logs))
        if _summary:
            _rows.append({
                'name': _summary.get('nick') or f'账号{index}',
                'sign': '任务完成',
                'earned': (f"获得番茄 {_summary.get('gained')}" if _summary.get('gained') else None),
                'total': str(_summary.get('tomato')) if _summary.get('tomato') is not None else None,
                'streak': None,
                'tasks': (f"完成 {_summary.get('completed')} 个" if _summary.get('completed') else None),
                'lottery': None,
                'taskEarned': None,
            })
        else:
            _rows.append({
                'name': f'账号{index}',
                'sign': '处理失败',
                'earned': None,
                'total': None,
                'streak': None,
                'tasks': None,
                'lottery': None,
                'taskEarned': None,
            })
        if index < len(users):
            human_delay("account")

    save_cache(cache)
    report_text = render_report(all_logs, stats)
    print(f"\n{report_text}")
    try:
        if report:
            report(APP_NAME, _rows)
    except Exception as exc:
        print(f"{ICON['warn']} 通知发送失败：{exc}")


if __name__ == "__main__":
    main()