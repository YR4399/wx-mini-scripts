#紧跟时事，使用wxcode模块获取code来获取参数
#wxcode模块参考脚本库：https://script.foglamb.top/
#群聊：797644857
#作者：foglamb

import requests
import json
import re
import os
import time
from xml.etree import ElementTree as ET
from datetime import datetime


class YiLiQQStar:
    """伊利QQ星 - 全自动每日任务"""
    
    APPID = "wx650bdff059f63f5b"
    SECRET = "d1e4b452117fa4ff4af6fa319fd858ff"
    WXCODE_URL = "http://192.168.100.163:8088/login"
    TOKEN_FILE = "yili_token.json"
    
    # 每日任务（已验证）
    TASKS = {
        11: "发起分享",
        31: "单次签到",
        40: "分享文章",
        47: "使用工具",
        53: "知识库每日打卡",
        56: "关注公众号",
        62: "活动签到",
        75: "活动连续签到",
    }
    
    def __init__(self):
        self.base_url = "https://mall.yili.com/MAMAIF/MCSWSIAPI.asmx/Call"
        self.device_code = self.APPID
        self.activity_id = "13D88C0D-A850-4278-A718-35CD397EF922"
        self.auth_key = None
        self.user_id = None
        self.points_before = 0
        
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows',
            'Content-Type': 'application/x-www-form-urlencoded',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{self.APPID}/162/page-frame.html',
        }
        self._load_token()
    
    def _load_token(self):
        if os.path.exists(self.TOKEN_FILE):
            try:
                with open(self.TOKEN_FILE) as f:
                    self.auth_key = json.load(f).get('auth_key')
            except: pass
    
    def _save_token(self):
        with open(self.TOKEN_FILE, 'w') as f:
            json.dump({'auth_key': self.auth_key}, f)
    
    def _parse(self, resp):
        text = resp.text.strip()
        if not text: return {}
        if text.startswith('<?xml') or text.startswith('<string'):
            try:
                root = ET.fromstring(text)
                if root.text: return json.loads(root.text)
            except:
                m = re.search(r'<string[^>]*>(.*?)</string>', text, re.DOTALL)
                if m:
                    try: return json.loads(m.group(1))
                    except: pass
        return {}
    
    def call(self, method, params, retry=2):
        if isinstance(params, dict): p = json.dumps(params)
        elif isinstance(params, str) and params: p = params
        else: p = ""
        
        for i in range(retry):
            s = requests.Session()
            try:
                r = s.post(
                    self.base_url, headers=self.headers,
                    data={'RequestPack': json.dumps({
                        "DeviceCode": self.device_code,
                        "AuthKey": self.auth_key or "0"*36,
                        "Method": method, "Params": p
                    })}, timeout=15
                )
                s.close()
                result = self._parse(r)
                if 'Result' in result and isinstance(result['Result'], str):
                    try: result['Result'] = json.loads(result['Result'])
                    except: pass
                return result
            except:
                s.close()
                if i < retry - 1: time.sleep(3)
                else: return {"Return": -999}
    
    def get_wx_code(self):
        try:
            r = requests.get(self.WXCODE_URL, params={"appId": self.APPID}, timeout=5)
            data = r.json()
            if data.get('err') == 0 and data.get('code'):
                return data['code']
        except: pass
        return None
    
    def login(self):
        code = self.get_wx_code()
        if not code: return False
        r1 = self.call("WechatService.GetWxOpenID", json.dumps({
            "AppID": self.APPID, "Secret": self.SECRET,
            "Js_Code": code, "Grant_Type": "authorization_code"
        }))
        if r1.get('Return', -1) < 0: return False
        result = r1.get('Result', {})
        if isinstance(result, str):
            try: result = json.loads(result)
            except: pass
        self.open_id = result.get('openid', '')
        if not self.open_id: return False
        r2 = self.call("MemberService.LoginByWechatOpenId", json.dumps({
            "Platform": self.APPID, "OpenId": self.open_id,
            "UnionId": result.get('unionid', '')
        }))
        if r2.get('Return', -1) < 0: return False
        self.auth_key = (r2.get('Result', {}) or {}).get('AuthKey', '')
        if self.auth_key: self._save_token()
        return bool(self.auth_key)
    
    def get_info(self):
        r = self.call("MemberService.GetMyMemberInfo", "")
        if r.get('Return') == 0:
            info = r['Result']
            self.user_id = info.get('ID')
            self.points_before = float(info.get('PointsBalance', 0))
            return info
        return None
    
    def get_points(self):
        r = self.call("PointsService.GetPointsBalance", "")
        return r.get('Result', {}) if r.get('Return') == 0 else None
    
    def do_join(self, jt):
        if not self.user_id: return None
        ji = json.dumps({"Activity": self.activity_id, "JoinType": jt, "UserId": self.user_id})
        return self.call("MemberService.CampaignJoin", json.dumps({"JoinInfo": ji}))
    
    def run(self):
        print(f"\n{'='*40}")
        print(f" 伊利QQ星 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*40}")
        
        info = self.get_info() if self.auth_key else None
        if not info:
            print("[登录] ...")
            if not self.login():
                print("❌ 登录失败")
                return False
            info = self.get_info()
            if not info:
                print("❌ 获取信息失败")
                return False
        
        print(f"👤 {info.get('RealName')} | {info.get('MemberLevelName')} | {self.points_before}积分\n")
        
        for jt, name in self.TASKS.items():
            r = self.do_join(jt)
            ret = r.get('Return', -999)
            
            if ret == 0:
                print(f"✅ [{jt}] {name} 完成!")
            elif ret in [-31, -33]:
                print(f"⏭️  [{jt}] {name} 已完成")
            elif ret == -10:
                print(f"🔄 [{jt}] 刷新AuthKey...")
                if self.login():
                    r = self.do_join(jt)
                    print(f"  {'✅ 完成' if r.get('Return')==0 else '❌ 失败'}")
            elif ret == -999:
                print(f"⚠️  [{jt}] {name} 网络错误")
            else:
                print(f"❌ [{jt}] {name}: {ret}")
            
            time.sleep(0.8)
        
        pts = self.get_points()
        if pts:
            a = float(pts.get('Points', self.points_before))
            d = a - self.points_before
            print(f"\n{'🎉' if d>0 else '📊'} 积分: {self.points_before} → {a} (+{d})" if d>0 else f"\n📊 积分: {self.points_before}")
        print(f"{'='*40}\n")


if __name__ == "__main__":
    YiLiQQStar().run()