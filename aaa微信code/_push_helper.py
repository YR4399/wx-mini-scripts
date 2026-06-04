# ========== 推送通知模块 ==========
import sys
import os
import requests

# PushPlus Token
PLUSPLUS_TOKEN = os.getenv('PLUSPLUS_TOKEN', '')

def push_notify(title, content):
    """发送推送通知"""
    # 尝试使用呆呆面板 notify 模块
    try:
        from notify import send as _send_notify
        _send_notify(title, content)
        print(f'✅ 推送成功: {title}')
        return True
    except ImportError:
        pass
    except Exception as e:
        print(f'⚠️ notify 推送失败: {e}')
    
    # 尝试使用 PushPlus
    if PLUSPLUS_TOKEN:
        try:
            # 清除代理
            env = os.environ.copy()
            for k in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
                env.pop(k, None)
            
            resp = requests.post('https://www.pushplus.plus/send', json={
                'token': PLUSPLUS_TOKEN,
                'title': title,
                'content': content,
                'template': 'txt'
            }, timeout=10, proxies={'http': None, 'https': None})
            result = resp.json()
            if result.get('code') == 200:
                print(f'✅ PushPlus推送成功: {title}')
                return True
            else:
                print(f'❌ PushPlus推送失败: {result.get("msg", "未知错误")}')
                return False
        except Exception as e:
            print(f'❌ PushPlus推送异常: {e}')
            return False
    
    print('⚠️ 未配置推送，跳过')
    return False
# ========== 推送通知模块结束 ==========
