# cron: 30 8 * * *
# new Env('Arusu运动打卡')
#
# 小程序：Arusu 运动打卡（AppID: wx6c6fefac45365d53，API: https://arusu.cn）
#
# 环境变量（统一 WCS 变量，勿新建专属变量）：
#   wx_openid / wx_opinion：微信 openid，多账号用 & 分隔
#   wx_server_url：WCS 服务地址（默认 http://host.docker.internal:18788）
#   wx_auth：WCS 鉴权密钥
#
# 登录链路：WCS /wx/code 取 login code → POST /api/wx/login {code,inviter} → JWT token
# token 有效期约 28h，缓存到 .arusu_token_cache.json（按 JWT exp 判断），失效自动回源刷新。
#
# 自动化范围（仅无副作用动作）：
#   ✅ 每日任务事件上报（浏览类 mission_event_add）
#   ✅ 领取已达成任务奖励（anim_mission_task）
#   ✅ 领取每日积分（integral）
#   ⏭️ 刷步数(step)：需 wx.getWeRunData 实时加密数据，每次唯一不可重放，无法自动化
#   ⏭️ 社交任务(发说说/评论/点赞)：产生公开内容，出于安全不自动化

import base64
import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    from notify import send
except Exception:  # 直跑无 notify 时容错
    def send(*_a, **_k):
        raise RuntimeError("notify 模块不可用（面板运行时注入）")

# ---------------- 基础配置 ----------------
APP_NAME = "Arusu运动打卡"
APP_ID = "wx6c6fefac45365d53"
BASE_URL = "https://arusu.cn"
WCS_URL = os.getenv("wx_server_url", "http://host.docker.internal:18788").rstrip("/")
WCS_AUTH = os.getenv("wx_auth", "").strip()
REFERER = f"https://servicewechat.com/{APP_ID}/264/page-frame.html"
UA = ("Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Version/4.0 Chrome/146.0.7680.178 Mobile Safari/537.36 XWEB/1460243 MMWEBSDK/20260502")

# token 缓存（与目录约定一致：隐藏文件 .xxx_token_cache.json）
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".arusu_token_cache.json")
EXP_SKEW = 300  # JWT 提前 5 分钟视为过期

# 可自动化的浏览类任务事件（不产生公开内容）。抓包观测值：1,4,5,6
SAFE_EVENT_TYPES = [1, 4, 5, 6]

# ---------------- 装饰元素 ----------------
LINE = "━" * 20
ICON = {
    "app": "🏃", "account": "👤", "cache": "💾", "refresh": "🔄", "ok": "✅",
    "fail": "❌", "warn": "⚠️", "task": "📋", "reward": "🎁", "point": "📊",
    "done": "✔️", "skip": "⏭️", "summary": "📈", "net": "🌐", "finish": "🏁",
}


# ---------------- token 缓存 ----------------
def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CACHE_FILE)
    except Exception as exc:
        print(f"{ICON['warn']} 缓存写入失败：{exc}")


def jwt_exp(token):
    """解析 JWT payload 中的 exp（失败返回 0）"""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return int(data.get("exp", 0))
    except Exception:
        return 0


def get_cached_token(cache, openid):
    item = cache.get(openid)
    if not item:
        return None
    token = item.get("token", "")
    if not token:
        return None
    if jwt_exp(token) - EXP_SKEW <= time.time():
        return None
    return token


def put_cached_token(cache, openid, token):
    cache[openid] = {"token": token, "exp": jwt_exp(token), "ts": int(time.time())}


# ---------------- 网络封装 ----------------
def wcs_get_code(openid):
    """通过 WCS 获取小程序 login code"""
    r = requests.post(
        f"{WCS_URL}/wx/code",
        headers={"Content-Type": "application/json", "auth": WCS_AUTH},
        json={"openid": openid, "appid": APP_ID},
        timeout=30,
    )
    data = r.json()
    if not data.get("status"):
        raise RuntimeError(f"WCS 取 code 失败：{data.get('message')}")
    return data["data"]["code"]


def api_login(code):
    """用 code 换取业务 token"""
    r = requests.post(
        f"{BASE_URL}/api/wx/login",
        headers={"Content-Type": "application/json", "referer": REFERER, "user-agent": UA},
        json={"code": code, "inviter": None},
        timeout=30,
    )
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"登录失败：{data.get('message')}")
    return data["data"]["token"]


class ArusuClient:
    def __init__(self, token):
        self.token = token
        self.s = requests.Session()
        self.s.headers.update({
            "authorization": token,
            "referer": REFERER,
            "user-agent": UA,
            "content-type": "application/json",
        })

    def _check(self, r):
        data = r.json()
        if data.get("code") == 401:
            raise PermissionError("token 失效")
        return data

    def get(self, path, **params):
        return self._check(self.s.get(f"{BASE_URL}{path}", params=params or None, timeout=30))

    def post(self, path, body=None):
        return self._check(self.s.post(f"{BASE_URL}{path}", json=body or {}, timeout=30))


# ---------------- 业务流程 ----------------
def do_tasks(client, logs):
    """执行每日任务：触发事件 → 领取奖励 → 领积分"""
    # 1. 起始积分
    try:
        total0 = client.get("/api/wx/integral_total")["data"].get("total", 0)
        logs.append(f"{ICON['point']} 当前积分：{total0}")
    except Exception:
        total0 = None

    # 2. 上报浏览类任务事件（推进浏览任务，无副作用）
    ev_ok = 0
    for et in SAFE_EVENT_TYPES:
        try:
            if client.post("/api/wx/mission_event_add", {"event_type": et}).get("code") == 0:
                ev_ok += 1
            time.sleep(0.6)
        except PermissionError:
            raise
        except Exception:
            pass
    logs.append(f"{ICON['net']} 任务事件上报：{ev_ok}/{len(SAFE_EVENT_TYPES)} 成功")

    # 3. 拉任务列表，领取已达成待领取的奖励
    claimed, pending = 0, 0
    try:
        tasks = client.get("/api/wx/mission_task")["data"].get("list", [])
        for t in tasks:
            tid = t.get("id")
            status = t.get("task_status")          # 1=已达成
            played = t.get("complete_anim_played")  # 0=未领取奖励
            reward = t.get("reward", 0)
            if status == 1 and played == 0:
                try:
                    client.post("/api/wx/anim_mission_task", {"task_id": tid})
                    claimed += 1
                    logs.append(f"{ICON['reward']} 领取任务奖励：task#{tid} +{reward}")
                    time.sleep(0.8)
                except Exception as exc:
                    logs.append(f"{ICON['warn']} 领取 task#{tid} 失败：{exc}")
            elif status == 1 and played == 1:
                logs.append(f"{ICON['done']} task#{tid} 已领取（+{reward}）")
            else:
                pending += 1
                prog = f"{t.get('progress_value')}/{t.get('task_cate_value')}"
                logs.append(f"{ICON['skip']} task#{tid} 未达成（进度 {prog}，需真实运动/操作）")
    except PermissionError:
        raise
    except Exception as exc:
        logs.append(f"{ICON['warn']} 任务列表获取失败：{exc}")

    # 4. 领取每日积分（宝箱/免费积分）
    try:
        client.post("/api/wx/integral", {})
        logs.append(f"{ICON['ok']} 已领取每日积分")
    except PermissionError:
        raise
    except Exception as exc:
        logs.append(f"{ICON['warn']} 领积分：{exc}")

    # 5. 结算积分
    try:
        total1 = client.get("/api/wx/integral_total")["data"].get("total", 0)
        delta = f"（+{total1 - total0}）" if total0 is not None else ""
        logs.append(f"{ICON['finish']} 最终积分：{total1}{delta}")
    except Exception:
        pass

    return claimed, pending


def login_account(openid, cache, logs):
    """登录：优先用缓存 token，失效则回源 WCS 刷新"""
    token = get_cached_token(cache, openid)
    if token:
        logs.append(f"{ICON['cache']} 身份来源：缓存 token")
        return ArusuClient(token), "cache"
    code = wcs_get_code(openid)
    token = api_login(code)
    put_cached_token(cache, openid, token)
    logs.append(f"{ICON['refresh']} 身份来源：WCS 回源登录")
    return ArusuClient(token), "refresh"


def run_single(index, openid, cache, stats):
    logs = [f"{ICON['account']} 账号{index}｜{openid[:10]}…"]
    try:
        client, source = login_account(openid, cache, logs)
        stats["cache_hit" if source == "cache" else "refresh"] += 1
        try:
            do_tasks(client, logs)
        except PermissionError:
            # 缓存 token 失效 → 回源重试一次
            logs.append(f"{ICON['refresh']} token 失效，回源 WCS 重新登录…")
            cache.pop(openid, None)
            code = wcs_get_code(openid)
            token = api_login(code)
            put_cached_token(cache, openid, token)
            do_tasks(ArusuClient(token), logs)
            stats["refresh"] += 1
        stats["ok"] += 1
    except Exception as exc:
        stats["fail"] += 1
        logs.append(f"{ICON['fail']} 处理失败：{exc}")
    return logs


# ---------------- 报告 & 入口 ----------------
def parse_accounts():
    raw = os.getenv("wx_openid", "") or os.getenv("wx_opinion", "")
    return [x.strip() for x in raw.replace("\n", "&").split("&") if x.strip()]


def render_report(all_logs, stats):
    lines = [
        f"{ICON['app']} {APP_NAME}",
        f"{ICON['summary']} 账号 {stats['total']}｜成功 {stats['ok']}｜失败 {stats['fail']}"
        f"｜缓存命中 {stats['cache_hit']}｜回源 {stats['refresh']}",
    ]
    for logs in all_logs:
        lines.append(LINE)
        lines.extend(logs)
    lines.append(LINE)
    lines.append(f"{ICON['finish']} 执行完毕 · {time.strftime('%Y-%m-%d %H:%M:%S')}")
    return "\n".join(lines)


def safe_send(title, content):
    try:
        send(title, content)
    except Exception as exc:
        print(f"{ICON['warn']} 通知发送失败（不影响执行结果）：{exc}")


def main():
    accounts = parse_accounts()
    if not accounts:
        msg = f"{ICON['fail']} 未读取到账号：请配置 wx_openid（或 wx_opinion）"
        print(msg)
        safe_send(APP_NAME, msg)
        return
    if not WCS_AUTH:
        print(f"{ICON['warn']} 未配置 wx_auth，若缓存 token 失效将无法回源 WCS")

    cache = load_cache()
    stats = {"total": len(accounts), "ok": 0, "fail": 0, "cache_hit": 0, "refresh": 0}
    all_logs = []

    for i, openid in enumerate(accounts, 1):
        print(f"\n{LINE}\n{ICON['app']} 开始处理账号 {i}\n{LINE}")
        logs = run_single(i, openid, cache, stats)
        for l in logs:
            print(l)
        all_logs.append(logs)

    save_cache(cache)
    report = render_report(all_logs, stats)
    print("\n" + report)
    safe_send(APP_NAME, report)


if __name__ == "__main__":
    main()
