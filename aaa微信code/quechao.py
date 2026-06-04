#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
雀巢会员自动签到 + 任务 + 抽奖 脚本 V2.0
对接本地 wechatserver (127.0.0.1:8787)
合并自：雀巢多任务.js（大大鸣版）
"""

import json
import sys
import ssl
import http.client
import random
import time
import os

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


# ==================== 配置区域（从环境变量读取） ====================
_ws_url = os.environ.get('wx_server_url', 'http://127.0.0.1:8787')
WS_AUTH = os.environ.get('wx_auth', '')

# 解析地址
if '://' in _ws_url:
    _parts = _ws_url.split('://', 1)
    WS_SCHEME = _parts[0]
    _host_port = _parts[1]
else:
    WS_SCHEME = 'http'
    _host_port = _ws_url

if ':' in _host_port:
    WS_HOST = _host_port.split(':')[0]
    WS_PORT = int(_host_port.split(':')[1])
else:
    WS_HOST = _host_port
    WS_PORT = 443 if WS_SCHEME == 'https' else 80

# 小程序 AppID（雀巢）
appid = 'wxc5db704249c9bb31'

# 用户的 OpenID（从环境变量读取，多账号用 # 分隔）
_openids_str = os.environ.get('wx_opinion') or os.environ.get('quechao', '')
_sep = '&' if '&' in _openids_str else '#'
openids = [x.strip() for x in _openids_str.split(_sep) if x.strip()]

# 活动频道标识，留空则不执行活动任务和抽奖
ACTIVITY_CHANNEL = 'NNXKC75FWQX5'
# =================================================

BASE_URL = 'crm.nestlechinese.com'
message_lines = []


def log(msg):
    print(msg)


def add_message(msg):
    global message_lines
    message_lines.append(msg)


def ws_post(path, payload):
    """调用本地 wechatserver API"""
    if WS_SCHEME == 'https':
        conn = http.client.HTTPSConnection(WS_HOST, WS_PORT, timeout=60, context=get_ssl_ctx())
    else:
        conn = http.client.HTTPConnection(WS_HOST, WS_PORT, timeout=60)
    headers = {'Content-Type': 'application/json', 'AUTH': WS_AUTH}
    try:
        conn.request('POST', path, body=json.dumps(payload), headers=headers)
        resp = conn.getresponse()
        data = json.loads(resp.read().decode())
        return data
    except Exception as e:
        return {'status': False, 'message': f'请求异常: {e}'}
    finally:
        conn.close()


def get_ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def nestle_request(method, path, access_token, payload=None):
    """调用雀巢 API"""
    conn = http.client.HTTPSConnection(BASE_URL, timeout=15, context=get_ssl_ctx())
    headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Content-Type': 'application/json',
        'displayversion': '0',
        'authorization': f'Bearer {access_token}',
        'referer': 'https://servicewechat.com/wxc5db704249c9bb31/489/page-frame.html'
    }
    body = json.dumps(payload) if payload else ('' if method == 'get' else '{}')
    conn.request(method.upper(), path, body=body, headers=headers)
    resp = conn.getresponse()
    result = json.loads(resp.read().decode())
    conn.close()
    return result


def random_wait(min_ms, max_ms):
    time.sleep(random.randint(min_ms, max_ms) / 1000)


# ==================== Token 获取 ====================

def get_auth_code(openid):
    """通过 wechatserver 获取微信授权码（带重试）"""
    for attempt in range(3):
        result = ws_post('/wx/code', {'appid': appid, 'openid': openid})
        if result.get('status') is True and result.get('data', {}).get('code'):
            code = result['data']['code']
            log(f'[信息] 获取授权码成功：{code}')
            return code
        log(f'[警告] 第{attempt + 1}次获取授权码失败：{result.get("message")}')
        if attempt < 2:
            log('[信息] 等待 5 秒后重试...')
            time.sleep(5)
    log('[错误] 获取授权码失败，已重试 3 次')
    return None


def get_nestle_token(auth_code):
    """使用授权码向雀巢身份服务换取 access_token"""
    conn = http.client.HTTPSConnection('crm.nestlechinese.com', timeout=15, context=get_ssl_ctx())
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    data = f'client_id=wechatMini&client_secret=secret&grant_type=wechat_auth_code&auth_code={auth_code}'
    conn.request('POST', '/openapi/identityservice/connect/token', body=data, headers=headers)
    token_data = json.loads(conn.getresponse().read().decode())
    conn.close()
    access_token = token_data.get('access_token')
    if access_token:
        log('[信息] 获取雀巢访问令牌成功')
        return access_token
    log(f'[错误] 获取令牌失败：{token_data}')
    return None


# ==================== 业务功能 ====================

def get_user_info(token):
    """获取用户信息"""
    try:
        data = nestle_request('get', '/openapi/member/api/User/GetUserInfo', token)
        if data.get('errcode') != 200:
            log(f'❌ 获取用户信息失败：{data.get("errmsg")}')
            return
        info = data.get('data', {})
        nickname = info.get('nickname', '')
        mobile = info.get('mobile', '')
        log(f'\n👤 用户信息：{nickname} ({mobile})')
        add_message(f'用户：{nickname}({mobile})')
    except Exception as e:
        log(f'❌ 获取用户信息异常：{e}')


def do_sign(token):
    """每日签到"""
    try:
        log(f'\n{"=" * 50}')
        log('📅 执行每日签到')
        log('=' * 50)

        data = nestle_request('post', '/openapi/activityservice/api/sign2025/sign', token,
                              {'rule_id': 1, 'goods_rule_id': 1})

        if data.get('errcode') == 200:
            d = data.get('data', {})
            log(f'\n✅ 签到成功！')
            log(f'  📆 连续签到：{d.get("sign_day")} 天')
            log(f'  💰 获得巢币：{d.get("sign_points")} 个')
            if d.get('goods_name'):
                log(f'  🎁 额外奖励：{d["goods_name"]}')
            add_message(f'签到：第{d.get("sign_day")}天，获得{d.get("sign_points")}巢币')
        else:
            errmsg = data.get('errmsg', '未知错误')
            if any(k in errmsg for k in ['已签到', '已经签到', '重复签到']):
                log('\nℹ️ 今日已签到')
                add_message('签到：今日已签到')
            else:
                log(f'\n⚠️ 签到失败：{errmsg}')
                add_message(f'签到：失败({errmsg})')
        log('=' * 50)
    except Exception as e:
        log(f'❌ 签到异常：{e}')


def check_task_finish(token, task_guid):
    """检查任务是否已完成"""
    try:
        data = nestle_request('post', '/openapi/activityservice/api/task/isfinish', token,
                              {'task_guid': task_guid})
        if data.get('errcode') == 200 and data.get('data') is True:
            return True
        return False
    except:
        return False


def do_task_direct(token, task_guid, progress_rule_id=1):
    """直接执行任务"""
    try:
        data = nestle_request('post', '/openapi/activityservice/api/task/add', token,
                              {'task_guid': task_guid, 'progress_rule_id': progress_rule_id})
        if data.get('errcode') in (200, 201):
            log(f'  ✅ 任务完成：{data.get("errmsg")}')
            return True
        else:
            log(f'  ⚠️ 任务失败：{data.get("errmsg")}')
            return False
    except Exception as e:
        log(f'  ❌ 任务异常：{e}')
        return False


def do_task(token, task_guid, progress_rule_id=1):
    """执行单个任务（先检查是否已完成）"""
    try:
        if check_task_finish(token, task_guid):
            log('  ℹ️ 任务已完成，跳过')
            return {'success': True, 'skipped': True}
        result = do_task_direct(token, task_guid, progress_rule_id)
        return {'success': result, 'skipped': False}
    except Exception as e:
        log(f'  ❌ 任务异常：{e}')
        return {'success': False, 'skipped': False}


def get_task_list(token):
    """获取并执行通用任务"""
    try:
        data = nestle_request('post', '/openapi/activityservice/api/task/getlist', token)
        if data.get('errcode') != 200:
            log(f'❌ 获取任务列表失败：{data.get("errmsg")}')
            return

        tasks = data.get('data', [])
        log(f'\n{"=" * 50}')
        log(f'📝 通用任务：获取到 {len(tasks)} 个任务')
        log('=' * 50)

        # 过滤可执行任务（跳过已完成的）
        executable = []
        for task in tasks:
            is_finished = check_task_finish(token, task.get('task_guid', ''))
            if is_finished:
                log(f'  ℹ️ 【{task.get("task_title")}】已完成，跳过')
            else:
                executable.append(task)

        if not executable:
            log('✅ 所有任务已完成！')
            add_message('通用任务：已全部完成')
            return

        log(f'\n待执行 {len(executable)} 个任务：')
        success = skip = fail = 0
        for i, task in enumerate(executable):
            log(f'\n[{i + 1}/{len(executable)}] 【{task.get("task_title")}】')
            result = do_task_direct(token, task.get('task_guid'))
            if result:
                success += 1
            else:
                fail += 1
            random_wait(2000, 2500)

        log(f'\n📊 通用任务完成：✅ {success}' + (f' | ⚠️ 失败 {fail}' if fail else ''))
        add_message(f'通用任务：完成{success}个' + (f'，失败{fail}个' if fail else ''))
    except Exception as e:
        log(f'❌ 获取任务列表异常：{e}')


def get_activity_task_list(token):
    """获取并执行活动任务"""
    if not ACTIVITY_CHANNEL:
        return
    try:
        data = nestle_request('post', '/openapi/activityservice/api/task/getlistbyshowchanneltype', token,
                              {'show_channel': ACTIVITY_CHANNEL, 'task_type': 1, 'gift_count': 0})
        if data.get('errcode') != 200:
            log(f'❌ 获取活动任务失败：{data.get("errmsg")}')
            return

        tasks = data.get('data', [])
        unfinished = [t for t in tasks if t.get('task_status') == 0]
        finished = len(tasks) - len(unfinished)

        log(f'\n{"=" * 50}')
        log(f'🎯 活动任务：共 {len(tasks)} 个，已完成 {finished}，待完成 {len(unfinished)}')
        log('=' * 50)

        if not unfinished:
            log('✅ 所有活动任务已完成！')
            add_message('活动任务：已全部完成')
            return

        success = skip = fail = 0
        for i, task in enumerate(unfinished):
            log(f'\n[{i + 1}/{len(unfinished)}] 【{task.get("task_title")}】')
            result = do_task(token, task.get('task_guid'))
            if result['skipped']:
                skip += 1
                random_wait(1000, 1500)
            elif result['success']:
                success += 1
                random_wait(2000, 2500)
            else:
                fail += 1
                random_wait(2000, 2500)

        log(f'\n📊 活动任务完成：✅ {success} | ℹ️ 跳过 {skip}' + (f' | ⚠️ 失败 {fail}' if fail else ''))
        add_message(f'活动任务：完成{success}个，跳过{skip}个')
    except Exception as e:
        log(f'❌ 获取活动任务异常：{e}')


def do_lucky_draw(token):
    """活动抽奖"""
    if not ACTIVITY_CHANNEL:
        return
    try:
        log(f'\n{"=" * 50}')
        log('🎰 开始活动抽奖')
        log('=' * 50)

        draw_count = 0
        total_coins = 0
        prizes = []

        for i in range(20):
            try:
                data = nestle_request('get',
                    f'/openapi/activityservice/api/LuckyDraw/LuckyDrawByPoints/{ACTIVITY_CHANNEL}', token)
                if data.get('errcode') == 200:
                    prize = {
                        'title': data.get('data', {}).get('title', '未知奖品'),
                        'goods_type': data.get('data', {}).get('goods_type', ''),
                        'value': data.get('data', {}).get('value', ''),
                    }
                    draw_count += 1
                    prizes.append(prize)
                    extra = f' ({prize["value"]}巢币)' if prize['goods_type'] == 'points' else ''
                    log(f'\n🎁 第{draw_count}次抽奖: {prize["title"]}{extra}')
                    if prize['goods_type'] == 'points':
                        total_coins += int(prize['value'] or 0)
                    random_wait(2000, 3000)
                else:
                    errmsg = data.get('errmsg', '')
                    if any(k in errmsg for k in ['次数', '不足', '用完']):
                        log('\nℹ️ 抽奖次数已用完')
                    else:
                        log(f'\n⚠️ 抽奖失败: {errmsg}')
                    break
            except Exception as e:
                log(f'\n⚠️ 抽奖异常: {e}')
                break

        if draw_count > 0:
            log(f'\n🎉 抽奖完成：共 {draw_count} 次')
            if total_coins > 0:
                log(f'💰 获得巢币：{total_coins} 个')
            log('🎁 奖品列表：')
            for idx, p in enumerate(prizes):
                log(f'  {idx + 1}. {p["title"]}' + (f' ({p["value"]})' if p['value'] else ''))
            add_message(f'抽奖：{draw_count}次，获得{total_coins}巢币')
        else:
            log('ℹ️ 暂无抽奖次数')
            add_message('抽奖：暂无次数')
        log('=' * 50)
    except Exception as e:
        log(f'❌ 抽奖异常：{e}')


def get_user_balance(token):
    """获取用户巢币余额"""
    try:
        data = nestle_request('post', '/openapi/pointsservice/api/Points/getuserbalance', token)
        if data.get('errcode') != 200:
            log(f'❌ 获取余额失败：{data.get("errmsg")}')
            return
        log(f'\n💰 当前巢币：{data.get("data")}')
        add_message(f'当前巢币：{data.get("data")}')
    except Exception as e:
        log(f'❌ 获取余额异常：{e}')


# ==================== 主流程 ====================

def run_account(openid):
    """执行单个账号的签到流程"""
    global message_lines
    message_lines = []

    log(f'\n{"=" * 50}')
    log(f'👤 账号：{openid[:15]}...')
    log('=' * 50)

    # 1. 获取微信授权码
    code = get_auth_code(openid)
    if not code:
        log('[终止] 获取授权码失败')
        return
    random_wait(1000, 2000)

    # 2. 换取雀巢令牌
    token = get_nestle_token(code)
    if not token:
        log('[终止] 获取令牌失败')
        return
    random_wait(1000, 2000)

    # 3. 获取用户信息
    get_user_info(token)
    random_wait(1000, 2000)

    # 4. 签到
    do_sign(token)
    random_wait(1000, 2000)

    # 5. 通用任务
    get_task_list(token)
    random_wait(1000, 2000)

    # 6. 活动任务
    get_activity_task_list(token)
    random_wait(1000, 2000)

    # 7. 抽奖
    do_lucky_draw(token)
    random_wait(1000, 2000)

    # 8. 查余额
    get_user_balance(token)

    # 汇总
    log(f'\n{"=" * 50}')
    log('📋 执行结果汇总：')
    log('=' * 50)
    for line in message_lines:
        log(line)


def main():
    log('=== 雀巢会员自动签到 V2.0 ===')
    if not openids:
        log('⚠️ 环境变量 quechao 未设置或为空，无法执行')
        return
    for idx, openid in enumerate(openids):
        log(f'\n\n========== 开始处理第 {idx+1}/{len(openids)} 个账号 ==========')
        run_account(openid)


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
            push_notify('quechao 签到结果', _logs[-2000:])
        except:
            pass



