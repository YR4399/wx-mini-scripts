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
星妈会小程序自动化签到 + 浏览任务脚本 (WCS Console 适配版)

登录流程 (HAR 逆向):
  1. GET www.feihevip.com/api/starMember/getUserToken?code=wxLoginCode -> token
  2. POST mom.feihe.com/program/crmMember/saveUserInfo  {openId, unionId}
  3. POST mom.feihe.com/program/crmMember/findIsAuthorized  {}
  4. POST mom.feihe.com/program/crmMember/memberQuery      {wxCode, querySource}
  5. POST www.feihevip.com/api/miniProgram/refreshMemberInfo  {}

认证方式:
  - token 通过自定义请求头 "token" 传递
  - 签名算法: @firmus/sign npm 包 (从 wxapkg 逆向)
  - 签名流程: 收集 {fhAppid,fhNonceStr,fhTimestamp} + data -> 拼接 -> +appKey -> MD5().upper()
  - appKey: xmyx=TwUQ01lKS1Km5zlV2f7amsZc5EQYkTbv, xmh=98d9fe9b613a479dbcb111ca261e3ce1
"""

import os
import sys
import time
import json
import random
import string
import hashlib
import logging
import requests
from datetime import datetime

# -----------------------------------------------------------------------
# 日志配置
# -----------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("xmyx")

# -----------------------------------------------------------------------
# 常量
# -----------------------------------------------------------------------
APPID = "wx4205ec55b793245e"
FH_APPID_BIZ = "xmyx"   # www.feihevip.com
FH_APPID_CRM = "xmh"    # mom.feihe.com
FH_APPKEY_BIZ = "TwUQ01lKS1Km5zlV2f7amsZc5EQYkTbv"
FH_APPKEY_CRM = "98d9fe9b613a479dbcb111ca261e3ce1"
CRM_BASE = "https://mom.feihe.com/program/crmMember"
API_BASE = "https://www.feihevip.com/api"
SIGNIN_BASE = f"{API_BASE}/member/signin"
REFERER = f"https://servicewechat.com/{APPID}/419/page-frame.html"

UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50.2700",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 MicroMessenger/8.0.50(0x18003233) NetType/WIFI Language/zh_CN",
]

# -----------------------------------------------------------------------
# 配置加载 (三级: 环境变量 > 缓存文件 > 默认值)
# -----------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIG_FILE = os.path.join(_SCRIPT_DIR, ".xmyx_config.json")
_TOKEN_CACHE_FILE = os.path.join(_SCRIPT_DIR, ".xmyx_token_cache.json")
_DEFAULT_CONFIG = {
    "wx_server_url": "http://127.0.0.1:8787",
    "wx_auth": "",
}
# token 有效期 (秒), 超过则重新登录
_TOKEN_TTL = 86400  # 24小时


def _load_config():
    config = dict(_DEFAULT_CONFIG)
    if os.path.exists(_CONFIG_FILE):
        try:
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                config.update(json.load(f))
        except Exception:
            pass
    # 环境变量覆盖
    env_map = {
        "wx_server_url": "wx_server_url",
        "wx_auth": "wx_auth",
    }
    updated = False
    for cfg_key, env_name in env_map.items():
        val = os.environ.get(env_name, "")
        if val and val != config.get(cfg_key, ""):
            config[cfg_key] = val
            updated = True
    if updated or not os.path.exists(_CONFIG_FILE):
        try:
            with open(_CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception:
            pass
    return config


def _load_token_cache():
    """读取 token 缓存, 返回 {openid: {"token": ..., "ts": ...}, ...}"""
    if os.path.exists(_TOKEN_CACHE_FILE):
        try:
            with open(_TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_token_cache(cache):
    """写入 token 缓存"""
    try:
        with open(_TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def _get_cached_token(openid):
    """获取缓存的 token, 过期返回 None"""
    cache = _load_token_cache()
    entry = cache.get(openid)
    if not entry:
        return None
    ts = entry.get("ts", 0)
    if time.time() - ts > _TOKEN_TTL:
        log.info(f"缓存 token 已过期 ({_TOKEN_TTL}s), 重新登录")
        return None
    log.info(f"使用缓存 token (年龄={int(time.time()-ts)}s)")
    return entry.get("token")


def _set_cached_token(openid, token):
    """缓存 token"""
    cache = _load_token_cache()
    cache[openid] = {"token": token, "ts": int(time.time())}
    _save_token_cache(cache)


_config = _load_config()
WCS_BASE = _config["wx_server_url"]
WCS_AUTH = _config["wx_auth"]


# -----------------------------------------------------------------------
# 签名算法 (从 @firmus/sign npm 包逆向)
# -----------------------------------------------------------------------
def _rand_nonce(length=16):
    return "".join(random.choices(string.ascii_letters + string.digits, k=length))


def _compute_fhsign(url, headers, data, app_key):
    """
    fhSign 算法 (逆向自 @firmus/sign):
    1. 收集签名基础字段 {fhAppid, fhNonceStr, fhTimestamp}
    2. 根据 Content-Type 决定参与签名的字段列表
    3. 拼接: 对每个字段, 追加 key + value
    4. 末尾追加 appKey
    5. MD5(拼接结果).toUpperCase() = fhSign
    """
    sign_keys = ["fhAppid", "fhNonceStr", "fhTimestamp"]

    # 提取签名基础头的值
    base = {k: headers.get(k, "") for k in sign_keys}

    # application/json -> case 2: keys = ownKeys(base).sort() + [data_key]
    if isinstance(data, dict):
        data_key = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    elif isinstance(data, str) and data:
        data_key = data
    else:
        data_key = ""

    all_keys = sorted(list(base.keys()) + [data_key])

    # 合并对象: base + data (if dict)
    merged = dict(base)
    if isinstance(data, dict):
        merged.update(data)

    # 拼接签名字符串
    sign_str = ""
    for key in all_keys:
        val = merged.get(key)
        if val is not None:
            if isinstance(val, (dict, list)):
                val = json.dumps(val, separators=(",", ":"), ensure_ascii=False)
            sign_str += str(key) + str(val)
        else:
            sign_str += str(key)

    # 追加 appKey
    sign_str += app_key

    return hashlib.md5(sign_str.encode("utf-8")).hexdigest().upper()


# -----------------------------------------------------------------------
# 请求头构建 (带签名)
# -----------------------------------------------------------------------
def _make_crm_headers(token="", body_data=None):
    """构建 mom.feihe.com CRM 接口请求头 (fhAppid=xmh) + 计算签名"""
    ts = str(int(time.time()))
    nonce = _rand_nonce()
    h = {
        "Content-Type": "application/json",
        "fhAppid": FH_APPID_CRM,
        "fhTimestamp": ts,
        "fhNonceStr": nonce,
        "User-Agent": random.choice(UA_LIST),
        "Referer": REFERER,
        "xweb_xhr": "1",
        "visit": "false",
        "OrderUpdate": "1",
        "source": "1",
    }
    if token:
        h["token"] = token
    # 计算 fhSign (用空 URL, 因为 CRM 接口的 path 不参与签名)
    h["fhSign"] = _compute_fhsign("", h, body_data, FH_APPKEY_CRM)
    return h


def _make_biz_headers(token, body_data=None, url_path=""):
    """构建 www.feihevip.com 业务接口请求头 (fhAppid=xmyx) + 计算签名"""
    ts = str(int(time.time()))
    nonce = _rand_nonce()
    h = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Connection": "keep-alive",
        "Content-Type": "application/json",
        "fhAppid": FH_APPID_BIZ,
        "fhTimestamp": ts,
        "fhNonceStr": nonce,
        "fhSign": "",  # placeholder
        "source": "1",
        "visit": "false",
        "orderupdate": "1",
        "token": token,
        "referrercrm": "",
        "User-Agent": random.choice(UA_LIST),
        "Referer": REFERER,
        "xweb_xhr": "1",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }
    # 计算 fhSign
    h["fhSign"] = _compute_fhsign(url_path, h, body_data, FH_APPKEY_BIZ)
    return h


# -----------------------------------------------------------------------
# WCS Client (与 WCS Console 通信)
# -----------------------------------------------------------------------
class WCSClient:
    """WCS 微信小程序自动登录客户端"""

    def __init__(self):
        self.base = WCS_BASE.rstrip("/")
        self.auth = WCS_AUTH
        self.session = requests.Session()

    def get_accounts(self):
        """获取 WCS 中已配置的账号列表"""
        try:
            resp = self.session.get(
                f"{self.base}/api/accounts",
                headers={"AUTH": self.auth},
                timeout=15,
            )
            body = resp.json()
            if body.get("status"):
                return body.get("data", {}).get("items", [])
        except Exception as e:
            log.warning(f"WCS 获取账号列表失败: {e}")
        return []

    def get_code(self, openid, user_key):
        """POST /wx/code, 获取 wx.login code"""
        body = {
            "appid": APPID,
            "userKey": user_key or openid,
            "openid": openid,
        }
        try:
            resp = self.session.post(
                f"{self.base}/wx/code",
                json=body,
                headers={"AUTH": self.auth, "Content-Type": "application/json"},
                timeout=60,
            )
            data = resp.json()
            if data.get("status") and data.get("data", {}).get("code"):
                return data["data"]["code"]
            log.warning(f"WCS /wx/code 响应异常: {data}")
        except requests.Timeout:
            log.warning("WCS /wx/code 超时")
        except Exception as e:
            log.warning(f"WCS /wx/code 请求失败: {e}")
        return None


# -----------------------------------------------------------------------
# 星妈会业务 Client
# -----------------------------------------------------------------------
class XingMaHuiClient:
    """星妈会 API 封装"""

    def __init__(self, token, openid=""):
        self.token = token
        self.openid = openid
        self.session = requests.Session()

    def get_sign_info(self):
        """GET /api/member/signin/getSignInfo?signType=1"""
        url = f"{SIGNIN_BASE}/getSignInfo?signType=1"
        try:
            resp = self.session.get(url, headers=_make_biz_headers(self.token, url_path=url), timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f"获取签到信息失败: {e}")
            return None

    def sign(self):
        """POST /api/member/signin/sign (body={})"""
        url = f"{SIGNIN_BASE}/sign"
        try:
            resp = self.session.post(url, headers=_make_biz_headers(self.token, body_data={}, url_path=url), json={}, timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f"签到请求失败: {e}")
            return None

    def get_task_list(self):
        """GET /api/member/signin/getTaskList"""
        url = f"{SIGNIN_BASE}/getTaskList"
        try:
            resp = self.session.get(url, headers=_make_biz_headers(self.token, url_path=url), timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f"获取任务列表失败: {e}")
            return None

    def tofinish(self, task_type):
        """GET /api/member/signin/tofinish?taskType=xxx"""
        url = f"{SIGNIN_BASE}/tofinish?taskType={task_type}"
        try:
            resp = self.session.get(url, headers=_make_biz_headers(self.token, url_path=url), timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f"开始浏览失败 {task_type}: {e}")
            return None

    def complete_task(self, task_type):
        """GET /api/member/signin/completeTask?taskType=xxx"""
        url = f"{SIGNIN_BASE}/completeTask?taskType={task_type}"
        try:
            resp = self.session.get(url, headers=_make_biz_headers(self.token, url_path=url), timeout=15)
            return resp.json()
        except Exception as e:
            log.error(f"完成任务失败 {task_type}: {e}")
            return None


# -----------------------------------------------------------------------
# 登录
# -----------------------------------------------------------------------
def login_via_wcs(wcs, openid, user_key):
    """
    WCS 自动登录全流程:
      1. WCS /wx/code -> wx.login code
      2. GET getUserToken?code=xxx -> token (不需要 fhSign)
      3. POST saveUserInfo + memberQuery + refreshMemberInfo (CRM 激活)
    返回 token 字符串或 None
    """
    # Step 1: 获取 wx.login code (重试 3 次)
    login_code = None
    for attempt in range(3):
        try:
            login_code = wcs.get_code(openid, user_key or openid)
        except Exception as e:
            log.warning(f"WCS 获取 code 失败: {e}, 重试 ({attempt + 1}/3)")
            login_code = None
        if login_code:
            break
        if attempt < 2:
            wait = 3 * (attempt + 1)
            log.info(f"code 为空, 等待 {wait}s...")
            time.sleep(wait)

    if not login_code:
        log.error("wx.login code 获取失败, 已重试 3 次")
        return None

    log.info(f"wxCode: {login_code[:30]}...")

    # Step 2: getUserToken (核心登录 - 不需要 fhSign!)
    log.info("[登录] GET getUserToken...")
    try:
        headers = {
            "User-Agent": random.choice(UA_LIST),
            "Referer": REFERER,
            "xweb_xhr": "1",
            "content-type": "application/json",
            "fhappid": FH_APPID_BIZ,
            "fhtimestamp": str(int(time.time())),
            "fhnoncestr": _rand_nonce(),
            "source": "1",
            "visit": "false",
        }
        resp = requests.get(
            f"{API_BASE}/starMember/getUserToken",
            params={"code": login_code},
            headers=headers,
            timeout=15,
        )
        data = resp.json()
    except Exception as e:
        log.error(f"getUserToken 请求失败: {e}")
        return None

    if not data.get("data") or not data["data"].get("token"):
        msg = data.get("msg", str(data))
        log.error(f"getUserToken 失败: {msg}")
        return None

    token = data["data"]["token"]
    user_openid = data["data"].get("openId", "")
    user_unionid = data["data"].get("unionId", "")
    log.info(f"[登录] token 获取成功 (长度={len(token)})")
    log.info(f"[登录] openId={user_openid}, unionId={user_unionid}")

    # Step 3: CRM 激活 (saveUserInfo + memberQuery, 非关键, 失败不影响)
    try:
        # saveUserInfo
        requests.post(
            f"{CRM_BASE}/saveUserInfo",
            json={"openId": user_openid, "unionId": user_unionid},
            headers=_make_crm_headers(token, body_data={"openId": user_openid, "unionId": user_unionid}),
            timeout=10,
        )
        # findIsAuthorized
        requests.post(
            f"{CRM_BASE}/findIsAuthorized",
            json={},
            headers=_make_crm_headers(token, body_data={}),
            timeout=10,
        )
        # memberQuery
        requests.post(
            f"{CRM_BASE}/memberQuery",
            json={"wxCode": login_code, "querySource": "0"},
            headers=_make_crm_headers(token, body_data={"wxCode": login_code, "querySource": "0"}),
            timeout=10,
        )
    except Exception as e:
        log.warning(f"CRM 激活跳过: {e}")

    # Step 4: refreshMemberInfo
    try:
        requests.post(
            f"{API_BASE}/miniProgram/refreshMemberInfo",
            json={},
            headers=_make_biz_headers(token, body_data={}),
            timeout=10,
        )
    except Exception:
        pass

    return token


def login_manual():
    """手动 token 模式: 从环境变量 XMYX_TOKEN 读取"""
    token = os.environ.get("XMYX_TOKEN", "")
    if not token:
        return None
    log.info("使用手动 token (长度=%d)", len(token))
    return token


# -----------------------------------------------------------------------
# 业务逻辑
# -----------------------------------------------------------------------
def run_sign(client):
    """执行每日签到"""
    print("\n========== 每日签到 ==========")
    info = client.get_sign_info()
    if not info:
        log.error("获取签到信息失败")
        return

    sign_status = info.get("data", {}).get("signStatus")
    total_point = info.get("data", {}).get("memberDetail", {}).get("totalPoint", 0)
    log.info(f"签到状态={sign_status}, 当前积分={total_point}")

    if sign_status == 1:
        log.info("今日已签到, 跳过")
        return

    result = client.sign()
    if result:
        code = result.get("code")
        log.info(f"签到结果: code={code}, msg={result.get('msg')}")
        if str(code) == "200":
            log.info("签到成功")
        else:
            log.warning(f"签到可能失败: {result}")
    else:
        log.error("签到请求失败")


def run_browse_task(client, task, wait_time=15):
    """执行单个浏览任务"""
    task_type = task.get("taskType")
    task_name = task.get("taskName", task_type)
    award = task.get("awardPoint", 0)
    log.info(f"任务: {task_name} (类型={task_type}, 奖励={award}分)")

    # 1. tofinish
    r1 = client.tofinish(task_type)
    if r1:
        log.info(f"开始浏览: {json.dumps(r1, ensure_ascii=False)[:120]}")

    # 2. wait
    print(f"  浏览中... {wait_time}s")
    time.sleep(wait_time)

    # 3. completeTask
    r2 = client.complete_task(task_type)
    if r2:
        log.info(f"完成任务: {json.dumps(r2, ensure_ascii=False)[:120]}")
        if str(r2.get("code")) == "200":
            log.info(f"任务完成: +{award}分")
        else:
            log.warning(f"任务可能失败: {r2.get('msg')}")


def run_all_tasks(client):
    """获取并执行所有浏览任务"""
    print("\n========== 浏览任务 ==========")
    data = client.get_task_list()
    if not data:
        log.error("获取任务列表失败")
        return

    tasks = data.get("data", [])
    if not isinstance(tasks, list):
        log.warning("任务列表格式异常")
        return

    # 过滤: 去掉 None taskType, 去掉 "进福利群" 等不可自动完成的任务
    skip_keywords = ["进福利群", "签到"]
    browse_tasks = [
        t for t in tasks
        if t.get("taskType") and t.get("taskType") != ""
        and not any(kw in t.get("taskName", "") for kw in skip_keywords)
    ]
    log.info(f"共 {len(browse_tasks)} 个任务待执行")

    # 可重复执行的任务类型及次数
    REPEAT_TASKS = {"TZSPXQ1": 3, "LLZTY": 3}
    executed = set()  # 已处理过的 taskType

    for task in browse_tasks:
        task_type = task.get("taskType")
        repeat = REPEAT_TASKS.get(task_type, 1)
        for round_i in range(repeat):
            r = client.tofinish(task_type)
            if r and str(r.get("code")) != "200":
                # 已经完成或不可用, 跳出本轮重复
                log.info(f"任务 {task.get('taskName')} 第{round_i+1}次已不可用, 跳过剩余")
                break
            log.info(f"任务: {task.get('taskName')} (第{round_i+1}/{repeat}次)")
            if r:
                log.info(f"开始浏览: {json.dumps(r, ensure_ascii=False)[:120]}")
            print(f"  浏览中... 15s")
            time.sleep(15)
            r2 = client.complete_task(task_type)
            if r2:
                log.info(f"完成任务: {json.dumps(r2, ensure_ascii=False)[:120]}")
                if str(r2.get("code")) == "200":
                    log.info(f"任务完成: +{task.get('awardPoint', 0)}分")
                else:
                    log.warning(f"任务可能失败: {r2.get('msg')}")
                    break
            if round_i < repeat - 1:
                delay = random.randint(3, 8)
                log.info(f"等待 {delay}s 后重复执行...")
                time.sleep(delay)

        delay = random.randint(3, 8)
        log.info(f"等待 {delay}s 后执行下一个任务...")
        time.sleep(delay)


# -----------------------------------------------------------------------
# 主函数
# -----------------------------------------------------------------------
def run_account(token, account_info):
    """对单个账号执行签到 + 全部浏览任务"""
    display = account_info.get("displayName", "") or account_info.get("openid", "")[:16]
    openid = account_info.get("openid", "")
    client = XingMaHuiClient(token, openid=openid)
    log.info(f"--- 账号: {display} ---")
    run_sign(client)
    time.sleep(random.randint(3, 8))
    run_all_tasks(client)


def main():
    print("=" * 50)
    print("星妈会 自动签到 + 浏览任务 (WCS)")
    print("=" * 50)

    token = login_manual()
    if token:
        run_account(token, {})
    elif WCS_AUTH:
        log.info("尝试 WCS 自动登录...")
        wcs = WCSClient()
        accounts = wcs.get_accounts()
        if not accounts:
            log.warning("未找到 WCS 账号")
            sys.exit(1)
        log.info(f"找到 {len(accounts)} 个 WCS 账号")
        for i, acc in enumerate(accounts):
            if i > 0:
                delay = random.randint(5, 10)
                log.info(f"等待 {delay}s 后切换下一个账号...")
                time.sleep(delay)
            openid = acc.get("openid", "")
            user_key = acc.get("userKey", openid)

            # 优先使用缓存 token
            token = _get_cached_token(openid)
            if not token:
                user_key = acc.get("userKey", openid)
                token = login_via_wcs(wcs, openid, user_key)
                if token:
                    _set_cached_token(openid, token)
            if token:
                run_account(token, acc)
            else:
                log.warning(f"账号 {acc.get('displayName', openid[:16])} 登录失败")
    else:
        print("\n无可用 token, 请选择:")
        print("  1. 设置环境变量 XMYX_TOKEN (手动模式, 单账号)")
        print("  2. 设置环境变量 wx_auth + wx_server_url (WCS 自动模式, 多账号)")
        sys.exit(1)

    print("\n全部完成!")


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
            push_notify('xmyx_auto_wcs 签到结果', _logs[-2000:])
        except:
            pass


# ========== 自动推送 ==========
try:
    push_content = []
    output = ''
    if hasattr(sys.stdout, 'getvalue'):
        output = sys.stdout.getvalue()
    if output:
        for line in output.split(chr(10)):
            if line.strip():
                push_content.append(line)
    if push_content:
        push_notify('xmyx_auto_wcs 签到结果', chr(10).join(push_content[-20:]))
except:
    pass
# ========== 自动推送结束 ==========
