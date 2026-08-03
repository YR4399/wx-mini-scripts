from __future__ import annotations
# ========== SSL和代理修复 ==========
from __future__ import annotations
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
微信支付优惠券每日领取脚本 - 修正 APPID
"""

import json
import os
import secrets
import string
import sys
import time
from typing import Any

import requests

# ========== 推送通知 ==========
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _push_helper import push_notify
    from _push_helper import send_push_notify  # 自动采集日志并推送

except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========


# ==================== 配置区 ====================
# 微信支付小程序 APPID（不是谷雨的！）
WXPAY_APPID = "wxdb3c0e388702f785"
# 谷雨 APPID（用于获取 code）
GUYU_APPID = "wxda948f3be0afc375"

wx_server_url = os.environ.get('wx_server_url', 'https://xxx')
wx_auth = os.environ.get('wx_auth', '')
GUYU_USERS = os.environ.get('wx_opinion', '') or os.environ.get('guyu', '')

CODE_COUNT = 1
TARGET_COUPON_ID: int | None = None
API_TIMEOUT = 15
CODE_TIMEOUT = 35

DOMAIN = "https://discount.wxpapp.wechatpay.cn"
PAGE = "pages/gift/index"
MODULE_NAME = "mmpaytxbbsmp"
PAGE_FRAME_VERSION = "180"
SESSION_SCENE = "daily_reward"
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; Mobile) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
    "Chrome/132.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.50 NetType/WIFI Language/zh_CN "
    "ABI/arm64 MiniProgramEnv/android"
)


class ClaimError(RuntimeError):
    pass


def get_wx_code(openid: str) -> str | None:
    """
    调用 WCS 服务获取微信小程序 code
    使用微信支付的 APPID
    """
    try:
        print(f'  调用 WCS 服务获取 Code...')
        print(f'  使用 APPID: {WXPAY_APPID}')
        
        response = requests.post(
            f"{wx_server_url}/wx/code",
            json={
                "appid": WXPAY_APPID,  # 使用微信支付的 APPID
                "openid": openid
            },
            headers={
                "auth": wx_auth,
                "Content-Type": "application/json"
            },
            timeout=CODE_TIMEOUT,
            verify=False)
        
        if response.status_code == 200:
            data = response.json()
            print(f'  响应: {json.dumps(data, ensure_ascii=False)[:200]}')
            
            if isinstance(data, dict) and data.get('status'):
                code_data = data.get('data', {})
                code = code_data.get('code') if isinstance(code_data, dict) else None
                
                if code:
                    print(f'  ✅ 获取到 Code: {code}')
                    return code
        
        print(f'  ❌ 获取失败: {response.text[:200]}')
        return None
        
    except Exception as e:
        print(f'  ❌ 异常: {e}')
        return None


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    print("=" * 60)
    print("微信支付优惠券领取脚本")
    print("=" * 60)

    if not wx_server_url or wx_server_url == 'https://xxx':
        print("❌ 未配置 wx_server_url")
        return 1
    
    if not wx_auth:
        print("❌ 未配置 wx_auth")
        return 1
    
    if not GUYU_USERS:
        print("❌ 未配置 guyu（用户 OpenID 列表）")
        return 1

    openids = [u.strip() for u in GUYU_USERS.split('&') if u.strip()]
    if not openids:
        print("❌ 未获取到有效账号")
        return 1

    print(f"✅ 配置检查通过")
    print(f"   服务器: {wx_server_url}")
    print(f"   账号数: {len(openids)}")
    print()

    ok_count = 0
    for index, openid in enumerate(openids, start=1):
        prefix = f"🌸 账号[{index}]"
        try:
            result = run_account(openid)
            print_success(prefix, openid, result)
            ok_count += 1
        except Exception as err:
            print(f"{prefix} ❌ 处理失败（{mask_openid(openid)}）")
            print(f"{prefix} 错误：{err}")
        print()

    print("=" * 60)
    print(f"执行完成: 成功 {ok_count}/{len(openids)}")
    print("=" * 60)
    
    return 0 if ok_count == len(openids) else 1


def run_account(openid: str) -> dict[str, Any]:
    track_id = make_track_id()
    session = requests.Session()
    session.verify = False

    # 获取微信小程序 code（使用微信支付 APPID）
    code = get_wx_code(openid)
    
    if not code:
        raise ClaimError("获取 Code 失败")
    
    print(f'  Code 长度: {len(code)}')
    
    # 立即使用 code 登录
    session_token, used_code_index = login_with_codes(session, [code], track_id)
    
    # 查询优惠券
    coupons = query_coupons(session, session_token, track_id)
    coupon = select_coupon(coupons)

    if coupon is None:
        claimed_coupon = next((item for item in coupons if item.get("is_claimed")), None)
        return {
            "code_count": 1,
            "used_code_index": used_code_index,
            "status": "already_claimed" if claimed_coupon else "no_daily",
            "coupon": claimed_coupon,
        }

    if coupon.get("is_claimed"):
        status = "already_claimed"
    else:
        claim_coupon(session, session_token, track_id, coupon)
        status = "claimed"

    return {
        "code_count": 1,
        "used_code_index": used_code_index,
        "status": status,
        "coupon": coupon,
    }


def login_with_codes(session: requests.Session, codes: list[str], track_id: str) -> tuple[str, int]:
    errors: list[str] = []
    for index, code in enumerate(codes, start=1):
        try:
            print(f'  使用 Code 登录 ({index}/{len(codes)})...')
            
            data = api_get(
                session,
                "/txbbs-user/user/login",
                headers=make_headers(track_id, jscode=code),
            )
            token = data.get("session_token")
            if not isinstance(token, str) or not token:
                raise ClaimError(f"登录返回缺少 session_token：{data}")
            
            print(f'  ✅ 登录成功')
            return token, index
            
        except Exception as err:
            errors.append(f"第{index}个code失败：{err}")
            print(f'  ❌ {err}')
    
    raise ClaimError("全部 code 登录失败：" + "；".join(errors))


def query_coupons(session: requests.Session, session_token: str, track_id: str) -> list[dict[str, Any]]:
    data = api_get(
        session,
        "/txbbs-mall/coupon/querydailygiftcoupons",
        headers=make_headers(track_id, session_token=session_token),
    )
    items = data.get("coupon_items")
    if not isinstance(items, list):
        raise ClaimError(f"查询返回缺少 coupon_items：{data}")
    return [item for item in items if isinstance(item, dict)]


def select_coupon(coupons: list[dict[str, Any]]) -> dict[str, Any] | None:
    if TARGET_COUPON_ID is not None:
        return next((item for item in coupons if coupon_id(item) == TARGET_COUPON_ID), None)
    return next((item for item in coupons if not item.get("is_claimed") and coupon_id(item)), None)


def claim_coupon(
    session: requests.Session,
    session_token: str,
    track_id: str,
    coupon: dict[str, Any],
) -> None:
    cid = coupon_id(coupon)
    gift_type = coupon.get("daily_gift_type")
    amount = coupon_face_value(coupon)

    if not isinstance(cid, int):
        raise ClaimError(f"券缺少 coupon_id：{coupon}")
    if not isinstance(gift_type, str) or not gift_type:
        raise ClaimError(f"券缺少 daily_gift_type：{coupon}")
    if not isinstance(amount, int):
        raise ClaimError(f"券缺少 face_value：{coupon}")

    api_post(
        session,
        "/txbbs-mall/coupon/claimdailygiftcoupon",
        headers=make_headers(
            track_id,
            session_token=session_token,
            session_id=make_session_id(),
        ),
        json={
            "daily_gift_type": gift_type,
            "coupon_id": cid,
            "expected_send_amount": amount,
        },
    )


def print_success(prefix: str, openid: str, result: dict[str, Any]) -> None:
    print(f"{prefix} ✅ 登录成功（{mask_openid(openid)}）")
    print(f"{prefix} Code：使用第{result['used_code_index']}个")

    coupon = result.get("coupon")
    if not isinstance(coupon, dict):
        print(f"{prefix} 未查询到每日额度")
        return

    name = coupon_name(coupon)
    amount = coupon_amount(coupon)
    status = result.get("status")

    if status == "claimed":
        print(f"{prefix} ✅ 领取成功：{name}")
        print(f"{prefix} 到账额度：{amount}")
    elif status == "already_claimed":
        print(f"{prefix} 今日已领取：{name}")
        print(f"{prefix} 当前额度：{amount}")
    else:
        print(f"{prefix} 未查询到每日额度")


def _req_with_retry(fn, action: str, retries: int = 3) -> requests.Response:
    """带退避重试的请求执行，缓解微信支付域偶发读超时"""
    import time as _t
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            return fn()
        except (requests.Timeout, requests.ConnectionError) as err:
            last_err = err
            if attempt < retries:
                print(f"  ⏳ {action} 第{attempt}次超时/连接失败，{attempt * 2}s 后重试...")
                _t.sleep(attempt * 2)
    raise last_err


def api_get(session: requests.Session, path: str, *, headers: dict[str, str]) -> dict[str, Any]:
    response = _req_with_retry(
        lambda: session.get(f"{DOMAIN}{path}", headers=headers, timeout=API_TIMEOUT),
        path,
    )
    return unwrap_response(response, path)


def api_post(
    session: requests.Session,
    path: str,
    *,
    headers: dict[str, str],
    json: dict[str, Any],
) -> dict[str, Any]:
    response = _req_with_retry(
        lambda: session.post(f"{DOMAIN}{path}", headers=headers, json=json, timeout=API_TIMEOUT),
        path,
    )
    return unwrap_response(response, path)


def unwrap_response(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
        payload = response.json()
    except Exception as err:
        raise ClaimError(f"{action} 请求失败：{err}，响应：{response.text}") from err

    if not isinstance(payload, dict):
        raise ClaimError(f"{action} 返回格式异常：{payload!r}")
    if payload.get("errcode") != 0:
        raise ClaimError(f"{action} 返回失败：errcode={payload.get('errcode')}，{payload}")

    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def make_headers(
    track_id: str,
    *,
    jscode: str | None = None,
    session_token: str | None = None,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Page": PAGE,
        "X-Track-Id": track_id,
        "xweb_xhr": "1",
        "X-Module-Name": MODULE_NAME,
        "X-Appid": WXPAY_APPID,  # 重要：使用微信支付的 APPID
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": f"https://servicewechat.com/{WXPAY_APPID}/{PAGE_FRAME_VERSION}/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if jscode:
        headers["jscode"] = jscode
    if session_token:
        headers["session-token"] = session_token
    if session_id:
        headers["session-id"] = session_id
    return headers


def make_track_id() -> str:
    return "T" + "".join(secrets.choice("0123456789ABCDEF") for _ in range(31))


def make_session_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    random_part = "".join(secrets.choice(alphabet) for _ in range(10))
    return f"{SESSION_SCENE}-{int(time.time() * 1000)}-{random_part}"


def coupon_info(coupon: dict[str, Any]) -> dict[str, Any]:
    value = coupon.get("coupon_info")
    return value if isinstance(value, dict) else {}


def coupon_id(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("coupon_id")
    return value if isinstance(value, int) else None


def coupon_face_value(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("face_value")
    return value if isinstance(value, int) else None


def coupon_name(coupon: dict[str, Any]) -> str:
    name = coupon_info(coupon).get("name")
    if isinstance(name, str) and name:
        return name
    return f"coupon_id={coupon_id(coupon)}"


def coupon_amount(coupon: dict[str, Any]) -> str:
    amount = coupon_face_value(coupon)
    if not isinstance(amount, int):
        return "未知额度"
    return f"{amount // 100}元" if amount % 100 == 0 else f"{amount / 100:.2f}元"


def mask_openid(openid: str) -> str:
    return openid if len(openid) <= 12 else f"{openid[:6]}...{openid[-4:]}"


if __name__ == "__main__":
    raise SystemExit(main())
