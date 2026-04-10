# Meeting Scheduler Flow Diagram

## 场景

> 你（发起者）发送: "帮我和Bob和Alice发一个会议邀约，大概在下周周一下午15:00-20:00，大概30min"

```mermaid
sequenceDiagram
    participant You as 你(发起者)
    participant IM as 飞书/Slack
    participant LLM as Agent(Kimi K2.5)
    participant Plugin as meeting-scheduler
    participant Bob as Bob(参会人)
    participant Alice as Alice(参会人)
    participant Cal as 飞书日历

    Note over You,Cal: 阶段 1 - 发起会议

    You->>IM: 帮我和Bob和Alice发会议邀约 周一15:00-20:00 30min
    IM->>LLM: 消息分发到 agent session

    rect rgb(240, 248, 255)
        Note right of LLM: LLM 意图识别, 提取参数: title/earliest/latest/duration/attendees
        LLM->>Plugin: find_and_book_meeting(title, attendees, earliest, latest, duration)
    end

    rect rgb(255, 250, 240)
        Note right of Plugin: 1. SHA256去重检查 2. 名称解析(查飞书通讯录) 3. 创建PendingMeeting 4. 发起者auto-accept
        Plugin-->>Bob: DM邀请: 会议邀约 周一15:00-20:00 时长30min
        Plugin-->>Alice: DM邀请: 同上
    end

    Plugin->>LLM: ok=true, meetingId=mtg_xxx, dispatched=2
    LLM->>IM: 已向2位参会人发送邀请, 等待回复中
    IM->>You: 显示回复

    Note over You,Cal: 阶段 1.5 - Background Ticker(每分钟)

    loop 每 TICKER_INTERVAL_MS
        Plugin-->>You: DM状态更新: 1/3已回复, 剩余等待xxx分钟
    end

    Note over You,Cal: 阶段 2 - 参会人回复

    Bob->>IM: 同意
    IM->>LLM: Bob的独立DM session
    LLM->>Plugin: record_attendee_response(status=accepted)
    Note right of Plugin: Bob: pending->accepted, pendingCount=1
    Plugin->>LLM: ok, allResponded=false, remaining=1
    LLM-->>Bob: 已记录: 同意

    Alice->>IM: 我只有15:30-17:00有空
    IM->>LLM: Alice的独立DM session
    LLM->>Plugin: record_attendee_response(status=proposed_alt, windows=[15:30-17:00])
    Note right of Plugin: Alice: pending->proposed_alt, pendingCount=0, 触发scheduleFinalize
    Plugin->>LLM: ok, allResponded=true
    LLM-->>Alice: 已记录: 15:30-17:00有空, 30秒后自动定稿

    Note over You,Cal: 阶段 3 - 30s Debounce窗口

    Note right of Plugin: 等待30s, 期间新回复会重置计时器

    Note over You,Cal: 阶段 4 - 自动定稿

    rect rgb(240, 255, 240)
        Note right of Plugin: finaliseMeeting: 你[15:00-20:00] + Bob[15:00-20:00] + Alice[15:30-17:00] 交集=[15:30-17:00] 最佳slot=15:30-16:00
        Plugin->>Cal: createEvent(会议邀约, 15:30-16:00, 3人)
        Cal-->>Plugin: eventId + joinUrl
    end

    Plugin-->>You: DM: 已锁定 周一15:30-16:00 会议链接:https://...
    Note right of Plugin: meeting.closed = true
```

## 异常流程

```mermaid
flowchart TD
    A["PendingMeeting 创建 (expiresAt = now + 12h)"] --> B{"Background Ticker 每分钟检查"}

    B -->|"未超时, 有人未回复"| C["定期DM发起者 状态更新"]
    C --> B

    B -->|"now >= expiresAt"| D["直接取消, DM发起者: 已超时自动取消"]

    B -->|"所有人已回复"| E["scheduleFinalize (30s debounce)"]
    E --> F{"debounce期间有新回复?"}
    F -->|"是"| G["clearTimeout 重新计时30s"]
    G --> F
    F -->|"否, 30s到期"| H{"intersectManyWindows 交集存在?"}

    H -->|"有共同时段"| I{"findSlotsInWindows 能放下duration?"}
    I -->|"能"| J["createEvent, DM发起者: 已锁定"]
    I -->|"不能"| K["DM发起者: 放不下N分钟"]

    H -->|"无共同时段"| L["DM发起者: 无法找到共同时段"]

    M["所有人declined"] --> N["acceptedOrAlt = 0"]
    N --> O["DM发起者: 所有人已拒绝"]

    J --> P["closed = true"]
    K --> P
    L --> P
    O --> P
    D --> P

    style J fill:#22c55e,color:#fff
    style D fill:#ef4444,color:#fff
    style K fill:#ef4444,color:#fff
    style L fill:#ef4444,color:#fff
    style O fill:#ef4444,color:#fff
```

## 关键机制

| 机制 | 代码位置 | 说明 |
|---|---|---|
| **In-flight 去重** | `inflightFindAndBook` Map | 并发相同请求共享同一个 Promise，防止 LLM 批量重复调用 |
| **Post-resolve 幂等** | `recentFindAndBook` Map | SHA256 指纹 + 60s 窗口，resolve 后的第二层去重 |
| **30s Debounce** | `scheduleFinalize()` | 最后一个回复后等 30s 再定稿，每次新回复 clearTimeout + 重新计时 |
| **12h TTL** | `PENDING_TTL_MS` | 超时直接取消（不尝试用已回复的人定稿），发起者需重新发起 |
| **Background Ticker** | `setInterval(TICKER_INTERVAL_MS)` | 每分钟检查超时 + 定期给发起者发状态更新 DM |
| **Auto-accept** | `find_and_book_meeting` | 发起者自动标记为 accepted，不需要自己回复 |
| **名称两步解析** | tool description | 插件查通讯录返回候选列表 → 若 unresolved，LLM 从 candidates 中语义匹配后重试 |
| **Append/Replace** | `record_attendee_response` | append(默认): union 时间窗口; replace: 仅当用户明确更正时使用 |
| **Append 合并规则** | `mergeOverlappingWindows()` | proposed_alt + proposed_alt → union 后合并重叠区间; accepted + proposed_alt → 保持 accepted |
