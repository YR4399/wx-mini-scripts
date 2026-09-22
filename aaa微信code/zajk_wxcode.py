#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
众安健康小程序自动任务脚本（wxcode版 v2）
功能：wxcode自动登录 + 签到 + 浏览商品 + 抽奖 + 提现（满5元）

v2 改动（2026-08-02）：
  1. 全部请求走统一 req() 封装，带 4 次退避重试（应对 ihealth.zhongan.com 频繁 Read timeout）
  2. timeout 从 10/15s 提升为 (连接10s, 读40s)，众安服务端本身响应慢
  3. Session 复用 TCP 连接，减少握手开销
  4. 步骤级容错：签到/商品/抽奖/提现各自独立 try，单步失败不再中断整个账号
  5. 第二次 homePage 拉取失败时回退用第一次的数据，保证抽奖/提现照常执行
  6. 汇总结果 + std_report(钉钉) 推送

环境变量:
  wx_opinion / zajk_openid : 用户 openid，多账号用 & 或 @ 分隔
  wx_server_url            : wechatserver 地址（如 http://host.docker.internal:18788）
  wx_auth                  : wechatserver 认证码
  推送由 std_report 引擎统一经钉钉机器人发送

cron: 10 15 * * *
"""

import os
import json
import time
import random
import requests

# ==================== 配置区 ====================

wx_server_url = os.environ.get("wx_server_url", "").rstrip("/")
wx_auth = os.environ.get("wx_auth", "")
ZA_APPID = "wxbac45cc1588a5a75"

# 清理代理，避免容器内代理导致连接异常
for _k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    os.environ.pop(_k, None)

CHANNEL_CODE = "c20195660470001"
ACTIVITY_CODE = "ONA20220411001"
BASE_URL = "https://ihealth.zhongan.com"

# 网络参数：众安服务端响应慢，连接 10s / 读 40s，失败退避重试 4 次
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 40
MAX_RETRIES = 4
RETRY_BACKOFF = 3  # 秒，第 n 次重试等待 RETRY_BACKOFF * n

# ==================== 工具函数 ====================

def log(index, msg):
    print(f"[{time.strftime('%H:%M:%S')}] [账号#{index}] {msg}")


def random_delay(min_s=2, max_s=4):
    time.sleep(random.uniform(min_s, max_s))


from std_report import report


# ==================== 账号类 ====================

class ZAHealth:
    def __init__(self, openid, index):
        self.index = index
        if "#" in openid:
            self.openid, self.remark = openid.split("#", 1)
            self.openid = self.openid.strip()
            self.remark = self.remark.strip()
        else:
            self.openid = openid.strip()
            self.remark = ""
        self.token = None
        self.session = requests.Session()
        self.summary = []          # 该账号执行结果摘要，用于推送

    def log(self, msg):
        log(self.index, msg)

    def note(self, msg):
        """记入摘要并打日志"""
        self.summary.append(msg)
        self.log(msg)

    # ---------- 统一请求封装（核心改动） ----------
    def req(self, method, url, *, headers=None, json_body=None, label=""):
        """
        带退避重试的请求。仅对网络层异常（超时/连接断开）重试，
        业务层错误码原样返回给调用方处理。
        """
        last_err = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.request(
                    method, url,
                    headers=headers,
                    json=json_body,
                    timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                )
                return resp.json()
            except (requests.exceptions.Timeout,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.ChunkedEncodingError) as e:
                last_err = e
                if attempt < MAX_RETRIES:
                    wait = RETRY_BACKOFF * attempt
                    self.log(f"⏳ {label or url.rsplit('/', 1)[-1]} 网络超时，{wait}s 后第 {attempt}/{MAX_RETRIES - 1} 次重试")
                    time.sleep(wait)
            except ValueError as e:
                # 返回非 JSON（可能被 WAF 拦截），也重试
                last_err = e
                if attempt < MAX_RETRIES:
                    wait = RETRY_BACKOFF * attempt
                    self.log(f"⏳ {label} 响应非 JSON，{wait}s 后重试")
                    time.sleep(wait)
        raise Exception(f"{label or '请求'} 重试 {MAX_RETRIES} 次仍失败: {last_err}")

    def get_wxcode(self):
        """从 wechatserver 获取 wxcode"""
        if not wx_auth:
            raise Exception("未配置 wx_auth")
        url = f"{wx_server_url}/wx/code"
        headers = {"auth": wx_auth, "Content-Type": "application/json"}
        data = {"appid": ZA_APPID, "openid": self.openid}
        result = self.req("POST", url, headers=headers, json_body=data, label="WCS取code")
        code = result.get("data", {}).get("code")
        if not code:
            raise Exception(f"获取 wxcode 失败: {result.get('message', '未知')}")
        return code

    def login(self):
        """用 wxcode 登录获取 token"""
        code = self.get_wxcode()
        url = f"{BASE_URL}/api/lemon/v1/wechatApplet/login/{CHANNEL_CODE}?code={code}"
        headers = {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X)",
            "Content-Type": "application/json",
        }
        result = self.req("GET", url, headers=headers, label="登录")

        if result.get("code") == "0":
            self.token = result.get("result", "")
            self.log(f"✅ 登录成功 | token: {self.token[:30]}...")
            return True
        raise Exception(f"登录失败: {result.get('message', '未知')}")

    def get_headers(self):
        return {
            "Host": "ihealth.zhongan.com",
            "Connection": "keep-alive",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Access-Token": self.token,
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.23(0x1800172f) NetType/WIFI Language/zh_CN",
            "Referer": f"https://servicewechat.com/{ZA_APPID}/210/page-frame.html",
        }

    def get_homepage(self):
        """获取首页信息（失败返回 None，由调用方决定回退）"""
        url = f"{BASE_URL}/api/lemon/v1/common/activity/homePage"
        body = {"activityCode": ACTIVITY_CODE, "channelCode": CHANNEL_CODE}
        try:
            result = self.req("POST", url, headers=self.get_headers(),
                              json_body=body, label="首页")
        except Exception as e:
            self.log(f"⚠️ 获取首页失败: {e}")
            return None
        if result.get("code") == "0":
            return result.get("result", {})
        self.log(f"⚠️ 首页返回异常: {result.get('message', '未知')}")
        return None

    def do_checkin(self):
        """签到"""
        self.log("执行签到...")
        url = f"{BASE_URL}/api/lemon/v1/common/activity/signIn"
        body = {"activityCode": ACTIVITY_CODE, "channelCode": CHANNEL_CODE}
        result = self.req("POST", url, headers=self.get_headers(),
                          json_body=body, label="签到")

        if result.get("code") == "0":
            data = result.get("result", {})
            self.note(f"✅ 签到成功，今日获得 {data.get('today', 0)} 分")
            self._sign = '签到成功'
            self._earned = data.get('today', 0)
            _streak = data.get('continueDays') or data.get('signDay') or data.get('seriesDays') or data.get('totalSign') or data.get('signCount')
            if _streak is not None:
                self._streak = _streak
            return True
        self.note(f"❌ 签到失败: {result.get('message', '未知')}")
        self._sign = '签到失败'
        return False

    def do_product_tasks(self, homepage):
        """商品浏览任务"""
        product_recommend = homepage.get("productRecommend", {}) or {}
        if not product_recommend:
            self.log("无商品浏览任务")
            return

        goods_codes = list(product_recommend.keys())[:3]
        self.log(f"开始商品浏览任务 ({len(goods_codes)}个)...")
        ok = 0

        for idx, goods_code in enumerate(goods_codes, start=1):
            url = f"{BASE_URL}/api/lemon/v1/applet/mgm/activity/add/award"
            body = {
                "activityCode": ACTIVITY_CODE,
                "channelCode": "1000000004",
                "goodsCode": goods_code,
                "taskId": "110",
            }
            headers = self.get_headers()
            headers["Origin"] = "https://ihealth.zhongan.com"

            try:
                result = self.req("POST", url, headers=headers,
                                  json_body=body, label=f"商品任务{idx}")
                if result.get("code") == "0":
                    ok += 1
                    self.log(f"商品任务 {idx}/{len(goods_codes)} 完成")
                else:
                    self.log(f"商品任务 {idx}/{len(goods_codes)} 失败: {result.get('message', '未知')}")
            except Exception as e:
                # 单个商品失败不影响后续
                self.log(f"商品任务 {idx}/{len(goods_codes)} 异常: {e}")

            random_delay(1, 2)

        self.note(f"🛒 商品浏览 {ok}/{len(goods_codes)} 完成")
        if ok > 0:
            self._task_earned = f"商品浏览{ok}个"

    def do_lottery(self, homepage):
        """抽奖"""
        reward_list = homepage.get("valuableRewardList", []) or []
        if not reward_list:
            self.note("🎰 无抽奖机会")
            return

        self.log(f"开始抽奖 ({len(reward_list)}次)...")
        ok = 0

        for reward in reward_list:
            award_id = reward.get("awardDetailId")
            if not award_id:
                continue

            url = f"{BASE_URL}/api/lemon/v1/common/activity/lottery"
            body = {"channelCode": CHANNEL_CODE,
                    "activityCode": ACTIVITY_CODE, "id": award_id}
            try:
                result = self.req("POST", url, headers=self.get_headers(),
                                  json_body=body, label="抽奖")
                if result.get("code") == "0":
                    ok += 1
                    prize = result.get("result", {}) or {}
                    prize_desc = prize.get("awardName") or prize.get("award") or prize.get("name") or json.dumps(prize, ensure_ascii=False)
                    self._lottery_prizes.append(str(prize_desc))
                    self.log(f"🎉 抽奖成功! {json.dumps(prize, ensure_ascii=False)[:80]}")
                else:
                    self.log(f"抽奖失败: {result.get('message', '未知')}")
            except Exception as e:
                self.log(f"抽奖异常: {e}")

            random_delay(1, 2)

        self.note(f"🎰 抽奖 {ok}/{len(reward_list)} 次成功")
        if self._lottery_prizes:
            self._lottery = "｜".join(self._lottery_prizes)
        else:
            self._lottery = (f'{ok}/{len(reward_list)}次抽奖' if reward_list else None)

    def do_withdraw(self, homepage):
        """提现（满 5 元）"""
        sum_allow_withdraw = homepage.get("sumAllowWithdraw", 0) or 0
        total_award = homepage.get("sumAward", 0) or 0
        self._total = total_award
        self.note(f"💰 累计 {total_award/100:.2f} 元 | 可提现 {sum_allow_withdraw/100:.2f} 元")

        if sum_allow_withdraw < 500:
            self.log("未达到提现门槛 (5元)")
            return

        self.log("执行提现 (5元)...")
        url = f"{BASE_URL}/api/lemon/v1/common/activity/withdraw"
        body = {"channelCode": CHANNEL_CODE,
                "activityCode": ACTIVITY_CODE, "amount": 500}
        try:
            result = self.req("POST", url, headers=self.get_headers(),
                              json_body=body, label="提现")
            if result.get("code") == "0":
                self.note("💸 提现成功 (5元)!")
            else:
                self.note(f"❌ 提现失败: {result.get('message', '未知')}")
        except Exception as e:
            self.note(f"❌ 提现异常: {e}")

    def run(self):
        """主流程：每一步独立容错，单步失败不中断整体"""
        self._sign = '未知'
        self._earned = None
        self._lottery = None
        self._total = None
        self._streak = None
        self._task_earned = None
        self._lottery_prizes = []
        self.log("=" * 40)
        try:
            self.login()
        except Exception as e:
            self.note(f"❌ 登录失败: {e}")
            return self.summary
        random_delay()

        homepage = self.get_homepage()
        if not homepage:
            self.note("❌ 获取首页信息失败，跳过该账号")
            return self.summary

        # 签到
        try:
            self.do_checkin()
        except Exception as e:
            self.note(f"❌ 签到异常: {e}")
        random_delay()

        # 商品浏览
        try:
            self.do_product_tasks(homepage)
        except Exception as e:
            self.note(f"❌ 商品任务异常: {e}")
        random_delay()

        # 刷新首页（拿最新抽奖次数/余额）；失败则沿用旧数据，不再中断
        fresh = self.get_homepage()
        if fresh:
            homepage = fresh
        else:
            self.log("⚠️ 刷新首页失败，沿用签到前数据继续抽奖/提现")

        # 抽奖
        try:
            self.do_lottery(homepage)
        except Exception as e:
            self.note(f"❌ 抽奖异常: {e}")
        random_delay()

        # 提现
        try:
            self.do_withdraw(homepage)
        except Exception as e:
            self.note(f"❌ 提现异常: {e}")

        self.log("任务完成!")
        return self.summary


# ==================== 主流程 ====================

def main():
    print("=" * 50)
    print(f"众安健康 (wxcode版 v2) | {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)

    openid_env = os.environ.get("wx_opinion", "") or os.environ.get("zajk_openid", "")

    if not openid_env:
        print("❌ 未配置环境变量 wx_opinion / zajk_openid")
        print("  wx_opinion    : 用户openid，多账号用 & 分隔")
        print("  wx_server_url : wechatserver 地址")
        print("  wx_auth       : wechatserver 认证码")
        return

    # 解析账号
    if "&" in openid_env:
        accounts = openid_env.split("&")
    elif "@" in openid_env:
        accounts = openid_env.split("@")
    else:
        accounts = [openid_env]

    accounts = [a.strip() for a in accounts if a.strip()]
    print(f"共找到 {len(accounts)} 个账号")

    all_summary = []
    _rows = []

    for idx, openid in enumerate(accounts, start=1):
        print(f"\n[>] 开始执行第 [{idx}/{len(accounts)}] 个账号...")
        bot = ZAHealth(openid, idx)
        try:
            result = bot.run()
        except Exception as e:
            result = [f"❌ 账号异常: {e}"]
            print(f"[账号#{idx}] 未捕获异常: {e}")

        all_summary.append(f"【账号#{idx}】\n" + "\n".join(result or ["无结果"]))
        _rows.append({
            'idx': idx,
            'name': bot.remark or f'账号#{idx}',
            'sign': getattr(bot, '_sign', '未知'),
            'earned': (f"{getattr(bot, '_earned', None)}分" if getattr(bot, '_earned', None) else None),
            'total': (str(getattr(bot, '_total', None)) if getattr(bot, '_total', None) is not None else None),
            'streak': getattr(bot, '_streak', None),
            'tasks': None,
            'taskEarned': getattr(bot, '_task_earned', None),
            'lottery': getattr(bot, '_lottery', None),
        })

        if idx < len(accounts):
            cooldown = random.randint(3, 8)
            print(f"[...] 等待 {cooldown} 秒后执行下一个账号...")
            time.sleep(cooldown)

    print("\n" + "=" * 50)
    print("全部完成!")

    try:
        report('众安健康签到', _rows)
    except Exception as e:
        print(f'[report] 失败: {e}')


if __name__ == "__main__":
    main()
