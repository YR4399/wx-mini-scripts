# 入口: 粉象生活APP
# 环境变量配置（环境变量名: fxsh)(变量值：did1#finger1#token1#oaid1)
# 多号&隔开变量值
# 功能: 签到 完成任务得券码，看脸中奖
# 加固: 请求重试 + PushPlus 推送 + 汇总统计 (2026-08-03)

import requests
import json
import time
import random
import hashlib
import os

# 配置常量（从请求头中提取）
BASE_URL = "https://fenxiang-lottery-api.fenxianglife.com"
COMMON_HEADERS = {
    "origin": "https://m.fenxianglife.com",
    "user-agent": "Mozilla/5.0 (Linux; Android 9; MI 8 SE Build/PKQ1.181121.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/72.0.3626.121 Mobile Safari/537.36 AgentWeb/5.0.0  UCBrowser/11.6.4.950",
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*",
    "version": "1.0.0",
    "accept-encoding": "gzip, deflate",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "x-requested-with": "com.n_add.android"
}

# 签名密钥
SECRET_KEY = "粉象好牛逼a8c19d8267527ea4c7d2f011acf7766f"

# 推送 token
PUSH_TOKEN = os.getenv("PUSH_PLUS_TOKEN") or os.getenv("PLUSPLUS_TOKEN") or ""


def push(title, content):
    """PushPlus 推送"""
    if not PUSH_TOKEN:
        return
    try:
        r = requests.post("https://www.pushplus.plus/send",
                          json={"token": PUSH_TOKEN, "title": title, "content": content, "template": "txt"},
                          timeout=10)
        print(f"推送结果: {r.status_code}")
    except Exception as e:
        print(f"推送失败: {e}")


def convert_object_to_query_string(obj):
    """
    对应JS中的convertObjectToQueryString函数
    将对象按key排序后转为query string格式
    """
    if not obj:
        return ""
    # 按key排序
    sorted_keys = sorted(obj.keys())
    parts = []
    for key in sorted_keys:
        value = obj[key]
        # 排除null和对象类型的值
        if value is not None and not isinstance(value, (dict, list)):
            parts.append(f"{key}={value}")
    return "&".join(parts)


def md5_hash(s):
    """对应JS中的v函数，生成MD5哈希"""
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def generate_sign(body_data, g_params):
    """生成sign签名"""
    # 处理body数据
    e = body_data if body_data else {}
    # 生成参数字符串
    e_str = convert_object_to_query_string(e)
    g_str = convert_object_to_query_string(g_params)
    # 拼接并生成MD5
    sign_str = f"{e_str}{g_str}{SECRET_KEY}"
    return md5_hash(sign_str)


def generate_g_params(account_params):
    """生成g参数（对应JS中的g对象）"""
    # 生成traceid
    timestamp_str = str(int(time.time() * 1000))
    random_str = str(random.random())
    traceid = md5_hash(timestamp_str + random_str)

    # 生成noncestr（8位数字）
    noncestr = str(random.randint(10000000, 99999999))

    # 组合g参数
    g_params = {
        "traceid": traceid,
        "noncestr": noncestr,
        "timestamp": int(time.time() * 1000),
        "platform": "h5",
        "did": account_params["did"],
        "version": "1.0.0",
        "finger": account_params["finger"],
        "token": account_params["token"],
        "oaid": account_params["oaid"]
    }
    return g_params


def send_post_request(path, body_data, account_params):
    """
    发送POST请求，自动处理签名和请求头 (失败重试 3 次)
    """
    # 生成g参数
    g_params = generate_g_params(account_params)

    # 生成签名
    sign = generate_sign(body_data, g_params)
    g_params["sign"] = sign

    # 组合请求头
    headers = COMMON_HEADERS.copy()
    # 将g参数和账号参数添加到请求头
    headers.update({
        "did": account_params["did"],
        "finger": account_params["finger"],
        "noncestr": g_params["noncestr"],
        "timestamp": str(g_params["timestamp"]),
        "oaid": account_params["oaid"],
        "platform": "h5",
        "traceid": g_params["traceid"],
        "sign": sign,
        "token": account_params["token"]
    })

    # 发送请求 (带重试)
    url = f"{BASE_URL}{path}"
    for attempt in range(1, 4):
        try:
            response = requests.post(
                url,
                headers=headers,
                json=body_data,
                verify=False,  # 忽略SSL验证（根据实际情况调整）
                timeout=15
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            if attempt < 3:
                print(f"请求失败 {url} (第{attempt}次): {e}, 2s 后重试")
                time.sleep(2 * attempt)
            else:
                print(f"请求失败 {url}: {e}")
    return None


def process_account(account_params, account_index):
    """处理单个账号的所有请求"""
    print(f"\n========== 处理第 {account_index + 1} 个账号 (did: {account_params['did']}) ==========")
    result = {"did": account_params["did"], "sign": "?", "receive": "-", "tasks": [], "errors": []}

    # 1. 签到奖励
    print("\n=== 执行第一个请求：签到奖励 ===")
    sign_reward_response = send_post_request("/fenxiang-lottery/user/sign/reward", {}, account_params)
    if sign_reward_response:
        code = sign_reward_response.get("code")
        data = sign_reward_response.get("data") or {}
        if code == 200 or code == 0 or (data and data.get("success")):
            msg = json.dumps(data, ensure_ascii=False)[:120]
            result["sign"] = f"成功 {msg}"
            print(f"✅ 签到奖励: {msg}")
        else:
            msg = sign_reward_response.get("msg") or sign_reward_response.get("message") or json.dumps(sign_reward_response, ensure_ascii=False)[:100]
            result["sign"] = msg
            print(f"签到响应: {msg}")
    else:
        result["errors"].append("sign: 请求失败")
        print("❌ 签到奖励请求失败")
    print("-" * 50)

    # 1.5 领取开奖结果中奖码 (receiveAll, 提取自 sky2022 插件)
    print("\n=== 领取开奖中奖码 ===")
    receive_response = send_post_request("/fenxiang-lottery/periodical/open/result/receiveAll", {}, account_params)
    if receive_response:
        rcode = receive_response.get("code")
        rmsg = receive_response.get("message") or ""
        rdata = receive_response.get("data") or {}
        if rcode == 200 or rcode == 0 or receive_response.get("success"):
            if rdata:
                result["receive"] = f"领取成功 {json.dumps(rdata, ensure_ascii=False)[:80]}"
                print(f"🎁 开奖码领取: {result['receive']}")
            else:
                result["receive"] = "无待领奖码"
                print(f"🎁 开奖码领取: 无待领奖码")
        else:
            result["receive"] = rmsg or "领取失败"
            print(f"🎁 开奖码领取: {result['receive']}")
    else:
        result["receive"] = "请求失败"
        print("❌ 开奖码领取请求失败")
    print("-" * 50)

    # 2. 获取首页数据
    print("\n=== 执行第二个请求：获取首页数据 ===")
    home_data_response = send_post_request("/fenxiang-lottery/home/data/V2",
                                           {"plateform": "android", "version": "7.0.1"}, account_params)

    if not home_data_response:
        print("❌ 获取首页数据失败，跳过该账号后续操作")
        result["errors"].append("home: 请求失败")
        return result

    # 提取所有taskId
    task_ids = []
    try:
        task_results = home_data_response["data"]["taskModule"]["taskResult"]
        for task in task_results:
            task_id = task.get("id")
            if task_id:
                task_ids.append(task_id)
        print(f"提取到的taskId列表: {task_ids}")
    except (KeyError, TypeError) as e:
        print(f"提取taskId失败: 找不到键 {e} (resp: {json.dumps(home_data_response, ensure_ascii=False)[:150]})")
        result["errors"].append("home: taskModule 缺失")
        return result
    print("-" * 50)

    # 3. 完成任务（循环所有taskId）
    print("\n=== 执行第三个请求：完成任务 ===")
    for task_id in task_ids:
        print(f"\n处理taskId: {task_id}")
        finish_task_response = send_post_request("/fenxiang-lottery/lotteryCode/task/finish",
                                                 {"taskId": task_id}, account_params)
        if finish_task_response:
            code = finish_task_response.get("code")
            data = finish_task_response.get("data") or {}
            msg = finish_task_response.get("msg") or finish_task_response.get("message") or ""
            ok = code == 200 or code == 0 or (data and data.get("success")) or (msg and ("成功" in msg or "完成" in msg))
            result["tasks"].append({"id": task_id, "ok": ok, "msg": (msg or json.dumps(finish_task_response, ensure_ascii=False))[:80]})
            print(f"taskId {task_id}: {msg or json.dumps(finish_task_response, ensure_ascii=False)[:100]}")
        else:
            result["tasks"].append({"id": task_id, "ok": False, "msg": "请求失败"})
            print(f"taskId {task_id}: 请求失败")
        time.sleep(1)
        print("-" * 30)

    print(f"\n========== 第 {account_index + 1} 个账号处理完成 ==========\n")
    return result


def parse_account_params():
    """解析环境变量fxsh中的账号参数"""
    fxsh_env = os.getenv("fxsh")
    if not fxsh_env:
        print("错误：未设置fxsh环境变量！")
        print("设置示例：export fxsh='did1#finger1#token1#oaid1&did2#finger2#token2#oaid2'")
        return []

    account_str_list = fxsh_env.split("&")
    accounts = []

    for idx, account_str in enumerate(account_str_list):
        parts = account_str.split("#")
        if len(parts) != 4:
            print(f"警告：第 {idx + 1} 个账号参数格式错误（应为did#finger#token#oaid），跳过该账号")
            print(f"错误参数：{account_str}")
            continue

        accounts.append({
            "did": parts[0].strip(),
            "finger": parts[1].strip(),
            "token": parts[2].strip(),
            "oaid": parts[3].strip()
        })

    return accounts


def main():
    # 禁用requests的警告
    requests.packages.urllib3.disable_warnings()

    # 解析账号参数
    accounts = parse_account_params()
    if not accounts:
        return

    print(f"共解析到 {len(accounts)} 个有效账号，开始处理...")

    # 逐个处理账号
    results = []
    for idx, account in enumerate(accounts):
        results.append(process_account(account, idx))
        if idx < len(accounts) - 1:
            time.sleep(2)

    print("\n所有账号处理完成！")

    # 汇总推送
    lines = []
    for r in results:
        task_ok = sum(1 for t in r["tasks"] if t.get("ok"))
        task_fail = [t["id"] for t in r["tasks"] if not t.get("ok")]
        lines.append(
            f"【did:{r['did'][:8]}...】\n"
            f"签到: {r['sign']}\n"
            f"领奖: {r['receive']}\n"
            f"任务: {task_ok}/{len(r['tasks'])} 完成"
            + (f"\n失败: {task_fail}" if task_fail else "")
            + (f"\n异常: {'; '.join(r['errors'])}" if r["errors"] else "")
        )
    summary = "\n\n".join(lines)
    print("\n📊 汇总:\n" + summary)
    push("粉象生活", summary)


if __name__ == "__main__":
    main()
