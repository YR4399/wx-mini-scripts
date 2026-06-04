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

#!/usr/bin/env python3
"""
溪云严选 - wechatserver 自动获取 code 版本
基于 xiyun_final.py 改造，集成 wechatserver 实现 wx.login code 自动获取

环境变量:
  XIYUN_YANXUAN   - 账号配置，格式 userKey@scene（多账号 & 分隔）
                    userKey 可以填账号序号(如1,2,3)自动算MD5，或直接填8位hex
                    示例: "1@1256&2@1256&3@1256"
  WX_SERVER_URL   - wechatserver 地址，默认 http://localhost:8787
  WX_SERVER_APIKEY - wechatserver APIKEY，必须配置
  XIYUN_DEBUG     - 设为 1 开启调试日志
  XIYUN_VIDEO_MIN_INTERVAL / XIYUN_VIDEO_MAX_INTERVAL - 看广告间隔秒数
  XIYUN_AUTO_WITHDRAW - 设为 1 自动提现（默认1）
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

try:
    import httpx
except ImportError:
    print("[ERROR] 缺少依赖 httpx, 请执行: pip install httpx")
    sys.exit(1)

try:
    sys.path.append("/ql/scripts")
    sys.path.append("/ql/data/scripts")
    from notify import send
except Exception:
    def send(title: str, content: str) -> None:
        pass


# ═══════════════════════════════════════════════════════════
# 常量配置（从抓包数据更新）
# ═══════════════════════════════════════════════════════════

BASE_URL = "https://cid-cps-api.heliang.cc"
APP_ID = "wx1661b44e984b6fcb"          # 抓包确认的 appid
DEFAULT_VERSION = "2.0.73"
REFERER_VERSION = "91"                  # 抓包 referer 中的版本号

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf254186b) XWEB/19481"
)
REFERER = f"https://servicewechat.com/{APP_ID}/{REFERER_VERSION}/page-frame.html"

# wechatserver 配置（兼容呆呆面板注入的小写环境变量）
WX_SERVER_URL = os.getenv("wx_server_url") or os.getenv("WX_SERVER_URL", "http://localhost:8787")
WX_SERVER_APIKEY = os.getenv("wx_auth") or os.getenv("WX_SERVER_APIKEY", "")

# 登录接口的固定设备信息（从抓包提取，无需每次变）
LOGIN_DEVICE_INFO = {
    "appBaseInfo": {
        "language": "zh_CN",
        "theme": "light",
        "version": "4.1.8.107",
        "statusBarHeight": 20,
        "SDKVersion": "3.16.0",
        "PCKernelVersion": "2.4.1",
        "enableDebug": False,
        "host": {"appId": "", "env": "WeChat"},
        "appName": "weixin",
    },
    "deviceInfo": {
        "CPUType": "11th Gen Intel(R) Core(TM) i5-11320H @ 3.20GHz",
        "benchmarkLevel": -1,
        "brand": "microsoft",
        "memorySize": 16167,
        "model": "microsoft",
        "platform": "windows",
        "system": "Windows Unknown x64",
        "statusBarHeight": 20,
        "SDKVersion": "3.16.0",
        "PCKernelVersion": "2.4.1",
    },
    "deviceBenchmark": {"canIUse": 0, "benchmarkLevel": -1, "modelLevel": 0},
    "windowInfo": {
        "pixelRatio": 1.75,
        "safeArea": {"bottom": 782, "height": 782, "left": 0, "right": 416, "top": 0, "width": 416},
        "screenHeight": 782,
        "screenWidth": 416,
        "statusBarHeight": 20,
        "windowHeight": 782,
        "windowWidth": 416,
        "SDKVersion": "3.16.0",
        "PCKernelVersion": "2.4.1",
    },
}

MAX_RETRY = 3
DEFAULT_TIMEOUT = 20.0


# ═══════════════════════════════════════════════════════════
# Logger
# ═══════════════════════════════════════════════════════════

def _build_logger() -> logging.Logger:
    lvl = logging.DEBUG if os.getenv("XIYUN_DEBUG") == "1" else logging.INFO
    lg = logging.getLogger("xiyun")
    lg.setLevel(lvl)
    if not lg.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] [%(rid)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        lg.addHandler(h)
    return lg

LOG = _build_logger()


class _RidFilter(logging.Filter):
    def __init__(self, rid: str) -> None:
        super().__init__()
        self.rid = rid

    def filter(self, record: logging.LogRecord) -> bool:
        record.rid = self.rid
        return True


def _mask(v: str | None, keep: int = 4) -> str:
    if not v:
        return "-"
    if len(v) <= keep * 2:
        return v[:keep] + "***"
    return f"{v[:keep]}***{v[-keep:]}"


# ═══════════════════════════════════════════════════════════
# 账号解析（新格式: userKey@scene）
# ═══════════════════════════════════════════════════════════

@dataclass
class Account:
    user_key: str       # wechatserver userKey（8位hex）
    account_num: int    # 原始账号序号（用于显示）
    scene: str
    x_web_id: str = ""
    token: str = ""     # 登录后获取的 x-token
    label: str = ""
    summary: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.x_web_id:
            self.x_web_id = str(uuid.uuid4())
        if not self.label:
            self.label = f"账号{self.account_num}({_mask(self.user_key, 4)})"


class AccountConfigError(ValueError):
    pass


def _derive_user_key(account_num: int) -> str:
    """根据账号序号计算 wechatserver userKey = MD5(APIKEY + num)[:8]"""
    if not WX_SERVER_APIKEY:
        raise AccountConfigError("未配置 WX_SERVER_APIKEY，无法自动计算 userKey")
    raw = WX_SERVER_APIKEY + str(account_num)
    return hashlib.md5(raw.encode()).hexdigest()[:8]


def parse_accounts(raw: str) -> list[Account]:
    accs: list[Account] = []
    if not raw:
        return accs
    for idx, chunk in enumerate(raw.split("&"), 1):
        chunk = chunk.strip()
        if not chunk:
            continue

        # scene 可选，默认 1256
        scene = "1256"
        if "@" in chunk:
            head, s = chunk.rsplit("@", 1)
            s = s.strip()
            if s:
                scene = s
                chunk = head
            else:
                chunk = head
        else:
            head = chunk

        x_web_id = ""
        if "#" in head:
            head, x_web_id = head.split("#", 1)
            x_web_id = x_web_id.strip()

        key_str = head.strip()
        if not key_str:
            raise AccountConfigError(f"账号#{idx} userKey 为空")

        # 判断是序号、8位hex、还是完整MD5(32位hex)、还是openid
        if key_str.isdigit():
            account_num = int(key_str)
            user_key = _derive_user_key(account_num)
        elif len(key_str) == 8 and all(c in "0123456789abcdef" for c in key_str.lower()):
            user_key = key_str.lower()
            account_num = idx
        elif len(key_str) == 32 and all(c in "0123456789abcdef" for c in key_str.lower()):
            user_key = key_str.lower()[:8]
            account_num = idx
        elif len(key_str) >= 20 and all(c.isalnum() or c in "-_" for c in key_str):
            # openid 格式 (如 owNAX6j83m4TzrbIA5R3iNXM1iY0)
            user_key = key_str
            account_num = idx
        else:
            raise AccountConfigError(
                f"账号#{idx} userKey 格式错误: '{key_str}'，请填序号(如1)、8位hex、openid"
            )

        accs.append(Account(
            user_key=user_key,
            account_num=account_num,
            scene=scene,
            x_web_id=x_web_id,
        ))
    return accs


# ═══════════════════════════════════════════════════════════
# wechatserver 交互
# ═══════════════════════════════════════════════════════════

async def get_wx_code(user_key: str, appid: str) -> str:
    """从 wechatserver 获取 wx.login code"""
    url = f"{WX_SERVER_URL}/wx/code"
    body = {
        "userKey": user_key,
        "openid": user_key,
        "appid": appid,
    }
    headers = {
        "Content-Type": "application/json",
        "AUTH": WX_SERVER_APIKEY,
    }
    LOG.debug("请求 wechatserver code: userKey=%s appid=%s", user_key, appid)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"wechatserver 返回 HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json()

    inner = data.get("data")
    code = data.get("code") or (inner.get("code") if isinstance(inner, dict) else "") or ""
    if not code:
        raise RuntimeError(f"wechatserver 未返回 code: {json.dumps(data, ensure_ascii=False)[:300]}")
    LOG.debug("获取 code 成功: %s", _mask(code, 6))
    return code


async def login_with_code(code: str, scene: str, x_web_id: str) -> str:
    """用 wx.login code 调用 /user/login 获取 x-token"""
    payload = {
        **LOGIN_DEVICE_INFO,
        "launchOptions": {
            "path": "pages/index/index",
            "query": {},
            "scene": int(scene),
            "referrerInfo": {},
            "apiCategory": "default",
        },
        "code": code,
        "errMsg": "login:ok",
    }
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "mp-platform": "weapp",
        "appid": APP_ID,
        "x-web-id": x_web_id,
        "xweb_xhr": "1",
        "scene": scene,
        "pageurl-pre": "%2F",
        "pageurl": "pages%2Findex%2Findex",
        "content-type": "application/json;charset=UTF-8",
        "version": DEFAULT_VERSION,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "referer": REFERER,
        "accept-language": "zh-CN,zh;q=0.9",
        "priority": "u=1, i",
    }

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        resp = await client.post(
            f"{BASE_URL}/user/login",
            content=json.dumps(payload),
            headers=headers,
        )

    if resp.status_code != 200:
        raise RuntimeError(f"登录接口 HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    err = data.get("error_code")
    msg = data.get("msg", "")
    if err and err != 0:
        raise BusinessError(err, msg, data)

    resp_data = data.get("data") or {}
    # 尝试多种可能的 token 字段名
    token = (
        resp_data.get("token")
        or resp_data.get("x_token")
        or resp_data.get("x-token")
        or resp_data.get("access_token")
        or ""
    )
    if not token:
        # 如果都找不到，打印响应让用户确认字段名
        LOG.debug("登录响应 data: %s", json.dumps(resp_data, ensure_ascii=False)[:500])
        raise RuntimeError(
            f"登录成功但未找到 token 字段，请检查响应。data keys: {list(resp_data.keys())}"
        )
    return token


# ═══════════════════════════════════════════════════════════
# 业务错误
# ═══════════════════════════════════════════════════════════

class BusinessError(Exception):
    def __init__(self, code: int | None, msg: str, raw: dict[str, Any]):
        super().__init__(f"[{code}] {msg}")
        self.code = code
        self.msg = msg
        self.raw = raw


def _url_encode(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


# ═══════════════════════════════════════════════════════════
# 溪云严选客户端
# ═══════════════════════════════════════════════════════════

class XiYunClient:
    def __init__(self, account: Account) -> None:
        self.account = account
        self.rid = account.label
        self.adapter = logging.LoggerAdapter(LOG, {"rid": self.rid})
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=DEFAULT_TIMEOUT,
            headers={
                "User-Agent": UA,
                "Referer": REFERER,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "content-type": "application/json;charset=UTF-8",
                "mp-platform": "weapp",
                "appid": APP_ID,
                "version": DEFAULT_VERSION,
                "x-web-id": account.x_web_id,
                "scene": account.scene,
                "x-token": account.token,
                "xweb_xhr": "1",
            },
            http2=False,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def post(
        self,
        path: str,
        data: dict[str, Any] | None = None,
        page_url: str = "pages/package/cashback/index",
        page_url_pre: str = "pages/user/index",
    ) -> dict[str, Any]:
        body = data if data is not None else {}
        headers = {
            "pageurl": _url_encode(page_url),
            "pageurl-pre": _url_encode(page_url_pre),
        }
        last_exc: Exception | None = None
        for attempt in range(1, MAX_RETRY + 1):
            t0 = time.time()
            try:
                resp = await self._client.post(path, json=body, headers=headers)
                cost = int((time.time() - t0) * 1000)
                if resp.status_code != 200:
                    self.adapter.warning(
                        "HTTP %s %s status=%s cost=%dms",
                        "POST", path, resp.status_code, cost,
                    )
                    raise httpx.HTTPStatusError(
                        f"status {resp.status_code}",
                        request=resp.request, response=resp,
                    )
                j = resp.json()
                err = j.get("error_code")
                msg = j.get("msg", "")
                self.adapter.debug(
                    "%s -> err=%s msg=%s cost=%dms", path, err, msg, cost
                )
                if err != 0:
                    raise BusinessError(err, msg, j)
                return j.get("data") or {}
            except BusinessError:
                raise
            except Exception as exc:
                last_exc = exc
                wait = (2 ** (attempt - 1)) + random.uniform(0, 0.8)
                self.adapter.warning(
                    "请求异常 path=%s attempt=%d/%d err=%s 等待 %.1fs",
                    path, attempt, MAX_RETRY, exc, wait,
                )
                await asyncio.sleep(wait)
        assert last_exc is not None
        raise last_exc


# ═══════════════════════════════════════════════════════════
# 任务函数（与原脚本一致）
# ═══════════════════════════════════════════════════════════

async def task_user_info(c: XiYunClient) -> dict[str, Any]:
    info = await c.post("/user/info", page_url="pages/user/index", page_url_pre="/")
    nick = info.get("nickname") or "-"
    uid = info.get("id")
    c.adapter.info("账号: %s (id=%s)", nick, uid)
    c.account.summary.append(f"账号: {nick} (id={uid})")
    return info


async def task_checkin(c: XiYunClient) -> None:
    dlg = await c.post(
        "/activity/checkin/dialog", page_url="pages/user/index", page_url_pre="/"
    )
    if dlg.get("is_signed_today"):
        c.adapter.info("签到: 今日已签")
        c.account.summary.append("签到: 今日已签")
        return
    try:
        r = await c.post("/activity/checkin")
        coin = r.get("coin", 0)
        days = r.get("continue_days", 0)
        c.adapter.info("签到成功 +%s金币 连续%s天", coin, days)
        c.account.summary.append(f"签到: +{coin}金币 连续{days}天")
    except BusinessError as e:
        c.adapter.warning("签到失败: %s", e)
        c.account.summary.append(f"签到: 失败 {e.msg}")


async def _get_video_progress(c: XiYunClient) -> tuple[int, int]:
    data = await c.post("/activity/task/list")
    for t in data.get("tasks") or []:
        if t.get("task_key") == "watch_video":
            return int(t.get("current_count", 0)), int(t.get("daily_limit", 10))
    return 0, 10


async def task_videos(c: XiYunClient) -> None:
    try:
        cur, lim = await _get_video_progress(c)
    except Exception as e:
        c.adapter.warning("获取视频进度失败: %s, 默认 0/10", e)
        cur, lim = 0, 10
    if cur >= lim:
        c.adapter.info("看广告任务已完成 %d/%d", cur, lim)
        c.account.summary.append(f"看广告: 已完成 {cur}/{lim}")
        return
    c.adapter.info("看广告进度 %d/%d, 开始领取剩余 %d 次", cur, lim, lim - cur)
    min_iv = float(os.getenv("XIYUN_VIDEO_MIN_INTERVAL", "30"))
    max_iv = float(os.getenv("XIYUN_VIDEO_MAX_INTERVAL", "60"))
    total_coin = 0
    success = 0
    for i in range(cur, lim):
        wait = random.uniform(min_iv, max_iv)
        c.adapter.info("模拟观看第 %d/%d 次, 等待 %.1fs", i + 1, lim, wait)
        await asyncio.sleep(wait)
        try:
            r = await c.post("/activity/video/reward")
            amt = int(r.get("reward_amount", 0))
            cnt = int(r.get("current_count", i + 1))
            tot = int(r.get("total_amount", 0))
            success += 1
            total_coin = tot
            c.adapter.info(
                "第 %d 次奖励 +%d金币 累计%d 进度 %d/%d", cnt, amt, tot, cnt, lim
            )
        except BusinessError as e:
            c.adapter.warning("领奖失败: %s, 中止后续", e)
            break
        except Exception as e:
            c.adapter.warning("领奖异常: %s", e)
            break
    c.account.summary.append(f"看广告: +{total_coin}金币 ({success}次)")


async def task_to_rmb(c: XiYunClient) -> None:
    try:
        await c.post("/coin/to-rmb", data={"version": 1})
        c.adapter.info("金币转 RMB 完成")
    except BusinessError as e:
        c.adapter.info("金币转 RMB: %s", e.msg)
    except Exception as e:
        c.adapter.warning("金币转 RMB 失败: %s", e)


async def task_withdraw(c: XiYunClient) -> None:
    if os.getenv("XIYUN_AUTO_WITHDRAW", "1") != "1":
        return
    try:
        items = await c.post("/coin/withdrawal-list")
    except Exception as e:
        c.adapter.warning("获取提现列表失败: %s", e)
        return
    available = (
        [x for x in items if x.get("is_available")] if isinstance(items, list) else []
    )
    if not available:
        c.adapter.info("无可提现项")
        return
    rmb_sum = 0.0
    ok = 0
    for it in available:
        pid = it.get("permission_id") or 0
        amt = it.get("amount")
        rmb = it.get("rmb", "0")
        try:
            await c.post(
                "/coin/withdrawal",
                data={"permission_id": pid, "amount": amt},
            )
            ok += 1
            try:
                rmb_sum += float(rmb)
            except ValueError:
                pass
            c.adapter.info("提现成功 amount=%s rmb=%s pid=%s", amt, rmb, pid)
            await asyncio.sleep(random.uniform(1.5, 3.0))
        except BusinessError as e:
            c.adapter.warning("提现失败 amount=%s err=%s", amt, e.msg)
        except Exception as e:
            c.adapter.warning("提现异常 amount=%s err=%s", amt, e)
    if ok:
        c.account.summary.append(f"提现: 成功{ok}笔 共{rmb_sum:.2f}元")
    else:
        c.account.summary.append("提现: 无成功")


async def task_balance(c: XiYunClient) -> None:
    try:
        d = await c.post("/coin/mine")
        coin = d.get("coin", 0)
        left = d.get("left_amount", "0")
        transfer = d.get("transfer_amount", "0")
        c.adapter.info("余额: 金币=%s 余额=%s 已转出=%s", coin, left, transfer)
        c.account.summary.append(f"余额: 金币{coin} 待提现{left}元 已提现{transfer}元")
    except Exception as e:
        c.adapter.warning("查询余额失败: %s", e)


# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════

async def run_account(account: Account) -> str:
    LOG.addFilter(_RidFilter(account.label))

    # Step 1: 通过 wechatserver 获取 code
    account.summary.append(f"userKey: {account.user_key}")
    try:
        code = await get_wx_code(account.user_key, APP_ID)
        account.summary.append("wechatserver code: 获取成功")
    except Exception as e:
        msg = f"获取 code 失败: {e}"
        account.summary.append(msg)
        LOG.error(msg, extra={"rid": account.label})
        return "\n".join(account.summary)

    # Step 2: 用 code 登录获取 x-token
    try:
        token = await login_with_code(code, account.scene, account.x_web_id)
        account.token = token
        account.summary.append(f"登录: 成功 token={_mask(token, 6)}")
    except Exception as e:
        msg = f"登录失败: {e}"
        account.summary.append(msg)
        LOG.error(msg, extra={"rid": account.label})
        return "\n".join(account.summary)

    # Step 3: 执行任务
    client = XiYunClient(account)
    try:
        try:
            await task_user_info(client)
        except BusinessError as e:
            client.adapter.error("账号鉴权失败: %s, 跳过", e)
            account.summary.append(f"鉴权失败: {e.msg}")
            return "\n".join(account.summary)
        await task_checkin(client)
        await task_videos(client)
        await task_to_rmb(client)
        await task_withdraw(client)
        await task_balance(client)
    finally:
        await client.close()
    return "\n".join(account.summary)


async def amain() -> int:
    if not WX_SERVER_APIKEY:
        LOG.error("未配置环境变量 WX_SERVER_APIKEY", extra={"rid": "-"})
        return 1

    raw = os.environ.get('wx_opinion', '') or os.environ.get('XIYUN_YANXUAN', '')
    if not raw:
        LOG.error("未配置环境变量 XIYUN_YANXUAN", extra={"rid": "-"})
        LOG.error(
            "格式: userKey@scene (多账号 & 分隔)\n"
            "  userKey 可填序号(如1)自动算MD5, 或直接填8位hex\n"
            "  示例: XIYUN_YANXUAN=\"1@1256&2@1256\"",
            extra={"rid": "-"},
        )
        return 1

    try:
        accounts = parse_accounts(raw)
    except AccountConfigError as e:
        LOG.error("环境变量配置错误: %s", e, extra={"rid": "-"})
        return 1
    if not accounts:
        LOG.error("账号解析为空", extra={"rid": "-"})
        return 1

    LOG.info(
        "wechatserver=%s 共加载 %d 个账号",
        WX_SERVER_URL, len(accounts),
        extra={"rid": "-"},
    )
    summaries: list[str] = []
    for idx, acc in enumerate(accounts, 1):
        header = f"===== 账号#{idx} {acc.label} ====="
        LOG.info(header, extra={"rid": acc.label})
        try:
            s = await run_account(acc)
        except Exception as e:
            LOG.exception("账号执行异常: %s", e, extra={"rid": acc.label})
            s = f"执行异常: {e}"
        summaries.append(f"{header}\n{s}")
        if idx < len(accounts):
            await asyncio.sleep(random.uniform(2.0, 4.0))

    final = "\n\n".join(summaries)
    print("\n========== 执行总结 ==========\n" + final)
    try:
        send("溪云严选", final)
    except Exception:
        pass
    return 0


def main() -> None:
    try:
        sys.exit(asyncio.run(amain()))
    except KeyboardInterrupt:
        sys.exit(130)


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