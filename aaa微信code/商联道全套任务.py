import requests
import time
import os
import random
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

# ==================== 核心配置项 ====================
ENV_NAME = "lzjd"                # 环境变量名称（多账号openid用 # 分隔）
SPLIT_CHAR = "#"                 # 多账号分隔符

# wx_server 配置
WX_SERVER_URL = os.environ.get("wx_server_url", "")
WX_AUTH = os.environ.get("wx_auth", "")
APPID = "wx31a4573b0bf1fcb3"
DEFAULT_AVATAR = "https://thirdwx.qlogo.cn/mmopen/vi_32/POgEwh4mIHO4nibH0KlMECNjjGxQUq24ZEaGT4poC6icRiccVGKSyXwibcPq4BWmiaIGuG1icwxaQX6grC9VemZoJ8rg/132"
DEFAULT_NICKNAME = "微信用户"
SPID = 29107                     # 绑定手机时的商户ID，固定值

# Token 缓存文件
TOKEN_CACHE_FILE = "lzjd_token_cache.json"

# 广告配置
AD_WATCH_SEC = 33
AD_LOOP_SLEEP = 15

# 阅读间隔配置
ARTICLE_NORMAL_MIN = 15
ARTICLE_NORMAL_MAX = 20
ARTICLE_FINISHED_MIN = 3
ARTICLE_FINISHED_MAX = 5

# 阅读范围与模式
ARTICLE_START_ID = 38
ARTICLE_END_ID = 1
ARTICLE_WATCH_SEC = 33
ARTICLE_REVERSE = True

# 并发&网络配置
MAX_WORKERS = 10
REQ_TIMEOUT = 15
# =====================================================

# -------------------- token 缓存管理 --------------------
def read_token_cache():
    try:
        if not os.path.exists(TOKEN_CACHE_FILE):
            return {}
        with open(TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except:
        return {}

def write_token_cache(cache):
    try:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except:
        pass

def get_cached_token(openid):
    cache = read_token_cache()
    return cache.get(openid, {}).get("token")

def save_cached_token(openid, token):
    cache = read_token_cache()
    cache[openid] = {"token": token, "updated_at": time.time()}
    write_token_cache(cache)

def remove_cached_token(openid):
    cache = read_token_cache()
    if openid in cache:
        del cache[openid]
        write_token_cache(cache)

# -------------------- wx_server 交互 --------------------
def wx_server_request(endpoint, data):
    """调用 wx_server 接口"""
    url = f"{WX_SERVER_URL}{endpoint}"
    headers = {
        "auth": WX_AUTH,
        "Content-Type": "application/json"
    }
    try:
        resp = requests.post(url, json=data, headers=headers, timeout=REQ_TIMEOUT)
        if resp.status_code != 200:
            raise Exception(f"wx_server 返回HTTP {resp.status_code}")
        result = resp.json()
        # 兼容不同的返回格式：有的直接返回 data，有的返回 {code, data}
        if "code" in result and result["code"] != 0:
            raise Exception(f"wx_server 错误: {result.get('msg')}")
        return result.get("data") or result
    except Exception as e:
        raise Exception(f"wx_server 请求失败 {endpoint}: {str(e)}")

def get_code(openid):
    """通过 wx_server 获取微信小程序 code"""
    data = {"openid": openid, "appid": APPID}
    result = wx_server_request("/wx/code", data)
    code = result.get("code") or (result.get("data") and result["data"].get("code"))
    if not code:
        raise Exception("wx_server 未返回 code")
    return code

def get_phone_number(openid):
    """通过 wx_server 获取手机号授权 code"""
    data = {"openid": openid, "appid": APPID}
    result = wx_server_request("/wx/getphonenumber", data)
    phone_code = result.get("phone_code") or result.get("data", {}).get("phone_code")
    if not phone_code:
        raise Exception("wx_server 未返回 phone_code")
    return phone_code

# -------------------- 登录 / 绑定手机 --------------------
def login(openid):
    """完整登录流程，返回 token"""
    # 1. 获取 code
    code = get_code(openid)
    
    # 2. 调用登录接口
    login_url = "https://mini.shangliandao.cn/api/auth/login"
    login_data = {
        "code": code,
        "nickname": DEFAULT_NICKNAME,
        "avatar": DEFAULT_AVATAR
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
        "Content-Type": "application/json",
        "Referer": "https://servicewechat.com/wx31a4573b0bf1fcb3/28/page-frame.html"
    }
    resp = requests.post(login_url, json=login_data, headers=headers, timeout=REQ_TIMEOUT)
    if resp.status_code != 200:
        raise Exception(f"登录接口HTTP {resp.status_code}")
    result = resp.json()
    
    if result.get("status") != 200:
        raise Exception(f"登录失败: {result.get('msg')}")
    
    data = result.get("data", {})
    token = data.get("token")
    if token:
        return token
    
    # 需要绑定手机号
    if data.get("need_bind_phone"):
        bind_token = data.get("bind_token")
        if not bind_token:
            raise Exception("登录响应缺少 bind_token")
        
        # 获取手机号授权 code
        phone_code = get_phone_number(openid)
        
        # 调用绑定接口
        bind_url = "https://mini.shangliandao.cn/api/auth/bind-phone"
        bind_data = {
            "phone_code": phone_code,
            "bind_token": bind_token,
            "spid": SPID
        }
        bind_resp = requests.post(bind_url, json=bind_data, headers=headers, timeout=REQ_TIMEOUT)
        if bind_resp.status_code != 200:
            raise Exception(f"绑定手机HTTP {bind_resp.status_code}")
        bind_result = bind_resp.json()
        if bind_result.get("status") != 200:
            raise Exception(f"绑定手机失败: {bind_result.get('msg')}")
        
        token = bind_result.get("data", {}).get("token")
        if not token:
            raise Exception("绑定成功但未返回 token")
        return token
    
    raise Exception("登录失败：未知状态")

def verify_token(token):
    """验证 token 是否有效（调用一个轻量接口）"""
    headers = get_headers(token)
    try:
        resp = requests.get(
            "https://mini.shangliandao.cn/api/rewards/home-reward-status",
            headers=headers,
            timeout=REQ_TIMEOUT
        )
        return resp.status_code != 401
    except:
        return False

def get_valid_token(openid):
    """获取有效 token（优先缓存，失效则重新登录）"""
    cached = get_cached_token(openid)
    if cached and verify_token(cached):
        return cached
    # 重新登录
    token = login(openid)
    save_cached_token(openid, token)
    return token

# -------------------- 原有业务逻辑（保持不变，仅修改获取token的方式）--------------------
def get_headers(token):
    return {
        "Host": "mini.shangliandao.cn",
        "Authorization": f"Bearer {token}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254193e) XWEB/19841",
        "xweb_xhr": "1",
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Referer": "https://servicewechat.com/wx31a4573b0bf1fcb3/27/page-frame.html",
    }

def do_sign_in(token, idx):
    headers = get_headers(token)
    sign_url = "https://mini.shangliandao.cn/api/rewards/sign-in"
    try:
        resp = requests.post(sign_url, json={}, headers=headers, timeout=REQ_TIMEOUT)
        res = resp.json()
        if res.get("status") == 200:
            bean = res["data"].get("golden_beans", 0)
            streak = res["data"].get("consecutive_days", 0)
            print(f"【账号{idx}】✅ 签到成功 | 获得金豆:{bean} | 连续签到:{streak}天")
        else:
            print(f"【账号{idx}】ℹ️ {res.get('msg','签到失败')}")
    except Exception as e:
        print(f"【账号{idx}】❌ 签到异常：{str(e)}")

def get_account_status(token, idx):
    headers = get_headers(token)
    try:
        resp = requests.get(
            "https://mini.shangliandao.cn/api/rewards/home-reward-status",
            headers=headers,
            timeout=REQ_TIMEOUT
        )
        if resp.status_code == 401:
            return "EXPIRED", None
        if resp.status_code != 200:
            return "FAIL", None
        res = resp.json()
        return "OK", res
    except Exception as e:
        return "NET_ERR", None

def get_bean(token, idx):
    code, data = get_account_status(token, idx)
    if code == "OK":
        return float(data["data"].get("golden_bean_balance", 0.00))
    return 0.00

def auto_answer(quiz):
    if not quiz or "question" not in quiz or "options" not in quiz or len(quiz["options"]) == 0:
        return quiz["options"][0]["id"]
    question = quiz["question"].strip().lower()
    options = quiz["options"]
    reverse_keywords = [
        "不", "错", "错误", "不当", "不正确", "有误", "禁止", "避免",
        "不能", "不要", "不该", "不符", "不属于", "错误的是", "不正确的是",
        "切勿", "严禁", "不可", "错误做法", "不利", "危害", "坏处", "无",
        "非", "否", "不准", "不许", "不宜", "不对", "不行", "不可以"
    ]
    is_reverse = any(k in question for k in reverse_keywords)
    absolute_correct = [
        "及时就医", "立即就诊", "咨询医生", "听从医嘱", "按时服药", "正规医院",
        "对症治疗", "专业指导", "遵医嘱", "定期检查", "接种疫苗", "预防为主",
        "规律作息", "早睡早起", "劳逸结合", "心态平和", "情绪稳定", "卧床休息",
        "静养", "保证睡眠", "充足睡眠", "开窗通风", "保持通风", "注意保暖",
        "清淡饮食", "低盐少油", "低糖低脂", "七分饱", "合理膳食", "均衡营养",
        "多喝温水", "多喝水", "细嚼慢咽", "三餐规律", "搭配蔬菜", "搭配粗粮",
        "适度运动", "循序渐进", "量力而行", "散步", "慢跑", "低强度运动",
        "加强锻炼", "饭后散步", "热身运动", "勤洗手", "注意卫生", "科学防护",
        "佩戴口罩", "远离危险", "安全第一", "减少主食", "控制主食", "代替主食",
        "适量食用", "当主食吃", "趁热吃"
    ]
    normal_correct = [
        "休息", "放松", "按时", "准时", "保暖", "防寒", "防暑", "适量", "适度",
        "少量", "慢慢", "走路", "耐心", "陪伴", "缓解疲劳", "安全", "戒烟限酒",
        "搭配食用", "减少食用", "清淡", "温热", "熟食", "洗净", "通风", "保湿"
    ]
    normal_wrong = [
        "晚睡", "不吃早餐", "久坐", "憋尿", "挑食", "暴晒", "情绪激动", "生气",
        "争吵", "冷饮", "空腹", "拖延", "乱吃", "用力过猛", "挤压", "饭后吃",
        "多吃", "额外吃", "代替正餐", "大量食用", "生冷", "辛辣", "油腻"
    ]
    absolute_wrong = [
        "熬夜", "通宵", "睡眠不足", "暴饮暴食", "喝冰水", "生冷食物", "辛辣刺激",
        "过量进食", "酗酒", "饮酒", "喝酒", "吸烟", "抽烟", "自行用药", "乱用药",
        "过量服药", "硬扛", "硬撑", "不治", "剧烈运动", "高强度运动", "强行坚持",
        "酒后运动", "带病运动", "空腹吃", "过量吃", "饭后多吃", "多吃两个",
        "空腹食用", "大量吃"
    ]
    zongzi_good = ["当主食", "减少米饭", "搭配蔬菜", "适量食用", "趁热吃", "搭配茶水"]
    zongzi_bad = ["空腹吃", "饭后吃", "多吃两个", "多吃几个", "大量吃", "代替所有主食"]
    health_good = ["温热饮食", "少食多餐", "细嚼慢咽"]
    health_bad = ["空腹进食", "暴饮暴食", "生冷刺激"]
    safe_good = ["及时报警", "紧急疏散", "切断电源"]
    safe_bad = ["乘坐电梯", "贪恋财物", "盲目逃生"]
    score_list = []
    for opt in options:
        opt_text = opt["text"].strip().lower()
        score = 0
        for word in absolute_correct:
            if word in opt_text:
                score += 25
        for word in normal_correct:
            if word in opt_text:
                score += 15
        for word in normal_wrong:
            if word in opt_text:
                score -= 20
        for word in absolute_wrong:
            if word in opt_text:
                score -= 30
        if "粽子" in question or "端午" in question:
            for word in zongzi_good: score += 30
            for word in zongzi_bad: score -= 40
        if "肠胃" in question or "养生" in question:
            for word in health_good: score += 25
            for word in health_bad: score -= 35
        if "消防" in question or "安全" in question:
            for word in safe_good: score += 25
            for word in safe_bad: score -= 35
        score_list.append({"id": opt["id"], "text": opt["text"], "score": score})
    if is_reverse:
        score_list.sort(key=lambda x: x["score"])
    else:
        score_list.sort(key=lambda x: x["score"], reverse=True)
    best = score_list[0]
    if len(score_list) >= 2 and best["score"] == score_list[1]["score"]:
        for fid in ["B", "A", "C", "D"]:
            for item in score_list:
                if item["id"] == fid:
                    best = item
                    break
            break
    return best["id"]

def report_ad(headers, idx, i, total, current_bean, total_earn):
    try:
        requests.get("https://mini.shangliandao.cn/api/rewards/home-reward-config", headers=headers, timeout=REQ_TIMEOUT)
        print(f"【账号{idx}】🎬 广告 {i}/{total} 开始观看，时长 {AD_WATCH_SEC} 秒")
        time.sleep(AD_WATCH_SEC)
        post_data = {"scene": "home_reward", "watch_seconds": AD_WATCH_SEC, "session_id": f"ad_{i}"}
        resp = requests.post(
            "https://mini.shangliandao.cn/api/rewards/ad-complete",
            json=post_data,
            headers=headers,
            timeout=REQ_TIMEOUT
        )
        res = resp.json()
        add_bean = float(res["data"].get("amount", 0.00)) if res.get("status") == 200 else 0.00
        new_current = current_bean + add_bean
        new_total = total_earn + add_bean
        print(f"【账号{idx}】🎬 广告 {i}/{total} 观看完成 ✅")
        print(f"【账号{idx}】💎 本次获得金豆：{add_bean:.2f} | 累计获得：{new_total:.2f} | 当前账户金豆：{new_current:.2f}")
        return add_bean, new_total, new_current
    except Exception as e:
        print(f"【账号{idx}】🎬 广告 {i}/{total} ❌ 异常：{str(e)}")
        return 0.00, total_earn, current_bean

def run_article(art_id, token, idx, total_earn, current_bean):
    headers = get_headers(token)
    print(f"\n【账号{idx}】📖 开始阅读文章 {art_id}")
    try:
        res = requests.get(f"https://mini.shangliandao.cn/api/article/{art_id}", headers=headers, timeout=REQ_TIMEOUT).json()
        if res.get("status") != 200:
            print(f"【账号{idx}】📖 文章 {art_id} 接口异常")
            return total_earn, current_bean, True
        art_data = res["data"]
        is_finished = art_data["today_status"]["completed_today"]
        if is_finished:
            print(f"【账号{idx}】📖 文章 {art_id} 今日已完成")
            return total_earn, current_bean, is_finished
        read_sec = art_data.get("read_duration", 10)
        print(f"【账号{idx}】📖 文章 {art_id} 阅读时长 {read_sec} 秒")
        time.sleep(read_sec)
        ans_id = auto_answer(art_data["quiz"])
        quiz_res = requests.post(
            f"https://mini.shangliandao.cn/api/article/{art_id}/quiz",
            json={"answer": ans_id, "read_seconds": read_sec},
            headers=headers
        ).json()
        base_bean = 0.00
        if quiz_res.get("status") == 200:
            correct = quiz_res["data"].get("quiz_correct")
            base_bean = float(quiz_res["data"].get("bean_amount", 0.00))
            status = "✅ 答题正确" if correct else "❌ 答题错误"
            print(f"【账号{idx}】📖 文章 {art_id} {status}")
        total_earn += base_bean
        current_bean += base_bean
        print(f"【账号{idx}】💎 基础奖励：{base_bean:.2f} | 累计获得：{total_earn:.2f} | 当前账户金豆：{current_bean:.2f}")
        if art_data.get("double_bean_video"):
            print(f"【账号{idx}】📖 文章 {art_id} 触发翻倍广告，观看 {ARTICLE_WATCH_SEC} 秒")
            time.sleep(ARTICLE_WATCH_SEC)
            ad_data = {"scene": "article_reward_double", "watch_seconds": ARTICLE_WATCH_SEC, "session_id": str(art_id)}
            requests.post("https://mini.shangliandao.cn/api/rewards/ad-complete", json=ad_data, headers=headers)
            time.sleep(1)
            double_res = requests.post(f"https://mini.shangliandao.cn/api/article/{art_id}/double-reward", headers=headers).json()
            if double_res.get("status") == 200:
                double_total = float(double_res["data"].get("total_beans", 0.00))
                double_bean = double_total - base_bean
                total_earn += double_bean
                current_bean += double_bean
                print(f"【账号{idx}】📖 文章 {art_id} 翻倍成功")
                print(f"【账号{idx}】💎 翻倍奖励：{double_bean:.2f} | 累计获得：{total_earn:.2f} | 当前账户金豆：{current_bean:.2f}")
        return total_earn, current_bean, is_finished
    except Exception as e:
        print(f"【账号{idx}】📖 文章 {art_id} 异常：{str(e)}")
        return total_earn, current_bean, True

def auto_withdraw_check(token, idx):
    headers = get_headers(token)
    print(f"\n【账号{idx}】======== 自动检测提现状态 ========")
    status_url = "https://mini.shangliandao.cn/api/user/golden-bean/withdraw/status"
    try:
        status_resp = requests.get(status_url, headers=headers, timeout=REQ_TIMEOUT).json()
    except:
        print(f"【账号{idx}】❌ 网络异常，查询提现状态失败，跳过提现")
        return
    if status_resp.get("status") != 200:
        print(f"【账号{idx}】❌ 提现状态接口异常，跳过提现")
        return
    data = status_resp.get("data", {})
    withdrawn_today = data.get("withdrawn_today", False)
    can_withdraw = data.get("can_withdraw", False)
    bean_balance = float(data.get("golden_bean_balance", 0))
    min_yuan = float(data.get("withdraw_min_yuan", 0))
    print(f"【账号{idx}】ℹ️ 当前金豆：{bean_balance:.2f} | 最低提现门槛：{min_yuan}元")
    print(f"【账号{idx}】ℹ️ 今日已提现：{withdrawn_today} | 满足提现条件：{can_withdraw}")
    if withdrawn_today:
        print(f"【账号{idx}】ℹ️ 今日已完成提现，自动跳过")
        return
    if not can_withdraw:
        print(f"【账号{idx}】ℹ️ 账户余额未达到提现门槛，自动跳过")
        return
    print(f"【账号{idx}】✅ 检测符合提现条件，开始执行提现")
    apply_url = "https://mini.shangliandao.cn/api/user/golden-bean/withdraw/apply"
    try:
        apply_resp = requests.post(apply_url, json={}, headers=headers, timeout=REQ_TIMEOUT).json()
    except:
        print(f"【账号{idx}】❌ 发起提现申请失败，终止提现")
        return
    if apply_resp.get("status") != 200 or "biz_no" not in apply_resp.get("data", {}):
        print(f"【账号{idx}】❌ 无法生成提现单号，提现失败")
        return
    biz_no = apply_resp["data"]["biz_no"]
    print(f"【账号{idx}】✅ 已生成提现单号：{biz_no}")
    confirm_url = "https://mini.shangliandao.cn/api/user/golden-bean/withdraw/reconfirm"
    confirm_data = {"biz_no": biz_no}
    try:
        requests.post(confirm_url, json=confirm_data, headers=headers, timeout=REQ_TIMEOUT)
    except:
        print(f"【账号{idx}】❌ 提现二次确认请求异常")
        return
    print(f"【账号{idx}】✅ 提现提交完成，请上小程序确定收款")

# -------------------- 单账号主流程（参数改为 openid）--------------------
def account_task(openid, idx):
    print(f"\n=============================================")
    print(f"============= 【账号 {idx}】 启动任务 =============")
    print(f"=============================================")

    # 1. 获取有效 token
    try:
        token = get_valid_token(openid)
        print(f"【账号{idx}】✅ 获取 token 成功")
    except Exception as e:
        print(f"【账号{idx}】❌ 获取 token 失败: {str(e)}")
        return f"【账号{idx}】任务失败（token获取失败）"

    # 2. 签到
    do_sign_in(token, idx)
    time.sleep(2)

    # 3. 获取账户状态
    code, status_data = get_account_status(token, idx)
    if code != "OK":
        print(f"【账号{idx}】❌ 获取账户状态失败")
        return f"【账号{idx}】任务失败"

    init_bean = get_bean(token, idx)
    current_bean = init_bean
    total_earn = 0.00
    ad_remain = status_data["data"].get("ad_remaining_today", 0)
    headers = get_headers(token)

    print(f"【账号{idx}】💰 初始账户金豆：{init_bean:.2f} | 今日剩余广告：{ad_remain}次")

    # 4. 广告任务
    print(f"\n【账号{idx}】======== 开始执行广告任务 ========")
    if ad_remain <= 0:
        print(f"【账号{idx}】✅ 今日广告已全部完成")
    else:
        for i in range(1, ad_remain + 1):
            add, total_earn, current_bean = report_ad(headers, idx, i, ad_remain, current_bean, total_earn)
            if i < ad_remain:
                print(f"【账号{idx}】⏸️ 广告轮次间隔，等待 {AD_LOOP_SLEEP} 秒")
                time.sleep(AD_LOOP_SLEEP)
    print(f"【账号{idx}】🎉 广告阶段累计收益：{total_earn:.2f}")

    # 5. 阅读任务
    print(f"\n【账号{idx}】======== 开始执行阅读任务 ========")
    if ARTICLE_REVERSE:
        art_id_list = range(ARTICLE_START_ID, ARTICLE_END_ID - 1, -1)
        print(f"【账号{idx}】📚 阅读范围：ID {ARTICLE_START_ID} ~ {ARTICLE_END_ID}（倒序读取）")
        print(f"【账号{idx}】⏱️ 正常文章随机间隔 {ARTICLE_NORMAL_MIN}~{ARTICLE_NORMAL_MAX} 秒 | 已完成文章随机间隔 {ARTICLE_FINISHED_MIN}~{ARTICLE_FINISHED_MAX} 秒")
    else:
        art_id_list = range(ARTICLE_START_ID, ARTICLE_END_ID + 1)
        print(f"【账号{idx}】📚 阅读范围：ID {ARTICLE_START_ID} ~ {ARTICLE_END_ID}（正序读取）")

    art_list = list(art_id_list)
    for index, aid in enumerate(art_list):
        total_earn, current_bean, is_finished = run_article(aid, token, idx, total_earn, current_bean)
        if index >= len(art_list) - 1:
            continue
        if is_finished:
            sleep_sec = random.randint(ARTICLE_FINISHED_MIN, ARTICLE_FINISHED_MAX)
            print(f"【账号{idx}】⏸️ 已完成文章间隔，等待 {sleep_sec} 秒")
        else:
            sleep_sec = random.randint(ARTICLE_NORMAL_MIN, ARTICLE_NORMAL_MAX)
            print(f"【账号{idx}】⏸️ 正常文章间隔，等待 {sleep_sec} 秒")
        time.sleep(sleep_sec)

    # 6. 自动提现
    auto_withdraw_check(token, idx)

    # 7. 汇总
    print(f"\n【账号{idx}】============ 账号任务汇总 ============")
    print(f"【账号{idx}】💰 初始金豆：{init_bean:.2f}")
    print(f"【账号{idx}】💰 最终金豆：{current_bean:.2f}")
    print(f"【账号{idx}】📈 本次总计收益：{total_earn:.2f}")
    return f"【账号{idx}】全部任务执行完成"

# -------------------- 程序入口 --------------------
def main():
    print("=" * 60)
    print("🚀 乐赚金豆全自动脚本 | 签到+广告+阅读+自动提现 (支持wx_server登录)")
    print("=" * 60)

    env_val = os.environ.get(ENV_NAME, "")
    if not env_val:
        print(f"❌ 未配置环境变量 {ENV_NAME}，请填入 openid 列表（# 分隔）")
        return
    openid_list = [oid.strip() for oid in env_val.split(SPLIT_CHAR) if oid.strip()]
    if not openid_list:
        print("❌ 无有效账号（openid）")
        return

    print(f"✅ 共加载 {len(openid_list)} 个账号，开始并发执行")
    print(f"✅ 广告时长：{AD_WATCH_SEC}秒 | 广告间隔：{AD_LOOP_SLEEP}秒")
    print(f"✅ wx_server: {WX_SERVER_URL}\n")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = []
        for idx, openid in enumerate(openid_list, 1):
            futures.append(executor.submit(account_task, openid, idx))
        for future in as_completed(futures):
            try:
                print(f"\n" + future.result())
            except Exception as e:
                print(f"❌ 线程异常：{str(e)}")

    print("\n" + "=" * 60)
    print("🏁 所有账号任务全部执行完毕")
    print("=" * 60)

if __name__ == "__main__":
    main()