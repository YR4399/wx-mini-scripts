#!/usr/bin/env python3
"""
GitHub 自动同步脚本 (容器内版)
==============================
在呆呆面板容器内运行，将 code/ 目录同步到 GitHub。

环境变量：
  GITHUB_TOKEN  - GitHub PAT
"""

import os
import sys
import json
import subprocess
import sqlite3
import re
from datetime import datetime, timezone, timedelta

# ==== 配置 ====
GITHUB_REPO = "YR4399/wx-mini-scripts"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "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")

# 容器内路径
PANEL_DIR = "/app/Dumb-Panel"
SCRIPTS_DIR = os.path.join(PANEL_DIR, "scripts/code")
REPO_DIR = os.path.join(PANEL_DIR, "wx-mini-scripts")
CODE_DIR = os.path.join(REPO_DIR, "code")
README_PATH = os.path.join(REPO_DIR, "README.md")
DB_PATH = os.path.join(PANEL_DIR, "daidai.db")

CST = timezone(timedelta(hours=8))


def run(cmd, cwd=None):
    """执行命令"""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    # 清除代理
    for k in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
        env.pop(k, None)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                       cwd=cwd or REPO_DIR, env=env, timeout=120)
    return r.stdout.strip() if r.returncode == 0 else None


def sync_scripts():
    """同步脚本文件"""
    print("[1/4] 同步脚本...")
    os.makedirs(CODE_DIR, exist_ok=True)

    # 获取源目录脚本
    remote = set(f for f in os.listdir(SCRIPTS_DIR) if f.endswith(".py"))
    local = set(f for f in os.listdir(CODE_DIR) if f.endswith(".py"))

    synced = []
    for fname in sorted(remote):
        src = os.path.join(SCRIPTS_DIR, fname)
        dst = os.path.join(CODE_DIR, fname)

        with open(src, "r", encoding="utf-8", errors="ignore") as f:
            new = f.read()

        old = ""
        if os.path.exists(dst):
            with open(dst, "r", encoding="utf-8", errors="ignore") as f:
                old = f.read()

        if new != old:
            with open(dst, "w", encoding="utf-8") as f:
                f.write(new)
            synced.append(fname)
            print(f"  ✅ {fname}")

    # 清理多余文件
    for fname in local - remote:
        os.remove(os.path.join(CODE_DIR, fname))
        print(f"  🗑️  {fname}")

    print(f"  共 {len(remote)} 个, 更新 {len(synced)} 个")
    return synced


def get_task_status():
    """获取任务状态"""
    print("[2/4] 获取状态...")
    status = {}
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT name, command, last_run_status, last_run_at FROM tasks WHERE command LIKE '%code/%' AND status=1")
        for name, cmd, run_st, run_at in c.fetchall():
            m = re.search(r"code/(.+\.py)", cmd)
            if not m:
                continue
            fname = m.group(1)
            t = ""
            if run_at:
                try:
                    dt = datetime.fromisoformat(run_at[:19])
                    t = dt.strftime("%m-%d %H:%M")
                except:
                    t = str(run_at)[:16]
            status[fname] = {"name": name, "ok": run_st == 0, "time": t}
        conn.close()
    except Exception as e:
        print(f"  [WARN] {e}")
    print(f"  找到 {len(status)} 个任务")
    return status


def get_desc():
    """获取脚本描述"""
    desc = {}
    for f in os.listdir(CODE_DIR):
        if not f.endswith(".py"):
            continue
        try:
            with open(os.path.join(CODE_DIR, f), "r", encoding="utf-8") as fh:
                c = fh.read(2000)
            m = re.search(r'"""(.*?)"""', c, re.DOTALL)
            desc[f] = m.group(1).strip().split("\n")[0][:60] if m else "(无描述)"
        except:
            desc[f] = "(读取失败)"
    return desc


def update_readme(synced, status, desc):
    """更新 README"""
    print("[3/4] 更新 README...")
    now = datetime.now(CST).strftime("%Y-%m-%d %H:%M")

    # 分类
    cats = {"sign": [], "task": [], "auto": [], "yili": [], "other": [], "tool": []}
    yili_kw = ["伊利", "qq星", "zhenxi", "甄稀", "星韵"]
    sign_kw = ["sign", "签到", "lj_sign", "袋鼠", "haishibao", "angel", "小紫"]
    tool_kw = ["wx_code_client"]

    for f in sorted(desc):
        entry = {
            "file": f, "desc": desc[f],
            "status": "✨" if status.get(f, {}).get("ok") else ("💥" if f in status else "—"),
            "time": status.get(f, {}).get("time", "—"),
            "updated": datetime.fromtimestamp(os.path.getmtime(os.path.join(CODE_DIR, f))).strftime("%m-%d"),
        }
        fl = f.lower()
        if any(k in fl for k in tool_kw):
            cats["tool"].append(entry)
        elif any(k in fl for k in yili_kw):
            cats["yili"].append(entry)
        elif any(k in fl for k in sign_kw):
            cats["sign"].append(entry)
        elif any(k in fl for k in ["抽奖", "claim", "gift"]):
            cats["task"].append(entry)
        elif any(k in fl for k in ["jph", "mcyx", "monalisa", "wps", "牛牛", "纷享", "飞鹤", "xmyx"]):
            cats["auto"].append(entry)
        else:
            cats["other"].append(entry)

    titles = {"sign": "🎀 签到类", "task": "🎁 任务 & 抽奖类", "auto": "🌸 综合自动化类",
              "yili": "🍼 伊利系列", "other": "🏠 其他", "tool": "🔧 工具模块"}

    L = []
    L += ['<div align="center">', '', '<img src="banner.svg" width="100%" />', '',
          '# ✨ 微信小程序自动化脚本合集 ✨', '',
          '**「 每天自动签到，把时间留给二次元 」**', '',
          '[![WeChat](https://img.shields.io/badge/WeChat-MiniProgram-07C160?style=for-the-badge&logo=wechat&logoColor=white)](https://github.com/YR4399/wx-mini-scripts)',
          '[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://github.com/YR4399/wx-mini-scripts)',
          '[![Docker](https://img.shields.io/badge/Docker-呆呆面板-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/linzixuanzz/Dumb-Panel)',
          '', f'> 🕐 最后同步：{now}', f'> 📦 脚本总数：**{len(desc)}** 个', '',
          '</div>', '', '---', '']

    for k, items in cats.items():
        if not items:
            continue
        L += [f'<div align="center">', '', f'### {titles[k]}', '', '</div>', '',
              '| 脚本 | 说明 | 更新 | 运行 | 状态 |',
              '|:-----|:-----|:----:|:----:|:----:|']
        for s in items:
            L.append(f'| `{s["file"]}` | {s["desc"]} | {s["updated"]} | {s["time"]} | {s["status"]} |')
        L.append('')

    L += ['<div align="center">', '', '| 标记 | 含义 |', '|:----:|:-----|',
          '| ✨ | 最近运行成功 |', '| 💥 | 最近运行失败 |', '| — | 无定时任务 |',
          '', '</div>', '', '---', '', '## 🛠️ 快速开始', '', '```bash',
          '# 克隆仓库', 'git clone https://github.com/YR4399/wx-mini-scripts.git', '',
          '# 将脚本放入呆呆面板', 'cp code/*.py /app/Dumb-Panel/scripts/code/', '',
          '# 配置环境变量', "export wx_server_url='http://172.17.0.3:8787'",
          "export wx_auth='your_api_key'", "export wx_opinion='openid1&openid2'", '```',
          '', '---', '', '<div align="center">', '',
          '**「 今天的签到，就交给小助手吧～ 」**', '',
          '![Visitors](https://komarev.com/ghpvc/?username=YR4399&label=Visitors&color=ff69b4&style=flat-square)',
          '', '</div>']

    with open(README_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")
    return sum(len(v) for v in cats.values())


def git_push(synced):
    """提交并推送"""
    print("[4/4] 推送...")
    run(f'git config user.name "YR4399"')
    run(f'git config user.email "yr@users.noreply.github.com"')
    run(f'git remote set-url origin https://YR4399:{GITHUB_TOKEN}@github.com/{GITHUB_REPO}.git')
    run("git add -A")

    if not run("git status --porcelain"):
        print("  无变更")
        return True

    now = datetime.now(CST).strftime("%m-%d %H:%M")
    msg = f"sync: {len(synced)} scripts [{now}]" if synced else f"sync: status update [{now}]"
    run(f'git commit -m "{msg}"')

    if run("git push origin main"):
        print("  ✅ 推送成功!")
        run(f'git remote set-url origin https://github.com/{GITHUB_REPO}.git')
        return True
    print("  ❌ 推送失败")
    return False


def main():
    print("=" * 40)
    print("  GitHub Auto Sync")
    print(f"  {datetime.now(CST).strftime('%H:%M:%S')}")
    print("=" * 40)

    synced = sync_scripts()
    status = get_task_status()
    desc = get_desc()
    total = update_readme(synced, status, desc)
    ok = git_push(synced)

    print(f"\n{'✅' if ok else '⚠️'} 完成: {total} 脚本, 更新 {len(synced)} 个")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
