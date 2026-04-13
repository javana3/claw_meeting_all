[English](./README.md) | **中文**

<div align="center">

# OpenClaw 会议调度器

**OpenClaw 多平台 AI 会议调度插件**

在飞书和 Slack 中通过自然语言安排会议。
插件自动按平台路由，解析参会人姓名，通过私信收集可用时间，智能评分排序时段，自动创建日历事件。

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%E6%8F%92%E4%BB%B6%20%2B%20%E6%8A%80%E8%83%BD-FF6B35)
![飞书](https://img.shields.io/badge/%E9%A3%9E%E4%B9%A6-%E5%B7%B2%E6%94%AF%E6%8C%81-00D09C?logo=bytedance&logoColor=white)
![Slack](https://img.shields.io/badge/Slack-%E5%B7%B2%E6%94%AF%E6%8C%81-4A154B?logo=slack&logoColor=white)
![许可证](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-%E7%A7%81%E6%9C%89-red)
![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-2.0.0-blue)

</div>

---

## 概述

本仓库包含两个版本的会议调度器：

| | `plugin_version/` | `skill_version/` |
|---|---|---|
| **架构** | OpenClaw 插件 (CJS) | 技能封装插件 (ESM) |
| **工具数** | 6 | 7 (+时段确认) |
| **平台** | 仅飞书 | 飞书 + Slack |
| **状态** | 纯内存（重启丢失） | 文件持久化（重启不丢） |
| **协商** | 简单接受/拒绝 | 三阶段打分 + 确认 |
| **安装** | `openclaw plugins install` | `openclaw skills add` |

## 架构

```mermaid
graph TB
    subgraph 用户
        U1(飞书用户)
        U2(Slack 用户)
    end

    subgraph OpenClaw 网关
        GW(网关)
        AG(Agent LLM)
    end

    subgraph 会议调度插件
        PC(plugin-core.ts)
        RC{resolveCtx}
        MS[(MeetingStore)]

        subgraph 飞书 Provider
            LP(lark.ts)
            LCAL(日历 API)
            LDIR(通讯录 API)
            LDM(消息 API)
        end

        subgraph Slack Provider
            SP(slack.ts)
            SDIR(users.list)
            SDM(chat.postMessage)
        end

        SCH(scheduler.ts)
    end

    U1 -->|消息| GW
    U2 -->|消息| GW
    GW -->|分发| AG
    AG -->|工具调用| PC
    PC --> RC
    RC -->|channel=feishu| LP
    RC -->|channel=slack| SP
    LP --> LCAL
    LP --> LDIR
    LP --> LDM
    SP --> SDIR
    SP --> SDM
    PC --> SCH
    PC <-->|读/写| MS

    style RC fill:#f59e0b,color:#000
    style MS fill:#3b82f6,color:#fff
    style LP fill:#00D09C,color:#fff
    style SP fill:#4A154B,color:#fff
    style SCH fill:#8b5cf6,color:#fff
```

## 会议生命周期

```mermaid
stateDiagram-v2
    [*] --> Collecting: find_and_book_meeting
    note right of Collecting: 私信每个参会人\n收集可用时间

    Collecting --> FastPath: 全部接受
    Collecting --> Scoring: 部分提出替代时间
    Collecting --> Cancelled: 全部拒绝
    Collecting --> Expired: 12 小时超时

    FastPath --> Committed: commitMeeting()

    Scoring --> Confirming: 发起者选择时段\n(confirm_meeting_slot)
    note right of Scoring: scoreSlots() 按\n参会人覆盖率排序

    Confirming --> Committed: 全部确认所选时段
    Confirming --> Cancelled: 被拒绝

    Committed --> [*]: 日历事件已创建
    Cancelled --> [*]: 会议已关闭
    Expired --> [*]: 自动取消
```

## 请求处理流水线

```mermaid
flowchart LR
    subgraph "1. 接收消息"
        MSG(用户消息)
    end

    subgraph "2. 意图识别"
        LLM(LLM 解析意图)
    end

    subgraph "3. 平台路由"
        CTX{ctx.messageChannel}
        F(飞书 Provider)
        S(Slack Provider)
    end

    subgraph "4. 名称解析"
        NR{resolveUsers}
        DIR(遍历通讯录)
        CAND(返回候选人)
        PICK(LLM 选择匹配)
    end

    subgraph "5. 创建会议"
        DUP{去重检查}
        PM(创建待定会议)
        DM(发送私信邀请)
        SAVE(store.save)
    end

    MSG --> LLM --> CTX
    CTX -->|飞书| F
    CTX -->|slack| S
    F --> NR
    S --> NR
    NR -->|已找到| DUP
    NR -->|未找到| DIR --> CAND --> PICK -->|重新调用| NR
    DUP -->|新会议| PM --> DM --> SAVE
    DUP -->|重复| RET(返回已有 ID)

    style CTX fill:#f59e0b,color:#000
    style DUP fill:#ef4444,color:#fff
    style SAVE fill:#3b82f6,color:#fff
```

## 参会人回复流程

```mermaid
flowchart TD
    REPLY(参会人在私信中回复) --> PARSE{LLM 解析回复}

    PARSE -->|"同意/可以/行"| ACC(状态 = 已接受)
    PARSE -->|"拒绝/不行"| DEC(状态 = 已拒绝)
    PARSE -->|"15:30-17:00有空"| ALT(状态 = 提出替代时间)
    PARSE -->|"让XXX替我去"| DEL(委托)
    PARSE -->|"无关内容"| IGN(请求澄清)

    ACC --> MERGE{合并模式}
    DEC --> MERGE
    ALT --> MERGE

    DEL --> D1(标记原参会人: 已拒绝)
    D1 --> D2(解析受托人姓名)
    D2 --> D3(添加受托人为待定)
    D3 --> D4(私信受托人发送邀请)

    MERGE -->|追加默认| UNION(取并集时段)
    MERGE -->|替换| OVERWRITE(覆盖之前回复)

    UNION --> CHECK{全部已回复?}
    OVERWRITE --> CHECK

    CHECK -->|否| WAIT(等待其他人)
    CHECK -->|是| DEBOUNCE(30 秒防抖计时器)

    DEBOUNCE -->|30 秒内有新回复| RESET(重置计时器)
    RESET --> DEBOUNCE
    DEBOUNCE -->|30 秒已过| FINAL(finaliseMeeting)

    style ACC fill:#22c55e,color:#fff
    style DEC fill:#ef4444,color:#fff
    style ALT fill:#f59e0b,color:#000
    style DEL fill:#8b5cf6,color:#fff
    style DEBOUNCE fill:#3b82f6,color:#fff
```

## 后台进程

```mermaid
flowchart LR
    subgraph "定时器（每 60 秒）"
        T1(检查所有进行中的会议)
        T2{now >= expiresAt?}
        T3(关闭 + 私信发起者)
        T4{需要状态更新?}
        T5(私信发起者点名报告)
        T6(回收过期会议)
    end

    T1 --> T2
    T2 -->|是，已过 12 小时| T3
    T2 -->|否| T4
    T4 -->|是，距上次 1 小时| T5
    T4 -->|否| T6

    style T3 fill:#ef4444,color:#fff
    style T5 fill:#3b82f6,color:#fff
```

## 安全机制

```mermaid
flowchart TD
    subgraph "并发去重（第 1 层）"
        L1(60 个并行工具调用)
        L1P(inflightFindAndBook Map)
        L1R(共享单个 Promise)
        L1 --> L1P --> L1R
    end

    subgraph "幂等性（第 2 层）"
        L2(顺序重试)
        L2H(SHA256 指纹)
        L2W(60 秒窗口检查)
        L2 --> L2H --> L2W
    end

    subgraph "防抖"
        DB1(收到最后一条回复)
        DB2(setTimeout 30 秒)
        DB3(有新回复?)
        DB4(clearTimeout + 重启)
        DB5(finaliseMeeting)
        DB1 --> DB2 --> DB3
        DB3 -->|是| DB4 --> DB2
        DB3 -->|否，30 秒已过| DB5
    end

    subgraph "持久化"
        PS1(状态变更)
        PS2(store.save 写入 JSON)
        PS3(网关重启)
        PS4(store.hydrate 从磁盘恢复)
        PS1 --> PS2
        PS3 --> PS4
    end

    style L1R fill:#22c55e,color:#fff
    style L2W fill:#22c55e,color:#fff
    style DB5 fill:#3b82f6,color:#fff
    style PS4 fill:#3b82f6,color:#fff
```

## 文件结构

```
Meeting_new/
├── docs/
│   ├── flow-diagram.md              Mermaid 时序图
│   ├── diff.md                      插件 vs 技能 6 场景分析
│   └── plugin-vs-skill.md           架构对比
│
├── plugin_version/                   原始插件版本 (v1.0)
│   ├── src/
│   │   ├── index.ts                  1908 行，6 个工具，单文件
│   │   ├── scheduler.ts             时段算法
│   │   └── providers/
│   │       ├── lark.ts              飞书后端（1020 行）
│   │       ├── google.ts            Google 日历后端
│   │       └── mock.ts             测试模拟
│   └── openclaw.plugin.json
│
└── skill_version/                    技能封装插件 (v2.0)
    ├── SKILL.md                      LLM 指令
    ├── src/
    │   ├── index.ts                  入口（平台配置）
    │   ├── plugin-core.ts            1176 行，7 个工具，多平台
    │   ├── meeting-store.ts          持久化状态层
    │   ├── scheduler.ts             时段查找 + 打分
    │   └── providers/
    │       ├── lark.ts              飞书（770 行）
    │       └── slack.ts             Slack（345 行）
    ├── pending/                      运行时会议状态
    └── openclaw.plugin.json         插件 + 技能清单
```

## 7 个工具

| 工具 | 描述 | 触发短语 |
|---|---|---|
| `find_and_book_meeting` | 创建待定会议，解析姓名，发送私信邀请 | 约会议 / 帮我约 / 安排会议 / 开个会 |
| `list_my_pending_invitations` | 列出发送者的待定邀请 | （回复邀请前使用） |
| `record_attendee_response` | 记录接受/拒绝/替代时间，含合并逻辑 | 同意 / 拒绝 / 我只有...有空 |
| `confirm_meeting_slot` | 发起者在打分后选择时段 | （收到打分报告后使用） |
| `list_upcoming_meetings` | 列出即将到来的日历事件 | 我有什么会 / 明天有什么会 |
| `cancel_meeting` | 按事件 ID 取消会议 | 取消会议 |
| `debug_list_directory` | 列出租户通讯录用户 | 显示通讯录 |

## 快速开始

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

## 配置 (.env)

```env
# 飞书
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_CALENDAR_ID=xxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxx

# 调度默认值
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

## 使用示例

```
"帮我和博泽约个会，明天下午，30分钟"
"我只有15:30-17:00有空"
"让子岩替我去"
"同意"
"我明天有什么会？"
"取消上午的设计评审"
"显示通讯录"
```

## 许可证

私有
