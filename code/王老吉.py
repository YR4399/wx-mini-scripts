"""
王老吉小程序 — 签到抽奖脚本

自动调用王老吉「吉伴考场 从容作答」活动抽奖接口，支持多账号轮询。

环境变量:
  wlj      格式: openid#apitoken，多账号用 @ 或换行分隔
           示例: export wlj="openid1#token1@openid2#token2"

抓包:
  1. 微信打开王老吉小程序，进入活动页面，点击签到/抽奖
  2. 找到 thirtypro.jmhd8.com 域名下的 lottery 请求
     - 请求头 → apitoken
     - 响应体 → openid

注意:
  - apitoken 和 openid 会过期，抽奖失败时请重新抓包
"""

import os
import re
import sys
import uuid
from datetime import datetime

import requests

DISCLAIMER = """
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  免责声明                                        ┃
┃  本脚本仅供学习交流使用，请勿用于商业用途。        ┃
┃  使用本脚本产生的任何后果由使用者自行承担。        ┃
┃  作者不对因使用本脚本造成的任何损失负责。          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
"""

GROUP_INFO = "  饱了么脚本交流群：476250706"

print(DISCLAIMER)
print(GROUP_INFO)


def parse_accounts(raw):
    accounts = []

    for part in re.split(r"[\n@]+", raw.strip()):
        part = part.strip()

        if not part:
            continue

        segs = part.split("#")

        if len(segs) >= 2:
            accounts.append(
                (
                    segs[0].strip(),
                    segs[1].strip()
                )
            )
        else:
            print(f"  警告  无法解析: {part}，已跳过")

    return accounts


def send_lottery(openid, apitoken):
    url = "https://thirtypro.jmhd8.com/api/v1/wanglaoji/signature/lottery"

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "apitoken": apitoken,
        "unique_identity": str(uuid.uuid4()),
        "Accept": "*/*",
        "Origin": "https://act1.geement.com",
        "Referer": "https://act1.geement.com/",
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_2 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
            "MicroMessenger/8.0.73(0x18004931) NetType/4G Language/zh_CN "
            "miniProgram/wxd25dc8ba975776e3"
        ),
    }

    body = {
        "code": "SCENE-26050614051636",
        "be_shared_user": "木瑶",
        "greeting": "吉伴君：愿你从容作答",
        "openid": openid,
    }

    now = datetime.now().strftime("%H:%M:%S")
    print(f" {now}  发起请求")

    try:
        resp = requests.post(
            url,
            headers=headers,
            data=body,
            timeout=15
        )

        data = resp.json()

        if (
            data.get("success")
            and data.get("data")
            and data["data"].get("prizedto")
        ):
            prize = data["data"]["prizedto"]

            goods = prize.get("goods", [])

            goods_text = (
                goods[0]["goods_name"]
                if goods else "无"
            )

            print(
                f" 成功  奖品 {prize['prize_name']} "
                f"({prize['prize_level']})"
            )

            print(f"        物品 {goods_text}")

        elif data.get("success"):
            msg = data.get(
                "msg",
                "处理成功（data 为空）"
            )

            print(f" 成功但无数据  {msg}")

        else:
            msg = data.get("msg", "未知错误")
            print(f" 失败  {msg}")

        return data

    except requests.RequestException as e:
        print(f" 网络异常  {e}")
        return None


class Stats:

    def __init__(self):
        self.total = 0
        self.success = 0
        self.fail = 0
        self.prizes = []

    def record(self, data):
        self.total += 1

        if (
            data
            and data.get("success")
            and data.get("data")
            and data["data"].get("prizedto")
        ):
            self.success += 1

            prize = data["data"]["prizedto"]

            self.prizes.append(
                f"{prize['prize_name']} "
                f"({prize['prize_level']})"
            )

        else:
            self.fail += 1

    def summary(self):
        print(f"\n{'=' * 44}")

        print(
            f" 总计 {self.total:<3}  "
            f"成功 {self.success:<3}  "
            f"失败 {self.fail:<3}"
        )

        print(f"{'=' * 44}")

        if self.prizes:
            print("\n 中奖记录")

            for i, p in enumerate(self.prizes, 1):
                print(f"  {i:>2}. {p}")

            print()


if __name__ == "__main__":

    raw = os.environ.get('wx_opinion', '') or os.environ.get('wlj', '')

    if not raw:
        print("\n请设置环境变量 wlj")

        print(
            " 格式: openid#apitoken，"
            "多账号用 换行 或 @ 分隔"
        )

        print(
            ' 示例: export '
            'wlj="openid1#token1@openid2#token2"\n'
        )

        sys.exit(1)

    accounts = parse_accounts(raw)

    if not accounts:
        print("未能解析出有效账号")
        sys.exit(1)

    print(f"\n共 {len(accounts)} 个账号\n")

    stats = Stats()

    for idx, (openid, apitoken) in enumerate(accounts, 1):

        print(f"{'─' * 44}")

        print(
            f" 账号 {idx}/{len(accounts)}  "
            f"{openid[:20]}..."
        )

        print(f"{'─' * 44}")

        data = send_lottery(openid, apitoken)

        stats.record(data)

    stats.summary()