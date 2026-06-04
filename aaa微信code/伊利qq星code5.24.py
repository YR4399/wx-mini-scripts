# ========== 推送通知 ==========
import sys as _sys
import os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
try:
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========

# 伊利QQ星 - 多账号自动每日任务（带青龙推送）
# 环境变量：
#   YILI_QQXING = 备注1#wcsid1&备注2#wcsid2
#   wx_server_url = http://你的CodeServer地址
#   wx_auth = 你的认证令牌
# 缓存文件: qqxing_tokens.json

import requests
import json
import re
import os
import time
import random
import base64
from xml.etree import ElementTree as ET
from datetime import datetime

try:
    from Crypto.Cipher import AES, PKCS1_v1_5
    from Crypto.PublicKey import RSA
    from Crypto.Util.Padding import pad, unpad
except Exception:
    AES = None
    PKCS1_v1_5 = None
    RSA = None
    pad = None
    unpad = None

# ================= 推送模块加载（青龙 Python 方式） =================
notifyFunc = None

def load_notify_module():
    global notifyFunc
    # 方式1：直接导入青龙 notify 模块
    try:
        from notify import send
        notifyFunc = send
        print('✅ 成功加载青龙推送模块 (notify.send)')
        return
    except ImportError:
        pass

    # 方式2：添加 /ql/scripts 路径后导入
    try:
        import sys
        if '/ql/scripts' not in sys.path:
            sys.path.append('/ql/scripts')
        from notify import send
        notifyFunc = send
        print('✅ 成功加载青龙脚本目录推送模块')
        return
    except ImportError:
        pass

    # 方式3：使用系统 notify 命令
    try:
        import subprocess
        # 测试 notify 命令是否可用
        subprocess.run(['notify', 'test', 'test'], capture_output=True, check=False)
        def cmd_notify(title, content):
            subprocess.run(['notify', title, content])
        notifyFunc = cmd_notify
        print('✅ 成功加载系统命令推送模块 (notify)')
        return
    except (FileNotFoundError, Exception):
        pass

    print('⚠️ 未找到青龙推送模块，将不会发送通知')

def send_notify(title, content):
    if notifyFunc:
        try:
            notifyFunc(title, content)
            print('📬 推送通知已发送')
        except Exception as e:
            print(f'❌ 推送通知发送失败: {e}')
    else:
        print('⚠️ 推送模块未加载，跳过通知')

load_notify_module()


class YiLiQQStar:
    """伊利QQ星 - 全自动每日任务（支持多账号）"""

    APPID = "wx650bdff059f63f5b"
    SECRET = "d1e4b452117fa4ff4af6fa319fd858ff"
    TOKEN_CACHE_FILE = "qqxing_tokens.json"

    # 每日任务（已验证）
    TASKS = {
        11: "发起分享",
        31: "单次签到",
        40: "分享文章",
        47: "使用工具",
        53: "知识库每日打卡",
        55: "转发小程序",
        56: "关注公众号",
        62: "活动签到",
        75: "活动连续签到",
    }

    # 抽奖活动ID（从源码分析得出）
    LOTTERY_ACTIVITY_ID = "13D88C0D-A850-4278-A718-35CD397EF922"
    LOTTERY_DEVICE_CODE = "0723B870-04B8-4EAD-BCAA-0E700A409ECB"
    LOTTERY_RSA_MODULUS = "i5X/k0j78vvkXaZIvWfZPvfW1zj7V+720MuG5rgXLHCMiUjY3SAxKql1l8O9K2WJye9vF95cTZkYWGOcGFA2HGTemuUhcYMXwL/Tda8pzszymeo8JGruGb1HXTEMkPruh3/R/eVJElfg18fw8Hqy1h+7zlhAwDgaV2RbQzTCOOs="
    LOTTERY_RSA_EXPONENT = "AQAB"
    LOTTERY_RSA_PRIVATE = "-----BEGIN PRIVATE KEY-----MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAIuV/5NI+/L75F2mSL1n2T731tc4+1fu9tDLhua4FyxwjIlI2N0gMSqpdZfDvStlicnvbxfeXE2ZGFhjnBhQNhxk3prlIXGDF8C/03WvKc7M8pnqPCRq7hm9R10xDJD67od/0f3lSRJX4NfH8PB6stYfu85YQMA4GldkW0M0wjjrAgMBAAECgYAQpAg9AdVviVIXTAyd7/R5SkiljdiBCi8Ig0sI1GeG18AZWcLo0b6qzFsFhcNWmhtMJKxE1zB/28GIQA/K4j0hBMV7me4x+VbfUmV4AH3TrgxmpPWCVNf7hIcIYrP6hG+5VsYiW6CmocyApLWL2ECLU8Dup6rkSwL9Ys++Sq+osQJBAPaNJyJ68Yo+O0B9CoyN9JiSgAEGTondClCKLHLEjCZCwe6vkIbDygVld48qHexQyc6/ZYQSyo0xqsy8wlYb74MCQQCQ72/px5BWZsDtC2/jNl7pHAYTaGI8mrKuOFPYHycOuWjjfhGysinNakpTxQCQ7Q4LDhb1vyWKsNP7v109Nqx5AkEArgX/o3TH3F4EkIYx1fe0t6RgOVjsQp8EUsjUisV0buUb4Y+GIbk8dQajlyeRK2Xyq72ot8pTsclm11A8k27wZQJAZoVYLpABo3xvv721WY2eOVqfWZ8ezivHdMFXXas7n4i7jyAgOL0aILms9fCGY/2rT1qaFx8s2RwX9x34QFKqUQJAR2H0otX4VsaAGcFfFPWo/Bs16AWdwALn2hOY9Vltbq2HykSDqezomzy9zWYVdArOMrq/uYfgt43ipcB356diZw==-----END PRIVATE KEY-----"

    def __init__(self, remark, wcsid):
        self.remark = remark
        self.wcsid = wcsid
        self.base_url = "https://mall.yili.com/MAMAIF/MCSWSIAPI.asmx/Call"
        self.device_code = self.APPID
        self.activity_id = "13D88C0D-A850-4278-A718-35CD397EF922"
        self.auth_key = None
        self.user_id = None
        self.open_id = wcsid
        self.points_before = 0
        self.points_after = 0
        self.points_earned = 0
        self.completed_tasks = 0      # 本次新完成的任务数
        self.already_done_tasks = 0   # 已经完成过的任务数
        self.lottery_result = None     # 抽奖结果

        # 抽奖缓存参数
        self.lottery_openid = None
        self.lottery_unionid = None
        self.lottery_session_key = None
        self.lottery_guid = None
        self.lottery_authkey = None
        self.lottery_authkey_expire = 0
        self.lottery_aes_key = None
        self.lottery_aes_iv = None

        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows',
            'Content-Type': 'application/x-www-form-urlencoded',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{self.APPID}/162/page-frame.html',
        }

        self.code_server_url = os.getenv("wx_server_url", "")
        self.code_server_auth = os.getenv("wx_auth", "")
        self._load_token()

    def _load_token(self):
        if not os.path.exists(self.TOKEN_CACHE_FILE):
            return
        try:
            with open(self.TOKEN_CACHE_FILE, 'r') as f:
                all_tokens = json.load(f)
            if self.wcsid in all_tokens:
                self.auth_key = all_tokens[self.wcsid].get('auth_key')
                # 加载抽奖缓存
                self.lottery_openid = all_tokens[self.wcsid].get('lottery_openid')
                self.lottery_unionid = all_tokens[self.wcsid].get('lottery_unionid')
                self.lottery_session_key = all_tokens[self.wcsid].get('lottery_session_key')
                self.lottery_guid = all_tokens[self.wcsid].get('lottery_guid')
                self.lottery_authkey = all_tokens[self.wcsid].get('lottery_authkey')
                self.lottery_authkey_expire = all_tokens[self.wcsid].get('lottery_authkey_expire', 0)
                self.lottery_aes_key = all_tokens[self.wcsid].get('lottery_aes_key')
                self.lottery_aes_iv = all_tokens[self.wcsid].get('lottery_aes_iv')
        except:
            pass

    def _save_token(self):
        all_tokens = {}
        if os.path.exists(self.TOKEN_CACHE_FILE):
            try:
                with open(self.TOKEN_CACHE_FILE, 'r') as f:
                    all_tokens = json.load(f)
            except:
                pass
        all_tokens[self.wcsid] = {
            'remark': self.remark,
            'auth_key': self.auth_key,
            'open_id': self.open_id,
            'updated_at': int(time.time()),
            # 抽奖缓存
            'lottery_openid': self.lottery_openid,
            'lottery_unionid': self.lottery_unionid,
            'lottery_session_key': self.lottery_session_key,
            'lottery_guid': self.lottery_guid,
            'lottery_authkey': self.lottery_authkey,
            'lottery_authkey_expire': self.lottery_authkey_expire,
            'lottery_aes_key': self.lottery_aes_key,
            'lottery_aes_iv': self.lottery_aes_iv,
        }
        with open(self.TOKEN_CACHE_FILE, 'w') as f:
            json.dump(all_tokens, f, indent=2)

    def _parse(self, resp):
        text = resp.text.strip()
        if not text:
            return {}
        if text.startswith('<?xml') or text.startswith('<string'):
            try:
                root = ET.fromstring(text)
                if root.text:
                    return json.loads(root.text)
            except:
                m = re.search(r'<string[^>]*>(.*?)</string>', text, re.DOTALL)
                if m:
                    try:
                        return json.loads(m.group(1))
                    except:
                        pass
        return {}

    def call(self, method, params, retry=2):
        if isinstance(params, dict):
            p = json.dumps(params)
        elif isinstance(params, str) and params:
            p = params
        else:
            p = ""

        for i in range(retry):
            s = requests.Session()
            try:
                r = s.post(
                    self.base_url, headers=self.headers,
                    data={'RequestPack': json.dumps({
                        "DeviceCode": self.device_code,
                        "AuthKey": self.auth_key or "0" * 36,
                        "Method": method, "Params": p
                    })},
                    timeout=15
                )
                s.close()
                result = self._parse(r)
                if 'Result' in result and isinstance(result['Result'], str):
                    try:
                        result['Result'] = json.loads(result['Result'])
                    except:
                        pass
                return result
            except:
                s.close()
                if i < retry - 1:
                    time.sleep(3)
                else:
                    return {"Return": -999}

    def get_wx_code(self, retry=2):
        if not self.code_server_url or not self.code_server_auth:
            print("  ⚠️ CodeServer未配置，无法获取code")
            return None
        
        payload = {"appid": self.APPID, "openid": self.wcsid}
        
        for attempt in range(retry):
            try:
                resp = requests.post(
                    f"{self.code_server_url}/wx/code",
                    json=payload,
                    headers={"auth": self.code_server_auth},
                    timeout=30
                )

                if resp.status_code == 200:
                    try:
                        data = resp.json()
                        if data.get("status") and data.get("data", {}).get("code"):
                            code = data["data"]["code"]
                            return code
                        else:
                            print(f"  ❌ CodeServer返回错误: {data}")
                    except Exception as json_err:
                        print(f"  ❌ 解析JSON失败: {json_err}")
                else:
                    print(f"  ❌ CodeServer HTTP错误: {resp.status_code}")
            except requests.exceptions.Timeout:
                print(f"  ⏱️ 请求超时 (第 {attempt+1}/{retry} 次尝试)")
            except requests.exceptions.ConnectionError as e:
                print(f"  ❌ 连接错误 (第 {attempt+1}/{retry} 次尝试): {e}")
            except Exception as e:
                print(f"  ❌ CodeServer请求异常 (第 {attempt+1}/{retry} 次尝试): {type(e).__name__}: {e}")
            
            if attempt < retry - 1:
                time.sleep(5)
        
        return None

    def login(self):
        code = self.get_wx_code()
        if not code:
            return False
        print(f"✅ 获取code成功: {code[:10]}...")
        r1 = self.call("WechatService.GetWxOpenID", json.dumps({
            "AppID": self.APPID, "Secret": self.SECRET,
            "Js_Code": code, "Grant_Type": "authorization_code"
        }))
        if r1.get('Return', -1) < 0:
            print("  ❌ 换取openid失败")
            return False
        result = r1.get('Result', {})
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except:
                pass
        self.open_id = result.get('openid', '')
        if not self.open_id:
            print("  ❌ 未获取到openid")
            return False
        r2 = self.call("MemberService.LoginByWechatOpenId", json.dumps({
            "Platform": self.APPID, "OpenId": self.open_id,
            "UnionId": result.get('unionid', '')
        }))
        if r2.get('Return', -1) < 0:
            print("  ❌ 登录失败")
            return False
        self.auth_key = (r2.get('Result', {}) or {}).get('AuthKey', '')
        if self.auth_key:
            self._save_token()
            return True
        return False

    def get_info(self):
        r = self.call("MemberService.GetMyMemberInfo", "")
        if r.get('Return') == 0:
            info = r['Result']
            self.user_id = info.get('ID')
            self.points_before = float(info.get('PointsBalance', 0))
            return info
        if r.get('Return') == -10:
            return None
        return None

    def get_points(self):
        r = self.call("PointsService.GetPointsBalance", "")
        if r.get('Return') == 0:
            result = r.get('Result', {})
            points = float(result.get('Points', self.points_before))
            self.points_after = points
            self.points_earned = self.points_after - self.points_before
            return result
        return None

    def do_join(self, jt):
        if not self.user_id:
            return None
        ji = json.dumps({"Activity": self.activity_id, "JoinType": jt, "UserId": self.user_id})
        return self.call("MemberService.CampaignJoin", json.dumps({"JoinInfo": ji}))

    def _lottery_json_loads(self, value):
        if isinstance(value, str):
            try:
                return json.loads(value)
            except:
                return value
        return value

    def _lottery_get_aes_key(self):
        raw_key = self.lottery_aes_key.encode()
        if len(raw_key) in (16, 24, 32):
            return raw_key
        key = base64.b64decode(self.lottery_aes_key)
        if len(key) not in (16, 24, 32):
            raise ValueError(f"Incorrect AES key length ({len(key)} bytes)")
        return key

    def _lottery_encrypt(self, params):
        if AES is None or pad is None:
            raise RuntimeError("缺少 pycryptodome 依赖，请先安装: pip install pycryptodome")
        text = json.dumps(params, separators=(',', ':'), ensure_ascii=False)
        key = self._lottery_get_aes_key()
        iv = self.lottery_aes_iv.encode()
        cipher = AES.new(key, AES.MODE_CBC, iv)
        return base64.b64encode(cipher.encrypt(pad(text.encode(), AES.block_size))).decode()

    def _lottery_decrypt(self, cipher_text):
        if AES is None or unpad is None:
            raise RuntimeError("缺少 pycryptodome 依赖，请先安装: pip install pycryptodome")
        key = self._lottery_get_aes_key()
        iv = self.lottery_aes_iv.encode()
        cipher = AES.new(key, AES.MODE_CBC, iv)
        return unpad(cipher.decrypt(base64.b64decode(cipher_text)), AES.block_size).decode()

    def _lottery_decrypt_rsa(self, cipher_text):
        if RSA is None or PKCS1_v1_5 is None:
            raise RuntimeError("缺少 pycryptodome 依赖，请先安装: pip install pycryptodome")
        private_text = self.LOTTERY_RSA_PRIVATE
        if "\n" not in private_text:
            private_text = private_text.replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\n").replace("-----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----")
            body = private_text.replace("-----BEGIN PRIVATE KEY-----\n", "").replace("\n-----END PRIVATE KEY-----", "")
            private_text = "-----BEGIN PRIVATE KEY-----\n" + "\n".join([body[i:i+64] for i in range(0, len(body), 64)]) + "\n-----END PRIVATE KEY-----"
        private_key = RSA.import_key(private_text)
        cipher = PKCS1_v1_5.new(private_key)
        return cipher.decrypt(base64.b64decode(cipher_text), None).decode()

    def _lottery_call(self, method, params=None, auth_key=None, url="/MCSAppletsAPI/MCSWSIAPI.asmx/Call", encrypt_params=True):
        base_url = "https://jifen.yilibabyclub.com"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows',
            'Content-Type': 'application/json;charset=UTF-8',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{self.APPID}/162/page-frame.html',
        }
        if params is None:
            params = {}
        params_json = json.dumps(params, separators=(',', ':'), ensure_ascii=False) if not encrypt_params else self._lottery_encrypt(params)
        request_pack = {
            "Method": method,
            "AuthKey": auth_key or "",
            "ParamsJson": params_json,
            "DeviceCode": self.LOTTERY_DEVICE_CODE
        }
        try:
            resp = requests.post(
                f"{base_url}{url}",
                headers=headers,
                data=json.dumps({"RequestPack": json.dumps(request_pack, separators=(',', ':'), ensure_ascii=False)}, separators=(',', ':'), ensure_ascii=False),
                timeout=30
            )
            if resp.status_code == 200:
                text = resp.text.strip()
                if text.startswith('<?xml') or text.startswith('<string'):
                    parsed = self._parse(resp)
                    return parsed
                data = resp.json()
                result_str = data.get('d', '')
                if result_str:
                    return json.loads(result_str)
                return data
            print(f"  ❌ 积分接口HTTP错误: {resp.status_code}")
            return None
        except Exception as e:
            print(f"  ❌ 接口调用异常: {type(e).__name__}: {e}")
            return None

    def get_wx_encrypt_key(self):
        if not self.code_server_url or not self.code_server_auth:
            print("  ⚠️ CodeServer未配置，无法获取encryptKey")
            return None
        try:
            payload = {"appid": self.APPID, "openid": self.wcsid}
            resp = requests.post(
                f"{self.code_server_url}/wx/encrypt",
                json=payload,
                headers={"auth": self.code_server_auth, "AUTH": self.code_server_auth},
                timeout=30
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") and data.get("data", {}).get("encryptKey") and data.get("data", {}).get("iv"):
                    print("  ✅ 获取encryptKey成功")
                    return data.get("data", {})
                print(f"  ❌ CodeServer encrypt返回错误: {data}")
            else:
                print(f"  ❌ CodeServer encrypt HTTP错误: {resp.status_code}")
        except Exception as e:
            print(f"  ❌ CodeServer encrypt请求异常: {type(e).__name__}: {e}")
        return None

    def _init_lottery_crypto(self):
        r = self._lottery_call(
            "LoginService.ApplyAESEncryptKey",
            {"Modulus": self.LOTTERY_RSA_MODULUS, "Exponent": self.LOTTERY_RSA_EXPONENT},
            auth_key="",
            encrypt_params=False
        )
        if not r or r.get('Return', -1) < 0:
            print(f"  ❌ 申请AES密钥失败: {r}")
            return False
        result = self._lottery_json_loads(r.get('Result', {}))
        try:
            self.lottery_aes_key = self._lottery_decrypt_rsa(result.get('CryptAESKey', ''))
            self.lottery_aes_iv = self._lottery_decrypt_rsa(result.get('CryptAESIV', ''))
            print("  ✅ 申请AES密钥成功")
            return True
        except Exception as e:
            print(f"  ❌ 解密AES密钥失败: {type(e).__name__}: {e}")
            return False

    def do_lottery(self):
        """执行每日抽奖 - 使用完整的积分系统登录流程"""
        if not self.open_id:
            print("  ⚠️ OpenID为空，无法抽奖")
            return None
        
        print("  🎲 正在进行每日抽奖...")

        now = int(time.time())
        if self.lottery_authkey and self.lottery_authkey_expire > now and self.lottery_openid and self.lottery_unionid and self.lottery_aes_key and self.lottery_aes_iv:
            print(f"  ✅ 使用缓存的抽奖AuthKey")
            openid = self.lottery_openid
            unionid = self.lottery_unionid
            lottery_authkey = self.lottery_authkey
        else:
            if not self._init_lottery_crypto():
                return None

            r1 = self._lottery_call("LoginService.GetAnonymityAuthkey", {"username": "anonymity"})
            if not r1 or r1.get('Return') != 0:
                return None
            
            result = self._lottery_json_loads(r1.get('Result', {}))
            anon_authkey = (result or {}).get('Authkey', '') if isinstance(result, dict) else ''
            if not anon_authkey:
                return None
            
            code = self.get_wx_code()
            if not code:
                return None
            
            r2 = self._lottery_call("LoginService.GetWxOpenID", {
                "appid": self.APPID,
                "secret": self.SECRET,
                "js_code": code,
                "grant_type": "authorization_code"
            }, anon_authkey)
            if not r2 or r2.get('Return') != 0:
                return None
            
            result = r2.get('Result', '')
            if isinstance(result, str):
                try:
                    result = json.loads(result)
                except:
                    pass
            
            openid = result.get('openid', '')
            if not openid:
                return None
            print(f"  ✅ 获取openid成功: {openid[:10]}...")
            
            unionid = result.get('unionid', '')
            session_key = result.get('session_key', '')
            r3 = self._lottery_call("LoginService.CheckRegister", {
                "Unionid": unionid,
                "Mobile": "",
                "session_key": session_key
            }, anon_authkey)
            guid = None
            if not r3 or r3.get('Return', -1) < 0:
                return None
            if r3.get('Result'):
                try:
                    guid = self._lottery_decrypt(r3.get('Result'))
                except Exception as e:
                    return None
            if not guid or guid == "取值失败":
                return None
            
            r3 = self._lottery_call("LoginService.UserLoginByGUID", {
                "GUID": guid,
                "Sequence": "6666",
                "UnionID": unionid,
                "session_key": session_key
            }, anon_authkey)
            if not r3 or r3.get('Return') != 0:
                return None
            
            result = self._lottery_json_loads(r3.get('Result', {}))
            lottery_authkey = (result or {}).get('Authkey', '') if isinstance(result, dict) else ''
            if not lottery_authkey:
                return None
            
            print(f"  ✅ 获取GUID成功: {guid[:8]}...")
            print(f"  ✅ 获取抽奖AuthKey成功: {lottery_authkey[:10]}...")

            self.lottery_openid = openid
            self.lottery_unionid = unionid
            self.lottery_session_key = session_key
            self.lottery_guid = guid
            self.lottery_authkey = lottery_authkey
            self.lottery_authkey_expire = now + 86400
            self._save_token()
            print("  ✅ 抽奖登录信息已缓存")
        
        lottery_tasks = [
            {"name": "浏览活动", "params": {"UnionID": unionid, "OpenID": openid, "JoinClassify": 4}},
            {"name": "关注公众号", "params": {"UnionID": unionid, "OpenID": openid, "JoinClassify": "1"}},
            {"name": "分享小程序", "params": {"UnionID": unionid, "OpenID": openid, "JoinClassify": "2"}},
        ]
        
        print("  📡 步骤5: 完成抽奖任务获取抽奖机会...")
        for task in lottery_tasks:
            print(f"    🔄 完成任务: {task['name']}")
            r5 = self._lottery_call("StampActivityService.QQActivityTaskadd", task['params'], lottery_authkey, "/mclubif2/SmallProgram.asmx/Call")
            if r5 and r5.get('Return') > 0:
                print(f"    ✅ 任务完成: {task['name']}")
            else:
                print(f"    ⏭️ 任务已完成或失败: {task['name']} {r5}")
            time.sleep(0.5)

        print("  📡 步骤6: 获取抽奖次数...")
        r4 = self._lottery_call("StampActivityService.GetQQActivityTaskState", {"Unionid": unionid, "OpenID": openid}, lottery_authkey, "/mclubif2/SmallProgram.asmx/Call")
        balance = 0
        if r4 and r4.get('Return', 0) > 0:
            result_data = self._lottery_json_loads(r4.get('Result', ''))
            try:
                interaction_list = self._lottery_json_loads(result_data.get('InteractionList', ''))
                if interaction_list:
                    balance = sum(float(item.get('Balance', 0)) for item in interaction_list)
            except:
                pass
        print(f"  ℹ️ 当前剩余抽奖次数: {balance}")
        
        if balance >= 1:
            draw_count = int(balance)
            awards = []
            raw_results = []
            print(f"  📡 步骤7: 执行抽奖 (剩余次数: {balance})...")
            for draw_index in range(1, draw_count + 1):
                print(f"    🎯 第 {draw_index}/{draw_count} 次抽奖...")
                r6 = self._lottery_call("StampActivityService.QQActivity_Award", {}, lottery_authkey, "/mclubif2/SmallProgram.asmx/Call")
                raw_results.append(r6)
                if not r6 or r6.get('Return') == -999:
                    print(f"    ❌ 抽奖失败: {r6}")
                    break

                result_data = r6.get('Result', '')
                if result_data and isinstance(result_data, str):
                    try:
                        result_data = json.loads(result_data)
                    except:
                        pass

                award_name = result_data.get('AwardName') if isinstance(result_data, dict) else None
                sort = result_data.get('Sort') if isinstance(result_data, dict) else None
                if award_name:
                    awards.append({"AwardName": award_name, "Sort": sort, "raw": r6})
                    print(f"    ✅ 抽奖成功！获得: {award_name}")
                else:
                    print(f"    ⚠️ 抽奖结果: {r6}")
                time.sleep(0.5)

            if awards:
                award_names = [item.get('AwardName') for item in awards if item.get('AwardName')]
                self.lottery_result = {
                    'Return': raw_results[-1].get('Return') if raw_results and raw_results[-1] else None,
                    'AwardName': '、'.join(award_names),
                    'Awards': awards,
                    'Count': len(awards),
                    'raw': raw_results
                }
                print(f"  ✅ 抽奖完成，共抽 {len(awards)} 次，获得: {self.lottery_result['AwardName']}")
                return self.lottery_result

            self.lottery_result = {
                'Return': raw_results[-1].get('Return') if raw_results and raw_results[-1] else None,
                'AwardName': None,
                'Awards': [],
                'Count': 0,
                'raw': raw_results
            }
            return self.lottery_result
        else:
            print("  ⚠️ 没有可用的抽奖次数")
        
        return None

    def run(self):
        print(f"\n{'='*40}")
        print(f" 账号: {self.remark} | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*40}")

        info = self.get_info() if self.auth_key else None
        if not info:
            print("[登录] 正在登录（缓存token失效或不存在，通过CodeServer获取code）...")
            if not self.login():
                print(f"❌ 账号 [{self.remark}] 登录失败")
                return False
            info = self.get_info()
            if not info:
                print(f"❌ 账号 [{self.remark}] 获取信息失败")
                return False

        print(f"👤 {info.get('RealName')} | {info.get('MemberLevelName')} | 当前积分: {self.points_before}")

        self.completed_tasks = 0
        self.already_done_tasks = 0

        for jt, name in self.TASKS.items():
            r = self.do_join(jt)
            ret = r.get('Return', -999)

            if ret == 0:
                print(f"✅ [{jt}] {name} 完成!")
                self.completed_tasks += 1
            elif ret in [-31, -33]:
                print(f"⏭️  [{jt}] {name} 已完成")
                self.already_done_tasks += 1
            elif ret == -10:
                print(f"🔄 [{jt}] 检测到AuthKey失效，重新登录...")
                if self.login():
                    r = self.do_join(jt)
                    if r.get('Return') == 0:
                        print(f"  ✅ 完成")
                        self.completed_tasks += 1
                    elif r.get('Return') in [-31, -33]:
                        print(f"  ⏭️ 已完成")
                        self.already_done_tasks += 1
                    else:
                        print(f"  ❌ 失败")
                else:
                    print(f"  ❌ 重新登录失败，跳过后续任务")
                    break
            elif ret == -999:
                print(f"⚠️  [{jt}] {name} 网络错误")
            else:
                print(f"❌ [{jt}] {name}: {ret}")

            time.sleep(0.8)

        time.sleep(1)
        self.do_lottery()

        self.get_points()
        if self.points_earned != 0:
            print(f"\n🎉 积分变化: {self.points_before} → {self.points_after} (+{self.points_earned})")
        else:
            print(f"\n📊 当前积分: {self.points_after}")

        if self.lottery_result:
            award_name = self.lottery_result.get('AwardName')
            if award_name:
                print(f"🎁 抽奖结果: {award_name}")
            else:
                print(f"🎁 抽奖已执行")
        else:
            print(f"⚠️ 抽奖未获得结果或无抽奖机会")

        print(f"{'='*40}\n")
        return True


def main():
    print("🚀 伊利QQ星多账号脚本启动")
    print(f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # 优先从 wx_opinion 读取，格式: openid1&openid2&openid3
    wx_opinion = os.getenv("wx_opinion", "").strip()
    env_accounts = os.getenv("YILI_QQXING", "")
    
    accounts = []
    
    if wx_opinion:
        # wx_opinion 模式：openid 作为 wcsid
        for wcsid in wx_opinion.split('&'):
            wcsid = wcsid.strip()
            if wcsid:
                accounts.append((wcsid[:8], wcsid))
        print(f"✅ 从 wx_opinion 加载 {len(accounts)} 个账号")
    elif env_accounts:
        # 原有模式：备注#wcsid
        for item in env_accounts.split('&'):
            item = item.strip()
            if not item:
                continue
            parts = item.split('#')
            if len(parts) == 2:
                remark, wcsid = parts
                accounts.append((remark, wcsid))
            else:
                print(f"⚠️ 忽略无效账号配置: {item}，应为 备注#wcsid")
    else:
        print("❌ 未设置环境变量 wx_opinion 或 YILI_QQXING")
        print("格式: wx_opinion=openid1&openid2&openid3")
        return

    if not accounts:
        print("❌ 未解析到任何有效账号")
        return

    wx_server_url = os.getenv("wx_server_url", "")
    wx_auth = os.getenv("wx_auth", "")
    if not wx_server_url or not wx_auth:
        print("⚠️ 未配置 wx_server_url 或 wx_auth，将无法获取code，请确保已正确设置")

    print(f"📌 共加载 {len(accounts)} 个账号")
    results = []   # 存放每个账号的运行结果

    for idx, (remark, wcsid) in enumerate(accounts, 1):
        print(f"\n>>> 开始处理第 {idx}/{len(accounts)} 个账号: {remark}")
        star = YiLiQQStar(remark, wcsid)
        success = star.run()
        results.append({
            'remark': remark,
            'success': success,
            'completed': star.completed_tasks,
            'already_done': star.already_done_tasks,
            'total_tasks': len(star.TASKS),
            'points_before': star.points_before,
            'points_after': star.points_after,
            'points_earned': star.points_earned,
            'lottery_result': star.lottery_result
        })

        if idx < len(accounts):
            wait_sec = random.randint(12, 18)
            print(f"⏳ 等待 {wait_sec} 秒后处理下一个账号...")
            time.sleep(wait_sec)

    # 构造推送消息 - 每个账号：总积分、今日抽奖情况、做任务情况
    total_accounts = len(results)
    success_accounts = sum(1 for r in results if r['success'])
    total_earned = sum(r['points_earned'] for r in results)
    lottery_count = sum(1 for r in results if r.get('lottery_result') and r['lottery_result'].get('AwardName'))

    content_lines = []
    content_lines.append(f"📊 伊利QQ星执行汇总 (共{total_accounts}个账号)")
    content_lines.append(f"✅ 成功: {success_accounts} | ❌ 失败: {total_accounts - success_accounts}")
    content_lines.append(f"💰 总获得积分: {total_earned:.2f}")
    content_lines.append(f"🎁 抽中奖品账号数: {lottery_count}")
    content_lines.append("")
    content_lines.append("📋 各账号详情:")
    
    for r in results:
        line = f"【{r['remark']}】"
        if r['success']:
            done = r['completed'] + r['already_done']
            line += f" 任务: {done}/{r['total_tasks']}项"
            line += f" | 总积分: {r['points_after']:.2f}"
            # 今日抽奖情况
            lottery_info = r.get('lottery_result')
            if lottery_info:
                award_name = lottery_info.get('AwardName')
                if award_name:
                    line += f" | 抽奖: {award_name}"
                else:
                    line += f" | 抽奖: 无奖励"
            else:
                line += f" | 抽奖: 未参与"
            # 积分变化
            if r['points_earned'] > 0:
                line += f" (今日+{r['points_earned']:.2f})"
            elif r['points_earned'] < 0:
                line += f" (今日{r['points_earned']:.2f})"
        else:
            line += " ❌ 执行失败"
        content_lines.append(line)

    content = "\n".join(content_lines)
    title = "伊利QQ星每日任务汇总"
    send_notify(title, content)

    print("\n" + "="*40)
    print(f"✅ 执行完毕！成功账号数: {success_accounts}/{total_accounts}")
    print("="*40)


if __name__ == "__main__":
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
            push_notify('签到结果', _logs[-2000:])
        except:
            pass