#!/usr/bin/env python3
"""
名创优品 - wechatserver 自动登录版（带 token 缓存 + 任务完成检测）
环境变量:
  MCYX_ACCOUNT    - 账号配置，userKey（多账号 & 分隔）
                    可填序号(如1,2,3)自动算MD5，或直接填8位hex
                    示例: "1&2&3" 或 "34d20cec&8b26bd0c"
  WX_SERVER_URL   - wechatserver 地址，呆呆面板自动注入 wx_server_url
  WX_SERVER_APIKEY - wechatserver APIKEY，呆呆面板自动注入 wx_auth
  MCYX_DEBUG      - 设为 1 开启调试日志
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
# 常量配置
# ═══════════════════════════════════════════════════════════

CDN_URL = "https://cdn-storeexpress.miniso.com"
SAAS_URL = "https://api-saas.miniso.com/task-manage-platform"
EASYGO_URL = "https://api.multibrands.miniso.com"
APP_ID = "wx2a212470bade49bf"

VERSION = "storeexpress1.0"
SECRET = "ffe232&t%4df!67sx55eas"
PAGE_TYPE = "%E6%BD%AE%E7%8E%A9%E7%AD%BE%E5%88%B0%E9%A1%B5%E9%9D%A2"
LANDING_PAGE_TYPE = "%E8%90%BD%E5%9C%B0%E9%A1%B5"
ACTIVITY_ID = 18
SIGN_TASK_ID = 79
BROWSE_TIME = 20
TASK_INTERVAL = 3

ALL_BROWSE_TASKS = [
    32, 33, 41, 81, 92, 96, 98, 100, 105, 109,
    110, 111, 113, 115, 116, 117, 118, 121, 122, 123,
    124, 127, 129, 130, 132, 140, 141, 142, 146, 147,
    152, 153, 155, 156, 160, 165, 175, 176, 177, 186,
    187, 190, 200, 201, 204, 210, 211, 238, 240, 241,
    242, 243, 257, 258, 259, 260, 261, 262,
]

UA = (
    "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/8.0.65.2960 MiniProgramEnv/Android"
)
REFERER = f"https://servicewechat.com/{APP_ID}/1079/page-frame.html"

# wechatserver 配置（兼容呆呆面板注入的小写环境变量）
WX_SERVER_URL = os.getenv("wx_server_url") or os.getenv("WX_SERVER_URL", "http://localhost:8787")
WX_SERVER_APIKEY = os.getenv("wx_auth") or os.getenv("WX_SERVER_APIKEY", "")

# ── Token 缓存配置 ──
TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".mcyx_token_cache.json")
TOKEN_TTL = 8 * 3600  # 8 小时


# ═══════════════════════════════════════════════════════════
# Logger
# ═══════════════════════════════════════════════════════════

def _build_logger() -> logging.Logger:
    lvl = logging.DEBUG if os.getenv("MCYX_DEBUG") == "1" else logging.INFO
    lg = logging.getLogger("mcyx")
    lg.setLevel(lvl)
    if not lg.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        ))
        lg.addHandler(h)
    return lg


LOG = _build_logger()


# ═══════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════

def _nonce() -> str:
    chars = "1234567890qwertyuiopasdfghjklzxcvbnm"
    return ''.join(random.choice(chars) for _ in range(32))


def _sign(nonce: str, timestamp: str) -> str:
    s = f"#{VERSION}#{SECRET}#{nonce}#{timestamp}"
    return hashlib.md5(s.encode()).hexdigest().upper()


def _api_headers(uid: str, openid: str, unionid: str, skey: str = "", pagetype: str = PAGE_TYPE) -> dict:
    nonce = _nonce()
    ts = str(int(time.time() * 1000))
    return {
        "User-Agent": UA,
        "Referer": REFERER,
        "content-uid": str(uid),
        "content-skey": skey,
        "content-openid": openid,
        "content-unionid": unionid,
        "content-weappcode": "52",
        "content-appcode": "51",
        "content-sceneid": "1089",
        "content-pagetype": pagetype,
        "content-pagename": pagetype,
        "content-type": "application/json",
        "version": VERSION,
        "nonce": nonce,
        "time": ts,
        "signature": _sign(nonce, ts),
        "tenant": "MINISO",
        "tenant-code": "MINISO",
        "x-client-source": "MINISO_WX_MINI",
    }


# ═══════════════════════════════════════════════════════════
# Token 缓存（纯标准库，零外部依赖）
# ═══════════════════════════════════════════════════════════

def _load_token_cache() -> dict:
    """加载 token 缓存文件"""
    if os.path.exists(TOKEN_CACHE_FILE):
        try:
            with open(TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_token_cache(cache: dict):
    """保存 token 缓存文件"""
    try:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def _get_cached_login(user_key: str) -> dict | None:
    """读取缓存的登录信息，过期返回 None"""
    cache = _load_token_cache()
    entry = cache.get(user_key)
    if not entry:
        return None
    if time.time() - entry.get("ts", 0) > TOKEN_TTL:
        # 过期 → 清除
        del cache[user_key]
        _save_token_cache(cache)
        return None
    return entry.get("data")


def _set_cached_login(user_key: str, login_data: dict):
    """写入登录信息缓存（uid / openid / unionid / skey）"""
    cache = _load_token_cache()
    cache[user_key] = {"data": login_data, "ts": time.time()}
    _save_token_cache(cache)


def _invalidate_login(user_key: str):
    """使登录缓存失效"""
    cache = _load_token_cache()
    if user_key in cache:
        del cache[user_key]
        _save_token_cache(cache)


# ═══════════════════════════════════════════════════════════
# wechatserver 交互
# ═══════════════════════════════════════════════════════════

async def get_wx_code(client: httpx.AsyncClient, user_key: str,
                     max_retries: int = 3, retry_delay: float = 3.0) -> str:
    """从 wechatserver 获取 wx.login code（带退避重试：3s→6s→9s）"""
    body = {
        "userKey": user_key,
        "openid": user_key,
        "appid": APP_ID,
    }
    headers = {
        "Content-Type": "application/json",
        "AUTH": WX_SERVER_APIKEY,
    }

    last_error = None
    for attempt in range(max_retries):
        try:
            LOG.debug("请求 wechatserver code (attempt %d/%d): userKey=%s appid=%s",
                     attempt + 1, max_retries, user_key, APP_ID)
            resp = await client.post(
                f"{WX_SERVER_URL}/wx/code", json=body, headers=headers, timeout=60.0,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"wechatserver HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            code = data.get("code") or data.get("data", {}).get("code") or ""
            if not code:
                raise RuntimeError(f"wechatserver 未返回 code: {json.dumps(data, ensure_ascii=False)[:300]}")
            LOG.debug("获取 code 成功: %s", code)
            return code
        except (httpx.TimeoutException, httpx.RequestError) as e:
            last_error = e
            LOG.warning("[%s] /wx/code 超时/网络错误 (attempt %d/%d): %s",
                       user_key, attempt + 1, max_retries, e)
        except RuntimeError as e:
            last_error = e
            LOG.warning("[%s] /wx/code 返回异常 (attempt %d/%d): %s",
                       user_key, attempt + 1, max_retries, e)

        if attempt < max_retries - 1:
            wait = retry_delay * (attempt + 1)  # 退避: 3s → 6s → 9s
            LOG.info("[%s] %ds 后重试...", user_key, wait)
            await asyncio.sleep(wait)

    raise RuntimeError(f"获取 code 失败，已重试 {max_retries} 次") from last_error


async def auto_login(client: httpx.AsyncClient, js_code: str) -> dict:
    """用 jsCode 调用 /wechat/miniapp/login 获取 uid/openid/unionid/skey"""
    nonce = _nonce()
    ts = str(int(time.time() * 1000))
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "content-pagetype": "%E9%A6%96%E9%A1%B5",
        "content-pagename": "%E9%A6%96%E9%A1%B5",
        "content-sceneid": "1145",
        "tenant-code": "MINISO",
        "x-mi-version": "5.1.62",
        "x-client-source": "MINISO_WX_MINI",
        "version": VERSION,
        "nonce": nonce,
        "time": ts,
        "signature": _sign(nonce, ts),
        "referer": f"https://servicewechat.com/{APP_ID}/1080/page-frame.html",
    }

    resp = await client.post(
        f"{CDN_URL}/wechat/miniapp/login",
        params={"jsCode": js_code},
        headers=headers,
        timeout=30.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"login HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    LOG.debug("login 响应: %s", json.dumps(data, ensure_ascii=False)[:500])

    if not data.get("success") or data.get("code") != 200:
        raise RuntimeError(f"login 失败: {data.get('message', '')}")

    login_data = data.get("data", {}).get("loginCJYResp", {}).get("data", {})
    uid = login_data.get("uid")
    openid = login_data.get("openid", "")
    unionid = login_data.get("unionid", "")
    skey = login_data.get("skey", "")

    if not uid or not skey:
        raise RuntimeError(
            f"登录返回数据不完整: uid={uid}, skey={'有' if skey else '无'}"
        )

    return {"uid": str(uid), "openid": openid, "unionid": unionid, "skey": skey}


# ═══════════════════════════════════════════════════════════
# 登录有效性检测
# ═══════════════════════════════════════════════════════════

async def check_login_valid(
    client: httpx.AsyncClient, uid: str, openid: str, unionid: str, skey: str
) -> bool:
    """用轻量接口检测缓存的登录信息是否有效"""
    try:
        headers = _api_headers(uid, openid, unionid, skey)
        resp = await client.get(
            f"{SAAS_URL}/api/activity/signInTask/taskDetail",
            params={"activityId": ACTIVITY_ID},
            headers=headers,
            timeout=15.0,
        )
        if resp.status_code == 200 and resp.json().get("code") == 200:
            return True
    except Exception:
        pass
    return False


# ═══════════════════════════════════════════════════════════
# 任务完成检测
# ═══════════════════════════════════════════════════════════

async def get_completed_task_ids(
    client: httpx.AsyncClient, uid: str, openid: str, unionid: str, skey: str
) -> set[int]:
    """批量查询已完成的任务 ID 集合。
    尝试多个可能的 task list 端点，成功则返回已完成任务 ID 的 set。
    全部失败返回空 set（回退到逐一执行）。
    """
    headers = _api_headers(uid, openid, unionid, skey)
    endpoints = [
        # (url, method, params_key)
        (f"{SAAS_URL}/api/activity/task/userTaskList", "GET", {}),
        (f"{SAAS_URL}/api/activity/periodTask/list", "GET", {}),
        (f"{SAAS_URL}/api/activity/task/list", "GET", {}),
        (f"{SAAS_URL}/api/activity/task/userTaskStatus", "GET", {}),
    ]

    for url, method, extra_params in endpoints:
        try:
            params = {"activityId": ACTIVITY_ID, **extra_params}
            if method == "GET":
                resp = await client.get(url, params=params, headers=headers, timeout=15)
            else:
                resp = await client.post(url, json=params, headers=headers, timeout=15)

            if resp.status_code != 200:
                continue

            data = resp.json()
            if data.get("code") != 200:
                continue

            tasks_raw = data.get("data")
            if not tasks_raw:
                continue

            # 解包可能的嵌套结构: {list, records, items, tasks}
            if isinstance(tasks_raw, dict):
                for key in ("list", "records", "items", "tasks", "taskList", "userTaskList"):
                    if key in tasks_raw:
                        tasks_raw = tasks_raw[key]
                        break
                else:
                    # 可能是单个任务对象
                    tasks_raw = [tasks_raw] if tasks_raw.get("taskId") or tasks_raw.get("id") else []

            if not isinstance(tasks_raw, list):
                tasks_raw = [tasks_raw] if tasks_raw else []

            completed: set[int] = set()
            for task in tasks_raw:
                if not isinstance(task, dict):
                    continue
                tid = task.get("taskId") or task.get("id") or task.get("task_id")
                if tid is None:
                    continue
                tid = int(tid)

                # 检查完成标记
                finish = task.get("finishFlag")
                if finish is not None:
                    if finish in (1, True, "1", "true"):
                        completed.add(tid)
                    continue

                status = task.get("status")
                if status is not None:
                    if status in (1, "completed", "done", "FINISHED", "已领取", "已完成", "已签到"):
                        completed.add(tid)
                    continue

                # 有 awardTime / receiveTime 说明已领取
                if task.get("awardTime") or task.get("receiveTime") or task.get("finishTime"):
                    completed.add(tid)

            if completed:
                LOG.info(
                    "[UID:%s] 任务预检: %d/%d 已完成",
                    uid[:8], len(completed), len(ALL_BROWSE_TASKS),
                )
                return completed
            else:
                # 端点返回了数据但没有完成标记 → 继续尝试下一个端点
                LOG.debug("[UID:%s] 端点 %s 返回了 %d 条但无完成标记", uid[:8], url, len(tasks_raw))

        except Exception as e:
            LOG.debug("[UID:%s] 任务列表查询异常 (%s): %s", uid[:8], url, e)
            continue

    LOG.info("[UID:%s] 任务预检: 无法获取任务列表，将逐一执行", uid[:8])
    return set()


def filter_pending_tasks(all_tasks: list[int], completed: set[int]) -> tuple[list[int], int]:
    """过滤出未完成的任务，返回 (待执行列表, 已跳过数)"""
    pending = [t for t in all_tasks if t not in completed]
    skipped = len(all_tasks) - len(pending)
    return pending, skipped


# ═══════════════════════════════════════════════════════════
# 名创优品业务接口
# ═══════════════════════════════════════════════════════════

async def do_sign(
    client: httpx.AsyncClient, uid: str, openid: str, unionid: str, skey: str
) -> str:
    """签到"""
    headers = _api_headers(uid, openid, unionid, skey)
    label = f"[UID:{uid[:8]}]"

    try:
        # 查询签到状态
        resp = await client.get(
            f"{SAAS_URL}/api/activity/signInTask/taskDetail",
            params={"activityId": ACTIVITY_ID},
            headers=headers,
            timeout=30.0,
        )
        data = resp.json()

        if data.get("code") != 200:
            return f"{label} 签到查询失败: {data.get('message', '')}"

        sign_data = data.get("data", {})
        if sign_data.get("todaySignInFinishFlag") == 1:
            days = sign_data.get("signInFinishDays", 0)
            tomorrow = sign_data.get("tomorrowAwardName", "")
            msg = f"{label} 今日已签到 (连续{days}天)"
            if tomorrow:
                msg += f" 明日: {tomorrow}"
            return msg

        # 上报点击
        await client.post(
            f"{SAAS_URL}/api/activity/task/uvClick",
            json={"activityId": ACTIVITY_ID, "taskId": SIGN_TASK_ID, "taskType": 1},
            headers=_api_headers(uid, openid, unionid, skey),
            timeout=30.0,
        )
        await asyncio.sleep(1)

        # 领取奖励
        resp = await client.post(
            f"{SAAS_URL}/api/activity/signInTask/award/receive",
            json={"activityId": ACTIVITY_ID, "taskId": SIGN_TASK_ID},
            headers=_api_headers(uid, openid, unionid, skey),
            timeout=30.0,
        )
        data = resp.json()

        if data.get("code") == 200:
            return f"{label} 签到成功！"
        return f"{label} 签到失败: {data.get('message', data.get('msg', ''))}"
    except Exception as e:
        return f"{label} 签到异常: {e}"


async def do_browse_task(
    client: httpx.AsyncClient, uid: str, openid: str, unionid: str, skey: str, task_id: int
) -> tuple[str, str]:
    """执行单个浏览任务，返回 (状态, 描述)
    状态: success / already / fail
    """
    label = f"[UID:{uid[:8]}] T{task_id}"

    try:
        # 上报点击
        await client.post(
            f"{SAAS_URL}/api/activity/task/uvClick",
            json={"activityId": ACTIVITY_ID, "taskId": task_id, "taskType": 5},
            headers=_api_headers(uid, openid, unionid, skey),
            timeout=30.0,
        )

        # 模拟浏览
        await asyncio.sleep(BROWSE_TIME)

        # 上报完成
        h = _api_headers(uid, openid, unionid, skey, pagetype=LANDING_PAGE_TYPE)
        await client.post(
            f"{EASYGO_URL}/multi-configure-platform/api/activity/task/browse/finish",
            json={"activityId": ACTIVITY_ID, "taskId": task_id},
            headers=h,
            timeout=30.0,
        )

        # 领取奖励
        resp = await client.post(
            f"{SAAS_URL}/api/activity/periodTask/award/receive",
            json={"activityId": ACTIVITY_ID, "taskId": task_id},
            headers=_api_headers(uid, openid, unionid, skey),
            timeout=30.0,
        )

        if resp.status_code != 200:
            return "fail", f"{label} HTTP {resp.status_code}"

        data = resp.json()
        msg = data.get("msg", data.get("message", ""))
        code = data.get("code")

        if code == 200:
            return "success", f"{label} 领奖成功"
        elif "已完成" in msg or "已领取" in msg:
            return "already", f"{label} {msg}"
        else:
            return "fail", f"{label} {msg}"
    except Exception as e:
        return "fail", f"{label} 异常: {e}"


# ═══════════════════════════════════════════════════════════
# 账号解析
# ═══════════════════════════════════════════════════════════

def _derive_user_key(account_num: int) -> str:
    """根据账号序号计算 userKey = MD5(APIKEY + num)[:8]"""
    if not WX_SERVER_APIKEY:
        raise ValueError("未配置 WX_SERVER_APIKEY，无法自动计算 userKey")
    return hashlib.md5((WX_SERVER_APIKEY + str(account_num)).encode()).hexdigest()[:8]


def parse_accounts(raw: str) -> list[str]:
    """解析账号配置，返回 userKey 列表
    支持格式:
      - 序号(如1,2,3): 自动计算 userKey = MD5(APIKEY + num)[:8]
      - 8位hex: 直接作为 userKey（旧版 wechatserver）
      - 32位MD5: 截取前8位
      - openid格式(如owNAX6...): 直接作为 userKey（新版 wechatserver）
    """
    keys: list[str] = []
    for idx, chunk in enumerate(raw.split("&"), 1):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.isdigit():
            keys.append(_derive_user_key(int(chunk)))
        elif len(chunk) == 8 and all(c in "0123456789abcdef" for c in chunk.lower()):
            keys.append(chunk.lower())
        elif len(chunk) == 32 and all(c in "0123456789abcdef" for c in chunk.lower()):
            keys.append(chunk.lower()[:8])
        elif len(chunk) >= 20 and all(c.isalnum() or c in "-_" for c in chunk):
            # openid 格式 (如 owNAX6j83m4TzrbIA5R3iNXM1iY0)
            keys.append(chunk)
        else:
            raise ValueError(
                f"账号#{idx} 格式错误: '{chunk}'，请填序号(如1)、8位hex、openid"
            )
    return keys


# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════

async def run_account(user_key: str, idx: int, semaphore: asyncio.Semaphore) -> str:
    label = f"账号#{idx}({user_key})"
    results = [f"===== {label} ====="]

    # ── 通用请求头 ──
    biz_headers = {
        "User-Agent": UA,
        "Referer": REFERER,
    }

    # ── Step 0: 尝试缓存 ──
    cached = _get_cached_login(user_key)
    if cached:
        LOG.info("[%s] 命中 token 缓存，验证有效性...", label)
        async with httpx.AsyncClient(timeout=30.0, headers=biz_headers) as check_client:
            if await check_login_valid(
                check_client, cached["uid"], cached["openid"],
                cached.get("unionid", ""), cached["skey"],
            ):
                uid = cached["uid"]
                openid = cached["openid"]
                unionid = cached.get("unionid", "")
                skey = cached["skey"]
                results.append(f"Token 缓存有效: UID={uid}")
                LOG.info("[%s] Token 缓存有效，跳过登录", label)
                # 跳到业务阶段
            else:
                LOG.info("[%s] Token 缓存失效，重新登录", label)
                cached = None
    else:
        LOG.info("[%s] 未命中缓存，开始登录...", label)

    if not cached:
        # ── 登录阶段（受信号量控制）──
        async with semaphore:
            async with httpx.AsyncClient(timeout=30.0) as login_client:
                # Step 1: wechatserver 获取 code
                try:
                    code = await get_wx_code(login_client, user_key)
                    results.append("wechatserver code: OK")
                except Exception as e:
                    msg = f"获取 code 失败: {e}"
                    results.append(msg)
                    LOG.error("[%s] %s", label, msg)
                    return "\n".join(results)

                # Step 2: login 获取身份信息 + skey
                try:
                    info = await auto_login(login_client, code)
                    uid = info["uid"]
                    openid = info["openid"]
                    unionid = info["unionid"]
                    skey = info["skey"]
                    results.append(f"登录成功: UID={uid}")
                    # 写入缓存
                    _set_cached_login(user_key, info)
                    LOG.info("[%s] Token 已缓存 (TTL=%ds)", label, TOKEN_TTL)
                except Exception as e:
                    msg = f"登录失败: {e}"
                    results.append(msg)
                    LOG.error("[%s] %s", label, msg)
                    return "\n".join(results)

    # ── 任务阶段（登录后不受信号量限制）──
    async with httpx.AsyncClient(timeout=30.0, headers=biz_headers) as biz_client:
        # ── 签到 ──
        sign_result = await do_sign(biz_client, uid, openid, unionid, skey)
        results.append(sign_result)
        LOG.info("[%s] %s", label, sign_result)

        # ── 任务预检：查询已完成任务 ──
        completed_ids = await get_completed_task_ids(biz_client, uid, openid, unionid, skey)
        pending_tasks, pre_skipped = filter_pending_tasks(ALL_BROWSE_TASKS, completed_ids)

        if pre_skipped > 0:
            results.append(f"任务预检: 跳过 {pre_skipped} 个已完成任务")
            LOG.info("[%s] 跳过 %d 个已完成任务", label, pre_skipped)

        if not pending_tasks:
            results.append("浏览任务: 全部已完成，无需执行")
            LOG.info("[%s] 浏览任务全部已完成，跳过", label)
            summary = f"账号#{idx}: 签到OK 浏览✅0 ⏭️{pre_skipped} (全部完成)"
            results.append(summary)
            return "\n".join(results)

        # ── 浏览任务 ──
        success = already = fail = 0
        total = len(pending_tasks)
        LOG.info("[%s] 开始浏览任务 (%d个待执行)", label, total)

        for i, task_id in enumerate(pending_tasks, 1):
            status, desc = await do_browse_task(biz_client, uid, openid, unionid, skey, task_id)
            if status == "success":
                success += 1
                LOG.info("[%s] 浏览 %d/%d: 成功", label, i, total)
            elif status == "already":
                already += 1
                LOG.info("[%s] 浏览 %d/%d: 已完成", label, i, total)
            else:
                fail += 1
                LOG.warning("[%s] 浏览 %d/%d: %s", label, i, total, desc)

            if i < total:
                await asyncio.sleep(TASK_INTERVAL)

        results.append(f"浏览任务: 预跳过{pre_skipped} 成功{success} 已完成{already} 失败{fail}")

    summary = f"账号#{idx}: 签到OK 浏览✅{success} ⏭️{pre_skipped + already} ❌{fail}"
    results.append(summary)
    return "\n".join(results)


async def amain() -> int:
    if not WX_SERVER_APIKEY:
        LOG.error("未配置环境变量 WX_SERVER_APIKEY（呆呆面板自动注入 wx_auth）")
        return 1

    raw = os.getenv("wx_opinion") or os.getenv("MCYX_ACCOUNT", "").strip()
    if not raw:
        LOG.error("未配置环境变量 MCYX_ACCOUNT")
        LOG.error("格式: userKey（多账号 & 分隔）")
        LOG.error("  可填序号(如1,2,3)自动算MD5，或直接填8位hex")
        LOG.error("  示例: MCYX_ACCOUNT=\"1&2&3\"")
        return 1

    try:
        accounts = parse_accounts(raw)
    except ValueError as e:
        LOG.error("账号配置错误: %s", e)
        return 1
    if not accounts:
        LOG.error("账号解析为空")
        return 1

    LOG.info(
        "名创优品 | wechatserver=%s appid=%s 共%d个账号 并发执行 | 浏览任务%d个 x %ds浏览",
        WX_SERVER_URL, APP_ID, len(accounts), len(ALL_BROWSE_TASKS), BROWSE_TIME,
    )

    # 并发信号量：控制同时登录数，避免打爆 wechatserver
    semaphore = asyncio.Semaphore(3)

    tasks = [run_account(key, idx, semaphore) for idx, key in enumerate(accounts, 1)]
    summaries = await asyncio.gather(*tasks, return_exceptions=True)

    final_parts: list[str] = []
    for s in summaries:
        if isinstance(s, Exception):
            final_parts.append(f"执行异常: {s}")
            LOG.exception("账号执行异常: %s", s)
        else:
            final_parts.append(s)

    final = "\n\n".join(final_parts)
    print("\n========== 执行总结 ==========\n" + final)
    try:
        send("名创优品", final)
    except Exception:
        pass
    return 0


def main() -> None:
    try:
        sys.exit(asyncio.run(amain()))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()