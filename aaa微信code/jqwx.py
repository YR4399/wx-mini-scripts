#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ==================== 匠心忠华 / 趣优选 签到脚本 (v9.1 国密安全防刷版 · WCS登录) ====================
# 本次更新：适配 WCS 登录 —— 不再依赖抓包 X-Token，通过 WCS 动态获取 code -> 匠心 get_openid.do 登录拿 token。
#           X-Param 加密 (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) 逻辑沿用已验证实现。
#
# 环境变量:
#   【WCS 登录 · 推荐】QWYX_OPENIDS : 微信 openid，多账号用 & 分隔
#       示例: oLvh-0ydiGAnlYBAVXbouPVAxXN4&oLvh-06JSe-78wETfzEs0o0cPAJU
#   【兼容旧版抓包】QWYX_DATA    : 抓包 X-Token#备注名，多账号用 & 分隔 (优先级低于 WCS)
#   WCS 配置:
#       wx_server_url : WCS 地址 (留空则自动探测; 默认优先 host.docker.internal:18788, 重启不变)
#       wx_auth       : WCS 认证 token
#   其他:
#       JX_APPID      : 匠心小程序 AppID (默认 wxddaa0832e6acc5f1)
#       JX_BASE       : 匠心 API 域名 (默认 https://api.quwayouxuan.com)
# ======================================================================================================
import requests, time, hashlib, urllib.parse, os, re, base64, random, json
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

# ==================== 配置 ====================
# WCS 地址: 留空则自动探测。容器重启后 smallcat-client 的 IP 会变,
# 因此优先用 host.docker.internal:18788 (永远指向宿主发布端口, 不受容器 IP 变化影响)。
WCS_URL  = os.environ.get("wx_server_url", "")
WCS_AUTH = os.environ.get("wx_auth", "1509ea7aca117dcbb7e635c0c007d528")
JX_APPID = os.environ.get("JX_APPID", "wxddaa0832e6acc5f1")
JX_BASE  = os.environ.get("JX_BASE", "https://api.quwayouxuan.com")

# WCS 候选地址 (按优先级探测), 覆盖常见容器 IP / 宿主网关 / 容器名, 重启后无需改脚本
_WCS_CANDIDATES = [
    "http://host.docker.internal:18788",
    "http://host.docker.internal:18788",
    "http://172.17.0.1:18788",
    "http://smallcat-client:8787",
    "http://localhost:18788",
    "http://127.0.0.1:18788",
    "http://host.docker.internal:18788",
    "http://host.docker.internal:18788",
]
_wcs_resolved = None

def clear_proxy():
    """清除代理环境变量，避免容器内请求被代理拦截 (docker 默认网桥常带 http_proxy 指向已关闭的 Clash)"""
    for k in ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']:
        os.environ.pop(k, None)
    os.environ['no_proxy'] = '*'
    os.environ['NO_PROXY'] = '*'

def resolve_wcs_url():
    """探测可用的 WCS base URL (绕过代理直连), 返回首个可达地址并缓存。"""
    global _wcs_resolved
    if _wcs_resolved:
        return _wcs_resolved
    candidates = list(_WCS_CANDIDATES)
    if WCS_URL:                       # 用户显式指定优先
        candidates.insert(0, WCS_URL.rstrip('/'))
    clear_proxy()
    for base in candidates:
        try:
            r = requests.post(f"{base}/wx/code",
                              json={"appid": JX_APPID, "openid": "probe"},
                              headers={"auth": WCS_AUTH, "Content-Type": "application/json"},
                              timeout=4, proxies={'http': None, 'https': None})
            _wcs_resolved = base      # 任何 HTTP 响应即说明主机可达
            print(f"  [WCS] 探测到可用地址: {base}")
            return base
        except Exception:
            continue
    _wcs_resolved = (WCS_URL.rstrip('/') if WCS_URL else _WCS_CANDIDATES[0])
    print(f"  [WCS] 警告: 所有候选地址均不可达, 退回: {_wcs_resolved}")
    return _wcs_resolved

def load_send():
    p = os.path.dirname(os.path.abspath(__file__)) + "/notify.py"
    if os.path.exists(p):
        try:
            from notify import send
            return send
        except:
            return None
    return None

send = load_send()

class QuWaRobot:
    def __init__(self):
        self._0x52a1 = base64.b64decode("c3VwZXJqaW5n").decode()  # superjing
        self._0x4b22 = base64.b64decode("aHR0cHM6Ly9hcGkucXV3YXlvdXh1YW4uY29t").decode()  # https://api.quwayouxuan.com
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 MicroMessenger/8.0.65 MiniProgramEnv/android",
            "xweb_xhr": "1", "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*",
            "Referer": "https://servicewechat.com/wxddaa0832e6acc5f1/123/page-frame.html"
        }
        # 公共请求固定参数 (已对照小程序源码验证：version 1.3.03, miniprogram_os 为空)
        self.global_request_data = {
            "os": "miniProgram",
            "deviceabout": "miniProgram",
            "version": "1.3.03",
            "miniprogram_os": ""
        }
        self.session_key = None
        self.token = None          # X-Token
        self.openid = None         # X-Device-Id / ECDH device (登录后写入真实小程序 openid)
        self.username = None

    def _0x1c3d(self, _0x221a):
        # 兼容老版未加密请求的 key 计算
        _0x5b12 = sorted(_0x221a.keys())
        _0x33e1 = "".join([f"{k}={_0x221a[k]}" for k in _0x5b12])
        _0x44f2 = (_0x33e1 + self._0x52a1).replace(" ", "")
        _0x99a1 = urllib.parse.quote(_0x44f2, safe='')
        _0x77b2 = re.sub(r"[!|'|\(|\)|\~|\*]", lambda m: "%" + "{:02X}".format(ord(m.group(0))), _0x99a1)
        return hashlib.sha1(_0x77b2.encode('utf-8')).hexdigest().lower()

    def generate_random_string(self, length=32):
        chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        return "".join(random.choices(chars, k=length))

    # ==================== WCS 登录 ====================
    def wcs_get_code(self, openid):
        """通过 WCS 获取 wx.login 临时 code (POST {WCS}/wx/code)"""
        base = resolve_wcs_url()
        clear_proxy()
        resp = requests.post(
            f"{base}/wx/code",
            json={"appid": JX_APPID, "openid": openid},
            headers={"auth": WCS_AUTH, "Content-Type": "application/json"},
            timeout=15, proxies={'http': None, 'https': None}
        ).json()
        if resp.get("status"):
            return resp.get("data", {}).get("code")
        raise RuntimeError(f"WCS 获取 code 失败: {resp.get('message', '未知错误')}")

    def login(self, openid):
        """
        通过 WCS 登录匠心，获取全新 X-Token / 小程序专属 openid。
        流程: WCS /wx/code -> {code} -> 匠心 /mini_program/get_openid.do {code,...} -> {token, openid, username}
        """
        print("  [+] 🔑 正在通过 WCS 登录...")
        code = self.wcs_get_code(openid)
        print(f"  [+] 获取 code: {code[:15]}...")

        login_data = {
            "current_time": str(int(time.time() * 1000)),
            **self.global_request_data,
            "code": code,
        }
        login_data["key"] = self._0x1c3d(login_data)
        clear_proxy()
        resp = requests.post(
            f"{self._0x4b22}/mini_program/get_openid.do",
            data=login_data, headers=self.headers, timeout=15,
            proxies={'http': None, 'https': None}
        ).json()
        if resp.get("code") != 1:
            raise RuntimeError(f"匠心登录失败: {resp.get('message', '未知错误')}")
        d = resp.get("data", {})
        self.token = d.get("token")
        self.openid = d.get("openid")  # 小程序专属 openid，作为 ECDH device 与 X-Device-Id
        self.username = d.get("username") or openid
        print(f"  [+] 登录成功: {self.username} | openid={self.openid}")
        return self.username

    def perform_ecdh_key_exchange(self, token):
        """
        与服务器进行 ECDH 密钥协商，生成 session_key
        """
        try:
            print("  [+] 🔒 正在启动 ECDH 密钥协商安全防封握手...")
            # 1. 生成客户端 P-256 临时密钥对
            private_key = ec.generate_private_key(ec.SECP256R1())
            public_key = private_key.public_key()

            # 2. 导出客户端公钥为 uncompressed (X9.62) 格式的字节流
            client_pub_bytes = public_key.public_bytes(
                encoding=Encoding.X962,
                format=PublicFormat.UncompressedPoint
            )
            client_pub_base64 = base64.b64encode(client_pub_bytes).decode('utf-8')

            # 3. 随机 32 字节 salt
            salt_bytes = os.urandom(32)
            salt_base64 = base64.b64encode(salt_bytes).decode('utf-8')

            # 4. 组装握手请求数据
            exchange_data = {
                **self.global_request_data,
                "clientPublicKey": urllib.parse.quote(client_pub_base64),
                "timestamp": str(int(time.time())),
                "salt": salt_base64,
                "device": self.openid,
                "token": token
            }
            exchange_data["key"] = self._0x1c3d(exchange_data)

            # 5. 向服务器发起交换密钥请求 (此时未加密)
            url = f"{self._0x4b22}/dynamic_key/getServerPublicKey.do"
            clear_proxy()
            res = requests.post(url, data=exchange_data, headers=self.headers,
                                timeout=30, proxies={'http': None, 'https': None}).json()

            if res.get("code") != 1:
                print(f"  [-] ❌ 协商失败: {res.get('message')}")
                return False

            server_pub_base64 = res.get("data", {}).get("publicKey")
            if not server_pub_base64:
                print("  [-] ❌ 服务器未返回有效的公钥")
                return False

            # 6. 加载服务器公钥并计算共享密钥 (ECDH Shared Secret X-Coordinate)
            server_pub_bytes = base64.b64decode(server_pub_base64)
            server_public_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_pub_bytes)

            shared_secret = private_key.exchange(ec.ECDH(), server_public_key)  # 32 字节 X 坐标

            # 7. 通过 HKDF-SHA256 派生会话密钥 (session_key)
            #    注意：info 必须与小程序 JSON.stringify 完全一致 —— 无空格、device 在前
            info_str = '{"device":"' + self.openid + '","token":"' + token + '"}'
            hkdf = HKDF(
                algorithm=hashes.SHA256(),
                length=32,
                salt=salt_bytes,
                info=info_str.encode('utf-8')
            )
            self.session_key = hkdf.derive(shared_secret)
            print("  [+] 🔑 密钥协商成功！安全信道建立完毕。")
            return True
        except Exception as e:
            print(f"  [-] ❌ 密钥协商异常: {str(e)}")
            return False

    def encrypt_payload(self, payload_dict):
        """使用 AES-GCM-256 加密请求载荷"""
        iv = os.urandom(12)
        plaintext = json_compact_str(payload_dict)
        aesgcm = AESGCM(self.session_key)
        ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode('utf-8'), b"")
        combined = iv + ciphertext_with_tag
        return base64.b64encode(combined).decode('utf-8')

    def decrypt_payload(self, encrypted_base64):
        """解密服务器响应数据"""
        try:
            combined = base64.b64decode(encrypted_base64)
            iv = combined[:12]
            ciphertext_with_tag = combined[12:]
            aesgcm = AESGCM(self.session_key)
            decrypted_bytes = aesgcm.decrypt(iv, ciphertext_with_tag, b"")
            return decrypted_bytes.decode('utf-8')
        except Exception as e:
            print(f"  [-] 解密响应数据异常: {str(e)}")
            return None

    def post_request(self, url_path, biz_data, token):
        """
        核心网络请求方法。如果 session_key 存在则自动加密，否则降级发送（并在需要时自动重试协商）
        """
        url = f"{self._0x4b22}{url_path}"

        # 1. 合并公共请求参数与业务数据
        full_biz_data = {**self.global_request_data, "token": token, **biz_data}
        full_biz_data["key"] = self._0x1c3d(full_biz_data)

        headers = self.headers.copy()
        headers["X-Request-Id"] = self.generate_random_string(32)
        headers["X-Device-Id"] = self.openid
        headers["X-Token"] = token

        # 2. 如果存在 sessionKey，则通过 X-Param 头部传输加密数据，POST 身体留空
        if self.session_key:
            try:
                x_param_val = self.encrypt_payload(full_biz_data)
                headers["X-Param"] = x_param_val

                # 微信小程序底层 myRequest 中如果 sessionKey 存在，data 是空的
                clear_proxy()
                res_obj = requests.post(url, data={}, headers=headers, timeout=30,
                                        proxies={'http': None, 'https': None}).json()

                # 处理失效状态 (4096 表示 session 失效，需要重新握手)
                if res_obj.get("code") == 4096:
                    print("  [-] ⚠️ 会话密钥已失效，重新执行密钥握手...")
                    self.session_key = None
                    if self.perform_ecdh_key_exchange(token):
                        return self.post_request(url_path, biz_data, token)
                    return {"code": -1, "message": "重新建立密钥通道失败"}

                # 解密响应数据
                if "data" in res_obj and res_obj.get("code") == 1 and isinstance(res_obj["data"], str):
                    decrypted_json_str = self.decrypt_payload(res_obj["data"])
                    if decrypted_json_str:
                        res_obj["data"] = json.loads(decrypted_json_str)
                return res_obj
            except Exception as e:
                print(f"  [-] 加密请求发生异常: {str(e)}，重试1次...")
                try:
                    res_obj = requests.post(url, data={}, headers=headers, timeout=30,
                                            proxies={'http': None, 'https': None}).json()
                    if res_obj.get("code") == 4096:
                        print("  [-] ⚠️ 会话密钥已失效，重新执行密钥握手...")
                        self.session_key = None
                        if self.perform_ecdh_key_exchange(token):
                            return self.post_request(url_path, biz_data, token)
                        return {"code": -1, "message": "重新建立密钥通道失败"}
                    if "data" in res_obj and res_obj.get("code") == 1 and isinstance(res_obj["data"], str):
                        decrypted_json_str = self.decrypt_payload(res_obj["data"])
                        if decrypted_json_str:
                            res_obj["data"] = json.loads(decrypted_json_str)
                    return res_obj
                except Exception as e2:
                    print(f"  [-] 重试失败 ({str(e2)[:80]})，降级为普通请求")
                    self.session_key = None

        # 3. 降级逻辑/未建立安全信道逻辑
        clear_proxy()
        try:
            res_obj = requests.post(url, data=full_biz_data, headers=headers, timeout=30,
                                    proxies={'http': None, 'https': None}).json()
            if isinstance(res_obj, str):
                # 服务器返回了字符串而非JSON对象（如纯文本错误响应），包装成dict
                return {'code': -1, 'message': '服务器返回非JSON响应: ' + res_obj[:100], 'data': res_obj}
            return res_obj
        except Exception as e:
            # 降级请求也失败，返回错误响应避免后续 .get() 调用报错
            return {'code': -1, 'message': f'降级请求失败: {str(e)}', 'data': {}}

def json_compact_str(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False)

class OptimizedQuWaRobot(QuWaRobot):
    def run_account(self, idx, openid=None, token=None, acc_name=None):
        """
        处理单个账号。
        openid : WCS openid（走 WCS 登录）。token: 旧版抓包 X-Token（走兼容模式）。
        """
        if token:
            # 兼容旧版抓包 token
            self.token = token
            self.openid = "o_" + "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=26))
            acc_name = acc_name or f"账号{idx}"
            print(f"\n" + "-"*35 + f"\n▶ [抓包版] 正在处理: {acc_name}")
        else:
            acc_name = acc_name or f"账号{idx}"
            print(f"\n" + "-"*35 + f"\n▶ [WCS版] 正在处理: {acc_name} ({openid[:10]}...)")
            try:
                self.login(openid)
            except Exception as e:
                print(f"  [-] ❌ 登录失败: {e}")
                return f"👤 {acc_name}: 登录失败"

        try:
            _t = self.token
            # 1. 尝试密钥协商
            negotiated = self.perform_ecdh_key_exchange(_t)
            if not negotiated:
                print("  [-] ⚠️ 协商失败，切换至明文降级模式...")

            # 2. 验证 Token 并获取个人信息
            biz_validate = {"current_time": str(int(time.time() * 1000)), "source": "4"}
            l_res = self.post_request("/task/task/taskList.do", biz_validate, _t)

            if l_res.get("code") != 1 and not l_res.get("data", {}).get("userinfo"):
                print(f"  [-] ❌ Token已失效或请求被拦截: {l_res.get('message', '未知错误')}")
                return f"👤 {acc_name}: Token失效，请重新登录"

            u_i = l_res.get("data", {}).get("userinfo", {})
            real_name = u_i.get("username", acc_name)
            initial_pts = u_i.get("points", "0")
            print(f"  [-] 账户: {real_name} | 跑前积分: {initial_pts}")

            # 3. 每日签到
            biz_signin = {
                "current_time": str(int(time.time() * 1000)),
                "taskid": "1",
                "subtask_id": "0"
            }
            c_res = self.post_request("/task/task/taskSuccrss.do", biz_signin, _t)
            c_m = c_res.get('message', '完成')
            print(f"  [-] 签到结果: {c_m}")
            c_s = "✅ 签到成功" if c_res.get('code') == 1 or any(k in c_m for k in ["已", "完成"]) else f"❌ {c_m}"

            # 4. 视频任务 (强力冷却防封模式 + 国密握手保护)
            a_c = 0
            gained_pts = 0
            max_attempts = 30

            print("  [-] 正在进行视频任务，遵循 160-200 秒防封冷却并全程处于国密隧道保护中...")
            for i in range(max_attempts):
                biz_video = {
                    "current_time": str(int(time.time() * 1000)),
                    "taskid": "40",
                    "subtask_id": "0"
                }
                a_res = self.post_request("/task/task/taskSuccrss.do", biz_video, _t)

                code = a_res.get("code")
                msg = a_res.get("message", "未知错误")

                if code == 1:
                    a_c += 1
                    pts = a_res.get("data", {}).get("points", 60)
                    gained_pts += int(pts) if str(pts).isdigit() else 60

                    wait_time = random.randint(160, 200)
                    print(f"      └─ 第{a_c}次: ✅ +{pts}积分 | 累计: {gained_pts}")
                    print(f"         🛡️ [深度防封] 冷却中，等待 {wait_time} 秒后再执行下一次...")
                    time.sleep(wait_time)

                elif any(kw in msg for kw in ["上限", "已达", "超出"]):
                    print(f"      └─ 触发服务器上限，今日共成功 {a_c} 次")
                    break
                elif any(kw in msg for kw in ["不能重复", "已完成", "已领取"]):
                    print(f"      └─ 任务已全部看完 ({msg})")
                    break
                else:
                    if msg == "未知错误":
                        print(f"      └─ 异常拦截: 服务器返回 code={code}，无 message 文本（原始响应: {str(a_res)[:160]}）")
                    else:
                        print(f"      └─ 异常拦截: {msg}（code={code}）")
                    print("         ℹ️ 若为反作弊限频，请确认两次请求间隔符合 160-200 秒防封冷却")
                    break

            v_s = f"🎬 执行({a_c}次) | 收益: +{gained_pts}分"
            print(f"  [√] 账号 [{real_name}] 处理完毕")
            return f"👤 昵称：{real_name}\n   ├ 原有：{initial_pts} 分\n   ├ 签到：{c_s}\n   └ 视频：{v_s}"

        except Exception as e:
            print(f"  [x] 异常: {str(e)}")
            return f"⚠️ {acc_name}: 运行异常"

def main():
    _h = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n┃  匠 心 忠 华 助 手 (v9.1 国密安全防刷·WCS登录版) ┃\n┗━━━━━━━━━━━━━━━━━━━━━━━━┛"
    print(_h)

    openids_str = os.environ.get("QWYX_OPENIDS", "") or os.environ.get("wx_opinion", "")
    data_str = os.environ.get("QWYX_DATA", "")

    accounts = []  # (mode, value, name)
    if openids_str:
        for i, o in enumerate(openids_str.replace("\n", "&").split("&"), 1):
            if o.strip():
                accounts.append(("wcs", o.strip(), None))
    elif data_str:
        for i, a in enumerate(data_str.replace("\n", "&").split("&"), 1):
            if a.strip():
                parts = a.strip().split("#")
                accounts.append(("legacy", parts[0], parts[1] if len(parts) > 1 else f"账号{i}"))

    if not accounts:
        print("\n❌ 未找到 QWYX_OPENIDS 或 QWYX_DATA，请配置环境变量")
        print("    WCS:  QWYX_OPENIDS=oLvh-0ydiGAnlYBAVXbouPVAxXN4&oLvh-06JSe-78wETfzEs0o0cPAJU")
        print("    旧版: QWYX_DATA=<抓包X-Token>#备注名")
        return

    bot = OptimizedQuWaRobot()
    _reps = []

    for i, (mode, val, name) in enumerate(accounts, 1):
        if mode == "wcs":
            _reps.append(bot.run_account(i, openid=val, acc_name=name))
        else:
            _reps.append(bot.run_account(i, token=val, acc_name=name))

    _f = "\n" + "="*35 + "\n🎯 任务汇总报告：\n\n" + "\n\n".join(_reps)
    print(_f)

    if send:
        send("匠心忠华安全版任务报告", _h + "\n\n" + "\n\n".join(_reps))

if __name__ == "__main__":
    main()
