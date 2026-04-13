# ClawMeeting - 多平台会议调度器

![Version](https://img.shields.io/badge/版本-2.0-blue)
![Platform](https://img.shields.io/badge/平台-飞书%20%7C%20Slack-green)
![License](https://img.shields.io/badge/许可证-私有-red)
![Tools](https://img.shields.io/badge/工具-7-orange)
![Status](https://img.shields.io/badge/状态-生产就绪-brightgreen)

[English](./README.md) | **简体中文** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md)

---

## 概述

ClawMeeting 是基于 OpenClaw 的 AI 驱动会议调度系统。它通过三阶段协商协议在飞书和 Slack 之间协调多参与者会议，具备智能时间段评分、自动委派和防抖控制的后台轮询功能。

提供两个生产版本：**插件版 (v1.0)** 使用 CommonJS 模块和共享库，**技能版 (v2.0)** 使用 ESM 模块、自包含代码和文件持久化。

---

## 系统架构

```mermaid
graph TD
    A(用户请求) --> B(OpenClaw 运行时)
    B --> C{ctx.messageChannel}
    C -->|feishu| D(飞书服务商)
    C -->|slack| E(Slack 服务商)
    D --> F(日历 API)
    E --> F
    F --> G(调度器 - 时间段查找与评分)
    G --> H(状态机 - 三阶段协商)
    H --> I(会议已确认)
```

---

## 插件版 (v1.0)

插件版是经过生产验证的原始实现。它使用 CommonJS 模块系统，依赖 `claw-meeting-shared` npm 包提供核心调度逻辑。状态仅保存在内存中，重启后丢失。

### 插件版数据流

```mermaid
graph LR
    A(插件入口 - index.ts) --> B(claw-meeting-shared)
    B --> C(plugin-core.ts - 7 个工具)
    C --> D{平台路由器}
    D -->|feishu| E(飞书服务商)
    D -->|slack| F(Slack 服务商)
    C --> G(内存状态 Map)
    C --> H(调度器 - 评分与排序)
```

---

## 技能版 (v2.0)

技能版是使用 ESM 模块的重新实现。所有代码自包含，无外部共享库依赖。状态持久化到 `pending/*.json` 文件中，重启后仍可恢复。包含 `SKILL.md` 以便用户友好安装。

### 技能版数据流

```mermaid
graph LR
    A(技能入口 - index.ts) --> B(plugin-core.ts - 7 个工具)
    B --> C{平台路由器}
    C -->|feishu| D(飞书服务商)
    C -->|slack| E(Slack 服务商)
    B --> F(MeetingStore)
    F --> G(内存 Map)
    F --> H(pending/*.json 文件)
    B --> I(调度器 - 评分与排序)
```

---

## 会议生命周期

```mermaid
stateDiagram-v2
    [*] --> 收集中: create_meeting
    收集中 --> 收集中: add_participants
    收集中 --> 评分中: find_slots
    评分中 --> 评分中: score_slots
    评分中 --> 确认中: confirm_meeting_slot
    确认中 --> [*]: 会议已预订
    收集中 --> [*]: cancel_meeting
    评分中 --> [*]: cancel_meeting
```

---

## 参会者响应流程

```mermaid
graph TD
    A(发送可用时间请求) --> B(等待响应)
    B --> C{全部已响应?}
    C -->|是| D(汇总可用时间)
    C -->|否| E{超时?}
    E -->|否| B
    E -->|是| F(使用部分数据继续)
    D --> G(评分与排序时间段)
    F --> G
    G --> H(展示最佳时间段)
```

---

## 后台进程

```mermaid
graph TD
    A(定时器 - 周期轮询) --> B{有活跃会议?}
    B -->|是| C(检查待处理响应)
    C --> D{防抖窗口已过?}
    D -->|是| E(处理更新)
    D -->|否| F(跳过 - 等待)
    B -->|否| G(空闲)
    E --> H(更新状态)
    H --> I(通知参与者)
```

---

## 工具列表

| # | 工具 | 描述 |
|---|------|------|
| 1 | `create_meeting` | 初始化新的会议协商会话 |
| 2 | `add_participants` | 向现有会议添加参会者 |
| 3 | `find_slots` | 查询日历可用性并查找空闲时间段 |
| 4 | `score_slots` | 按参与者偏好重叠度排序候选时间段 |
| 5 | `confirm_meeting_slot` | 锁定选定时间段并发送邀请 |
| 6 | `cancel_meeting` | 中止会议协商并清理状态 |
| 7 | `get_meeting_status` | 获取会议的当前状态和进度 |

---

## 文件结构

```
plugin_version/
├── src/
│   ├── index.ts              入口文件 (平台配置)
│   ├── plugin-core.ts        核心逻辑 (7 个工具, 路由, 状态机)
│   ├── scheduler.ts          时间段查找 + 评分
│   ├── load-env.ts           .env 加载器
│   └── providers/
│       ├── types.ts           CalendarProvider 接口
│       ├── lark.ts            飞书后端
│       └── slack.ts           Slack 后端

skill_version/
├── SKILL.md                   LLM 指令文件
├── src/
│   ├── index.ts              入口文件 (平台配置)
│   ├── plugin-core.ts        核心逻辑 (7 个工具, 路由, 状态机)
│   ├── meeting-store.ts      持久化状态层
│   ├── scheduler.ts          时间段查找 + 评分
│   ├── load-env.ts           .env 加载器 (ESM)
│   └── providers/
│       ├── types.ts           CalendarProvider 接口
│       ├── lark.ts            飞书后端
│       └── slack.ts           Slack 后端
├── pending/                   运行时会议状态
```

---

## 快速开始

### 插件版 (v1.0)

```bash
cd plugin_version
npm install
npm run build
openclaw plugins install ./
```

### 技能版 (v2.0)

```bash
cd skill_version
npm install
npm run build
openclaw skills add ./
```

---

## 配置

两个版本都需要通过环境变量提供平台凭据：

```env
# 飞书 / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx
SLACK_SIGNING_SECRET=xxxxx
```

将 `.env` 文件放置在对应版本目录中，或在 shell 环境中设置变量。

---

## 版本对比

| 维度 | 插件版 (v1.0) | 技能版 (v2.0) |
|---|---|---|
| 模块系统 | CommonJS | ESM (Node16) |
| 依赖方式 | claw-meeting-shared 包 | 自包含 |
| 工具数量 | 7 | 7 |
| 平台支持 | 飞书 + Slack | 飞书 + Slack |
| 平台路由 | ctx.messageChannel | ctx.messageChannel |
| 状态存储 | 内存 Map | 内存 + 文件持久化 |
| 重启恢复 | 状态丢失 | 状态保留 |
| 协商模式 | 三阶段 | 三阶段 |
| 评分功能 | 支持 | 支持 |
| 委派功能 | 支持 | 支持 |
| 安装方式 | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | 无 | 有 |

---

## 许可证

私有 - 保留所有权利。
