# ========== 推送通知模块 (Python) ==========
import sys, os, json, urllib.request, ssl, builtins

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

PLUSPLUS_TOKEN = os.getenv('PLUSPLUS_TOKEN', '') or os.getenv('PUSH_PLUS_TOKEN', '')

_log_lines = []
_orig_print = builtins.print

def _log_print(*args, **kwargs):
    text = ' '.join(str(a) for a in args)
    _log_lines.append(text)
    _orig_print(*args, **kwargs)

# Monkey-patch print to capture output
builtins.print = _log_print


def push_notify(title, content=""):
    """发送推送通知 (兼容旧版)"""
    _do_push(title, content)


def send_push_notify(title, content=""):
    """发送推送通知 (新版)
    自动提取最近日志作为内容
    """
    if not content:
        keys = []
        for line in _log_lines[-40:]:
            s = str(line).strip()
            if s and len(s) > 3 and not s.startswith('===') and not s.startswith('---'):
                keys.append(s[-150:])
        content = '\n'.join(keys[-20:]) if keys else f'{title}执行完成'
    _do_push(title, content)


def _do_push(title, content):
    try:
        from notify import send as _send_notify
        _send_notify(title, content)
        _orig_print(f'✅ 推送成功: {title}')
        return True
    except ImportError:
        pass
    except Exception as e:
        _orig_print(f'⚠️ notify 推送失败: {e}')

    if PLUSPLUS_TOKEN:
        try:
            body = json.dumps({
                'token': PLUSPLUS_TOKEN, 'title': title,
                'content': content, 'template': 'txt'
            }).encode()
            req = urllib.request.Request('http://www.pushplus.plus/send', data=body, method='POST')
            req.add_header('Content-Type', 'application/json')
            resp = urllib.request.urlopen(req, timeout=15, context=CTX)
            result = json.loads(resp.read())
            if result.get('code') == 200:
                _orig_print(f'✅ PushPlus推送成功: {title}')
                return True
            _orig_print(f'❌ PushPlus推送失败: {result.get("msg", "未知")}')
        except Exception as e:
            _orig_print(f'❌ PushPlus推送异常: {e}')
        return False

    _orig_print('⚠️ 未配置推送，跳过')
    return False
# ========== 推送通知模块结束 ==========
