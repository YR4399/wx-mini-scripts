# -*- coding: utf-8 -*-
"""
太平洋蓝医保 (cpic.com.cn) - 每日签到 & 健康问答自动化脚本

API 流程:
  0. login/wx-session -> 用 wx.login code 换取 token（token 在响应头中！）
  1. zqdk/dk-V1        -> 签到打卡
  2. jkwd/getQuestion-V1 -> 获取健康问题
  3. jkwd/getQuestionAnswer-V1 -> 提交答案（随机 A/B）
  4. jkwd/revive-V1     -> 分享复活（答错时）
  5. getScore-V1        -> 查询健康分

环境变量:
    wx_server_url  - WCS 控制台地址，默认 http://127.0.0.1:8787
    wx_auth        - WCS 控制台 AUTH key
    tpylyb         - 降级模式的手动 token（格式: 备注#openid#token#unionid）

依赖: pip install requests

自动缓存:
    首次运行时从环境变量读取 wx_server_url / wx_auth 并缓存到
    .tpy_lyb_config.json，后续运行无需重复设置环境变量。
    AI 答题已内置阿里云百炼 API Key，无需额外配置。
"""
import os
# 清除代理环境变量
for _k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "*"
import sys
import time
import random
import json
import logging
from datetime import datetime

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'requests', '-q'])
    import requests

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('tpy_lyb')

# ============ 常量 + 自动缓存配置 ============

API_BASE   = 'https://lyb-api.cpic.com.cn/lyb-api'
APPID      = 'wx41b377f9104ee1c2'  # 太平洋蓝医保小程序 AppID

# 缓存文件：脚本同目录下 .tpy_lyb_config.json
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '.tpy_lyb_config.json')

# 硬编码默认值
_DEFAULT_CONFIG = {
    'wx_server_url':     'http://127.0.0.1:8787',
    'wx_auth':           '',
    'ai_api_key':        'sk-033fb36a9a304b8e9f40e141439d55de',
    'ai_api_url':        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'ai_model':          'deepseek-r1-distill-qwen-7b',
}

AI_API_URL   = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
AI_MODEL     = 'deepseek-r1-distill-qwen-7b'


def _load_config():
    """
    三级配置加载，优先级: 环境变量 > 缓存文件 > 硬编码默认值

    首次设置环境变量后自动写入缓存，后续运行无需重复 set。
    """
    config = dict(_DEFAULT_CONFIG)  # 从硬编码起底

    # L1: 读缓存文件
    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'r', encoding='utf-8') as f:
                cached = json.load(f)
            config.update(cached)
        except Exception:
            pass

    # L2: 环境变量覆盖（最高优先级）
    env_map = {
        'wx_server_url':    'wx_server_url',
        'wx_auth':          'wx_auth',
        'ai_api_key':       'AI_API_KEY',
        'ai_api_url':       'AI_API_URL',
        'ai_model':         'AI_MODEL',
        'tpylyb':           'tpylyb',
    }
    updated = False
    for cfg_key, env_name in env_map.items():
        val = os.environ.get(env_name, '')
        if val and val != config.get(cfg_key, ''):
            config[cfg_key] = val
            updated = True

    # 回写缓存（有变化时）
    if updated or not os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            if updated:
                log.info(f'[Config] 已缓存 {len([k for k in env_map if os.environ.get(env_map[k])])} 个环境变量 -> {_CACHE_FILE}')
        except Exception:
            pass

    return config


_config = _load_config()
WCS_BASE = _config['wx_server_url']
WCS_AUTH = _config['wx_auth']
AI_API_KEY = _config['ai_api_key']


def ask_deepseek(question_text, options):
    """
    用阿里云百炼 AI（deepseek-r1-distill-qwen-7b）回答健康知识选择题。

    百炼兼容模式 API: POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
    r1-distill 系列模型响应中可能包含 reasoning_content（思考过程）和 content（最终答案）。

    Args:
        question_text: 问题文本，如 "孕妇能不能喝咖啡？"
        options: 选项列表 [{"optionKey": "A", "optionValue": "可以"}, ...]

    Returns:
        str: 'A' 或 'B'，失败时返回 None
    """
    if not AI_API_KEY:
        return None

    api_url = _config.get('ai_api_url', AI_API_URL)
    model   = _config.get('ai_model', AI_MODEL)

    opts_text = '\n'.join(f"{o['optionKey']}. {o['optionValue']}" for o in options)
    prompt = (
        f'请回答以下健康知识选择题，直接输出正确的选项字母（A 或 B），不要解释。\n\n'
        f'问题：{question_text}\n'
        f'选项：\n{opts_text}\n\n'
        f'正确答案：'
    )

    try:
        resp = requests.post(
            api_url,
            headers={
                'Authorization': f'Bearer {AI_API_KEY}',
                'Content-Type': 'application/json',
            },
            json={
                'model': model,
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.1,
                'max_tokens': 1000,  # r1-distill 需要足够 token 完成推理链
            },
            timeout=30,
        )
        data = resp.json()

        # 检查 API 错误（402 余额不足、401 鉴权失败等）
        if 'error' in data:
            err_msg = data['error'].get('message', '未知错误')
            err_code = data['error'].get('code', '')
            log.warning(f'[AI] API 错误 [{resp.status_code}]: {err_msg} ({err_code})')
            return None

        if 'choices' not in data:
            log.warning(f'[AI] 响应缺少 choices: {list(data.keys())}')
            return None

        message = data['choices'][0]['message']
        # r1-distill 模型: content 是最终答案，reasoning_content 是思考过程
        answer = message.get('content', '') or message.get('reasoning_content', '')
        if not answer:
            log.warning(f'[AI] 消息体无有效内容: {list(message.keys())}')
            return None

        answer = answer.strip().upper()
        # 提取第一个 A 或 B
        for ch in answer:
            if ch in ('A', 'B'):
                log.info(f'[AI] 百炼响应: {answer[:50]}')
                return ch
        log.warning(f'[AI] 无法解析答案: {answer[:80]}')
        return None
    except Exception as e:
        log.warning(f'[AI] 百炼调用异常: {e}')
        return None


def pick_answer(question_text, options, history_result=None):
    """
    智能选择题答案，优先级:
      1. 历史记录中已揭示的正确答案 (historyAnswerResult)
      2. DeepSeek AI 推理
      3. 随机蒙

    Args:
        question_text: 问题文本
        options: 选项列表
        history_result: getQuestion 返回的 data dict (可能含 historyAnswerResult/answerResultDesc)

    Returns:
        tuple: (option_key, source)  如 ('A', 'history')
    """
    # 优先级1: 历史正确答案
    if history_result:
        hist_ans = history_result.get('historyAnswerResult', 'N')
        ans_desc = history_result.get('answerResultDesc', '')
        if hist_ans == 'N' and ans_desc in ('A', 'B'):
            log.info(f'[答题] 从历史记录获取正确答案: {ans_desc}')
            return ans_desc, 'history'

    # 优先级2: DeepSeek AI
    ai_ans = ask_deepseek(question_text, options)
    if ai_ans:
        log.info(f'[答题] AI 选择: {ai_ans}')
        return ai_ans, 'ai'

    # 优先级3: 随机
    guess = random.choice(['A', 'B'])
    log.info(f'[答题] 随机选择: {guess}')
    return guess, 'random'


def random_ua():
    """生成随机微信 User-Agent"""
    devices = [
        ('16', 'M2012K11AC Build/BP2A.250605.031.A3'),
        ('15', 'PELM00 Build/OPR1A.20240502.001'),
        ('14', 'Pixel 8 Pro Build/UQ1A.240105.002'),
        ('14', 'SM-S918B Build/UP1A.231005.007'),
        ('13', 'V2141A Build/TP1A.220627.004'),
    ]
    wv_list = ['8.0.72.3100', '8.0.70.2780', '8.0.68.2780',
               '8.0.65.2780', '8.0.60.2780']
    av, dev = random.choice(devices)
    wv = random.choice(wv_list)
    return (
        f'Mozilla/5.0 (Linux; Android {av}; {dev}; wv) '
        f'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
        f'Chrome/{random.randint(140,146)}.0.{random.randint(6000,7680)} Mobile Safari/537.36 '
        f'MicroMessenger/{wv}(0x28004835) MMWEBSDK/20260404 MMWEBID/6067 '
        f'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android'
    )


def make_headers():
    """
    构建请求头（高度还原微信小程序真实环境，降低风控概率）。

    防封号关键：
      - User-Agent 随机化（真实设备 + 微信版本轮换）
      - Referer 必须匹配目标小程序 APPID
      - xweb_xhr、Sec-Fetch-* 为 WebView XHR 特征头
      - Accept / Accept-Encoding / Connection 补全真实浏览器字段
    """
    return {
        'User-Agent':        random_ua(),
        'Content-Type':      'application/json',
        'Accept':            'application/json, text/plain, */*',
        'Accept-Encoding':   'gzip, deflate, br',
        'Accept-Language':   'zh-CN,zh;q=0.9',
        'Connection':        'keep-alive',
        'xweb_xhr':          '1',
        'Sec-Fetch-Site':    'cross-site',
        'Sec-Fetch-Mode':    'cors',
        'Sec-Fetch-Dest':    'empty',
        'Referer':           f'https://servicewechat.com/{APPID}/127/page-frame.html',
        'Origin':            f'https://servicewechat.com',
    }


# ============ WCS 控制台客户端 ============

class WCSClient:
    """WCS 控制台客户端（与乐购脚本一致的实现）"""

    def __init__(self):
        self.base = WCS_BASE.rstrip('/')
        self.auth = WCS_AUTH

    def _get(self, path, timeout=30):
        r = requests.get(f'{self.base}{path}',
                         headers={'AUTH': self.auth}, timeout=timeout)
        return r.json()

    def _post(self, path, data, timeout=60):
        r = requests.post(f'{self.base}{path}', json=data,
                          headers={'AUTH': self.auth,
                                   'Content-Type': 'application/json'},
                          timeout=timeout)
        return r.json()

    def get_accounts(self):
        result = self._get('/api/accounts')
        if result and result.get('status'):
            return result.get('data', {}).get('items', [])
        return None

    def get_code(self, openid, user_key=None):
        """通过 WCS 对蓝医保小程序执行 wx.login() 获取 code"""
        body = {
            'appid':   APPID,
            'userKey': user_key or openid,
            'openid':  openid,
        }
        data = self._post('/wx/code', body)
        if data and data.get('status') and data.get('data', {}).get('code'):
            return data['data']['code']
        log.warning(f'[WCS] /wx/code 返回: {data}')
        return None


# ============ Token 缓存（防封号：减少 wx.login 调用频率）============

_TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  '.tpy_lyb_token_cache.json')
# 蓝医保 token 有效期未知，保守设 8 小时
_TOKEN_TTL = 8 * 3600


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
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def _get_cached_token(openid):
    """读取未过期的 token，返回 dict 或 None"""
    cache = _load_token_cache()
    entry = cache.get(openid)
    if not entry:
        return None
    if time.time() - entry.get('ts', 0) > _TOKEN_TTL:
        del cache[openid]
        _save_token_cache(cache)
        log.info(f'[TokenCache] token 已过期，将重新登录 ({openid[:15]}...)')
        return None
    age_h = (time.time() - entry['ts']) / 3600
    log.info(f'[TokenCache] 命中缓存 (已使用 {age_h:.1f}h, TTL={_TOKEN_TTL//3600}h) '
             f'openid={openid[:15]}...')
    return entry.get('data')


def _set_cached_token(openid, token_data):
    """写入 token 缓存"""
    cache = _load_token_cache()
    cache[openid] = {'data': token_data, 'ts': time.time()}
    _save_token_cache(cache)
    log.info(f'[TokenCache] token 已缓存 openid={openid[:15]}...')


def _invalidate_token(openid):
    """主动使 token 失效（业务接口鉴权失败时调用）"""
    cache = _load_token_cache()
    if openid in cache:
        del cache[openid]
        _save_token_cache(cache)
        log.info(f'[TokenCache] 已清除失效 token ({openid[:15]}...)')


def login_via_wcs(openid, user_key=None):
    """
    通过 WCS 控制台自动登录，返回蓝医保 token 信息。
    优先读取缓存（防封号：减少 wx.login 调用次数）。

    流程:
        1. 读 token 缓存 → 命中且未过期 → 直接返回
        2. POST /wx/code          -> 获取小程序 wx.login code
        3. POST /login/wx-session -> 用 code 换 token（C 模式：token 在响应头！）
        4. 写入 token 缓存

    返回:
        dict: {'token', 'openid', 'unionid'} 或 None
    """
    # 优先读缓存
    cached = _get_cached_token(openid)
    if cached:
        return cached

    wcs = WCSClient()

    # Step 1: 通过 WCS 获取 wx.login code
    log.info('[WCS] 获取蓝医保 loginCode...')
    for attempt in range(3):
        login_code = wcs.get_code(openid, user_key or openid)
        if login_code:
            break
        log.warning(f'[WCS] code 获取失败，重试 ({attempt+1}/3)...')
        time.sleep(3)

    if not login_code:
        log.error(f'[WCS] loginCode 获取失败，已重试3次 (openid={openid[:15]}...)')
        return None

    log.info(f'[WCS] loginCode 长度: {len(login_code)}')

    # Step 2: 用 code 换 token（关键：蓝医保的 token 在 HTTP 响应头中！）
    time.sleep(random.uniform(0.5, 1.5))
    url = f'{API_BASE}/login/wx-session'

    for attempt in range(3):
        try:
            resp = requests.post(
                url,
                json={'code': login_code},
                headers=make_headers(),
                timeout=15,
            )
            data = resp.json()

            if data.get('code') != 0:
                log.error(f'[Login] 登录接口返回错误: code={data.get("code")} msg={data.get("msg")}'
                          f' (openid={openid[:15]}...)')
                return None

            # C 模式：token/openid/unionid 在 HTTP 响应头中
            token   = resp.headers.get('lyb-m-token',   '')
            openid  = resp.headers.get('lyb-m-openid',  '')
            unionid = resp.headers.get('lyb-m-unionid', '')

            if not token:
                # 检查是否有 lyb-m-openid 但无 token → 可能是未注册蓝医保
                h_openid = resp.headers.get('lyb-m-openid', '')
                if h_openid:
                    log.warning(f'[Login] 该微信账号未注册蓝医保，请先在蓝医保小程序完成注册'
                                f' (openid={h_openid[:15]}...)')
                else:
                    log.error('[Login] 响应头缺少 lyb-m-token')
                    log.error(f'[Login] 响应头 keys: {list(resp.headers.keys())[:15]}')
                return None

            log.info(f'[Login] 成功! openid={openid[:15]}...')
            token_info = {'token': token, 'openid': openid, 'unionid': unionid}
            _set_cached_token(openid, token_info)
            return token_info

        except requests.exceptions.RequestException as e:
            log.error(f'[Login] 网络错误 (attempt {attempt+1}/3): {e}')
            if attempt < 2:
                time.sleep(2)

    return None


# ============ 蓝医保业务客户端 ============

class LybClient:
    """蓝医保 API 客户端"""

    def __init__(self, token, openid, unionid='', remark=''):
        self.token   = token
        self.openid  = openid
        self.unionid = unionid
        self.remark  = remark
        self.rs      = requests.Session()
        self.total_score = 0

    def _auth_headers(self):
        """业务请求头（lyb-m-* 认证）"""
        return {
            'lyb-m-openid':  self.openid,
            'lyb-m-token':   self.token,
            'lyb-m-unionid': self.unionid,
        }

    def _post(self, path, data=None, timeout=15):
        """发送业务 POST 请求，自动检测 token 失效并清缓存"""
        url = f'{API_BASE}{path}'
        headers = make_headers()
        headers.update(self._auth_headers())

        for attempt in range(3):
            try:
                resp = self.rs.post(url, json=(data or {}), headers=headers,
                                    timeout=timeout)
                # 鉴权失败时清缓存（下次 login_via_wcs 会重新登录）
                if resp.status_code in (401, 403):
                    log.warning(f'[{self.remark}] HTTP {resp.status_code}，清除 token 缓存')
                    _invalidate_token(self.openid)
                result = resp.json()
                # 业务层 token 失效判断（code=401 / msg含"登录"/"token"等）
                if isinstance(result, dict):
                    msg = result.get('msg', '') or ''
                    if result.get('code') in (401, 40001) or any(
                        kw in msg for kw in ('登录', 'token', 'Token', '失效', '过期', '未授权')
                    ):
                        log.warning(f'[{self.remark}] 业务层 token 失效: {msg}，清除缓存')
                        _invalidate_token(self.openid)
                return result
            except requests.exceptions.RequestException as e:
                log.error(f'[{self.remark}] 网络错误 (attempt {attempt+1}/3): {e}')
                if attempt < 2:
                    time.sleep(2)
        return None

    # ---- 业务接口 ----

    def sign_in(self):
        """签到打卡"""
        return self._post('/healthScore/upgrade/zqdk/dk-V1', {'taskCode': 'ZQDK'})

    def get_question(self):
        """获取健康问题"""
        return self._post('/healthScore/upgrade/jkwd/getQuestion-V1', {'taskCode': 'JKWD'})

    def submit_answer(self, question_id, option=None):
        """提交答案（可指定选项，默认随机）"""
        option = option or random.choice(['A', 'B'])
        log.info(f'[{self.remark}] 选择答案: {option}')
        return self._post('/healthScore/upgrade/jkwd/getQuestionAnswer-V1', {
            'questionId':   question_id,
            'selectValue':  option,
        })

    def revive(self, answer_id):
        """分享复活"""
        return self._post('/healthScore/upgrade/jkwd/revive-V1',
                          {'answerId': answer_id})

    def query_score(self):
        """查询健康分"""
        return self._post('/healthScore/getScore-V1')


# ============ 业务逻辑 ============

def run_sign_in(client):
    """执行签到打卡"""
    try:
        resp = client.sign_in()
        if resp and resp.get('code') == 0:
            reward = resp.get('data', {}).get('taskReward', '0')
            log.info(f'[{client.remark}] 签到成功，健康分 +{reward}')
            return {'sign': 'ok', 'reward': reward}
        else:
            msg = resp.get('msg', '未知') if resp else '无响应'
            log.info(f'[{client.remark}] 签到: {msg}')
            return {'sign': 'fail', 'msg': msg}
    except Exception as e:
        log.error(f'[{client.remark}] 签到异常: {e}')
        return {'sign': 'error', 'msg': str(e)}


def run_health_question(client, max_retries=2):
    """
    执行健康问答（AI 答题 + 答错复活逻辑）。

    流程:
        getQuestion -> pick_answer(历史/AI/随机) -> submit_answer
        -> 答对完成
        -> 答错: 从响应获取正确答案 -> revive -> 用正确答案重试
        -> 已答过("非法操作"): 跳过
    """
    log.info(f'[{client.remark}] 开始健康问答...')

    learned_answer = None  # 上一轮答错后学到的正确答案

    for attempt in range(max_retries):
        try:
            # 1) 获取问题
            q = client.get_question()
            time.sleep(1)
            if not q or q.get('code') != 0:
                msg = q.get('msg', '失败') if q else '无响应'
                log.info(f'[{client.remark}] 获取问题: {msg}')
                return {'question': 'fail', 'msg': msg}

            q_data = q['data']
            qid = q_data['questionId']
            q_text = q_data.get('questionText', '')
            options = q_data.get('options', [])

            log.info(f'[{client.remark}] Q: {q_text}')
            log.info(f'[{client.remark}] A:{options[0].get("optionValue","?") if len(options)>0 else "?"}  '
                     f'B:{options[1].get("optionValue","?") if len(options)>1 else "?"}')

            # 2) 定答案：优先用上一轮学到的正确答案，其次 pick_answer
            if learned_answer:
                choice, source = learned_answer, 'learned'
                log.info(f'[{client.remark}] 用上一轮正确答案: {choice}')
                learned_answer = None  # 只用一次
            else:
                choice, source = pick_answer(q_text, options, q_data)

            # 3) 提交答案
            a = client.submit_answer(qid, option=choice)
            time.sleep(1)

            # 处理已答过的情况
            if not a or a.get('code') != 0:
                msg = a.get('msg', '失败') if a else '无响应'
                if '非法操作' in msg or '已答' in msg:
                    log.info(f'[{client.remark}] 今日已答过，跳过')
                    return {'question': 'already_done'}
                log.info(f'[{client.remark}] 提交答案: {msg}')
                return {'question': 'fail', 'msg': msg}

            # 4) 判断结果
            a_data = a['data']
            is_correct = a_data.get('historyAnswerResult', 'N')
            correct_ans = a_data.get('answerResultDesc', '')

            if is_correct == 'Y':
                log.info(f'[{client.remark}] 回答正确 (来源: {source})，健康分 +1')
                return {'question': 'correct', 'source': source}

            # 5) 答错了
            log.warning(f'[{client.remark}] 回答错误 (来源: {source})，正确答案: {correct_ans}'
                        f' — {a_data.get("explain", "")[:30]}')

            # 从响应中学到正确答案，下次复活后用
            if correct_ans in ('A', 'B'):
                learned_answer = correct_ans

            answer_id = a_data.get('answerId')
            if not answer_id:
                log.warning(f'[{client.remark}] 无 answerId，无法复活')
                return {'question': 'wrong', 'source': source}

            # 检查是否允许复活
            if not a_data.get('showReviveButton'):
                log.warning(f'[{client.remark}] 已无复活机会')
                return {'question': 'revive_fail', 'source': source}

            # 复活
            r = client.revive(answer_id)
            time.sleep(1)
            if r and r.get('code') == 0 and r['data'].get('reviveResult') == 'Y':
                log.info(f'[{client.remark}] 分享复活成功，继续答题...')
                continue
            else:
                log.warning(f'[{client.remark}] 复活失败')
                return {'question': 'revive_fail', 'source': source}

        except Exception as e:
            log.error(f'[{client.remark}] 健康问答异常: {e}')
            return {'question': 'error', 'msg': str(e)}

    log.info(f'[{client.remark}] 已达最大重试次数')
    return {'question': 'max_retries'}


def run_query_score(client):
    """查询健康分"""
    try:
        resp = client.query_score()
        time.sleep(1)
        if resp and resp.get('code') == 0:
            score = resp.get('data', {}).get('score', '?')
            log.info(f'[{client.remark}] 当前健康分: {score}')
            return {'score': str(score)}
        else:
            msg = resp.get('msg', '失败') if resp else '无响应'
            log.info(f'[{client.remark}] 查询: {msg}')
            return {'score': 'fail', 'msg': msg}
    except Exception as e:
        log.error(f'[{client.remark}] 查询异常: {e}')
        return {'score': 'error', 'msg': str(e)}


def run_one_account(client):
    """处理一个账号的完整流程: 签到 -> 问答 -> 查分"""
    results = {'remark': client.remark}
    results.update(run_sign_in(client))
    time.sleep(1)
    results.update(run_health_question(client))
    time.sleep(1)
    results.update(run_query_score(client))
    return results


# ============ 账号解析 ============

def parse_account(raw_line):
    """解析单行账号: 备注#openid#token#unionid"""
    parts = raw_line.strip().split('#')
    if len(parts) < 3:
        raise ValueError(f'账号格式错误（应为 备注#openid#token#unionid）: {raw_line[:50]}')
    return {
        'remark':  parts[0].strip(),
        'openid':  parts[1].strip(),
        'token':   parts[2].strip(),
        'unionid': parts[3].strip() if len(parts) >= 4 else '',
    }


def load_manual_accounts():
    """从 tpylyb 环境变量/缓存加载手动 token 账号"""
    raw = os.environ.get('tpylyb', '') or _config.get('tpylyb', '')
    if not raw:
        return []
    return [parse_account(l) for l in raw.strip().split('\n') if l.strip()]




# ============ 主入口 ============

def main():
    # 心跳（与原 Node 版一致）
    try:
        requests.get('http://yu.lihailong.top:38000/file.txt',
                     timeout=5)
    except Exception:
        pass

    log.info('=' * 50)
    log.info('  太平洋蓝医保 - 每日签到 & 健康问答')
    log.info(f'  执行时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')

    results = []
    manual_accounts = load_manual_accounts()

    if manual_accounts:
        # ---- 方式1: 手动 token 模式 ----
        log.info(f'  模式: 手动 token ({len(manual_accounts)} 个账号)')
        log.info('=' * 50)
        for i, a in enumerate(manual_accounts, 1):
            log.info(f'\n------ 账号 {i}/{len(manual_accounts)}: {a["remark"]} ------')
            client = LybClient(a['token'], a['openid'], a.get('unionid', ''),
                               a['remark'])
            result = run_one_account(client)
            results.append(result)
            if i < len(manual_accounts):
                time.sleep(2)

    elif WCS_AUTH:
        # ---- 方式2: WCS 自动登录模式 ----
        log.info('  模式: WCS 自动登录')
        log.info('=' * 50)

        wcs = WCSClient()
        accounts = wcs.get_accounts()

        if not accounts:
            log.error('WCS 未发现微信账号，请检查控制台')
            log.info('提示: set wx_auth=your-apikey')
            sys.exit(1)

        log.info(f'WCS 发现 {len(accounts)} 个微信账号')

        active = [a for a in accounts if not a.get('disabled', False)]
        for idx, acc in enumerate(active):
            openid   = acc.get('openid', '') or acc.get('userKey', '')
            user_key = acc.get('userKey', openid)
            display  = acc.get('displayName', '') or openid[:12]
            remark   = f'{display}(#{idx+1})'

            log.info(f'\n------ {remark} ------')

            # 登录
            login_info = login_via_wcs(openid, user_key)
            if not login_info:
                log.error(f'{remark} 登录失败，跳过')
                results.append({'remark': remark,
                                'sign': 'error', 'question': 'error',
                                'score': 'error'})
                continue

            # 执行业务
            client = LybClient(login_info['token'], login_info['openid'],
                               login_info.get('unionid', ''), remark)
            result = run_one_account(client)
            results.append(result)

            if idx < len(active) - 1:
                time.sleep(random.uniform(2, 5))

        # TODO: 标记为手动方式1/todo
    else:
        # ---- 无配置 ----
        log.error('未提供认证信息! 请选择以下方式之一:')
        print(r'''
╔══════════════════════════════════════════╗
║     太平洋蓝医保 - 配置说明              ║
╠══════════════════════════════════════════╣
║                                          ║
║  方式一: 手动提供 Token (降级)            ║
║    set tpylyb=备注#openid#token#unionid   ║
║                                          ║
║  方式二: WCS 控制台自动登录 (推荐)        ║
║    set wx_server_url=http://127.0.0.1:8787║
║    set wx_auth=你的AUTH_KEY               ║
║    (首次设置后自动缓存，后续无需重复)      ║
║                                          ║
║  健康问答已内置阿里云百炼 AI，开箱即用     ║
║                                          ║
╚══════════════════════════════════════════╝
''')
        sys.exit(1)

    # ---- 汇总 ----
    log.info('')
    log.info('=' * 50)
    log.info('  执行汇总')
    log.info('=' * 50)
    for r in results:
        log.info(f'  [{r["remark"]}] '
                 f'签到: {r.get("sign","?")} | '
                 f'问答: {r.get("question","?")} | '
                 f'健康分: {r.get("score","?")}')
    log.info('')
    log.info('  所有账号处理完成')


if __name__ == '__main__':
    main()