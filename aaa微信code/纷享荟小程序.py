#!/usr/bin/env python3
"""
纷享会积分任务自动化 - WCS 全自动版
====================================
环境变量:
  wx_server_url = http://127.0.0.1:8787
  wx_auth = 认证令牌

自动从 WCS /api/accounts 发现活跃账号, 无需额外设 foglamb_fxh

两个小程序共用同一 WCS 账号:
  纷享荟商城: wx7bb6f3b8f0ad2ae8
  新平衡生活+: wxd47be70c1083e8bb

登录流程:
  WCS /wx/code → wx.login code
  → POST goauth/oauth/token (authorization_code)
  → {access_token, refresh_token}
  → 缓存 → 后续用 refresh_token 自动刷新
"""

import requests, json, time, random, os, base64
from datetime import datetime

try:
    import notify
    NOTIFY = lambda t, c: notify.send(t, c)
except:
    NOTIFY = None

# ====== ECP 配置 (纷享荟商城) ======
ECP = {
    'name': '纷享荟商城',
    'app_id': 'wx7bb6f3b8f0ad2ae8',
    'base_url': 'https://ecp-mall-api.infinituscloud.com.cn',
    'bmo_url': 'https://bmo-open-api.infinitus.com.cn',
    'goauth_url': 'https://goauth.infinitus.com.cn',
    'client_id': 'ecp-weapp',
    'client_secret': 'pBn5WeV2CGBshPGw3jz1BaaY9JPKXwhQ',
    'referer': 'https://servicewechat.com/wx7bb6f3b8f0ad2ae8/488/page-frame.html'
}

# ====== OPP 配置 (新平衡生活+) ======
OPP = {
    'name': '新平衡生活+',
    'app_id': 'wxd47be70c1083e8bb',
    'base_url': 'https://opp-api.infinitus.com.cn/wellness',
    'goauth_url': 'https://goauth.infinitus.com.cn',
    'client_id': 'opp-wellness',
    'client_secret': 'wnc2i2urhjhx3z4ico9jivfb21w8plz7',
    'referer': 'https://servicewechat.com/wxd47be70c1083e8bb/371/page-frame.html'
}

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.fenxianghui_cache.json')

STATUS_MAP = {0:"已达上限",1:"成功",2:"已到账",3:"已达上限",4:"已完成",5:"未开始/已结束"}

class WCS:
    def __init__(self):
        self.url = os.environ.get('wx_server_url', 'http://127.0.0.1:8787')
        self.auth = os.environ.get('wx_auth', '')

    def get_code(self, appid, openid):
        try:
            r = requests.post(f'{self.url}/wx/code',
                json={'appid': appid, 'openid': openid, 'userKey': openid},
                headers={'auth': self.auth, 'AUTH': self.auth}, timeout=30)
            d = r.json()
            if d.get('status'):
                code = d['data']['code']
                print(f'  ✅ code: {code[:12]}...')
                return code
            print(f'  ❌ WCS: {d}')
        except Exception as e:
            print(f'  ❌ WCS异常: {e}')
        return None

class Account:
    def __init__(self, wcsid):
        self.remark = wcsid[:8]
        self.wcsid = wcsid
        self.wcs = WCS()
        self.tokens = {'ecp':{'access_token':'','refresh_token':'','token_expires':0},
                       'opp':{'access_token':'','refresh_token':'','token_expires':0}}
        self._load_cache()

    def _load_cache(self):
        if os.path.exists(CACHE_FILE):
            try:
                with open(CACHE_FILE,'r') as f:
                    data = json.load(f)
                    entry = data.get(self.wcsid, {})
                    self.tokens = {
                        'ecp': {
                            'access_token': entry.get('ecp_access',''),
                            'refresh_token': entry.get('ecp_refresh',''),
                            'token_expires': entry.get('ecp_expires',0)
                        },
                        'opp': {
                            'access_token': entry.get('opp_access',''),
                            'refresh_token': entry.get('opp_refresh',''),
                            'token_expires': entry.get('opp_expires',0)
                        }
                    }
            except: pass

    def _save_cache(self):
        data = {}
        if os.path.exists(CACHE_FILE):
            try:
                with open(CACHE_FILE,'r') as f: data = json.load(f)
            except: pass
        data[self.wcsid] = {
            'remark': self.remark,
            'ecp_access': self.tokens['ecp']['access_token'],
            'ecp_refresh': self.tokens['ecp']['refresh_token'],
            'ecp_expires': self.tokens['ecp']['token_expires'],
            'opp_access': self.tokens['opp']['access_token'],
            'opp_refresh': self.tokens['opp']['refresh_token'],
            'opp_expires': self.tokens['opp']['token_expires'],
            'updated_at': int(time.time())
        }
        with open(CACHE_FILE,'w') as f: json.dump(data, f, indent=2)

    def _client_auth(self, cfg):
        return 'Basic ' + base64.b64encode(f"{cfg['client_id']}:{cfg['client_secret']}".encode()).decode()

    def _refresh_token(self, cfg, token_key):
        t = self.tokens[token_key]
        if not t['refresh_token']:
            return False
        print(f'  🔄 刷新 {cfg["name"]}...')
        r = requests.post(f"{cfg['goauth_url']}/oauth/token",
            data={'grant_type':'refresh_token', 'refresh_token': t['refresh_token']},
            headers={'Authorization':self._client_auth(cfg), 'Content-Type':'application/x-www-form-urlencoded', 'Referer':cfg['referer']},
            timeout=30)
        if r.status_code == 200:
            d = r.json()
            t['access_token'] = d['access_token']
            if d.get('refresh_token'): t['refresh_token'] = d['refresh_token']
            t['token_expires'] = time.time() + d.get('expires_in', 2591999) - 3600
            self._save_cache()
            print(f'  ✅ 刷新成功')
            return True
        print(f'  ❌ 刷新失败: {r.status_code}')
        return False

    def _login_with_code(self, cfg, token_key):
        """用 wx.login code 首次登录"""
        code = self.wcs.get_code(cfg['app_id'], self.wcsid)
        if not code:
            return False
        print(f'  🔐 {cfg["name"]} 首次登录...')
        r = requests.post(f"{cfg['goauth_url']}/oauth/token",
            data={'grant_type':'authorization_code', 'code': code},
            headers={'Authorization':self._client_auth(cfg), 'Content-Type':'application/x-www-form-urlencoded', 'Referer':cfg['referer']},
            timeout=30)
        if r.status_code == 200:
            d = r.json()
            self.tokens[token_key] = {
                'access_token': d['access_token'],
                'refresh_token': d.get('refresh_token', ''),
                'token_expires': time.time() + d.get('expires_in', 2591999) - 3600
            }
            self._save_cache()
            print(f'  ✅ 登录成功')
            return True
        print(f'  ❌ 登录失败: {r.status_code} {r.text[:100]}')
        return False

    def ensure_token(self, cfg, token_key):
        t = self.tokens[token_key]
        if t['access_token'] and time.time() < t['token_expires']:
            return True
        if t['refresh_token'] and self._refresh_token(cfg, token_key):
            return True
        return self._login_with_code(cfg, token_key)

    def get_headers(self, cfg, token_key, extra=None):
        return {
            'Authorization': f'Bearer {self.tokens[token_key]["access_token"]}',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 16)',
            'content-type': 'application/json;charset=utf-8',
            'Referer': cfg['referer'],
            **(extra or {})
        }

    def get_points(self):
        if not self.ensure_token(ECP, 'ecp'): return -1
        r = requests.post(f"{ECP['base_url']}/mall/member/obtain/currency",
            headers=self.get_headers(ECP,'ecp'), json={}, timeout=30)
        if r.status_code==200 and r.json().get('success'):
            return int(r.json()['data'].get('fxbValue', 0))
        return -1

    def get_tasks(self):
        if not self.ensure_token(ECP, 'ecp'): return []
        r = requests.post(f"{ECP['bmo_url']}/member/api/v2/integral/user/tasks",
            headers=self.get_headers(ECP,'ecp'),
            json={'eventSourceSystem':'ecp','onlyEventSourceSystem':False,'pageNum':1,'pageSize':50},
            timeout=30)
        if r.status_code==200:
            return r.json().get('data',{}).get('records',[])
        return []

    def start_view(self, task_code, is_opp=False):
        cfg = OPP if is_opp else ECP
        tk = 'opp' if is_opp else 'ecp'
        if not self.ensure_token(cfg, tk): return False
        r = requests.post(f"{ECP['base_url']}/mall/api/currencyTask/startViewTask",
            headers=self.get_headers(cfg, tk), json={'taskNumber': task_code}, timeout=30)
        return r.status_code==200 and r.json().get('success')

    def complete_view(self, task_code, target_id='', is_opp=False):
        cfg = OPP if is_opp else ECP
        tk = 'opp' if is_opp else 'ecp'
        if not self.ensure_token(cfg, tk): return False
        d = {'id': task_code}
        if target_id: d['shareContent'] = target_id
        r = requests.post(f"{ECP['base_url']}/mall/api/currencyTask/complete",
            headers=self.get_headers(cfg, tk), json=d, timeout=30)
        return r.status_code==200 and r.json().get('success')

    def report_task(self, event_code, task_type, path, target_id='', is_opp=False, _retry=3):
        cfg = OPP if is_opp else ECP
        tk = 'opp' if is_opp else 'ecp'
        if not self.ensure_token(cfg, tk): return False, 0, -1
        src = 'opp-wellness' if is_opp else 'ecp'
        for _attempt in range(_retry):
            try:
                r = requests.post(f"{ECP['base_url']}/mall/api/currencyTask/task-event-report",
                    headers=self.get_headers(cfg, tk),
                    json={'eventCode':event_code,'eventSourceSystem':src,'type':task_type,'path':path,'targetId':target_id,'sourceSystem':src},
                    timeout=30)
                if r.status_code==200:
                    d = r.json()
                    if d.get('success'):
                        rd = d.get('data',{})
                        return True, rd.get('integral',0), rd.get('integralStatus',0)
            except Exception:
                pass
            if _attempt < _retry - 1:
                import time; time.sleep(2)
        return False, 0, -1

    def run(self):
        print(f"\n{'='*50}")
        print(f"👤 {self.remark}  {datetime.now().strftime('%H:%M:%S')}")
        print(f"{'='*50}")

        pts_before = self.get_points()
        if pts_before >= 0:
            print(f"💰 初始爽积分: {pts_before}")

        tasks = self.get_tasks()
        if not tasks:
            print("❌ 获取任务失败")
            return

        # 分类
        ecp_tasks, opp_tasks, completed, failed = [], [], 0, 0
        for task in tasks:
            events = task.get('event', [])
            if not events or events[0].get('isCompleted'): continue
            g = task.get('guidance') or {}
            app_id = g.get('appId', '')
            if app_id == 'wx7bb6f3b8f0ad2ae8' or g.get('system') == 'ecp':
                ecp_tasks.append(task)
            else:
                opp_tasks.append(task)

        print(f"📋 ECP:{len(ecp_tasks)} | OPP:{len(opp_tasks)}")

        total_pts = 0
        for lst, is_opp in [(ecp_tasks, False), (opp_tasks, True)]:
            for task in lst:
                name = task.get('name','')
                events = task.get('event',[])
                if not events: continue
                event = events[0]
                code = event.get('code','')
                g = task.get('guidance') or {}
                t = g.get('targetObject') or {}
                tt = t.get('type','')

                print(f"  📱 {name}")
                # 浏览类
                if '浏览' in name:
                    dur = (t.get('pageConfig',{}) or {}).get('duration',10)
                    print(f"    ⏱️ 浏览 {dur}s...")
                    self.start_view('', is_opp)
                    time.sleep(dur)
                    self.complete_view('', is_opp)
                # 分享类
                elif '分享' in name:
                    ids = (t.get('articleConfig',{}) or {}).get('ids','')
                    self.start_view('', is_opp)
                    time.sleep(2)
                    self.complete_view('', ids, is_opp)
                # 答题
                elif '答题' in name:
                    ids = (t.get('questionConfig',{}) or {}).get('ids','')

                path = '/pages/index/index'
                if '签到' in name: path = '/pages/preloadPages/signIn/index'
                elif '养生圈' in name: path = '/pages/wellness-circle/index'
                elif '养生营' in name: path = '/pages-sub/learnActivity/myActivityList/index'
                elif '健康检测' in name: path = '/pages-sub/assessment/home/index'
                elif '十二时辰' in name: path = '/pages-sub/circadian-activity/index'

                ok, pts, st = self.report_task(code,
                    'page' if '浏览' in name else 'sign_in' if '签到' in name else 'article',
                    path, '', is_opp)
                if ok:
                    if pts > 0:
                        print(f"    ✅ +{pts}积分")
                        total_pts += pts
                    else:
                        print(f"    ⚠️ {STATUS_MAP.get(st, f'状态{st}')}")
                    completed += 1
                else:
                    print(f"    ❌ 失败")
                    failed += 1
                time.sleep(random.uniform(2,4))

        pts_after = self.get_points()
        print(f"{'='*50}")
        if pts_before>=0 and pts_after>=0:
            print(f"💰 {pts_before} → {pts_after} (+{pts_after-pts_before})")
        print(f"✅ {completed} | ❌ {failed}")
        print(f"{'='*50}\n")
        return pts_after - pts_before if pts_before>=0 else 0


def main():
    # 自动从 WCS 发现活跃账号
    try:
        wcs_url = os.environ.get('wx_server_url','http://127.0.0.1:8787')
        wcs_auth = os.environ.get('wx_auth','')
        # 优先从 wx_opinion 环境变量读取账号
        _wx_op = os.environ.get("wx_opinion", "")
        if _wx_op:
            items = [{"openid": o.strip()} for o in _wx_op.split("&") if o.strip()]
        else:
        r = requests.get(f'{wcs_url}/api/accounts', headers={'AUTH':wcs_auth,'auth':wcs_auth}, timeout=10)
        data = r.json()
        items = data.get('data',{}).get('items',[]) if data.get('status') else []
        items = [a for a in items if not a.get('disabled',False)]
    except:
        items = []

    if not items:
        print('❌ WCS 未发现活跃账号')
        return

    accounts = [Account(a.get('openid','')) for a in items]

    if not accounts:
        print('❌ 无有效账号')
        return

    print(f'🚀 纷享会积分任务  {len(accounts)}账号')
    total_pts = 0
    for i, acc in enumerate(accounts):
        total_pts += acc.run() or 0
        if i < len(accounts)-1:
            time.sleep(random.uniform(5,8))

    print(f'🎉 完成 总积分+{total_pts}')
    if NOTIFY:
        NOTIFY('纷享会积分任务', f'{len(accounts)}账号 | +{total_pts}积分')

if __name__ == '__main__':
    main()