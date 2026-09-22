# ========== SSL和代理修复 ==========


# ==================== 推送 ====================
import urllib3
urllib3.disable_warnings()
import os
os.environ['HTTP_PROXY'] = ''
os.environ['HTTPS_PROXY'] = ''
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
# ========== SSL和代理修复结束 ==========

#!/usr/bin/env python3
"""
孩视宝签到脚本 (有赞零售平台)
===============================
平台: 有赞零售 (Youzan Retail)
小程序 AppID: wxf7c51121c72bfb05
店铺 kdt_id: 45216658
签到活动 checkinId: 13714
登录域名: retail-uic.youzan.com (注意是 retail 子域)
业务域名: retail-h5.youzan.com

支持两种模式:
  1. 手动 token 模式: 设置环境变量 hsb = "备注#access_token"
  2. WCS 自动模式: 设置 wx_server_url + wx_auth，自动获取 wx.login code 换取 access_token

环境变量:
  hsb             - 手动 token (格式: "备注#access_token")
  wx_server_url   - WCS 控制台地址 (默认 http://host.docker.internal:18788)
  wx_auth         - WCS API Key
"""

import os
import sys
import json
import time
import random
import hashlib
import logging
from _log_tee import enable as _enable_tee


# ========== 推送通知 ==========
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from _youzan_milestone import check_milestone
    from _push_helper import push_notify
except ImportError:
    def push_notify(title, content):
        print(f'⚠️ 推送模块未加载')
        return False
# ========== 推送通知结束 ==========
try:
    from std_report import report as _std_report, extract_points
except ImportError:
    _std_report = None
    extract_points = None
_rows = []


def _dig_lottery(obj):
    """通用抽奖/奖励字段扫描：从响应体提取 lottery/draw/prize/转盘/福袋 等字段。"""
    if not obj:
        return ""
    flat = {}

    def _f(o, pre):
        if isinstance(o, list):
            for i, v in enumerate(o):
                _f(v, f"{pre}.{i}" if pre else str(i))
        elif isinstance(o, dict):
            for k, v in o.items():
                nk = f"{pre}.{k}" if pre else k
                if isinstance(v, (dict, list)):
                    _f(v, nk)
                else:
                    flat[nk.lower()] = v
        elif pre:
            flat[pre] = o

    _f(obj, "")
    import re
    pat = re.compile(r"lottery|draw|prize|转盘|turntable|raffle|lucky|福袋|reward|rewards|gift")
    out = []
    for k, v in flat.items():
        if pat.search(k) and v not in (None, "", {}, []):
            out.append(str(v))
    return "｜".join(out)


# ====== 自动安装依赖 ======
try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests


def _req_retry(fn, *args, _retries=3, **kw):
    """网络请求退避重试：超时/连接/SSL 错误重试 3 次"""
    last = None
    for i in range(_retries):
        try:
            return fn(*args, **kw)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError,
                requests.exceptions.SSLError) as e:
            last = e
            if i < _retries - 1:
                print(f"  [retry] {fn.__name__} 网络异常({e.__class__.__name__}), {i+1}s 后重试 {i+1}/{_retries}", flush=True)
                time.sleep(i + 1)
    raise last

# ====== 日志配置 ======
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('haishibao')

# ====== 常量 (有赞零售平台) ======
APPID = 'wxf7c51121c72bfb05'
KDT_ID = '45216658'
CHECKIN_ID = '13714'
# 有赞零售用 retail- 子域
API_BASE = 'https://retail-h5.youzan.com'
UIC_BASE = 'https://retail-uic.youzan.com'
BIZ_ENV = 'retail'
YZ_VERSION = '3.193.6'
REFERRER_PAGE = '199'  # Referer 中的页面编号

# ====== 配置缓存 ======
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.haishibao_config.json')

_DEFAULT_CONFIG = {
    'wx_server_url': 'http://host.docker.internal:18788',
    'wx_auth': '',
    'hsb': '',  # 手动 token 降级
}


def _load_config():
    """三级配置加载: 环境变量 > 缓存文件 > 硬编码默认值"""
    config = dict(_DEFAULT_CONFIG)

    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'r', encoding='utf-8') as f:
                config.update(json.load(f))
        except Exception:
            pass

    env_map = {
        'wx_server_url': 'wx_server_url',
        'wx_auth': 'wx_auth',
        'hsb': 'hsb',
    }
    updated = False
    for cfg_key, env_name in env_map.items():
        val = os.environ.get(env_name, '')
        if val and val != config.get(cfg_key, ''):
            config[cfg_key] = val
            updated = True

    if updated or not os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    return config


_config = _load_config()
WCS_BASE = _config['wx_server_url']
WCS_AUTH = _config['wx_auth']


# ====== Token 缓存 ======
_TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.haishibao_token_cache.json')
_TOKEN_TTL = 8 * 3600  # 8 小时


def _load_token_cache():
    if os.path.exists(_TOKEN_CACHE_FILE):
        try:
            with open(_TOKEN_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_token_cache(cache):
    try:
        with open(_TOKEN_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _token_cache_key(appid, user_key):
    raw = f'{appid}:{user_key}'
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def get_cached_token(appid, user_key):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    entry = cache.get(ck)
    if not entry:
        return None, 'no_cache'
    if time.time() - entry.get('ts', 0) > _TOKEN_TTL:
        del cache[ck]
        _save_token_cache(cache)
        return None, 'expired'
    return entry.get('data'), None


def set_cached_token(appid, user_key, token_data):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    cache[ck] = {'data': token_data, 'ts': time.time(), 'appid': appid}
    _save_token_cache(cache)


def invalidate_token(appid, user_key):
    cache = _load_token_cache()
    ck = _token_cache_key(appid, user_key)
    if ck in cache:
        del cache[ck]
        _save_token_cache(cache)


# ====== WCS 客户端 ======
class WCSClient:
    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _post(self, path, data, timeout=60):
        r = _req_retry(requests.post,f'{self.base}{path}', json=data,
                          headers={'AUTH': self.auth, 'Content-Type': 'application/json'},
                          timeout=timeout, verify=False)
        return r.json()

    def _get(self, path, timeout=30):
        r = _req_retry(requests.get,f'{self.base}{path}',
                         headers={'AUTH': self.auth}, timeout=timeout, verify=False)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """对孩视宝小程序执行 wx.login() 获取 code"""
        body = {
            'appid': APPID,
            'userKey': user_key or openid,
            'openid': openid,
        }
        try:
            data = self._post('/wx/code', body)
        except requests.exceptions.Timeout:
            log.warning('[WCS] /wx/code 请求超时')
            return None
        except requests.exceptions.RequestException as e:
            log.warning(f'[WCS] /wx/code 网络错误: {e}')
            return None
        if data and data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
        log.warning(f'[WCS] /wx/code 返回异常: {data}')
        return None


# ====== 有赞零售客户端 ======
class YouzanClient:
    """有赞零售平台 API 客户端"""

    def __init__(self, access_token, openid='', session_id='', user_id=''):
        self.access_token = access_token
        self.openid = openid
        self.session_id = session_id
        self.user_id = user_id

    def _make_headers(self):
        devices = [
            ('16', 'M2012K11AC Build/BP2A.250605.031.A3'),
            ('15', 'PELM00 Build/OPR1A.20240502.001'),
            ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ]
        wv_list = ['8.0.72.3100', '8.0.70.2780', '8.0.68.2780']
        av, dev = random.choice(devices)
        wv = random.choice(wv_list)
        ua = (
            f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
            f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
            f'Chrome/{random.randint(140,146)}.0.{random.randint(6000,7680)} Mobile Safari/537.36 '
            f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
            f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
        )
        headers = {
            'User-Agent': ua,
            'Content-Type': 'application/json',
            'xweb_xhr': '1',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': f'https://servicewechat.com/{APPID}/{REFERRER_PAGE}/page-frame.html',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }
        # Extra-Data 头 (有赞零售 bizEnv=retail, version=3.193.6)
        if self.session_id:
            import uuid as _uuid
            headers['Extra-Data'] = json.dumps({
                'is_weapp': 1,
                'sid': self.session_id,
                'version': YZ_VERSION,
                'client': 'weapp',
                'bizEnv': BIZ_ENV,
                'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                'ftime': int(time.time() * 1000),
            })
        return headers

    def _get(self, path, params=None):
        if params is None:
            params = {}
        params.setdefault('app_id', APPID)
        params.setdefault('kdt_id', KDT_ID)
        params.setdefault('access_token', self.access_token)

        url = f'{API_BASE}{path}'
        resp = _req_retry(requests.get,url, params=params, headers=self._make_headers(), timeout=15)
        return resp.json()

    def get_checkin_info(self):
        return self._get('/wscump/checkin/check-in-info.json')

    def get_checkin_status(self):
        return self._get('/wscump/checkin/get_activity_by_yzuid_v2.json',
                         {'checkinId': CHECKIN_ID})

    def do_checkin(self):
        return self._get('/wscump/checkin/checkinV2.json',
                         {'checkinId': CHECKIN_ID})

    def get_monthly_record(self, year, month):
        return self._get('/wscump/checkin/find_checkin_info_by_month.json',
                         {'checkin_id': CHECKIN_ID, 'year': year, 'month': month})

    def get_user_points(self):
        """通过 membercenter/stats.json 获取用户真实积分（需要 store_id=userId）"""
        if not self.user_id:
            return None
        params = {
            'app_id': APPID,
            'kdt_id': KDT_ID,
            'access_token': self.access_token,
            'store_id': self.user_id,
            'currentKdtId': KDT_ID,
            'version': YZ_VERSION,
            'needConsumptionAboveCoupon': '1',
        }
        try:
            resp = _req_retry(requests.get, f'{API_BASE}/wscuser/membercenter/stats.json',
                              params=params, headers=self._make_headers(), timeout=15)
            d = resp.json()
            if d.get('code') == 0:
                stats = d.get('data', {}).get('stats', {}) or {}
                return stats.get('points', None)
        except Exception as e:
            log.warning(f'[有赞] 查询积分异常: {e}')
        return None


# ====== 登录流程 ======
def login_via_wcs(openid, user_key=None):
    """通过 WCS 自动登录，返回 {'access_token': ..., 'session_id': ...} 或 None"""
    wcs = WCSClient()

    # Step 1: 获取 wx.login code
    log.info('[WCS] 获取 loginCode...')
    login_code = None
    for attempt in range(3):
        try:
            login_code = wcs.get_code(openid, user_key or openid)
        except Exception as e:
            log.warning(f'[WCS] get_code 异常: {e}，重试 ({attempt+1}/3)...')
            login_code = None
        if login_code:
            break
        if attempt < 2:
            wait = 3 * (attempt + 1)
            log.info(f'[WCS] code 获取失败，{wait}s 后重试 ({attempt+1}/3)...')
            time.sleep(wait)

    if not login_code:
        log.error('loginCode 获取失败，已重试 3 次')
        return None

    log.info(f'[WCS] 获取到 code: {login_code[:10]}...')

    # Step 2: 用 code 换取有赞 accessToken
    # 有赞零售登录域名: retail-uic.youzan.com
    try:
        import uuid as _uuid
        resp = _req_retry(requests.post,
            f'{UIC_BASE}/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APPID}',
            json={
                'appId': APPID,
                'code': login_code,
                'platformName': 'weapp',
                'signature': 'windows',
                'clientBiz': 'weapp_wsc',
                'inWsc': True,
                'kdtId': KDT_ID,
                'extraBizData': {
                    'enterOptions': {
                        'extKdtId': int(KDT_ID),
                        'path': 'pages/home/dashboard/index',
                        'query': {},
                        'scene': 1005,
                        'referrerInfo': {},
                        'apiCategory': 'default',
                    },
                    'guideBizDataMap': {'from_params': ''},
                    'sceneData': {},
                },
            },
            headers={
                'Content-Type': 'application/json',
                'Referer': f'https://servicewechat.com/{APPID}/{REFERRER_PAGE}/page-frame.html',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541939) XWEB/19841',
                'xweb_xhr': '1',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'page-path': 'pages/home/dashboard/index',
                'app-mode': 'default',
                'Extra-Data': json.dumps({
                    'sid': '',
                    'version': YZ_VERSION,
                    'clientType': 'weapp-miniprogram',
                    'client': 'weapp',
                    'bizEnv': '',
                    'uuid': str(_uuid.uuid4()).replace('-', '')[:24],
                    'ftime': int(time.time() * 1000),
                }),
            },
            timeout=15,
        )
        data = resp.json()
        log.info(f'[有赞] 登录响应: code={data.get("code")}, msg={data.get("msg")}')

        if data.get('code') == 0 and data.get('data'):
            login_data = data['data']
            token = login_data.get('accessToken', '')
            session_id = login_data.get('sessionId', '')
            user_id = login_data.get('userId', '') or login_data.get('buyerId', '')
            if token:
                log.info(f'[有赞] 获取到 accessToken: {token[:10]}..., sessionId: {session_id[:20]}..., userId: {user_id}')
                return {'access_token': token, 'session_id': session_id, 'user_id': user_id}

    except Exception as e:
        log.error(f'[有赞] 登录请求异常: {e}')

    return None


def parse_manual_accounts():
    """解析手动 token 环境变量: "备注#access_token" """
    raw = _config.get('hsb', '') or os.environ.get('hsb', '')
    if not raw:
        return []

    accounts = []
    for item in raw.split('@'):
        item = item.strip()
        if not item:
            continue
        parts = item.split('#')
        if len(parts) >= 2:
            accounts.append({
                'remark': parts[0],
                'access_token': parts[1],
            })
        elif len(parts) == 1:
            accounts.append({
                'remark': '手动',
                'access_token': parts[0],
            })
    return accounts


# ====== 签到逻辑 ======

# ---------- 本地累计积分（接口无总积分字段，本机向前累计每日签到获得积分）----------
_POINTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "haishibao_points_cache.json")
def _read_points():
    try:
        if not os.path.exists(_POINTS_FILE): return {}
        with open(_POINTS_FILE, encoding="utf-8") as f: return json.load(f) or {}
    except Exception: return {}
def _write_points(c):
    try:
        with open(_POINTS_FILE, "w", encoding="utf-8") as f: json.dump(c, f, ensure_ascii=False, indent=2)
    except Exception as e: print(f"写入积分缓存失败: {e}")
def _today():
    import datetime; return datetime.date.today().isoformat()
def _roll_day(openid, cache):
    rec = cache.setdefault(openid, {"hist": 0, "gain": 0, "date": _today()})
    if rec.get("date") != _today():
        rec["hist"] = (rec.get("hist") or 0) + (rec.get("gain") or 0); rec["gain"] = 0; rec["date"] = _today()
    return rec
def _add_gain(openid, pts, cache):
    rec = _roll_day(openid, cache)
    rec["gain"] = (rec.get("gain") or 0) + (pts or 0)
def _cur_total(openid, cache):
    rec = cache.get(openid) or {"hist": 0, "gain": 0}
    return (rec.get("hist") or 0) + (rec.get("gain") or 0)

def run_checkin(client, remark='', row=None):
    prefix = f'[{remark}] ' if remark else ''

    log.info(f'{prefix}查询签到状态...')
    status = client.get_checkin_status()
    if status.get('code') != 0:
        log.error(f'{prefix}查询签到状态失败: {status.get("msg")}')
        if row is not None:
            row['sign'] = f"查询签到状态失败: {status.get('msg')}"
        return False

    status_data = status.get('data', {})
    is_checkin = status_data.get('isCheckin', False)
    continues_day = status_data.get('continuesDay', 0)
    cycle_times = status_data.get('cycleTimes', 0)

    log.info(f'{prefix}连续签到: {continues_day} 天, 周期: {cycle_times} 天, 今日已签: {is_checkin}')
    # 查询真实总积分（从 membercenter/stats.json 获取）
    _total_from_server = None
    if row is not None:
        try:
            _total_from_server = client.get_user_points()
            if _total_from_server is not None:
                row['total'] = str(_total_from_server)
                row['totalLabel'] = '总积分'
                log.info(f'{prefix}总积分: {_total_from_server}')
        except Exception as e:
            log.warning(f'{prefix}查询总积分异常: {e}')
    if row is not None:
        if continues_day:
            row['streak'] = continues_day
        _ep = (extract_points(status) if extract_points else None) or {}
        if _ep.get('total') is not None and _total_from_server is None:
            row['total'] = str(_ep['total'])

    if is_checkin:
        log.info(f'{prefix}今日已签到，跳过')
        if row is not None:
            row['sign'] = f'今日已签到, 连续{continues_day}天'
        return True

    log.info(f'{prefix}执行签到...')
    time.sleep(random.uniform(0.5, 1.5))

    result = client.do_checkin()
    if result.get('code') != 0:
        log.error(f'{prefix}签到失败: {result.get("msg")}')
        if row is not None:
            row['sign'] = f"签到失败: {result.get('msg')}"
        return False

    checkin_data = result.get('data', {})
    success = checkin_data.get('success', False)
    desc = checkin_data.get('desc', '')

    if success:
        rewards = checkin_data.get('list', [])
        reward_str = ', '.join([
            f'{r.get("infos", {}).get("title", "未知奖励")}'
            for r in rewards
        ])
        log.info(f"{prefix}签到成功! {desc} - 获得: {reward_str}")
        import re as _re
        _m = _re.search(r'(\d+)\s*积分', reward_str)
        _pc = _read_points(); _roll_day(client.openid, _pc)
        if _m: _add_gain(client.openid, int(_m.group(1)), _pc)
        _lt = _cur_total(client.openid, _pc); _write_points(_pc)
        if row is not None:
            row['sign'] = f'签到成功{(" - " + desc) if desc else ""}'
            if reward_str:
                row['earned'] = reward_str
            # 优先用服务端积分，其次用本地累计
            if _total_from_server is not None:
                row['total'] = str(_total_from_server)
                row['totalLabel'] = '总积分'
            else:
                row['total'] = str(_lt)
                row['totalLabel'] = '累计积分'
            _lot = _dig_lottery(checkin_data)
            if _lot:
                row['lottery'] = _lot
        # 连签里程碑推送
        try:
            info = client.do_get("/wscump/checkin/show_checkin_page_v2.json", {})
            page_data = info.get("data") if isinstance(info, dict) else info
            check_milestone("孩视宝签到", page_data, getattr(client, "openid", ""), reward_str)
        except Exception:
            pass
        return True
    else:
        log.warning(f'{prefix}签到未成功: {desc}')
        if row is not None:
            row['sign'] = f'签到未成功: {desc}'
        return False


def run_one_account(access_token, remark='', openid='', session_id='', user_id='', row=None):
    client = YouzanClient(access_token, openid, session_id, user_id)
    return run_checkin(client, remark, row)


# ====== 主函数 ======
def main():
    manual_accounts = parse_manual_accounts()

    if manual_accounts:
        log.info(f'手动 token 模式: {len(manual_accounts)} 个账号')
        success_count = 0
        for i, acc in enumerate(manual_accounts):
            remark = acc.get('remark', f'账号{i+1}')
            token = acc.get('access_token', '')
            if not token:
                log.warning(f'[{remark}] token 为空，跳过')
                continue

            _row = {'idx': i + 1, 'name': remark, 'sign': '', 'earned': '', 'total': '', 'streak': '', 'lottery': ''}
            _rows.append(_row)
            if run_one_account(token, remark, row=_row):
                success_count += 1

            if i < len(manual_accounts) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s...')
                time.sleep(delay)

        log.info(f'签到完成: {success_count}/{len(manual_accounts)} 成功')

    elif WCS_AUTH:
        log.info('WCS 自动登录模式')
        wcs = WCSClient()
        accounts = wcs.get_accounts()
        if not accounts:
            log.error('未找到 WCS 账号')
            sys.exit(1)

        active = [a for a in accounts if not a.get('disabled', False)]
        
        # wx_opinion 过滤：只处理指定的 openid
        wx_opinion = os.environ.get('wx_opinion', '').strip()
        if wx_opinion:
            filter_openids = set(wx_opinion.split('&'))
            active = [a for a in active if a.get('openid', '') in filter_openids]
            log.info(f'wx_opinion 过滤后: {len(active)} 个账号')
        log.info(f'找到 {len(active)} 个活跃账号')

        success_count = 0
        for i, acc in enumerate(active):
            openid = acc.get('openid', '')
            user_key = acc.get('userKey', openid)
            display_name = acc.get('displayName', openid[:8])

            _row = {'idx': i + 1, 'name': display_name, 'sign': '', 'earned': '', 'total': '', 'streak': '', 'lottery': ''}
            _rows.append(_row)
            login_info = login_via_wcs(openid, user_key)
            if not login_info:
                log.error(f'[{display_name}] 登录失败，跳过')
                _row['sign'] = '登录失败'
                continue

            access_token = login_info['access_token']
            session_id = login_info.get('session_id', '')
            user_id = str(login_info.get('user_id', '') or '')

            if run_one_account(access_token, display_name, openid, session_id, user_id, row=_row):
                success_count += 1

            if i < len(active) - 1:
                delay = random.uniform(3, 8)
                log.info(f'等待 {delay:.1f}s...')
                time.sleep(delay)

        log.info(f'签到完成: {success_count}/{len(active)} 成功')

    else:
        print('''
孩视宝签到脚本 - 配置帮助
==========================

方式1: 手动 token 模式
  设置环境变量 hsb:
    set hsb=备注#access_token
  示例:
    set hsb=我的账号#45f0e2f72f1a2d88e3cf6146d282ba
  多账号用 @ 分隔:
    set hsb=账号1#token1@账号2#token2

方式2: WCS 自动登录模式
  设置环境变量:
    set wx_server_url=http://host.docker.internal:18788
    set wx_auth=你的AUTH_KEY

access_token 从抓包数据中获取:
  URL 参数中包含 access_token=xxx 即可提取
        ''')
        sys.exit(1)

    if _std_report and _rows:
        try:
            _std_report('孩视宝签到', _rows)
        except Exception as _e:
            print(f'[push] 异常: {_e}')


if __name__ == '__main__':
    import io


    _tee_out, _tee_err = _enable_tee()
    try:
        main()
    except SystemExit:
        pass
    except Exception as e:
        print(f'脚本异常: {e}')
    finally:
        sys.stdout = _tee_out.original

        sys.stderr = _tee_err.original

        _logs = _tee_out.getvalue()
    if _logs.strip():
        print(_logs)

