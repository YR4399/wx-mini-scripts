<div align="center">

<img src="banner.svg" width="100%" />

# ✨ 微信小程序自动化脚本合集 ✨

**「 每天自动签到，把时间留给二次元 」**

<br />

[![WeChat](https://img.shields.io/badge/WeChat-MiniProgram-07C160?style=for-the-badge&logo=wechat&logoColor=white)](https://github.com/YR4399/wx-mini-scripts)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://github.com/YR4399/wx-mini-scripts)
[![Docker](https://img.shields.io/badge/Docker-Container-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/YR4399/wx-mini-scripts)
[![MIT](https://img.shields.io/badge/License-MIT-FEE75C?style=for-the-badge)](https://github.com/YR4399/wx-mini-scripts/blob/main/LICENSE)

<br />

> 🌟 自动获取 `wx.login code` 实现微信小程序自动化  
> 🚀 签到 · 任务 · 抽奖 全自动  
> 🎯 基于 Docker 容器化部署

</div>

---

## 📜 脚本一览

<div align="center">

### 🎀 签到类

</div>

| 脚本 | 说明 | 更新 | 状态 |
|:-----|:-----|:----:|:----:|
| `angel_sign.py` | 安吉尔 · 每日签到 | 05-30 | ✨ |
| `袋鼠mama_sign.py` | 袋鼠妈妈 · 有赞签到 | 05-29 | ✨ |
| `haishibao_sign.py` | 孩视宝 · 有赞零售签到 | 05-29 | ✨ |
| `lj_sign.py` | 联家超市 · 每日签到 | 05-29 | ✨ |
| `monalisa_wechatserver.py` | 蒙娜丽莎 · 自动签到 | 05-29 | 🔧 |
| `小紫_sign.py` | 小紫有约 · 每日签到 | 05-30 | ✨ |
| `tpy_lyb.py` | 太平洋蓝医保 · 签到+问答 | 05-29 | ✨ |

<div align="center">

### 🎁 任务 & 抽奖类

</div>

| 脚本 | 说明 | 更新 | 状态 |
|:-----|:-----|:----:|:----:|
| `glico_sign.py` | 格力高 · 签到+抽奖+520活动 | 05-29 | ✨ |
| `quechao.py` | 雀巢 · 签到+任务+抽奖 | 05-29 | ✨ |
| `claim_daily_gift.py` | 微信支付 · 每日优惠券 | 05-29 | ✨ |
| `王老吉.py` | 王老吉 · 签到抽奖 | 05-29 | ✨ |
| `wps小程序.py` | WPS · 签到+浏览+抽奖 | 05-29 | ✨ |
| `ljg_ad_watcher.py` | 乐购 · 激励广告观看 | 05-30 | ⚠️ |

<div align="center">

### 🌸 综合自动化类

</div>

| 脚本 | 说明 | 更新 | 状态 |
|:-----|:-----|:----:|:----:|
| `jph.py` | 君品荟 · 签到+花园种植 | 05-30 | ✨ |
| `jph_runner.py` | 君品荟 · 轻量版(宿主机/容器) | 05-30 | ⚠️ |
| `mcyx_wechatserver.py` | 名创优品 · 登录+任务 | 05-29 | 🔧 |
| `xmyx_auto_wcs.py` | 星妈会/飞鹤 · 签到+浏览 | 05-30 | ✨ |
| `纷享荟小程序.py` | 纷享荟 · 积分任务 | 05-30 | ✨ |
| `牛牛短剧.py` | 牛牛短剧 · 登录+任务 | 05-29 | ✨ |
| `haitian_sign.py` | 海天美味馆 · 签到+抽奖 | 05-29 | 🔑 |

<div align="center">

### 🍼 伊利系列

</div>

| 脚本 | 说明 | 更新 | 状态 |
|:-----|:-----|:----:|:----:|
| `伊利qq星code5.24.py` | 伊利QQ星 · 全自动多账号 | 05-29 | ✨ |
| `zhenxi.py` | 伊利甄稀 · 免单券/会员券 | 05-29 | ✨ |
| `星韵多号并发稳定毛0.2一次.py` | 星韵 · 多号并发 | 05-29 | ✨ |
| `星韵每小时抽奖0.2配合主脚本运行.py` | 星韵 · 每小时抽奖 | 05-29 | ✨ |

<div align="center">

### 🏠 其他

</div>

| 脚本 | 说明 | 更新 | 状态 |
|:-----|:-----|:----:|:----:|
| `溪云严选.py` | 溪云严选 · 自动签到 | 05-29 | ✨ |
| `浓五的酒馆 (2).py` | 浓五的酒馆 · 签到 | 05-29 | ✨ |
| `赵钱孙李.py` | 赵钱孙李养老 · 自动签到 | 05-29 | ✨ |
| `wx_code_client.py` | 微信Code获取 · 公共模块 | 05-29 | 🔩 |

<br />

<div align="center">

| 标记 | 含义 |
|:----:|:-----|
| ✨ | 运行正常 |
| ⚠️ | 需要调试 |
| 🔧 | 待适配 |
| 🔑 | 需手动Token |
| 🔩 | 工具模块 |

</div>

---

## 🛠️ 快速开始

```
  ① 克隆仓库          ② 配置环境变量         ③ 添加定时任务
┌─────────────┐    ┌─────────────────┐    ┌──────────────────┐
│ git clone    │ →  │ wx_server_url   │ →  │ python code/x.py │
│ 本仓库       │    │ wx_auth         │    │ crontab / 任务调度│
│              │    │ wx_opinion      │    │                  │
└─────────────┘    └─────────────────┘    └──────────────────┘
```

### 环境变量

| 变量 | 说明 | 示例 |
|:-----|:-----|:-----|
| `wx_server_url` | 微信服务地址 | `http://your-server:8787` |
| `wx_auth` | API Key | `your_api_key` |
| `wx_opinion` | openid 列表 (`&` 分隔) | `owNAX6...&owNAX6...` |

---

## 📁 项目结构

```
wx-mini-scripts/
├── 📄 README.md            ← 你正在看的这个
├── 🚫 .gitignore
└── 📂 code/
    ├── 🎀 angel_sign.py
    ├── 🎀 袋鼠mama_sign.py
    ├── 🎁 glico_sign.py
    ├── 🎁 quechao.py
    ├── 🌸 jph.py
    ├── 🌸 纷享荟小程序.py
    ├── 🍼 伊利qq星code5.24.py
    ├── 🍼 zhenxi.py
    ├── 🏠 溪云严选.py
    ├── 🏠 赵钱孙李.py
    └── ... (共 28 个脚本)
```

---

<div align="center">

## 💖 致谢

感谢所有开源贡献者

<br />

**「 今天的签到，就交给小助手吧～ 」**

<img src="https://media.tenor.com/images/f0c8b7a3c0b3a5b3c0b3a5b3c0b3a5b3/tenor.gif" width="200" />

<br />

![Visitors](https://komarev.com/ghpvc/?username=YR4399&label=Visitors&color=ff69b4&style=flat-square)

</div>
