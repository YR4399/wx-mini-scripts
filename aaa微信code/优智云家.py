#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
优智云家动态 code 版

功能：
  1. 四端口本地服务获取微信 code
  2. 使用 code 换 token（微信登录）
  3. 每日签到
  4. PushPlus 推送
  5. 品赞代理，业务请求优先代理，失败直连兜底

环境变量：
  PLUSPLUS_TOKEN    PushPlus token，可选
  PROXY_API         品赞代理提取 API，可选
  PROXY_TYPE        http / socks5，默认 http

依赖：
  pip install requests
  socks5 代理需：
  pip install requests[socks]
"""

import json
import os
import random
import time
import traceback
from datetime import datetime
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

import requests


APP_NAME = "优智云家品牌商城小程序"
APPID = "wxa61f98248d20178b"

WX_SERVER_URL = os.getenv("wx_server_url", "http://127.0.0.1:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")
CK_NAME = "wx_opinion"

PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")
PROXY_API = os.getenv("PROXY_API", "")
PROXY_TYPE = os.getenv("PROXY_TYPE", "http").lower()

PROXY_RETRY_TIMES = 3
PROXY_VALIDATE_URL = "http://httpbin.org/ip"
PROXY_FETCH_INTERVAL = 3
ENABLE_DIRECT_FALLBACK = True
REQUEST_TIMEOUT = 30

BASE_URL = "https://xapi.weimob.com"
LOGIN_URL = f"{BASE_URL}/fe/mapi/user/loginX"
SIGN_STATUS_URL = f"{BASE_URL}/api3/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo"
SIGN_SUBMIT_URL = f"{BASE_URL}/api3/onecrm/mactivity/sign/misc/sign/activity/core/c/sign"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541938) XWEB/19823"
)


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def mask(value: Any) -> str:
    value = str(value or "")
    if len(value) <= 12:
        return value
    return f"{value[:6]}...{value[-6:]}"


def json_preview(data: Any, limit: int = 800) -> str:
    try:
        return json.dumps(data, ensure_ascii=False)[:limit]
    except Exception:
        return str(data)[:limit]


def log_title() -> None:
    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🏠 优智云家动态 code 版                       ║")
    print(f"║ 🕒 启动时间: {now_text():<32}║")
    _accounts = [x.strip() for x in os.getenv(CK_NAME, "").replace("&", "\n").splitlines() if x.strip()]
    print(f"║ 🔢 账号数量: {len(_accounts):<34}║")
    print("╚" + "═" * 50 + "╝")


def log_account_header(index: int, total: int, server: str) -> None:
    print()
    print("┌" + "─" * 50 + "┐")
    print(f"│ 🧩 账号 {index} / {total:<37}│")
    print(f"│ 🌍 来源 {server:<40}│")
    print("└" + "─" * 50 + "┘")


def direct_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def parse_proxy_response(text: Any) -> Dict[str, Any] | None:
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    text = text.strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        proxy_obj = None
        if isinstance(data.get("data"), list) and data["data"]:
            proxy_obj = data["data"][0]
        elif isinstance(data.get("data"), dict):
            proxy_obj = data["data"]
        elif data.get("ip") and data.get("port"):
            proxy_obj = data
        elif isinstance(data.get("result"), dict):
            proxy_obj = data["result"]
        if proxy_obj:
            host = proxy_obj.get("ip") or proxy_obj.get("host")
            port = proxy_obj.get("port")
            if host and port:
                return {"host": str(host), "port": int(port),
                        "username": proxy_obj.get("user") or proxy_obj.get("username") or "",
                        "password": proxy_obj.get("pass") or proxy_obj.get("password") or ""}
    except Exception:
        pass
    if ":" in text:
        parts = text.split(":")
        if len(parts) >= 2:
            return {"host": parts[0], "port": int(parts[1]),
                    "username": parts[2] if len(parts) > 2 else "",
                    "password": parts[3] if len(parts) > 3 else ""}
    return None


def build_proxy_dict(proxy_info: Dict[str, Any] | None) -> Dict[str, str] | None:
    if not proxy_info:
        return None
    host = proxy_info["host"]
    port = proxy_info["port"]
    username = proxy_info.get("username", "")
    password = proxy_info.get("password", "")
    auth = f"{quote(username)}:{quote(password)}@" if username and password else ""
    scheme = "socks5" if PROXY_TYPE == "socks5" else "http"
    proxy_url = f"{scheme}://{auth}{host}:{port}"
    print(f"🛠️ [代理] 生成 {scheme.upper()} 代理 {host}:{port}")
    return {"http": proxy_url, "https": proxy_url}


def validate_proxy(proxies: Dict[str, str] | None) -> Tuple[bool, str]:
    if not proxies:
        return False, ""
    try:
        response = requests.get(PROXY_VALIDATE_URL, proxies=proxies, timeout=15)
        if response.status_code == 200:
            ip = response.json().get("origin", "未知") if response.json() else "未知"
            print(f"✅ [代理] 验证通过，出口 IP: {ip}")
            return True, ip
    except Exception as exc:
        print(f"⚠️ [代理] 验证失败: {exc}")
    return False, ""


def get_valid_proxy(account_name: str) -> Tuple[Dict[str, str] | None, str]:
    if not PROXY_API:
        print(f"⚠️ [代理] {account_name} 未配置 PROXY_API，使用直连")
        return None, ""
    print(f"🌐 [代理] {account_name} 正在获取品赞代理...")
    for index in range(1, PROXY_RETRY_TIMES + 1):
        try:
            response = direct_session().get(PROXY_API, timeout=15)
            proxy_info = parse_proxy_response(response.text)
            if not proxy_info:
                print(f"⚠️ [代理] 第 {index} 次代理解析失败")
                continue
            print(f"✅ [代理] 提取到 {proxy_info['host']}:{proxy_info['port']}")
            proxies = build_proxy_dict(proxy_info)
            ok, ip = validate_proxy(proxies)
            if ok:
                return proxies, ip
            print(f"⚠️ [代理] 第 {index} 次代理不可用")
        except Exception as exc:
            print(f"⚠️ [代理] 第 {index} 次获取代理异常: {exc}")
        if index < PROXY_RETRY_TIMES:
            sleep(2)
    print("⚠️ [代理] 获取失败，使用直连")
    return None, ""


def request_with_proxy(method: str, url: str, *, proxies: Dict[str, str] | None = None, server: str = "", **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    if proxies:
        try:
            return requests.request(method, url, proxies=proxies, **kwargs)
        except Exception as exc:
            print(f"⚠️ [代理] {server} 代理请求失败: {exc}")
            if not ENABLE_DIRECT_FALLBACK:
                raise
            print("🔁 [兜底] 切换直连重试")
    return direct_session().request(method, url, **kwargs)


def send_pushplus(title: str, content: str) -> None:
    if not PLUSPLUS_TOKEN:
        print("⚠️ [PushPlus] 未配置 PLUSPLUS_TOKEN，跳过推送")
        return
    try:
        requests.post("https://www.pushplus.plus/send", json={"token": PLUSPLUS_TOKEN, "title": title, "content": content, "template": "txt"}, timeout=10)
        print("✅ [PushPlus] 推送成功")
    except Exception as exc:
        print(f"❌ [PushPlus] 推送失败: {exc}")


def get_code(openid: str) -> str | None:
    url = f"{WX_SERVER_URL}/wx/code"
    print(f"🔐 [授权] 通过WCS获取code: {openid[:10]}...")
    try:
        response = direct_session().post(url, json={"appid": APPID, "openid": openid}, headers={"auth": WX_AUTH}, timeout=60)
        data = response.json()
        code = (data.get("data") or {}).get("code") or data.get("code")
        if not code:
            print(f"❌ [授权] WCS未返回 code: {json_preview(data)}")
            return None
        print("✅ [授权] code 获取成功")
        return code
    except Exception as exc:
        print(f"❌ [授权] code 获取异常: {exc}")
        return None


def common_headers(token: str | None = None, extra_headers: Dict | None = None) -> Dict[str, str]:
    headers = {
        "Host": "xapi.weimob.com", "User-Agent": USER_AGENT, "Content-Type": "application/json",
        "Accept": "*/*", "Referer": f"https://servicewechat.com/{APPID}/109/page-frame.html",
        "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if token:
        headers["X-WX-Token"] = token
    if extra_headers:
        headers.update(extra_headers)
    return headers


def extract_token(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in ["token", "accessToken", "access_token", "jwt"]:
        val = data.get(key) or (data.get("data") or {}).get(key)
        if val and val != "null":
            return str(val)
    return None


def login_by_code(server: str, code: str, proxies: Dict[str, str] | None) -> Tuple[str | None, Dict[str, Any] | None]:
    try:
        print("🔐 [登录] 使用 code 换 token")
        payload = {"appid": APPID, "basicInfo": {"bosId": "4022115200359", "cid": "821033359", "tcode": "weimob", "vid": "6016741943359"},
                   "env": "production", "extendInfo": {"source": 1}, "is_pre_fetch_open": True, "parentVid": 0, "pid": "", "storeId": "", "code": code, "queryAuthConfig": True}
        response = request_with_proxy("POST", LOGIN_URL, headers=common_headers(), json=payload, proxies=proxies, server=server)
        try:
            data = response.json()
        except Exception:
            data = {"raw": response.text[:800]}
        if str(data.get("errcode")) == "0":
            token = extract_token(data)
            if token:
                print(f"✅ [登录] token 获取成功: {mask(token)}")
                return token, data
        print(f"❌ [登录] 登录失败: {data.get('errmsg', '未知错误')}")
        return None, data
    except Exception as exc:
        print(f"❌ [登录] 请求异常: {exc}")
        return None, None


def check_sign_status(server: str, token: str, proxies: Dict[str, str] | None) -> Tuple[bool, Dict]:
    extra_headers = {"x-wmsdk-vid": "6016741943359", "x-biz-id": "146", "cloud-project-name": "fansquan",
                     "x-component-is": "onecrm/signgift", "cloud-bosid": "4022115200359", "weimob-bosId": "4022115200359"}
    payload = {"appid": APPID, "basicInfo": {"vid": 6016741943359, "vidType": 2, "bosId": 4022115200359, "productId": 146, "productInstanceId": 15532102359, "productVersionId": "10003", "merchantId": 2000230069359, "tcode": "weimob", "cid": 821033359}, "extendInfo": {"wxTemplateId": 7930}}
    try:
        response = request_with_proxy("POST", SIGN_STATUS_URL, headers=common_headers(token, extra_headers), json=payload, proxies=proxies, server=server)
        data = response.json()
        if str(data.get("errcode")) == "0":
            sign_data = data.get("data", {})
            return sign_data.get("isSign", False), sign_data
        return False, {}
    except Exception as exc:
        print(f"⚠️ [签到状态] 检查失败: {exc}")
        return False, {}


def submit_signin(server: str, token: str, proxies: Dict[str, str] | None) -> Tuple[bool, str, int]:
    """提交签到，使用正确的签到接口"""
    extra_headers = {"x-wmsdk-vid": "6016741943359", "x-biz-id": "146", "cloud-project-name": "fansquan",
                      "x-component-is": "onecrm/signgift", "cloud-bosid": "4022115200359", "weimob-bosId": "4022115200359",
                      "parentrpcid": "a6e117c9d2dad0ad"}
    payload = {"appid": APPID, "basicInfo": {"vid": 6016741943359, "vidType": 2, "bosId": 4022115200359, "productId": 146, "productInstanceId": 15532102359, "productVersionId": "10003", "merchantId": 2000230069359, "tcode": "weimob", "cid": 821033359},
               "extendInfo": {"wxTemplateId": 8105, "analysis": [], "bosTemplateId": 1000002154, "childTemplateIds": [{"customId": 90004, "version": "crm@0.1.81"}, {"customId": 90002, "version": "ec@80.0"}, {"customId": 90006, "version": "hudong@0.0.251"}, {"customId": 90008, "version": "cms@0.0.524"}, {"customId": 90070, "version": "1.0.12"}],
                         "quickdeliver": {"enable": True}, "youshu": {"enable": False}, "source": 1, "channelsource": 5, "refer": "onecrm-signgift", "mpScene": 1005},
               "queryParameter": None, "i18n": {"language": "zh", "timezone": "8"}, "pid": "", "storeId": "", "customInfo": {"source": 0, "wid": 11983225884}}
    try:
        response = request_with_proxy("POST", SIGN_SUBMIT_URL, headers=common_headers(token, extra_headers), json=payload, proxies=proxies, server=server)
        data = response.json()
        print(f"📝 [签到] 响应数据: {json_preview(data)}")
        
        if str(data.get("errcode")) == "0":
            sign_data = data.get("data", {})
            is_sign = sign_data.get("isSign", False)
            reward_info = sign_data.get("rewardInfo", {})
            reward_name = reward_info.get("rewardName", "签到奖励")
            integral = reward_info.get("integral", 0) or reward_info.get("score", 0)
            
            if is_sign:
                return True, f"签到成功: {reward_name} +{integral}积分", int(integral) if integral else 0
            return True, "签到成功", 0
        return False, data.get("errmsg", "签到失败"), 0
    except Exception as exc:
        return False, f"签到异常: {exc}", 0


def run_account(index: int, total: int, openid: str) -> Dict[str, Any]:
    result = {"openid": openid[:10]+"...", "success": False, "proxyStatus": "未使用代理", "proxyIp": "-", "token": "-",
              "signMsg": "-", "earnedIntegral": "0", "error": ""}

    log_account_header(index, total, openid[:10]+"...")
    proxies, proxy_ip = get_valid_proxy(openid[:10])
    result["proxyStatus"] = "使用专属代理" if proxies else "使用直连"
    result["proxyIp"] = proxy_ip or "-"
    sleep(PROXY_FETCH_INTERVAL)

    delay = random.randint(2, 6)
    print(f"⏳ [延迟] 启动延迟 {delay}s")
    sleep(delay)

    code = get_code(openid)
    if not code:
        result["error"] = "获取 code 失败"
        return result

    token, raw_login = login_by_code(openid[:10], code, proxies)
    if not token:
        result["error"] = f"登录失败: {json_preview(raw_login)}"
        return result

    result["token"] = mask(token)

    try:
        sleep(random.randint(1, 3))
        print("📝 [签到] 检查签到状态...")
        is_signed, sign_data = check_sign_status(openid[:10], token, proxies)
        
        if is_signed:
            result["signMsg"] = "今日已签到"
            result["earnedIntegral"] = "0"
            print(f"✅ [签到] 今日已签到")
        else:
            print("📝 [签到] 未签到，开始签到...")
            sign_ok, sign_msg, earned = submit_signin(openid[:10], token, proxies)
            result["signMsg"] = sign_msg
            result["earnedIntegral"] = str(earned)
            if sign_ok:
                print(f"✅ [签到] {sign_msg}")
            else:
                print(f"⚠️ [签到] {sign_msg}")

        sleep(random.randint(1, 3))
        result["success"] = True
        return result

    except Exception as exc:
        result["error"] = traceback.format_exc().strip()
        print(f"❌ [账号] 执行失败: {exc}")
        return result


def build_notify(results: List[Dict[str, Any]]) -> str:
    success_count = sum(1 for item in results if item["success"])
    fail_count = len(results) - success_count
    total_earned = sum(int(item.get("earnedIntegral", 0)) for item in results if item.get("success"))

    content = f"""🏠 优智云家四账号任务结果

━━━━━━━━━━━━━━━━━━━━
🏁 总结：{success_count} 成功 / {fail_count} 失败
💰 总获得积分：{total_earned}
🕒 时间：{now_text()}
━━━━━━━━━━━━━━━━━━━━
"""

    for idx, res in enumerate(results, 1):
        icon = "✅" if res["success"] else "❌"
        content += f"""
🧩 账号 {idx}
🌍 来源：{res["openid"]}
🌐 代理：{res["proxyStatus"]}
📡 出口IP：{res["proxyIp"]}
🔐 Token：{res["token"]}
📝 签到：{res["signMsg"]}
💰 获得：{res["earnedIntegral"]} 积分
{icon} 结果：{"成功" if res["success"] else "失败"}
"""
        if not res["success"]:
            content += f"❌ 原因：{res['error']}\n"
        content += "━━━━━━━━━━━━━━━━━━━━\n"
    return content


def main() -> None:
    log_title()
    results: List[Dict[str, Any]] = []

    accounts = [x.strip() for x in os.getenv(CK_NAME, "").replace("&", "\n").splitlines() if x.strip()]
    if not accounts:
        print("❌ 未检测到 wx_opinion 账号，退出")
        return

    for index, openid in enumerate(accounts, 1):
        try:
            result = run_account(index, len(accounts), openid)
            results.append(result)
        except Exception as exc:
            print(f"❌ [主程序] {openid[:10]}... 执行异常: {exc}")
            results.append({"openid": openid[:10]+"...", "success": False, "proxyStatus": "-", "proxyIp": "-", "token": "-",
                           "signMsg": "-", "earnedIntegral": "0", "error": traceback.format_exc().strip()})
        if index < len(accounts):
            print("⏳ [间隔] 等待 2s 后处理下一个账号")
            sleep(2)

    success_count = sum(1 for item in results if item["success"])
    fail_count = len(results) - success_count

    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🏁 优智云家任务执行完成                      ║")
    print(f"║ ✅ 成功: {success_count:<39}║")
    print(f"║ ❌ 失败: {fail_count:<39}║")
    print(f"║ 🕒 结束时间: {now_text():<32}║")
    print("╚" + "═" * 50 + "╝")

    send_pushplus("🏠 优智云家四账号任务完成", build_notify(results))


if __name__ == "__main__":
    main()