# 粉象生活 果园自动化 (HAR 2026-08-03 09:36 抓包)
# env fxsh = did#finger#token#oaid (多号 & 分隔)
# 流程: 会话(h5token) → 查水量 → 任务列表 → 完成任务 → 登录奖励 → 浇水 → 领升级水 → 好友访问/偷水
# 签名: H5 web 签名 (SECRET1 + bodyQS+gQS, noncestr 32位混合)

import requests
import json
import time
import random
import hashlib
import os

requests.packages.urllib3.disable_warnings()

# 果园接口用 App 原生签名体系 (wqwl 插件算法): SECRET2 + platform:android + version:6.7.1
SECRET2 = "粉象好牛逼nb3b16f5a02479a0e34df78d14aefe76"
API = "https://api.fenxianglife.com"
M = "https://m.fenxianglife.com"
H = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8 Lite) AppleWebKit/537.36 Chrome/80.0.3987.99 Mobile Safari/537.36 AgentWeb/5.0.0 UCBrowser/11.6.4.950",
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/json",
    "origin": M,
    "sec-fetch-dest": "empty",
    "x-requested-with": "com.n_add.android",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "referer": M,
    "accept-language": "zh-CN,zh;q=0.9",
}


def objQS(o):
    if not o:
        return ""
    return "&".join(f"{k}={o[k]}" for k in sorted(o) if o[k] is not None)


class Orchard:
    def __init__(self, acc):
        self.acc = acc
        self.s = requests.Session()
        self.h5token = ""
        self.ref = M + "/"

    def api(self, method, path, body=None, query=None):
        """wqwl 签名: MD5(SECRET2 + bodyQS(sorted) + gQS(sorted)), platform:android version:6.7.1"""
        g = {
            "traceid": hashlib.md5((str(int(time.time() * 1000)) + str(random.random())).encode()).hexdigest(),
            "noncestr": str(random.random())[2:10],
            "timestamp": int(time.time() * 1000),
            "platform": "android",
            "did": self.acc["did"],
            "version": "6.7.1",
            "finger": self.acc["finger"],
            "token": self.acc["token"],
            "oaid": self.acc["oaid"],
        }
        s = body or {}
        g["sign"] = hashlib.md5((SECRET2 + objQS(s) + objQS(g)).encode()).hexdigest()
        h = {**H, **{k: str(v) for k, v in g.items()}}
        url = API + path + (f"?{query}" if query else "")
        for attempt in range(3):
            try:
                r = self.s.request(method, url, headers=h, data=json.dumps(s) if s else "", verify=False, timeout=15)
                return r.json()
            except Exception as e:
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
                    continue
                return {"code": -1, "message": str(e)[:80]}
        return {"code": -1, "message": "failed"}

    def build_session(self):
        """拿 h5token (带签名, wqwl 算法)"""
        r = self.api("GET", "/njia/users/info")
        try:
            self.h5token = r.get("data", {}).get("h5token", "")
        except Exception:
            self.h5token = ""
        if self.h5token:
            idx = f"{M}/act/persistent/orchard/index.html?hidNav=1&token={self.h5token}&AppToken={self.acc['token']}"
            try:
                self.s.get(idx, headers={"User-Agent": H["user-agent"]}, verify=False, timeout=20)
            except Exception:
                pass
            self.ref = idx
        return self.h5token


def run(acc):
    o = Orchard(acc)
    out = {"did": acc["did"][:10], "water": "?", "tasks": [], "rewards": [], "watered": False, "elephant": [], "games": [], "takeaway": "-", "errors": []}

    # 0. 建立 H5 会话
    h5 = o.build_session()
    if not h5:
        out["errors"].append("h5token 获取失败(可能风控)")

    # 0.5 大象游戏 (放最前, 先 GET info 预热再 POST)
    out["elephant"] = []
    r0 = o.api("GET", "/njia/elephant/info")
    if r0.get("code") == 200 and r0.get("data"):
        d0 = r0["data"]
        out["elephant"].append(f"🐘金币: {d0.get('coinCurrent')} 待收:{d0.get('coinUnCollect')}")
    for name, path, body in [
        ("🐘签到", "/njia/elephant/sign", {}),
        ("🪙收金币", "/njia/elephant/coin/receive", {}),
        ("💰财神助力", "/njia/elephant/mammon/help", {"initiatorId": "515233097"}),
        ("🎁开宝箱", "/njia/elephant/activity/limitedTime/complete", {"doublingKey": "doubling"}),
    ]:
        r = o.api("POST", path, body)
        if r.get("success") or r.get("code") == 200:
            d = r.get("data") or {}
            if isinstance(d, dict) and d.get("reward") is not None:
                out["elephant"].append(f"{name}✅ +{d['reward']}金币")
            else:
                out["elephant"].append(f"{name}✅")
        elif r.get("code") != -1:
            out["elephant"].append(f"{name}:{r.get('message')}")
        time.sleep(2)

    # 1. 查水量
    r = o.api("GET", "/njia/orchard/user/water/totalNew")
    if r.get("code") == 200 and r.get("data"):
        d = r["data"]
        out["water"] = f"{d.get('currentWaterTotal')}/{d.get('maxWaterTotal')}"
    elif r.get("code") != 200 and r.get("code") != -1:
        out["errors"].append(f"水量:{r.get('message')}")

    # 2. 果树详情 (拿 userFruiterId)
    uid = None
    r = o.api("GET", "/njia/orchard/user/fruiter/detail")
    if r.get("code") == 200 and r.get("data"):
        d = r["data"]
        uid = d.get("id")
        if d.get("fruiterName"):
            out["fruit"] = f"{d.get('fruiterName')} 阶段{d.get('currentStage') or d.get('stage') or '?'}"

    # 3. 任务列表 + 完成任务
    r = o.api("GET", "/njia/orchard/task/list")
    if r.get("code") == 200 and r.get("data"):
        for t in r["data"]:
            if not t.get("taskInfoId"):
                continue
            done = t.get("finishCount", 0) or 0
            remain = t.get("remainsCount", 1) or 1
            if done < remain:
                fr = o.api("POST", "/njia/orchard/task/finish", {"type": t.get("type"), "taskInfoId": t.get("taskInfoId")})
                if fr.get("code") == 200:
                    out["tasks"].append(f"✅{t.get('name','')}: +{fr.get('data')}")
                else:
                    out["tasks"].append(f"⚠️{t.get('name','')}: {fr.get('message')}")
                time.sleep(1)

    # 4. 登录奖励 (7天签到领水滴)
    r = o.api("GET", "/njia/orchard/loginAward/user/detail")
    if r.get("code") == 200 and r.get("data"):
        for a in r["data"]:
            if a.get("receiveStatus") == 0 and a.get("status") == 1:
                rr = o.api("POST", "/njia/orchard/loginAward/receive", {"day": a.get("day")})
                if rr.get("code") == 200:
                    out["rewards"].append(f"✅第{a.get('day')}天: {a.get('description','')}")
                time.sleep(1)

    # 5. 浇水 + 领升级水
    if uid:
        r = o.api("POST", "/njia/orchard/user/fruiter/water", {"userFruiterId": uid})
        if r.get("code") == 200 and r.get("data"):
            d = r["data"]
            out["watered"] = True
            if d.get("isUpgrade"):
                out["rewards"].append(f"🌳升级: {d.get('upgradeContext','')}")
                cid = d.get("canAcquireWaterId")
                if cid:
                    time.sleep(1)
                    rr = o.api("POST", "/njia/orchard/user/fruiter/acquireWater", {"canAcquireWaterId": cid, "userFruiterId": uid})
                    if rr.get("code") == 200:
                        out["rewards"].append(f"💧领升级水: {rr.get('data')}")
        time.sleep(1)
        # 再查一次水量
        r = o.api("GET", "/njia/orchard/user/water/totalNew")
        if r.get("code") == 200 and r.get("data"):
            out["water"] = f"{r['data'].get('currentWaterTotal')}/{r['data'].get('maxWaterTotal')}"

    # 6. 好友访问 + 偷水
    r = o.api("POST", "/njia/orchard/friend/friendList", {"page": 0, "size": 10, "enterOrchardTime": int(time.time())})
    if r.get("code") == 200 and r.get("data", {}).get("list"):
        for f in r["data"]["list"]:
            fid = f.get("userId")
            if fid is None:
                continue
            o.api("POST", "/njia/orchard/friend/visitFriendOrchard", {"friendId": fid})
            time.sleep(0.8)
            st = o.api("POST", "/njia/orchard/friend/stealWater", {"friendId": fid})
            if st.get("code") == 200 and st.get("data"):
                out["rewards"].append(f"💧偷水: {st['data']}")
            time.sleep(0.8)

    # ============ 游戏任务 (领现金兑商品) ============
    out["games"] = []
    r = o.api("POST", "/njia/game/task/list", {"gameType": 2, "platform": "android", "version": "6.7.1"})
    tasks = r.get("data") if r.get("success") or r.get("code") == 200 else None
    if isinstance(tasks, list):
        for t in tasks:
            item = t.get("item") or {}
            tid = item.get("id")
            if not tid:
                continue
            for attempt in range(2):
                fr = o.api("POST", "/njia/game/task/finish", {"taskId": tid, "gameType": t.get("activityType")})
                if fr.get("code") == 200 and fr.get("data"):
                    d = fr["data"]
                    award = d.get("awardCount")
                    out["games"].append(f"✅{t.get('name','')}: {d.get('toastText') or ('+' + str(award) + '金币' if award else '')}")
                    dur = item.get("taskDuration") or 0
                    if d.get("awardCount") and attempt == 0:
                        time.sleep(int(dur) + 2)
                        continue
                    break
                else:
                    out["games"].append(f"⚠️{t.get('name','')}: {fr.get('message') or fr.get('errmsg','')}")
                    break
            time.sleep(3)
    # 11. 特殊任务
    r = o.api("POST", "/njia/game/task/special/finish", {})
    if r.get("errcode") == 0:
        out["games"].append("⭐特殊任务✅")

    # ============ 外卖打卡签到 (活动id从 env FXSH_SIGN_DATE, 临时活动) ============
    sign_date = os.getenv("FXSH_SIGN_DATE", "")
    if sign_date:
        r = o.api("POST", "/njia/takeaway/clock/in/sign", {"activityId": sign_date})
        if r.get("code") == 200 and r.get("data"):
            d = r["data"]
            money = d.get("rewardAmount", 0) / 100
            out["takeaway"] = f"🍔外卖签到✅ +{money}元"
        else:
            out["takeaway"] = f"🍔外卖签到:{r.get('message') or '活动已结束'}"
    else:
        out["takeaway"] = "未配置外卖活动id"

    return out


def main():
    fxsh_env = os.getenv("fxsh")
    if not fxsh_env:
        print("未设置 fxsh 环境变量 (did#finger#token#oaid & 分隔)")
        return
    accounts = []
    for acc_str in fxsh_env.split("&"):
        parts = acc_str.split("#")
        if len(parts) == 4:
            accounts.append({"did": parts[0], "finger": parts[1], "token": parts[2], "oaid": parts[3]})
    print(f"共 {len(accounts)} 个账号\n")
    results = []
    for i, acc in enumerate(accounts):
        print(f"========== 账号{i+1} ({acc['did'][:10]}...) ==========")
        r = run(acc)
        results.append(r)
        lines = [f"水量: {r['water']}"]
        if r.get("fruit"): lines.append(f"果树: {r['fruit']}")
        for t in r["tasks"]: lines.append(t)
        for rw in r["rewards"]: lines.append(rw)
        if r["watered"]: lines.append("浇水: ✅")
        for e in r["elephant"]: lines.append(e)
        for g in r["games"]: lines.append(g)
        if r.get("takeaway"): lines.append(r["takeaway"])
        for e in r["errors"]: lines.append(f"⚠️{e}")
        print("\n".join(lines) + "\n")
        time.sleep(2)
    print("完成")


if __name__ == "__main__":
    main()
