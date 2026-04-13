# Plugin vs Skill 架构对比

## 场景

> "帮我和Bob和Alice发一个会议邀约，下周周一15:00-20:00，30min"

---

## 当前 Plugin 架构流程

```mermaid
sequenceDiagram
    participant You as 你(发起者)
    participant IM as 飞书/Slack
    participant LLM as Agent(Kimi K2.5)
    participant Plugin as Plugin(常驻内存)
    participant State as pendingMeetings Map
    participant Timer as setInterval/setTimeout
    participant Cal as 飞书日历

    Note over You,Cal: 阶段 1 - 发起

    You->>IM: 帮我约会议
    IM->>LLM: 分发到 agent session
    LLM->>Plugin: find_and_book_meeting()
    Plugin->>Plugin: SHA256 去重 + in-flight Promise 合并
    Plugin->>State: 创建 PendingMeeting 写入 Map
    Plugin-->>IM: DM Bob 邀请
    Plugin-->>IM: DM Alice 邀请
    Plugin->>LLM: ok, dispatched=2

    Note over You,Cal: 阶段 2 - 后台 Ticker (常驻)

    loop setInterval 每分钟
        Timer->>State: 读取所有 pending meetings
        Timer->>Timer: 检查超时 now >= expiresAt?
        Timer-->>You: DM 状态更新 (2/3已回复...)
    end

    Note over You,Cal: 阶段 3 - 参会人回复

    Bob->>IM: 同意
    IM->>LLM: Bob 的 DM session
    LLM->>Plugin: record_attendee_response(accepted)
    Plugin->>State: Bob: pending->accepted (内存直接改)
    Plugin->>LLM: remaining=1

    Alice->>IM: 我只有15:30-17:00有空
    IM->>LLM: Alice 的 DM session
    LLM->>Plugin: record_attendee_response(proposed_alt)
    Plugin->>State: Alice: pending->proposed_alt
    Note right of Plugin: pendingCount=0, 全部回复

    Plugin->>Timer: setTimeout(30s) 启动 debounce
    Note right of Timer: 30s 内新回复会 clearTimeout 重置

    Note over You,Cal: 阶段 4 - 自动定稿 (30s后)

    Timer->>State: 读取 meeting 状态
    Timer->>Timer: intersectManyWindows + findSlots
    Timer->>Cal: createEvent(15:30-16:00)
    Timer-->>You: DM: 已锁定 15:30-16:00

    Note over You,Cal: 全程 Plugin 常驻内存, 主动推进流程
```

## Plugin 架构 - 异常处理

```mermaid
flowchart TD
    A[PendingMeeting 创建] --> B[setInterval Ticker 每分钟检查]
    B -->|未超时| C[DM 发起者状态更新]
    C --> B
    B -->|12h 超时| D[主动关闭 + DM通知]
    B -->|全部回复| E[setTimeout 30s debounce]
    E -->|30s内新回复| F[clearTimeout 重置]
    F --> E
    E -->|30s到期| G[finaliseMeeting]
    G -->|有交集| H[createEvent]
    G -->|无交集| I[DM: 无共同时段]

    style D fill:#ef4444,color:#fff
    style H fill:#22c55e,color:#fff
    style I fill:#ef4444,color:#fff
```

---

## Skill 架构流程

```mermaid
sequenceDiagram
    participant You as 你(发起者)
    participant IM as 飞书/Slack
    participant LLM as Agent(Kimi K2.5)
    participant Skill as SKILL.md(指令注入)
    participant Script as scripts/(独立进程)
    participant File as JSON文件(磁盘)
    participant Cal as 飞书日历

    Note over You,Cal: 阶段 1 - 发起

    You->>IM: 帮我约会议
    IM->>LLM: 分发到 agent session
    Note right of LLM: 读取 SKILL.md 指令, 决定调用哪个 script
    LLM->>Script: exec scripts/find_and_book.sh
    Note right of Script: 新进程启动, 无历史状态
    Script->>File: 读取 pending.json (可能不存在)
    Script->>Script: 去重检查 (基于文件, 有竞态风险)
    Script->>File: 写入新 PendingMeeting 到 pending.json
    Script->>IM: 调飞书API DM Bob
    Script->>IM: 调飞书API DM Alice
    Script->>LLM: 输出结果
    Note right of Script: 进程退出, 内存释放

    Note over You,Cal: 阶段 2 - 无后台 Ticker

    Note over You,Cal: 没有 setInterval, 没有主动检查, 没有状态更新 DM, 静默等待直到有人说话触发 LLM

    Note over You,Cal: 阶段 3 - 参会人回复

    Bob->>IM: 同意
    IM->>LLM: Bob 的 DM session
    Note right of LLM: 读取 SKILL.md, 决定调用 record 脚本
    LLM->>Script: exec scripts/record_response.sh
    Note right of Script: 新进程启动
    Script->>File: 读取 pending.json
    Script->>File: Bob: pending->accepted, 写回文件
    Script->>LLM: remaining=1
    Note right of Script: 进程退出

    Alice->>IM: 我只有15:30-17:00有空
    IM->>LLM: Alice 的 DM session
    LLM->>Script: exec scripts/record_response.sh
    Note right of Script: 新进程启动
    Script->>File: 读取 pending.json
    Script->>File: Alice: pending->proposed_alt, 写回
    Note right of Script: pendingCount=0, 全部回复

    Note over You,Cal: 阶段 4 - 定稿 (无 debounce)

    Note right of Script: 无法 setTimeout, 必须立刻决定
    alt 方案A: 脚本内直接定稿
        Script->>Script: intersectManyWindows + findSlots
        Script->>Cal: createEvent(15:30-16:00)
        Script-->>You: DM: 已锁定
        Note right of Script: 没有30s纠错窗口, Alice无法改口
    else 方案B: 等下一次触发
        Script->>LLM: 全部回复, 请确认定稿
        LLM-->>Alice: 是否确认?
        Note right of LLM: 需要额外一轮对话
        Alice->>IM: 确认
        IM->>LLM: 再次触发
        LLM->>Script: exec scripts/finalize.sh
        Script->>File: 读取 pending.json
        Script->>Cal: createEvent
        Script-->>You: DM: 已锁定
    end

    Note over You,Cal: 全程无常驻进程, 每次 exec 都是独立进程
```

## Skill 架构 - 异常处理

```mermaid
flowchart TD
    A[PendingMeeting 写入 JSON 文件] --> B{等待 LLM 被触发}

    B -->|有人说话触发 LLM| C[exec script 读 JSON]
    C --> D{检查超时?}
    D -->|未超时| E[正常处理回复]
    D -->|已超时| F[标记关闭, DM通知]

    B -->|没人说话| G[无人检查, 静默挂起]
    G -->|可能永远不触发| G

    E -->|全部回复| H{能否 debounce?}
    H -->|不能, 没有定时器| I[立刻定稿或要求确认]
    I -->|有交集| J[createEvent]
    I -->|无交集| K[DM: 无共同时段]

    style F fill:#ef4444,color:#fff
    style G fill:#fbbf24,color:#000
    style J fill:#22c55e,color:#fff
    style K fill:#ef4444,color:#fff
```

---

## 逐项对比

```mermaid
flowchart LR
    subgraph Plugin
        P1[常驻内存 Map]
        P2[setInterval Ticker]
        P3[setTimeout Debounce]
        P4[in-flight Promise 去重]
        P5[registerTool 5个工具]
        P6[provider.sendTextDM]
    end

    subgraph Skill
        S1[JSON 文件读写]
        S2[无]
        S3[无]
        S4[文件锁 有竞态风险]
        S5[5个 scripts]
        S6[脚本直接调 API]
    end

    P1 -.->|替代| S1
    P2 -.->|丢失| S2
    P3 -.->|丢失| S3
    P4 -.->|降级| S4
    P5 -.->|替代| S5
    P6 -.->|替代| S6

    style S2 fill:#ef4444,color:#fff
    style S3 fill:#ef4444,color:#fff
    style S4 fill:#fbbf24,color:#000
```

## 差异总结表

| 维度 | Plugin | Skill | 差异 |
|---|---|---|---|
| **状态存储** | 内存 Map, 进程内直接读写 | JSON 文件, 每次 exec 读写 | Skill 有磁盘IO开销 + 并发竞态风险 |
| **后台 Ticker** | setInterval 每分钟主动检查 | 无 | Skill 丢失主动超时检查和状态更新推送 |
| **Debounce** | setTimeout 30s 缓冲 | 无 | Skill 丢失纠错窗口, 要么立刻定稿要么多一轮对话 |
| **并发去重** | in-flight Promise 合并 | 无法实现 (独立进程) | Skill 下 Kimi 批量重复调用问题会重现 |
| **幂等性** | 内存 Map 60s 窗口 | 文件锁 | 可替代但有竞态风险 |
| **工具注册** | registerTool, LLM 直接看到工具 schema | SKILL.md 文字描述 + scripts | Skill 依赖 LLM 理解自然语言指令来调用 |
| **超时处理** | 主动: ticker 发现超时立即关闭 + DM | 被动: 下次有人触发时才检查 | Skill 可能 12h 后无人触发导致永远挂起 |
| **DM 发送** | 通过 OpenClaw provider 体系 | 脚本直接调飞书/Slack API | Skill 需自行管理 token 和重试 |
| **多 session** | 各 session 共享同一个 Plugin 实例 | 各 session 独立 exec, 通过文件共享 | 可行但需要文件锁协调 |
| **持久化** | 无 (重启丢失) | 有 (文件天然持久) | Skill 反而更好, 重启不丢数据 |
