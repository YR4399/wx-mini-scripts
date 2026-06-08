#!/usr/bin/env python3
"""
每日脚本运行状态总结 - 晚上 22:30 运行
读取呆呆面板数据库和日志,生成当日所有任务执行汇总,PushPlus 推送
"""
import os, sys, sqlite3, json, glob, re
from datetime import datetime, date

PANEL_DB = "/app/Dumb-Panel/daidai.db"
LOGS_DIR = "/app/Dumb-Panel/logs"
PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")


def get_today_runs():
    """获取今天每个任务的最后一次运行记录"""
    conn = sqlite3.connect(PANEL_DB)
    conn.row_factory = sqlite3.Row
    
    today = date.today().isoformat()
    rows = conn.execute("""
        SELECT t.id, t.name, t.command, t.labels,
               tl.status, tl.duration, tl.log_path, tl.started_at, tl.ended_at
        FROM tasks t
        INNER JOIN (
            SELECT task_id, MAX(id) as max_id
            FROM task_logs
            WHERE date(started_at) = ?
            GROUP BY task_id
        ) latest ON latest.task_id = t.id
        INNER JOIN task_logs tl ON tl.id = latest.max_id
        WHERE t.status = 1 AND t.task_type = 'cron'
        ORDER BY t.sort_order, t.id
    """, (today,)).fetchall()
    
    conn.close()
    return rows


def read_log_tail(log_path, max_lines=50):
    """读取日志文件末尾几行"""
    full = os.path.join(LOGS_DIR, log_path)
    if not os.path.exists(full):
        return ""
    try:
        with open(full, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
            return "".join(lines[-max_lines:])
    except:
        return ""


def extract_summary(name, command, log_tail):
    """从日志尾部提取每个账号的详细信息"""
    info = {
        "accounts": [],   # [{idx, user, points, sign}]
        "sign_ok": 0,
        "sign_fail": 0,
    }

    # 按账号编号分块解析
    # 匹配 "账号[N]" 或 "🌸账号[N]" 开头的所有行
    acct_lines = {}
    for m in re.finditer(r'账号\[(\d+)\]\s*(.+?)(?:\n|$)', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append(m.group(2).strip())
    # 匹配 账号[N][手机号] 积分[N]🎉 格式 (无空格)
    for m in re.finditer(r'账号\[(\d+)\]\[([^\]]+)\]\s*积分\[(\d+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s 积分: %s" % (m.group(2), m.group(3)))
    # 匹配 🌸账号[N][手机号] 积分[N]🎉 格式
    for m in re.finditer(r'🌸账号\[(\d+)\]\[([^\]]+)\]\s*积分\[(\d+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s 积分: %s" % (m.group(2), m.group(3)))
    # 也匹配 🌸账号[N][手机号] 积分[N]🎉 格式
    for m in re.finditer(r'🌸账号\[(\d+)\]\[([^\]]+)\]\s*积分\[(\d+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s 积分: %s" % (m.group(2), m.group(3)))
    # 匹配 账号[N] [手机号] 积分[N]🎉 格式 (无🌸)
    for m in re.finditer(r'账号\[(\d+)\]\s*\[([^\]]+)\]\s*积分\[(\d+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s 积分: %s" % (m.group(2), m.group(3)))
    # 匹配 账号[N] 用户CK有效: [手机号] 雪王币剩余[N] 格式
    for m in re.finditer(r'账号\[(\d+)\]\s*用户CK有效:\s*\[([^\]]+)\]\s*雪王币剩余\[(\d+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s 积分: %s" % (m.group(2), m.group(3)))
    # 匹配 账号[N] 登录成功: [手机号] 格式
    for m in re.finditer(r'账号\[(\d+)\]\s*登录成功:\s*\[([^\]]+)\]', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s" % m.group(2))
    # 匹配 账号[N] 用户: 陌白 193****2646 格式 (飞鹤等)
    for m in re.finditer(r'账号\[(\d+)\]\s*用户[：:]\s*(\S+)\s+(\d[\d*]+\d)', log_tail):
        idx = int(m.group(1))
        acct_lines.setdefault(idx, []).append("用户: %s %s" % (m.group(2), m.group(3)))
    # 匹配 INFO 格式: [INFO] [Login] 成功! user=陌白, uid=6907922
    if not acct_lines:
        for i, m in enumerate(re.finditer(r'\[INFO\]\s*\[Login\]\s*成功!\s*user=(\S+?),\s*uid=(\d+)', log_tail), 1):
            acct_lines.setdefault(i, []).append("用户: %s" % m.group(1))
    # 匹配 [INFO] [陌白] ✅ 签到成功 格式
    if not acct_lines:
        for m in re.finditer(r'\[INFO\]\s*\[([^\]]+)\]\s*(✅|签到成功|签到失败)', log_tail):
            name = m.group(1)
            if name not in ("INFO", "Login", "Error"):
                idx = len(acct_lines) + 1
                acct_lines.setdefault(idx, []).append("用户: %s %s" % (name, "✅" if "✅" in m.group(2) or "成功" in m.group(2) else "❌"))
    info_blocks = re.findall(r'INFO\s*签到.*?当前积分=(\d+).*?INFO\s*签到结果.*?code=(\d+)', log_tail, re.DOTALL)
    if info_blocks and not acct_lines:
        for i, (pts, code) in enumerate(info_blocks, 1):
            acct_lines.setdefault(i, []).append("积分: %s %s" % (pts, "✅" if code == "200" else "❌"))

    # 匹配 [手机号] 当前积分: N 格式 (太平洋汽车等)
    if not acct_lines:
        for i, m in enumerate(re.finditer(r'\[(\d[\d*]+\d)\]\s*(?:当前积分|积分)[：:]\s*(\d+)', log_tail), 1):
            acct_lines.setdefault(i, []).append("用户: %s 积分: %s" % (m.group(1), m.group(2)))

    # 匹配 📊 当前积分: totalScore=N 格式 (imusic等)
    if not acct_lines:
        for i, m in enumerate(re.finditer(r'📊\s*当前积分[：:]\s*totalScore=(\d+)', log_tail), 1):
            acct_lines.setdefault(i, []).append("积分: %s" % m.group(1))

    # 匹配 💰 执行后积分: 【N】格式 (顺丰速运)
    if not acct_lines:
        for i, m in enumerate(re.finditer(r'💰\s*执行后积分[：:]\s*【(\d+)】', log_tail), 1):
            acct_lines.setdefault(i, []).append("积分: %s" % m.group(1))

    # 匹配 [签到] 成功 格式 (中国智普等简单签到)
    if not acct_lines:
        sign_ok = len(re.findall(r'签到成功|签到.*成功|今日已签到|已签到', log_tail))
        sign_fail = len(re.findall(r'签到失败|签到.*失败', log_tail))
        if sign_ok or sign_fail:
            info["sign_ok"] = sign_ok
            info["sign_fail"] = sign_fail

    for idx in sorted(acct_lines.keys()):
        lines = acct_lines[idx]
        user = ""
        points = ""
        sign = ""

        for line in lines:
            # 用户: 陌白 193****2646
            um = re.search(r'用户[：:]\s*(.+)', line)
            if um:
                raw = um.group(1).strip()
                # 用户: memberId=xxx 193****2646 → 提取手机号
                mm = re.search(r'memberId=\S+\s+(\d[\d*]+\d)', raw)
                if mm:
                    user = mm.group(1)
                # 用户:  193****2646 (空用户名,纯手机号)
                elif re.match(r'^\d[\d*]+\d$', raw):
                    user = raw
                else:
                    # 用户: 193****2646 积分: 1375 (手机号+积分)
                    nm = re.match(r'(\d[\d*]+\d)\s+积分', raw)
                    if nm:
                        user = nm.group(1)
                    else:
                        nm = re.match(r'(\S+)\s+(\d[\d*]+\d)', raw)
                        if nm and nm.group(1) not in ("null", "未知", "None"):
                            # 如果第一个字段是手机号,不截断
                            if re.match(r'^\d[\d*]+\d$', nm.group(1)):
                                user = nm.group(1)
                            else:
                                user = nm.group(1).strip()[:10] + " " + nm.group(2)
                        elif raw not in ("null", "未知", "None", ""):
                            user = raw.split()[0][:10] if raw.split() else ""

            # user=安宝23183 (安吉尔格式)
            um5 = re.search(r'user=(\S+?)(?:,|\s|$)', line)
            if um5 and not user and um5.group(1) not in ("null", "None", "未知"):
                user = um5.group(1).strip()[:10]

            # 会员: 陌白 193****2646 或 会员: 陌白 193****2646 积分=未知
            um2 = re.search(r'会员[：:]\s*(\S+)\s+(\d[\d*]+\d)', line)
            if um2 and not user:
                name = um2.group(1).strip()
                phone = um2.group(2)
                if name not in ("null", "未知", "None"):
                    user = name[:10] + " " + phone

            # 会员: 陌白 180****8939 (无积分)
            um3 = re.search(r'会员[：:]\s*(\S+)\s+(\d[\d*]+\d)\s*$', line)
            if um3 and not user:
                user = um3.group(1).strip()[:10] + " " + um3.group(2)

            # 会员: 🌸 198****6325
            um4 = re.search(r'会员[：:]\s*(🌸)\s+(\d[\d*]+\d)', line)
            if um4 and not user:
                user = "🌸 " + um4.group(2)

            # 积分: 12 或 当前积分350 或 当前金币=24312 或 积分=11
            pm = re.search(r'(?:积分|金币|快乐币)[：:=]\s*(\d+)', line)
            if pm and not points:
                points = pm.group(1)

            # 签到结果
            if '签到成功' in line or '今日已签到' in line or '已签到' in line:
                sign = '✅'
            elif '签到失败' in line or '签到异常' in line:
                sign = '❌'

        info["accounts"].append({"idx": idx, "user": user, "points": points, "sign": sign})

    info["sign_ok"] = sum(1 for a in info["accounts"] if a["sign"] == "✅")
    info["sign_fail"] = sum(1 for a in info["accounts"] if a["sign"] == "❌")

    # 如果没解析到账号,回退到旧格式
    if not info["accounts"]:
        pts = re.findall(r'(?:积分|金币|快乐币)[：:]\s*(\d+)', log_tail)
        ok = len(re.findall(r'签到成功|今日已签到|已签到', log_tail))
        fail = len(re.findall(r'签到失败|签到异常|签到-失败', log_tail))
        info["sign_ok"] = ok
        info["sign_fail"] = fail
        if pts:
            info["accounts"].append({"idx": 0, "user": "", "points": "/".join(pts[:5]), "sign": "✅" if ok else ""})

    return info


def get_group(labels):
    """从 labels 提取分组名"""
    if not labels:
        return "未分组"
    for part in labels.split(","):
        part = part.strip()
        if part.startswith("分组:"):
            return part[3:]
    return "未分组"


def format_duration(d):
    """格式化耗时"""
    if d > 3600:
        return "%.0fh%.0fm" % (d // 3600, (d % 3600) // 60)
    elif d > 60:
        return "%.0fm%.0fs" % (d // 60, d % 60)
    elif d > 0:
        return "%.1fs" % d
    return "-"


def build_report(runs):
    """按分组生成汇总报告"""
    # 按分组归类
    groups = {}
    for run in runs:
        grp = get_group(run["labels"])
        if grp == "工具":
            continue
        groups.setdefault(grp, []).append(run)

    lines = []
    lines.append("📊 今日脚本运行状态总结")
    lines.append("")

    total_ok = 0
    total_fail = 0

    for grp_name in sorted(groups.keys()):
        tasks = groups[grp_name]
        grp_ok = sum(1 for t in tasks if t["status"] == 0)
        grp_fail = len(tasks) - grp_ok
        total_ok += grp_ok
        total_fail += grp_fail

        lines.append("【%s】✅%d ❌%d" % (grp_name, grp_ok, grp_fail))
        lines.append("─" * 32)

        for run in tasks:
            name = run["name"]
            status = run["status"]
            duration = run["duration"] or 0
            log_path = run["log_path"] or ""

            icon = "✅" if status == 0 else "❌"
            t = format_duration(duration)

            log_tail = read_log_tail(log_path, 150) if log_path else ""
            summary = extract_summary(name, run["command"], log_tail)

            lines.append("  %s %s (%s)" % (icon, name, t))

            # 只显示有实际内容的账号
            has_detail = False
            for acct in summary["accounts"]:
                parts = []
                if acct["user"]:
                    parts.append(acct["user"])
                if acct["points"]:
                    parts.append("积分:" + acct["points"])
                if acct["sign"]:
                    parts.append(acct["sign"])
                # 跳过没有任何信息的账号
                if not parts or parts == ["-"]:
                    continue
                has_detail = True
                detail = " ".join(parts)
                lines.append("    [%d] %s" % (acct["idx"], detail))
        lines.append("")

    lines.append("━" * 32)
    lines.append("合计: ✅%d  ❌%d" % (total_ok, total_fail))

    return "\n".join(lines)


def send_push(title, content):
    """PushPlus 推送"""
    if not PLUSPLUS_TOKEN:
        print("未配置 PLUSPLUS_TOKEN,跳过推送")
        return
    import urllib.request
    data = json.dumps({
        "token": PLUSPLUS_TOKEN,
        "title": title,
        "content": content,
        "template": "txt",
    }).encode()
    req = urllib.request.Request(
        "https://www.pushplus.plus/send",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
            if result.get("code") == 200:
                print("推送成功")
            else:
                print("推送返回: %s" % result)
    except Exception as e:
        print("推送失败: %s" % e)


def main():
    runs = get_today_runs()
    if not runs:
        print("今日无任务运行记录")
        return
    
    report = build_report(runs)
    print(report)
    send_push("每日脚本状态总结", report)


if __name__ == "__main__":
    main()
