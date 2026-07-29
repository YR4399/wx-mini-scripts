"""实时日志 + 推送捕获，解决 StringIO 阻塞问题"""
import sys, io

class TeeOutput:
    def __init__(self):
        self.buffer = io.StringIO()
        self.original = sys.stdout
    def write(self, data):
        self.original.write(data)
        self.original.flush()
        self.buffer.write(data)
    def flush(self):
        self.original.flush()
    def getvalue(self):
        return self.buffer.getvalue()

def enable():
    """用 Tee 替换 sys.stdout/stderr，同时保持实时输出和日志捕获"""
    tee_out = TeeOutput()
    tee_err = TeeOutput()
    tee_err.original = sys.stderr
    sys.stdout = tee_out
    sys.stderr = tee_err
    return tee_out, tee_err
