# ============================================================
# 统一走 std_report.py 的钉钉机器人(markdown 加签)。保留旧 API 兼容：
#   send_push(title, content) / send_push_notify(title, content)
# ============================================================
import os, sys


def send_push(title, content):
    """推送消息到钉钉（经 std_report 引擎）。"""
    try:
        from std_report import send_push as _ding_send
        return _ding_send(title, content)
    except Exception as e:
        print(f'[push] 钉钉推送失败: {e}')
        return False


def send_push_notify(title, content):
    """兼容别名：部分脚本仍按旧名导入，转发到 send_push。"""
    return send_push(title, content)


if __name__ == '__main__':
    title = sys.argv[1] if len(sys.argv) > 1 else '脚本执行'
    content = sys.argv[2] if len(sys.argv) > 2 else '执行完成'
    send_push(title, content)
