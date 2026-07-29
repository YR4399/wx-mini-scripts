"""
顺丰速运 - WCS code 刷新 Cookie（多账号版 v3，带缓存+推送）
流程（逆向 SunnyNet 抓包）：
1. 读取现有 sfsyUrl，逐个调 ifLogin 检查是否有效
2. 全部有效则跳过刷新，直接运行主脚本
3. 有失效则重新走 WCS 刷新流程，写入 sfsyUrl 后运行主脚本
4. 运行完成后 PushPlus 推送结果
"""
import json
import re
import os
import sys
import ssl
import sqlite3
import time
import urllib.request
import urllib.error
import urllib.parse
import subprocess
from datetime import datetime

WCS_URL = os.getenv("wx_server_url", "http://172.17.0.4:8787")
WCS_AUTH = os.getenv("wx_auth", "1509ea7aca117dcbb7e635c0c007d528")
SF_APPID = "wxd4185d00bf7e08ac"
SF_PUBLIC_ID = "gh_f9d9fca26a50"
DB_PATH = "/app/Dumb-Panel/daidai.db"
MAIN_SCRIPT = "/app/Dumb-Panel/scripts/顺丰速运日常任务v1.3.py"
DRAGONBOAT_SCRIPT = "/app/Dumb-Panel/scripts/顺丰端午节活动增加推.py"
PYTHON_BIN = "/app/Dumb-Panel/deps/python/3.11/bin/python3"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")

# ==================== 推送 ====================
def push_result(success, cached, points_summary=None, coins_summary=None):
    token = os.getenv("PLUSPLUS_TOKEN", "")
    if not token:
        log("未配置 PLUSPLUS_TOKEN，跳过推送")
        return
    title = "顺丰速运"
    lines = [f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"]
    if cached:
        lines.append("[状态] 使用缓存凭证")
    if points_summary:
        lines.append(points_summary)
    if coins_summary:
        lines.append(coins_summary)
    if not points_summary and not coins_summary:
        lines.insert(0, f"结果是成功" if success else f"结果失败")
    body = json.dumps({"token": token, "title": title, "content": chr(10).join(lines), "template": "txt"}).encode()
    try:
        req = urllib.request.Request("http://www.pushplus.plus/send", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        resp = urllib.request.urlopen(req, timeout=15, context=CTX)
        result = json.loads(resp.read())
        log(f'PushPlus: {result.get("code", "?")}')
    except Exception as e:
        log(f"推送异常: {e}")


def http_post(url, data, headers=None, timeout=30):
    req = urllib.request.Request(url, method="POST")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    req.data = data.encode() if isinstance(data, str) else data
    return urllib.request.urlopen(req, timeout=timeout, context=CTX)

def http_get_no_follow(url, headers=None, timeout=30):
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req2, fp, code, msg, hdrs, newurl):
            raise urllib.error.HTTPError(newurl, code, str(msg), hdrs, fp)
    opener = urllib.request.build_opener(NoRedirect)
    opener.add_handler(urllib.request.HTTPSHandler(context=CTX))
    try:
        return opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e

# ==================== 缓存检查 ====================
def read_sfsy_url():
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        row = cur.execute("SELECT value FROM env_vars WHERE name = 'sfsyUrl'").fetchone()
        conn.close()
        if row and row[0]:
            return row[0].strip()
    except Exception:
        pass
    return ""

def check_one_cookie(cookie_str):
    try:
        ck_parts = []
        for k in ("JSESSIONID", "sessionId", "_login_user_id_", "_login_mobile_"):
            for item in cookie_str.split(";"):
                item = item.strip()
                if item.startswith(k + "="):
                    ck_parts.append(item)
                    break
        if not ck_parts:
            return False, ""
        cookie = ";".join(ck_parts)
        resp = http_post(
            "https://mcs-mimp-web.sf-express.com/mcs-mimp/ifLogin",
            b"{}",
            {
                "Content-Type": "application/json",
                "platform": "MINI_PROGRAM",
                "Origin": "https://mcs-mimp-web.sf-express.com",
                "Cookie": cookie,
            },
        )
        result = json.loads(resp.read())
        obj = result.get("obj", {})
        if obj.get("loginStatus") == 1:
            return True, obj.get("mobile", "")
        return False, ""
    except Exception:
        return False, ""

def check_cache():
    sfsy_val = read_sfsy_url()
    if not sfsy_val:
        log("无缓存 sfsyUrl，需要刷新")
        return False, ""
    accounts = sfsy_val.split("&")
    if not accounts:
        return False, ""
    log(f"检查缓存（{len(accounts)} 个账号）...")
    all_valid = True
    for i, ck in enumerate(accounts):
        valid, mobile = check_one_cookie(ck)
        if valid:
            log(f"  账号 {i + 1}: {mobile} 有效")
        else:
            log(f"  账号 {i + 1}: 失效")
            all_valid = False
    return all_valid, sfsy_val

# ==================== WCS 刷新 ====================
def get_openids():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    for name in ("wx_opinion", "WECHAT_ACCOUNTS"):
        row = cur.execute(
            "SELECT value FROM env_vars WHERE name = ? AND enabled = 1", (name,)
        ).fetchone()
        if row and row[0]:
            conn.close()
            raw = row[0].strip().replace(chr(10), "&")
            ids = [x.strip() for x in raw.split("&") if x.strip()]
            if ids:
                return ids
    conn.close()
    return []

def get_wx_code(openid):
    resp = http_post(
        f"{WCS_URL}/wx/code",
        json.dumps({"appid": SF_APPID, "openid": openid}),
        {"AUTH": WCS_AUTH, "Content-Type": "application/json"},
    )
    result = json.loads(resp.read())
    if result.get("status"):
        return result["data"]["code"]
    raise Exception(f"获取 code 失败: {result}")

def code_to_session(code):
    resp = http_post(
        f"https://ucmp.sf-express.com/wxaccess/weixin/appOnLogin?code={code}&publicId={SF_PUBLIC_ID}",
        "",
        {"Referer": f"https://servicewechat.com/{SF_APPID}/694/page-frame.html"},
    )
    data = json.loads(resp.read())
    sid = data.get("sessionId", "")
    if sid:
        return sid
    raise Exception(f"获取 sessionId 失败: {data}")

def session_to_cookies(sid):
    ts = str(int(time.time() * 1000))
    url = (
        f"https://ucmp.sf-express.com/wxaccess/weixin/activity/sfwxappczfl"
        f"?bizCode=622&suuid={sid}&timestamp={ts}"
        f"&citycode=551&cityname=%E5%90%88%E8%82%A5"
    )
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")
    resp = urllib.request.urlopen(req, timeout=30, context=CTX)
    final_url = resp.url
    resp.close()
    params = urllib.parse.parse_qs(urllib.parse.urlparse(final_url).query)
    token_from_url = params.get("token", [""])[0]

    resp2 = http_get_no_follow(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    location = resp2.headers.get("Location", "")
    resp2.close()

    if not location or "shareGiftReceiveRedirect" not in location:
        log("  WARN no shareGiftReceiveRedirect")
        return {
            "JSESSIONID": token_from_url,
            "sessionId": token_from_url,
            "_login_mobile_": params.get("mobile", [""])[0],
            "_login_user_id_": params.get("userId", [""])[0],
        }, False

    resp3 = http_get_no_follow(location, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    set_cookies_raw = resp3.headers.get_all("Set-Cookie") or []
    resp3.close()

    cookies = {}
    for item in set_cookies_raw:
        kv = item.split(";")[0].strip()
        if "=" in kv:
            k, v = kv.split("=", 1)
            cookies[k] = v
    return cookies, True

def verify_login(cookies_dict):
    ck_parts = []
    for k in ("JSESSIONID", "sessionId", "_login_user_id_", "_login_mobile_"):
        if k in cookies_dict:
            ck_parts.append(f"{k}={cookies_dict[k]}")
    cookie_str = ";".join(ck_parts)
    resp = http_post(
        "https://mcs-mimp-web.sf-express.com/mcs-mimp/ifLogin",
        b"{}",
        {
            "Content-Type": "application/json",
            "platform": "MINI_PROGRAM",
            "Origin": "https://mcs-mimp-web.sf-express.com",
            "Cookie": cookie_str,
        },
    )
    result = json.loads(resp.read())
    return result.get("obj", {}).get("loginStatus", -1) == 1

def refresh_one(openid, index):
    log(f"--- 账号 {index + 1}: {openid[:20]}... ---")
    try:
        code = get_wx_code(openid)
        log(f"  OK code: {code[:20]}...")
    except Exception as e:
        log(f"  FAIL code: {e}")
        return None
    try:
        sid = code_to_session(code)
        log(f"  OK sessionId: {sid[:20]}...")
    except Exception as e:
        log(f"  FAIL sessionId: {e}")
        return None
    try:
        cookies, got_sc = session_to_cookies(sid)
    except Exception as e:
        log(f"  FAIL cookies: {e}")
        return None
    jsession = cookies.get("JSESSIONID", "")
    mobile = cookies.get("_login_mobile_", "")
    if not jsession:
        log("  FAIL no JSESSIONID")
        return None
    if got_sc:
        log(f"  OK Set-Cookie JSESSIONID: {jsession[:20]}...")
        log(f"  OK Set-Cookie mobile: {mobile}")
    else:
        log(f"  WARN fallback: mobile={mobile}")
    if not verify_login(cookies):
        log("  FAIL login verify")
        return None
    log("  OK login verified (loginStatus=1)")
    ck_parts = []
    for k in ("JSESSIONID", "sessionId", "_login_mobile_", "_login_user_id_"):
        if k in cookies:
            ck_parts.append(f"{k}={cookies[k]}")
    return ";".join(ck_parts)

def do_refresh():
    openids = get_openids()
    if not openids:
        log("FAIL no wx_opinion / WECHAT_ACCOUNTS")
        return None
    log(f"共找到 {len(openids)} 个 WCS openid")
    cookies_list = []
    for i, openid in enumerate(openids):
        ck = refresh_one(openid, i)
        if ck:
            cookies_list.append(ck)
        if i < len(openids) - 1:
            time.sleep(1)
    if not cookies_list:
        log("没有任何账号刷新成功")
        return None
    log(f"成功刷新 {len(cookies_list)}/{len(openids)} 个账号")
    return "&".join(cookies_list)

def write_sfsy_url(sfsy_val):
    try:
        db = sqlite3.connect(DB_PATH)
        cur = db.cursor()
        cur.execute("SELECT id FROM env_vars WHERE name = 'sfsyUrl'")
        if cur.fetchone():
            cur.execute(
                "UPDATE env_vars SET value = ?, updated_at = datetime('now') WHERE name = 'sfsyUrl'",
                (sfsy_val,),
            )
        else:
            cur.execute(
                "INSERT INTO env_vars (name, value, enabled) VALUES ('sfsyUrl', ?, 1)",
                (sfsy_val,),
            )
        db.commit()
        db.close()
        return True
    except Exception as e:
        log(f"更新 sfsyUrl 失败: {e}")
        return False

def run_main_script(sfsy_val):
    log("----- 运行顺丰主脚本 -----")
    env = os.environ.copy()
    env["sfsyUrl"] = sfsy_val
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        [PYTHON_BIN, MAIN_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        bufsize=0,
    )
    output = []
    for line in proc.stdout:
        print(line, end="", flush=True)
        output.append(line)
    proc.wait(timeout=600)
    log(f"主脚本退出码: {proc.returncode}")
    # 提取积分汇总
    full = "".join(output)
    points_summary = ""
    m = re.search(r"积分统计汇总.*?", full, re.DOTALL)
    if m:
        points_summary = m.group()
    return proc.returncode == 0, points_summary

def run_dragonboat_script(sfsy_val):
    log("----- 运行端午活动脚本 -----")
    env = os.environ.copy()
    env["sfsyUrl"] = sfsy_val
    env["PYTHONUNBUFFERED"] = "1"
    try:
        proc = subprocess.Popen(
            [PYTHON_BIN, DRAGONBOAT_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            bufsize=0,
        )
        output = []
        for line in proc.stdout:
            print(line, end="", flush=True)
            output.append(line)
        proc.wait(timeout=600)
        log(f"端午脚本退出码: {proc.returncode}")
        # 提取金币汇总
        full = "".join(output)
        coins_summary = ""
        coins_summary = ""
        cm = re.search(r"[=]+.*各账号金币余额统计.*?总计金币 : [0-9]+", full, re.DOTALL)
        if cm: coins_summary = cm.group()
        return proc.returncode == 0, coins_summary
    except Exception as e:
        log(f"端午脚本异常: {e}")
        return False, ""
        return False

# ==================== 主流程 ====================
def main():
    log("===== 顺丰速运 WCS Code 刷新（v3 缓存+推送） =====")

    # Step 1: 检查并刷新缓存（每次运行都检查，过期就刷新）
    cache_valid, cached_val = check_cache()

    if cache_valid:
        log("缓存全部有效，跳过刷新")
        sfsy_val = cached_val
        cached = True
    else:
        log("缓存失效，开始刷新...")
        sfsy_val = do_refresh()
        if not sfsy_val:
            push_result(False, False)
            return False
        if not write_sfsy_url(sfsy_val):
            push_result(False, False)
            return False
        log("sfsyUrl 已更新")
        cached = False

    # Step 2: 每次刷新后都执行主任务 + 端午任务
    now = datetime.now()
    log(f"当前时间 {now.hour}:{now.minute:02d}，执行主任务脚本")
    success, points_summary = run_main_script(sfsy_val)
    log(f"主任务完成，执行端午活动脚本")
    _, coins_summary = run_dragonboat_script(sfsy_val)

    # Step 3: 推送结果 (积分 + 金币)
    try:
        push_result(success, cached, points_summary, coins_summary)
    except Exception as e:
        log(f"推送异常: {e}")

    return success

if __name__ == "__main__":
    try:
        success = main()
        sys.exit(0 if success else 1)
    except Exception as e:
        log(f"异常: {e}")
        sys.exit(1)
