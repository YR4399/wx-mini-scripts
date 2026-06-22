"""
中国农业普查 App 签到脚本
依赖环境变量:
  NYPC_ACCOUNTS - 账号列表, 格式: 手机号1:密码1&手机号2:密码2
  PLUSPLUS_TOKEN - PushPlus推送token
"""
import json, os, sys, time, base64
from urllib import request, parse
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

API_BASE = "https://a8xbw5ab.315xfyun.cn/api"
AES_KEY = b"i4YcHJdJOJFdw6O5sVoHt01PA3bjJX1c"

def encrypt_aes(data: str) -> str:
    """加密请求数据"""
    raw = data.encode("utf-8")
    iv = os.urandom(16)
    cipher = AES.new(AES_KEY, AES.MODE_CBC, iv)
    ct = cipher.encrypt(pad(raw, 16))
    result = bytearray([1, 16])  # prefix: version=1, flag=16
    result += iv
    result += ct
    return base64.b64encode(result).decode()

def decrypt_aes(enc_b64: str) -> dict:
    """解密响应数据"""
    raw = base64.b64decode(enc_b64)
    iv = raw[2:18]
    ct = raw[18:]
    cipher = AES.new(AES_KEY, AES.MODE_CBC, iv)
    pt = unpad(cipher.decrypt(ct), 16)
    return json.loads(pt.decode("utf-8"))

def api_post(endpoint: str, data: dict = None, session: dict = None) -> dict:
    """调用加密API"""
    url = f"{API_BASE}/{endpoint}"
    enc_body = encrypt_aes(json.dumps(data or {}))
    req_data = json.dumps({"_enc": enc_body}).encode()
    
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13)",
        "Referer": "https://a8xbw5ab.315xfyun.cn/",
    }
    if session and session.get("token"):
        headers["token"] = session["token"]
    
    req = request.Request(url, data=req_data, headers=headers, method="POST")
    with request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode())
        if result.get("_enc"):
            return decrypt_aes(result["_enc"])
        return result

def login(account: str, password: str) -> dict:
    """登录获取token"""
    data = {"username": account, "password": password}
    resp = api_post("index/login", data)
    print(f"  登录响应: {json.dumps(resp, ensure_ascii=False)[:200]}")
    return resp

def sign_in(session: dict) -> dict:
    """签到"""
    resp = api_post("user/signIn", {}, session)
    return resp

def get_balance(session: dict) -> dict:
    """获取余额"""
    resp = api_post("user/getBalance", {}, session)
    return resp

def get_user_info(session: dict) -> dict:
    """获取用户信息"""
    resp = api_post("user/getUserInfo", {}, session)
    return resp

def get_sign_info(session: dict) -> dict:
    """获取签到状态"""
    resp = api_post("user/signinfo", {}, session)
    return resp

def get_prize_pool(session: dict) -> dict:
    """获取奖品池"""
    resp = api_post("user/getPrizePool", {}, session)
    return resp

def run_account(account: str, password: str, index: int):
    print(f"\n{'='*50}")
    print(f"  账号[{index}] {account[:3]}****{account[-4:]}")
    print(f"{'='*50}")
    
    # 登录
    print("  登录中...")
    login_resp = login(account, password)
    session = {"token": login_resp.get("data", {}).get("token", login_resp.get("token", ""))}
    
    if not session["token"]:
        print(f"  登录失败: {login_resp.get('msg', '未知错误')}")
        return
    
    print(f"  登录成功")
    
    # 获取用户信息
    user = get_user_info(session)
    nick = user.get("data", {}).get("nickname", "") or user.get("nickname", "")
    pts = user.get("data", {}).get("points", 0) or user.get("points", 0)
    if nick:
        print(f"  昵称: {nick}, 积分: {pts}")
    
    time.sleep(1)
    
    # 签到状态
    sign_info = get_sign_info(session)
    print(f"  签到状态: {json.dumps(sign_info, ensure_ascii=False)[:200]}")
    
    time.sleep(1)
    
    # 签到
    sign_resp = sign_in(session)
    print(f"  签到结果: {json.dumps(sign_resp, ensure_ascii=False)[:200]}")
    
    time.sleep(1)
    
    # 余额
    balance = get_balance(session)
    print(f"  余额: {json.dumps(balance, ensure_ascii=False)[:200]}")
    
    time.sleep(1)
    
    # 奖品池
    pool = get_prize_pool(session)
    print(f"  奖品池: {json.dumps(pool, ensure_ascii=False)[:200]}")

def main():
    accounts_raw = os.environ.get("NYPC_ACCOUNTS", "").strip()
    if not accounts_raw:
        print("请设置环境变量 NYPC_ACCOUNTS，格式: 手机号:密码&手机号:密码")
        sys.exit(1)
    
    accounts = []
    for item in accounts_raw.split("&"):
        parts = item.strip().split(":")
        if len(parts) == 2:
            accounts.append((parts[0].strip(), parts[1].strip()))
    
    print(f"中国农业普查 App 签到")
    print(f"共 {len(accounts)} 个账号")
    
    for i, (acc, pwd) in enumerate(accounts):
        try:
            run_account(acc, pwd, i + 1)
        except Exception as e:
            print(f"  账号[{i+1}] 异常: {e}")
        if i < len(accounts) - 1:
            time.sleep(2)

if __name__ == "__main__":
    main()
