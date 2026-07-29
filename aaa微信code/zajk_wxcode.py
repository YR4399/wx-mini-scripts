#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
众安健康小程序自动任务脚本（wxcode版）
功能：wxcode自动登录 + 签到 + 浏览商品 + 抽奖 + 提现
满5元可提现！

环境变量:
  zajk_openid: 用户openid，多账号用 @ 或换行分隔
  wx_server_url: wechatserver 地址（如 http://192.168.1.100:8787）
  wx_auth: wechatserver 认证码

cron: 32 7 * * *
"""

import os
import json
import time
import random
import requests

# ==================== 配置区 ====================

WX_SERVER_URL = os.environ.get("wx_server_url", "").rstrip("/")
WX_AUTH = os.environ.get("wx_auth", "")
ZA_APPID = "wxbac45cc1588a5a75"
# Clear proxy
for _k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'):
    os.environ.pop(_k, None)

CHANNEL_CODE = "c20195660470001"
ACTIVITY_CODE = "ONA20220411001"

BASE_URL = "https://ihealth.zhongan.com"

# ==================== 工具函数 ====================

def log(index, msg):
    print(f"[{time.strftime('%H:%M:%S')}] [账号#{index}] {msg}")

def random_delay(min_s=2, max_s=4):
    time.sleep(random.uniform(min_s, max_s))

# ==================== 账号类 ====================

class ZAHealth:
    def __init__(self, openid, index):
        self.index = index
        self.openid = openid
        self.token = None

    def log(self, msg):
        log(self.index, msg)

    def get_wxcode(self):
        """获取 wxcode"""
        if not WX_AUTH:
            raise Exception("未配置 wx_auth")
        url = f"{WX_SERVER_URL}/wx/code"
        headers = {"auth": WX_AUTH, "Content-Type": "application/json"}
        data = {"appid": ZA_APPID, "openid": self.openid}
        resp = requests.post(url, headers=headers, json=data, timeout=15)
        result = resp.json()
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
        resp = requests.get(url, headers=headers, timeout=15)
        result = resp.json()

        if result.get("code") == "0":
            self.token = result.get("result", "")
            self.log(f"登录成功 | token: {self.token[:30]}...")
            return True
        else:
            raise Exception(f"登录失败: {result.get('message', '未知')}")

    def get_headers(self):
        """构造请求头"""
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
        """获取首页信息"""
        url = f"{BASE_URL}/api/lemon/v1/common/activity/homePage"
        body = {
            "activityCode": ACTIVITY_CODE,
            "channelCode": CHANNEL_CODE
        }
        resp = requests.post(url, headers=self.get_headers(), json=body, timeout=10)
        result = resp.json()
        if result.get("code") == "0":
            return result.get("result", {})
        return None

    def do_checkin(self):
        """签到"""
        self.log("执行签到...")
        url = f"{BASE_URL}/api/lemon/v1/common/activity/signIn"
        body = {
            "activityCode": ACTIVITY_CODE,
            "channelCode": CHANNEL_CODE
        }
        resp = requests.post(url, headers=self.get_headers(), json=body, timeout=10)
        result = resp.json()

        if result.get("code") == "0":
            data = result.get("result", {})
            self.log(f"签到成功! 今日获得: {data.get('today', 0)}分")
            return True
        else:
            self.log(f"签到失败: {result.get('message', '未知')}")
            return False

    def do_product_tasks(self, homepage):
        """执行商品浏览任务"""
        product_recommend = homepage.get("productRecommend", {})
        if not product_recommend:
            self.log("无商品浏览任务")
            return

        goods_codes = list(product_recommend.keys())[:3]
        self.log(f"开始商品浏览任务 ({len(goods_codes)}个)...")

        for idx, goods_code in enumerate(goods_codes, start=1):
            url = f"{BASE_URL}/api/lemon/v1/applet/mgm/activity/add/award"
            body = {
                "activityCode": ACTIVITY_CODE,
                "channelCode": "1000000004",
                "goodsCode": goods_code,
                "taskId": "110"
            }
            headers = self.get_headers()
            headers["Origin"] = "https://ihealth.zhongan.com"

            resp = requests.post(url, headers=headers, json=body, timeout=10)
            result = resp.json()

            if result.get("code") == "0":
                self.log(f"商品任务 {idx}/{len(goods_codes)} 完成")
            else:
                self.log(f"商品任务 {idx}/{len(goods_codes)} 失败: {result.get('message', '未知')}")

            random_delay(1, 2)

    def do_lottery(self, homepage):
        """抽奖"""
        reward_list = homepage.get("valuableRewardList", [])
        if not reward_list:
            self.log("无抽奖机会")
            return

        self.log(f"开始抽奖 ({len(reward_list)}次)...")

        for reward in reward_list:
            award_id = reward.get("awardDetailId")
            if not award_id:
                continue

            url = f"{BASE_URL}/api/lemon/v1/common/activity/lottery"
            body = {
                "channelCode": CHANNEL_CODE,
                "activityCode": ACTIVITY_CODE,
                "id": award_id
            }
            resp = requests.post(url, headers=self.get_headers(), json=body, timeout=10)
            result = resp.json()

            if result.get("code") == "0":
                self.log(f"抽奖成功!")
            else:
                self.log(f"抽奖失败: {result.get('message', '未知')}")

            random_delay(1, 2)

    def do_withdraw(self, homepage):
        """提现"""
        sum_allow_withdraw = homepage.get("sumAllowWithdraw", 0)
        total_award = homepage.get("sumAward", 0)
        self.log(f"累计金额: {total_award/100:.2f}元 | 可提现: {sum_allow_withdraw/100:.2f}元")

        if sum_allow_withdraw >= 500:
            self.log("执行提现 (5元)...")
            url = f"{BASE_URL}/api/lemon/v1/common/activity/withdraw"
            body = {
                "channelCode": CHANNEL_CODE,
                "activityCode": ACTIVITY_CODE,
                "amount": 500
            }
            resp = requests.post(url, headers=self.get_headers(), json=body, timeout=10)
            result = resp.json()

            if result.get("code") == "0":
                self.log("提现成功!")
            else:
                self.log(f"提现失败: {result.get('message', '未知')}")
        else:
            self.log("未达到提现门槛 (5元)")

    def run(self):
        """主流程"""
        try:
            self.log("=" * 40)
            self.login()
            random_delay()

            # 获取首页信息
            homepage = self.get_homepage()
            if not homepage:
                self.log("获取首页信息失败")
                return

            # 签到
            self.do_checkin()
            random_delay()

            # 商品浏览任务
            self.do_product_tasks(homepage)
            random_delay()

            # 重新获取首页信息
            homepage = self.get_homepage()
            if not homepage:
                return

            # 抽奖
            self.do_lottery(homepage)
            random_delay()

            # 提现
            self.do_withdraw(homepage)

            self.log("任务完成!")

        except Exception as e:
            self.log(f"执行失败: {e}")

# ==================== 主流程 ====================

def main():
    print("=" * 50)
    print(f"众安健康 (wxcode版) | {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)

    # 读取环境变量
    openid_env = os.environ.get("wx_opinion", "") or os.environ.get("zajk_openid", "")

    if not openid_env:
        print("❌ 未配置环境变量 zajk_openid")
        print("请在青龙面板配置以下环境变量：")
        print("  zajk_openid: 用户openid，多账号用 @ 分隔")
        print("  wx_server_url: wechatserver 地址")
        print("  wx_auth: wechatserver 认证码")
        return

    # 解析账号
    accounts = []
    if "&" in openid_env:
        accounts = openid_env.split("&")
    elif "@" in openid_env:
        accounts = openid_env.split("@")
    else:
        accounts = [openid_env]

    accounts = [a.strip() for a in accounts if a.strip()]
    print(f"共找到 {len(accounts)} 个账号")

    # 执行任务
    for idx, openid in enumerate(accounts, start=1):
        print(f"\n[>] 开始执行第 [{idx}/{len(accounts)}] 个账号...")
        bot = ZAHealth(openid, idx)
        bot.run()

        if idx < len(accounts):
            cooldown = random.randint(3, 8)
            print(f"[...] 等待 {cooldown} 秒后执行下一个账号...")
            time.sleep(cooldown)

    print("\n" + "=" * 50)
    print("全部完成!")

if __name__ == "__main__":
    main()
