# 浓五的酒馆签到 (自动获取 Code -> 换 Token -> 本地缓存 -> 积分验活 -> 动态获取活动ID -> 签到)

import requests
import json
import os
import sys
import time
import random
import datetime
import re

# ========== 推送通知 ==========
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========


print(f'浓五的酒馆开始运行 (已加入本地 Token 缓存及积分验活机制)')

# ================= 环境变量与配置 =================
WECHAT_API_URL = os.environ.get("wxcodeurl", "").rstrip('/')
WECHAT_API_KEY = os.environ.get("WXAPIKEY", "")
APP_ID = "wxed3cf95a14b58a26"

if not WECHAT_API_URL or not WECHAT_API_KEY:
    print("❌ 错误: 未配置 wxcodeurl 或 WXAPIKEY 环境变量，请检查配置。")
    sys.exit(1)

# ================= 本地缓存设置 =================
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(CURRENT_DIR, '缓存token')
os.makedirs(CACHE_DIR, exist_ok=True)
CACHE_FILE = os.path.join(CACHE_DIR, 'nwjg_tokens.json')

def load_cache():
    """读取本地 Token 缓存"""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_cache(data):
    """保存 Token 缓存到本地"""
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"保存缓存失败: {e}")

# ================= 新版微信 API 方法 =================
def get_all_accounts():
    """获取所有微信账号列表"""
    _wx_op = os.environ.get("wx_opinion", "")
    if _wx_op:
        return [{"userKey": o.strip(), "openid": o.strip()} for o in _wx_op.split("&") if o.strip()]
    url = f"{WECHAT_API_URL}/api/accounts"
    headers = {"AUTH": WECHAT_API_KEY}
    try:
        response = requests.get(url, headers=headers, timeout=20)
        result = response.json()
        if result.get("status") or result.get("ok"):
            return result.get("data", {}).get("items", [])
        else:
            print(f"获取账号列表失败: {result}")
            return []
    except Exception as e:
        print(f"请求账号列表接口异常: {e}")
        return []

def get_wx_code_with_retry(openid, appid):
    """获取小程序 Code (含底层卡死报错熔断机制)"""
    url = f"{WECHAT_API_URL}/wx/code"
    headers = {
        "AUTH": WECHAT_API_KEY,
        "Content-Type": "application/json"
    }
    payload = {"openid": openid, "appid": appid}
    
    while True:
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=60)
            result = response.json()
            
            if result.get("status") and result.get("data", {}).get("code"):
                return result["data"]["code"]
                
            error_msg = str(result)
            if "Runtime.evaluate returned without ok=true/ok=false" in error_msg:
                print(f"⚠️ [{openid}] 触发 CDP 沙盒阻塞报错，暂停 5 分钟后重试...")
                time.sleep(300)
                continue
            else:
                print(f"❌ [{openid}] 获取 Code 失败: {result.get('message', error_msg)}")
                return None
        except Exception as e:
            print(f"❌ [{openid}] 请求 /wx/code 发生网络异常: {e}")
            return None

# ================= 浓五的酒馆 业务方法 =================
def get_nwjg_token(code):
    """根据 Code 换取小程序 Token"""
    url = "https://stdcrm.dtmiller.com/std-weixin-mp-service/miniApp/custom/login"
    payload = {
        "code": code,
        "appId": APP_ID
    }
    headers = {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI",
        'Content-Type': "application/json",
        'authorization': "",
        'xweb_xhr': "1",
        'referer': "https://servicewechat.com/wxed3cf95a14b58a26/257/page-frame.html",
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=20)
        res = response.json()
        if res.get("code") == 0:
            return res.get("data", "")
        else:
            print(f"换取 Token 失败: {res.get('msg')}")
    except Exception as e:
        print(f"换取 Token 异常: {e}")
    return ""

def get_base_headers(token):
    """生成带有鉴权 Bearer 的标准请求头"""
    return {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI",
        'authorization': f"Bearer {token}",
        'xweb_xhr': "1",
        'content-type': "application/json",
        'referer': "https://servicewechat.com/wxed3cf95a14b58a26/257/page-frame.html",
    }

def get_integral(token, validate_only=False):
    """查询积分与手机号 (兼作验活接口)"""
    url = "https://stdcrm.dtmiller.com/scrm-promotion-service/mini/wly/user/info"
    try:
        response = requests.get(url, headers=get_base_headers(token), timeout=20)
        res = response.json()
        if res.get('code') == 0:
            member = res.get('data', {}).get('member', {})
            mobile = member.get('mobile', '未知手机号')
            points = member.get('points', 0)
            return mobile, points
        else:
            if not validate_only:
                print(f"查询积分失败: {res.get('msg')}")
    except Exception as e:
        if not validate_only:
            print(f"查询积分异常: {e}")
    return None, None

def get_promotion_id(token):
    """动态提取每日签到活动 promotionId"""
    url = "https://stdcrm.dtmiller.com/scrm-promotion-service/mini/module/config/list"
    try:
        response = requests.post(url, json={}, headers=get_base_headers(token), timeout=20)
        res = response.json()
        
        if res.get("code") == 0 and res.get("success"):
            modules = res.get("data", [])
            for module in modules:
                detail_list = module.get("detailList", [])
                for detail in detail_list:
                    detail_json_str = detail.get("detailJson", "{}")
                    try:
                        detail_json = json.loads(detail_json_str)
                        title = detail_json.get("title", "")
                        
                        # 使用包含匹配，兼容 "个人中心-任务中心-每日签到"
                        if "每日签到" in title:
                            page_path = detail_json.get("jumpData", {}).get("pagePath", "")
                            match = re.search(r'promotionId=([^&]*)', page_path)
                            if match:
                                return match.group(1)
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        print(f"动态获取活动ID异常: {e}")
    
    # 获取失败时返回保底 ID
    print("⚠️ 动态获取失败，使用保底活动ID。")
    return "PI69eb321d37c48c000a05ee4e"

def sign_in(token, promotion_id, mobile):
    """执行签到"""
    url = "https://stdcrm.dtmiller.com/scrm-promotion-service/promotion/sign/today"
    params = {'promotionId': promotion_id}
    try:
        response = requests.get(url, params=params, headers=get_base_headers(token), timeout=20)
        res = response.json()
        
        if res.get('code') == 0:
            data = res.get('data', {})
            prize = data.get('prize', {})
            goods_name = prize.get('goodsName', '未知奖励')
            sign_days = data.get('signDays', 1)
            print(f"✅ 用户【{mobile}】 - 签到成功！获得 {goods_name}，累计签到天数：{sign_days}")
        else:
            msg = res.get('msg', '未知原因')
            print(f"⚠️ 用户【{mobile}】 - 签到结果: {msg}")
    except Exception as e:
        print(f"❌ 用户【{mobile}】 - 签到发生异常: {e}")

# ================= 主流程控制 =================
def main():
    if datetime.datetime.strptime('05:01', '%H:%M').time() <= datetime.datetime.now().time() <= datetime.datetime.strptime('06:59', '%H:%M').time():
        print("处于5:01-6:59随机休眠防封期...")
        time.sleep(random.randint(100, 300))

    accounts = get_all_accounts()
    token_cache = load_cache()

    if not accounts:
        print("未获取到任何微信账号，请检查服务端状态。")
        return
        
    print(f"\n======================================")
    print(f"✅ 成功获取到 {len(accounts)} 个微信账号，准备逐个执行...")
    print(f"======================================\n")

    for i, acc in enumerate(accounts):
        openid = acc.get('userKey') or acc.get('openid')
        acc_name = acc.get('displayName', '未知微信昵称')
        
        print(f"***** 第 [{i + 1}/{len(accounts)}] 个账号开始运行 *****")
        print(f"微信标识: {acc_name}")
        
        token = token_cache.get(openid)
        is_token_valid = False
        
        # 1. 如果有缓存，直接用 get_integral 查询积分验活
        if token:
            print("🔍 检测到本地缓存 JWT Token，正在验证有效性...")
            mobile, points = get_integral(token, validate_only=True)
            if mobile:
                print(f"✅ Token 依然有效！用户: {mobile} | 当前可用积分: {points}")
                is_token_valid = True
            else:
                print("⚠️ 缓存 Token 已失效或过期，准备重新获取...")
                
        # 2. 如果无效或无缓存，走获取新 Code 换 Token 流程
        if not is_token_valid:
            print("⏳ 正在请求微信 Code...")
            code = get_wx_code_with_retry(openid, APP_ID)
            if not code:
                print(f"❌ 获取 Code 失败，跳过。")
                print("\n")
                continue
                
            print("⏳ 获取 Code 成功，正在换取 JWT Token...")
            token = get_nwjg_token(code)
            
            if token:
                # 记录缓存
                token_cache[openid] = token
                save_cache(token_cache)
                print("✅ Token 换取成功并已写入本地缓存。")
                
                # 获取一次基础信息
                mobile, points = get_integral(token)
                if not mobile:
                    print("❌ 新获取的 Token 无法读取用户信息，跳过。")
                    print("\n")
                    continue
                print(f"📱 用户【{mobile}】 - 当前可用积分: {points}")
            else:
                print("❌ 换取 Token 失败，跳过。")
                print("\n")
                continue
        
        # 3. 确保存活后，执行核心签到逻辑
        promotion_id = get_promotion_id(token)
        print("☁️ 开始执行签到...")
        sign_in(token, promotion_id, mobile)
        
        print("\n")
        time.sleep(random.uniform(2.5, 4.0)) # 账号之间适当延迟

    print(f'🎉 所有账号执行完毕 🎉')

if __name__ == '__main__':
    import io
    _log_capture = io.StringIO()
    _old_stdout = sys.stdout
    _old_stderr = sys.stderr
    sys.stdout = _log_capture
    sys.stderr = _log_capture
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        print(f'脚本异常: {e}')
    finally:
        sys.stdout = _old_stdout
        sys.stderr = _old_stderr
    _logs = _log_capture.getvalue()
    if _logs.strip():
        print(_logs)
        try:
            push_notify('浓五的酒馆 (2) 签到结果', _logs[-2000:])
        except:
            pass



