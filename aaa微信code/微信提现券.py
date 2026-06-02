#!/usr/bin/env python3
"""
wx_code_client - 微信 Code 获取客户端
完全模拟原 JavaScript 脚本的 WeChatServer 调用方式
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

import requests

# 默认配置
DEFAULT_APPID = "wxda948f3be0afc375"
DEFAULT_BASE_URLS = os.environ.get('wx_server_url', 'https://xxx')
AUTH_TOKEN = os.environ.get('wx_auth', '')

BRIDGE_TIMEOUT = 35
INIT_RETRIES = 2

# 启用调试模式可以看到更多信息
DEBUG = os.environ.get('DEBUG', '').lower() == 'true'


def debug_print_response(action: str, response: requests.Response) -> None:
    """调试打印响应信息"""
    print(f"[DEBUG] === {action} ===")
    print(f"[DEBUG] URL: {response.url}")
    print(f"[DEBUG] Status: {response.status_code}")
    print(f"[DEBUG] Headers: {dict(response.headers)}")
    print(f"[DEBUG] Response: {response.text[:1000]}")
    print(f"[DEBUG] === END ===\n")


def get_login_codes(
    appid: str,
    openid: str,
    code_count: int = 1,
    base_url: str = None,
    timeout: int = BRIDGE_TIMEOUT,
    init_retries: int = INIT_RETRIES,
) -> list[str]:
    """
    获取微信小程序登录 code
    完全模拟原脚本的 wechat.getCode(openid) 调用
    
    原 JS 调用：
    let { data: codeRes } = await wechat.getCode(this.wcsid)
    if (codeRes.status) {
        await this.getUserToken(codeRes.data.code)
    }
    """
    if not base_url:
        base_url = DEFAULT_BASE_URLS
    
    if not AUTH_TOKEN:
        raise RuntimeError("未设置 wx_auth 环境变量")
    
    codes = []
    
    for i in range(code_count):
        code = None
        for retry in range(init_retries):
            try:
                code = _fetch_code_single(base_url, appid, openid, timeout)
                if code:
                    codes.append(code)
                    if DEBUG:
                        print(f"[DEBUG] ✅ 成功获取第{i+1}个 Code: {code[:20]}...")
                    break
                else:
                    print(f"获取 Code 返回为空，重试 {retry+1}/{init_retries}")
            except Exception as e:
                print(f"获取 Code 异常，正在重试（{retry+1}/{init_retries}）：{e}")
                if DEBUG:
                    import traceback
                    traceback.print_exc()
        else:
            print(f"获取第{i+1}个 Code 失败，已重试{init_retries}次")
    
    if not codes:
        raise RuntimeError(f"未能获取到任何 Code，openid={openid}")
    
    return codes


def _fetch_code_single(base_url: str, appid: str, openid: str, timeout: int) -> str:
    """
    获取单个 code
    模拟原 WeChatServer 的请求方式
    """
    # 原脚本中的 WeChatServer 配置：
    # let wechat = new WeChatServer({
    #     url: process.env.wx_server_url || 'https://xxx',
    #     appid: 'wxda948f3be0afc375',
    #     auth: process.env.wx_auth || "",
    # });
    
    # 构建请求 URL - 通常是 /api/code 或 /api/getCode
    endpoints_to_try = [
        f"{base_url.rstrip('/')}/api/code",
        f"{base_url.rstrip('/')}/api/getCode",
        f"{base_url.rstrip('/')}/api/wechat/code",
        f"{base_url.rstrip('/')}/code",
    ]
    
    # 构建请求头
    headers = {
        "Authorization": AUTH_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    
    # 尝试不同的请求体格式
    payloads = [
        {"appid": appid, "openid": openid},
        {"appId": appid, "openId": openid},
        {"app_id": appid, "open_id": openid},
        {"appid": appid, "openid": openid, "type": "miniprogram"},
    ]
    
    last_response = None
    
    for endpoint in endpoints_to_try:
        for payload in payloads:
            try:
                if DEBUG:
                    print(f"[DEBUG] 尝试: POST {endpoint}")
                    print(f"[DEBUG] Body: {json.dumps(payload)}")
                
                response = requests.post(
                    endpoint,
                    json=payload,
                    headers=headers,
                    timeout=timeout
                )
                
                last_response = response
                
                if DEBUG:
                    debug_print_response(f"POST {endpoint}", response)
                
                if response.status_code == 200:
                    code = _parse_code_from_response(response.json(), openid)
                    if code:
                        return code
                    
            except requests.exceptions.Timeout:
                print(f"请求超时: {endpoint}")
                continue
            except requests.exceptions.ConnectionError as e:
                print(f"连接失败: {endpoint} - {e}")
                continue
            except Exception as e:
                if DEBUG:
                    print(f"请求异常: {endpoint} - {e}")
                continue
    
    # 如果所有尝试都失败，打印最后的响应信息
    if last_response is not None:
        print(f"最后一次请求状态码: {last_response.status_code}")
        print(f"最后一次响应内容: {last_response.text[:500]}")
    
    return None


def _parse_code_from_response(result: dict, openid: str) -> str | None:
    """
    解析返回的 code
    兼容多种返回格式，严格按照原脚本的解析逻辑
    
    原 JS 代码：
    let { data: codeRes } = await wechat.getCode(this.wcsid)
    if (codeRes.status) {
        await this.getUserToken(codeRes.data.code)
    }
    
    这意味着返回结构是:
    {
      data: {           <- axios 的 data 包装
        status: true,   <- codeRes.status
        data: {         <- codeRes.data
          code: "xxx"   <- 我们需要的 code
        }
      }
    }
    """
    if not isinstance(result, dict):
        return None
    
    if DEBUG:
        print(f"[DEBUG] 解析响应: {json.dumps(result, ensure_ascii=False, indent=2)[:500]}")
    
    # 路径1: result.data.status && result.data.data.code
    # 对应 axios 返回的 data 字段
    if 'data' in result:
        inner_data = result['data']
        if isinstance(inner_data, dict):
            # 检查是否有 status 和 data.code
            if inner_data.get('status'):
                code_data = inner_data.get('data')
                if isinstance(code_data, dict):
                    code = code_data.get('code')
                    if code and isinstance(code, str):
                        if DEBUG:
                            print(f"[DEBUG] ✅ 路径1解析成功: {code[:20]}...")
                        return code
    
    # 路径2: result.status && result.data.code
    # 直接在最外层
    if result.get('status'):
        code_data = result.get('data')
        if isinstance(code_data, dict):
            code = code_data.get('code')
            if code and isinstance(code, str):
                if DEBUG:
                    print(f"[DEBUG] ✅ 路径2解析成功: {code[:20]}...")
                return code
        elif isinstance(code_data, str):
            if DEBUG:
                print(f"[DEBUG] ✅ 路径2-2解析成功: {code_data[:20]}...")
            return code_data
    
    # 路径3: result.code 直接返回
    code = result.get('code')
    if code and isinstance(code, str) and len(code) > 10:
        if DEBUG:
            print(f"[DEBUG] ✅ 路径3解析成功: {code[:20]}...")
        return code
    
    # 路径4: result.data.code
    if 'data' in result:
        inner_data = result['data']
        if isinstance(inner_data, dict):
            code = inner_data.get('code')
            if code and isinstance(code, str):
                if DEBUG:
                    print(f"[DEBUG] ✅ 路径4解析成功: {code[:20]}...")
                return code
        elif isinstance(inner_data, str) and len(inner_data) > 10:
            if DEBUG:
                print(f"[DEBUG] ✅ 路径4-2解析成功: {inner_data[:20]}...")
            return inner_data
    
    # 路径5: 递归查找 code 字段
    code = _find_code_recursive(result)
    if code:
        if DEBUG:
            print(f"[DEBUG] ✅ 路径5解析成功: {code[:20]}...")
        return code
    
    return None


def _find_code_recursive(obj: Any, depth: int = 0) -> str | None:
    """递归查找 code 字段"""
    if depth > 5:  # 防止过深递归
        return None
    
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == 'code' and isinstance(value, str) and len(value) > 10:
                return value
            result = _find_code_recursive(value, depth + 1)
            if result:
                return result
    elif isinstance(obj, list):
        for item in obj:
            result = _find_code_recursive(item, depth + 1)
            if result:
                return result
    
    return None


def resolve_openids() -> list[str]:
    """
    从环境变量获取用户 OpenID 列表
    优先读取 guyu 变量，支持 & 分割
    """
    user_str = os.environ.get('wx_opinion', '') or os.environ.get('guyu', '')
    
    if not user_str:
        print("❌ 未找到用户配置，请设置 guyu 环境变量")
        return []
    
    # 支持 & 分割
    users = user_str.split('&')
    
    # 过滤空值并去空格
    return [u.strip() for u in users if u.strip()]


if __name__ == "__main__":
    # 测试代码
    print("🧪 测试 wx_code_client 模块")
    print(f"Server URL: {DEFAULT_BASE_URLS}")
    print(f"Auth: {AUTH_TOKEN[:10]}..." if AUTH_TOKEN else "Auth: 未设置")
    
    if not AUTH_TOKEN:
        print("\n❌ 请设置 wx_auth 环境变量")
        sys.exit(1)
    
    openids = resolve_openids()
    if not openids:
        print("\n❌ 请设置 guyu 环境变量")
        sys.exit(1)
    
    print(f"\n✅ 获取到 {len(openids)} 个账号")
    
    for i, openid in enumerate(openids, 1):
        try:
            print(f"\n{'='*50}")
            print(f"账号 {i}: {openid}")
            print(f"{'='*50}")
            
            codes = get_login_codes(DEFAULT_APPID, openid)
            
            if codes:
                print(f"✅ 成功获取 {len(codes)} 个 Code:")
                for j, code in enumerate(codes, 1):
                    print(f"  Code {j}: {code[:30]}...")
            else:
                print("❌ 未能获取到 Code")
                
        except Exception as e:
            print(f"❌ 错误: {e}")
            import traceback
            traceback.print_exc()