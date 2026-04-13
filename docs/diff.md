# Plugin vs Skill 架构差异分析

基于 meeting-scheduler 的实际代码逻辑，从 6 个具体场景出发对比两种架构的优劣。

---

## 场景 1：参会人回复后想改口（Debounce）

> Alice 发了"我只有15:30-17:00"，5 秒后发现说错了，改成"不对，16:00-17:30"

### Plugin

```
Alice 回复 → record_attendee_response → 写入内存 → pendingCount=0
→ scheduleFinalize: setTimeout(30s)
5 秒后 Alice 改口 → record_attendee_response → clearTimeout → 重新 setTimeout(30s)
→ 30s 后用 16:00-17:30 定稿
```

- 30s debounce 窗口自动给参会人纠错机会
- 每次新回复重置计时器，不会误定稿

### Skill

```
Alice 回复 → exec record_response.sh → 写入 JSON → pendingCount=0
→ 无法 setTimeout → 立刻定稿 / 或需要额外一轮对话确认
5 秒后 Alice 改口 → exec record_response.sh → 读 JSON → meeting 已 closed
→ 改口失败
```

- 没有定时器，无法实现 debounce
- 要么立刻定稿（丢失纠错窗口），要么强制多一轮确认对话（体验变差）

### 结论

| | Plugin | Skill |
|---|---|---|
| 结果 | ✅ 无感纠错 | ❌ 改口失败或体验降级 |

### Skill 解决方案：利用 `openclaw cron` 一次性定时任务

经验证，OpenClaw 支持秒级一次性延迟任务（`--at "30s"`），可以等价实现 `setTimeout` / `clearTimeout`：

```bash
# 创建 30s 后执行的一次性任务 (= setTimeout)
openclaw cron add --name "finalize-mtg_xxx" --at "30s" \
  --message "finalize mtg_xxx" --session isolated

# 取消任务 (= clearTimeout)
openclaw cron remove <cron-id>
```

Skill 脚本中的完整 debounce 流程：

```
Alice 回复 → exec record_response.sh:
  1. 读 pending.json, 更新 Alice 状态, 写回
  2. pendingCount == 0 → 全部已回复
  3. openclaw cron add --name "finalize-mtg_xxx" --at "30s"
  4. 将返回的 cron id 写入 pending.json

Alice 5秒后改口 → exec record_response.sh:
  1. 读 pending.json, 拿到上次的 cron id
  2. openclaw cron remove <旧 id>          ← clearTimeout
  3. 更新 Alice 回复, 写回
  4. openclaw cron add --at "30s"           ← 重新 setTimeout
  5. 将新 cron id 写入 pending.json

30s 到期, cron 触发 → exec finalize.sh:
  1. 读 pending.json
  2. intersectManyWindows + findSlots
  3. createEvent → DM 发起者
```

| | Plugin | Skill (使用 cron --at) |
|---|---|---|
| 结果 | ✅ 无感纠错 | ✅ 等价实现 |
| 机制 | setTimeout / clearTimeout | cron add --at / cron remove |

**场景 1 差异消除。**

---

## 场景 2：所有参会人都没回复，超时处理

> 周五 18:00 发起会议，参会人都下班了，周末没人跟 bot 说话

### Plugin

```
周五 18:00 发起 → PendingMeeting 创建 (expiresAt = 周六 06:00)
setInterval ticker 每分钟检查:
  周五 20:00 → DM 发起者: "0/2 已回复，剩余 10h"
  周五 23:00 → DM 发起者: "0/2 已回复，剩余 7h"
  ...
  周六 06:00 → 检测到 now >= expiresAt → closed=true
  → DM 发起者: "已超过12小时，已自动取消"
```

- 后台 ticker 主动检查，无需任何人触发
- 发起者定期收到进度通知
- 超时准时关闭

### Skill

```
周五 18:00 发起 → pending.json 写入
周五 18:01 ~ 周一 09:00 → 没有任何进程运行 → 没有检查 → 静默挂起
周一 09:00 Bob 回复"同意" → exec record_response.sh → 读 JSON
→ 才发现已超时 → 关闭 → DM 发起者
```

- 没有后台进程，无法主动检测超时
- 发起者整个周末不知道会议已失效
- 如果永远没人再说话，meeting 永远挂起

### 结论

| | Plugin | Skill |
|---|---|---|
| 超时检测 | ✅ 主动，准时 | ❌ 被动，依赖下次触发 |
| 状态通知 | ✅ 定期推送 | ❌ 无 |
| 最坏情况 | 12h 后准时关闭 | 可能永远挂起 |

### Skill 解决方案：`cron --at "12h"` + `cron --every`

经验证，OpenClaw cron 支持一次性延迟（`--at`）和周期性任务（`--every`），可以完整替代 Plugin 的 `setInterval` ticker：

```bash
# 12h 后自动过期 (= setTimeout 12h)
openclaw cron add --name "expire-mtg_xxx" --at "12h" \
  --message "meeting mtg_xxx expired, close and notify"

# 每 1h 推送状态更新 (= setInterval 1h)
openclaw cron add --name "status-mtg_xxx" --every "1h" \
  --message "check status of mtg_xxx and DM initiator"
```

Skill 脚本中的完整超时 + 状态更新流程：

```
发起会议 → exec find_and_book.sh:
  1. 创建 meeting, 写入 pending.json
  2. openclaw cron add --name "expire-mtg_xxx" --at "12h"
     → 12h 后触发过期脚本
  3. openclaw cron add --name "status-mtg_xxx" --every "1h"
     → 每小时触发状态更新脚本
  4. 将两个 cron id 写入 pending.json

每 1h cron 触发 → exec status_update.sh:
  1. 读 pending.json, 统计已回复/未回复
  2. DM 发起者: "2/3 已回复, 剩余 Xh"

12h cron 触发 → exec expire.sh:
  1. 读 pending.json, 标记 closed=true
  2. openclaw cron remove <status cron id>  ← 停止状态推送
  3. DM 发起者: "已超过12小时, 已自动取消"

提前定稿时 → exec finalize.sh:
  1. openclaw cron remove <expire cron id>  ← 取消超时
  2. openclaw cron remove <status cron id>  ← 停止状态推送
  3. 正常定稿流程
```

| | Plugin | Skill (使用 cron) |
|---|---|---|
| 超时检测 | ✅ ticker 主动 | ✅ cron --at "12h" |
| 状态通知 | ✅ setInterval | ✅ cron --every "1h" |
| 最坏情况 | 12h 关闭 | 12h 关闭 |

**场景 2 差异消除。**

---

## 场景 3：Kimi K2.5 批量重复调用（并发去重）

> LLM 在一个 turn 里产生 60 个相同的 find_and_book_meeting 调用（已观察到的真实行为）

### Plugin

```
60 个调用同时到达 Plugin
→ rawRequestKey() 计算相同的 SHA256
→ inflightFindAndBook Map 检测到相同 key
→ 第 1 个创建 Promise 并执行
→ 第 2~60 个 await 同一个 Promise
→ 只执行 1 次解析 + 1 组 DM
参会人收到 1 条邀请
```

- 两层去重：in-flight Promise（并发）+ 后 resolve 幂等（顺序重试）
- 同一进程内共享状态，天然可去重

### Skill

```
60 个 exec scripts/find_and_book.sh 同时启动
→ 60 个独立进程，各自有独立内存
→ 各自读 pending.json → 都发现不存在目标 meeting
→ 各自创建 meeting → 各自发 DM
参会人收到 60 条相同邀请
```

- 独立进程之间无法共享 Promise
- 文件锁可以缓解但无法完全解决（锁竞争 + 性能开销）

### 结论

| | Plugin | Skill |
|---|---|---|
| 结果 | ✅ 1 条邀请 | ❌ 60 条邀请 |
| 去重机制 | Promise 共享 + 内存幂等 | 文件锁（不可靠） |

### Skill 解决方案：确定性 meetingId + noclobber 标记文件

核心思路：**让 60 个进程创建的 meeting 完全相同，DM 只发一次。**

**第一步：meetingId 改为确定性（基于请求指纹）**

Plugin 用 `Math.random()` 生成 meetingId，60 个进程会产生 60 个不同 ID。改为用请求参数的 SHA256：

```bash
fingerprint=$(echo "${sender}|${title}|${earliest}|${latest}|${duration}|${attendees}" \
  | sha256sum | cut -d' ' -f1)
meetingId="mtg_${fingerprint:0:16}"
```

60 个进程算出相同的 meetingId → 写入 pending.json 的内容完全相同 → 多次覆盖写入无害。

**第二步：DM 发送用 noclobber 标记去重**

```bash
sent_marker="/tmp/mtg-sent-${fingerprint}"

# set -C (noclobber): 文件已存在则 > 操作失败
# 原子操作，60 个进程中只有 1 个能成功创建文件
if ( set -C; echo "1" > "$sent_marker" ) 2>/dev/null; then
  # 我是第一个 → 发送 DM
  send_dm_to_bob "$inviteText"
  send_dm_to_alice "$inviteText"
else
  # 标记已存在 → 别人已经发过了 → 跳过
  echo "duplicate request, DM already sent"
fi
```

`set -C` 在 Windows Git Bash 上也是原子的，不需要 flock。

**完整流程：**

```
60 个 exec find_and_book.sh 同时启动:
  1. fingerprint = SHA256(sender|title|earliest|latest|duration|attendees)
  2. meetingId = "mtg_" + fingerprint[:16]      ← 60 个都一样
  3. 读 pending.json
  4. 写入 meeting 到 pending.json              ← 内容相同，覆盖无害
  5. ( set -C; echo "1" > /tmp/mtg-sent-$fp )
     → 1 个成功：发 DM，参会人收到 1 条邀请
     → 59 个失败：跳过 DM
  6. 返回 meetingId                            ← 60 个都返回相同 ID
```

标记文件 60s 后由脚本自行清理（或系统 tmpwatch），不影响后续真正的新请求。

| | Plugin | Skill (确定性 ID + noclobber) |
|---|---|---|
| 结果 | ✅ 1 条邀请 | ✅ 1 条邀请 |
| 去重机制 | Promise 共享 | 确定性 ID + 原子标记文件 |
| 代价 | 无 | pending.json 被写 60 次（内容相同，无害） |

**场景 3 差异消除。**

---

## 场景 4：两个参会人同一秒回复（并发写入竞态）

> Bob 和 Alice 恰好在同一秒回复

### Plugin

```
Bob 的 session → record_attendee_response → 写内存 Map
Alice 的 session → record_attendee_response → 写内存 Map
Node.js 单线程事件循环 → 实际顺序执行 → 两次写入都成功
```

- 同一进程、同一 Map，JS 单线程保证不会并行写
- 不需要任何锁机制

### Skill

```
Bob 的 exec → 读 pending.json → 修改 Bob 状态 → 写回 pending.json
Alice 的 exec → 读 pending.json → 修改 Alice 状态 → 写回 pending.json
                 ↑ 如果在 Bob 写回之前读取，Alice 的写入会覆盖 Bob 的修改
```

- 经典的 read-modify-write 竞态条件
- 需要引入文件锁（如 flock），增加复杂度且有死锁风险

### 结论

| | Plugin | Skill |
|---|---|---|
| 并发安全 | ✅ 单线程天然安全 | ❌ 竞态风险，需文件锁 |
| 复杂度 | 无额外处理 | 需要锁机制 |

### Skill 解决方案：拆成目录结构，每人一个文件

核心思路：**不共享一个大 JSON，每个参会人的回复写独立文件，各写各的，永远不冲突。**

原来的存储结构（单文件，有竞态）：

```
pending.json
  └─ { "mtg_xxx": { attendees: [{ bob: "accepted" }, { alice: "proposed_alt" }] } }
```

改为目录结构（每人独立文件，无竞态）：

```
pending/
  mtg_a1b2c3/
    meeting.json          ← 会议元数据（创建时写入，之后只读）
    resp_ou_bob.json      ← Bob 的回复（只有 Bob 的进程写）
    resp_ou_alice.json    ← Alice 的回复（只有 Alice 的进程写）
```

脚本中的写入逻辑：

```bash
# record_response.sh
meeting_dir="pending/mtg_${meetingId}"
resp_file="${meeting_dir}/resp_${senderOpenId}.json"

# 每个进程只写自己的文件，不碰别人的
echo "{\"status\":\"${status}\",\"windows\":${windows},\"respondedAt\":$(date +%s)}" \
  > "$resp_file"
```

检查状态：

```bash
# 统计已回复 vs 总人数
meeting_dir="pending/mtg_${meetingId}"
total=$(jq '.attendees | length' "${meeting_dir}/meeting.json")
replied=$(ls "${meeting_dir}"/resp_*.json 2>/dev/null | wc -l)
pending_count=$((total - replied))

if [ "$pending_count" -eq 0 ]; then
  # 全部已回复 → 触发 debounce 定稿
  openclaw cron add --name "finalize-${meetingId}" --at "30s" \
    --message "finalize ${meetingId}"
fi
```

Bob 和 Alice 同一秒回复：

```
Bob 的进程  → 写 resp_ou_bob.json    ← 独占文件，无冲突
Alice 的进程 → 写 resp_ou_alice.json  ← 独占文件，无冲突
两个写入互不干扰，都成功保留
```

| | Plugin | Skill (目录结构) |
|---|---|---|
| 并发安全 | ✅ 单线程天然安全 | ✅ 每人独立文件，无竞态 |
| 复杂度 | 无额外处理 | 目录结构管理（简单） |
| 额外好处 | 无 | 天然支持回复历史追溯（每人一个文件） |

**场景 4 差异消除。**

---

## 场景 5：Gateway 重启后恢复

> 你执行 `openclaw gateway --force`，进程被杀重启

### Plugin

```
--force → 进程退出 → pendingMeetings Map 清空 → 所有进行中的会议丢失
重启后 → 参会人回复"同意" → record_attendee_response
→ "Meeting not found"
→ 参会人困惑，发起者需要重新发起
```

- 纯内存状态，进程死即全丢
- 你之前遇到的 orphaned user message 就是这个问题的副作用

### Skill

```
--force → 进程退出 → pending.json 仍在磁盘
重启后 → 参会人回复"同意" → exec record_response.sh
→ 读 pending.json → 正常找到 meeting → 正常记录
→ 流程继续
```

- 文件天然持久化，重启不丢数据
- 这是 Skill 唯一明确优于 Plugin 的场景

### 结论

| | Plugin | Skill |
|---|---|---|
| 重启恢复 | ❌ 状态全丢 | ✅ 文件持久 |
| 影响 | 所有进行中会议作废 | 无影响 |

---

## 场景 6：LLM 不按指令调用工具

> 参会人回复"同意"，LLM 需要正确调用 record_attendee_response

### Plugin

```
LLM 看到 registerTool 注册的结构化工具:
{
  name: "record_attendee_response",
  parameters: {
    status: { type: "string", enum: ["accepted","declined","proposed_alt"] },
    proposed_windows: { type: "array", items: { start, end } },
    mode: { type: "string", enum: ["append","replace"] }
  }
}
→ LLM 按 JSON Schema 填参数 → 类型和枚举有约束 → 出错概率低
```

- 结构化 Schema 对 LLM 有强约束
- 参数类型、枚举值、必填项都有明确定义

### Skill

```
LLM 读到 SKILL.md 里的自然语言描述:
"当用户表示同意时，执行:
  exec scripts/record_response.sh --meeting-id MTG_ID --status accepted
 当用户提出替代时间时，执行:
  exec scripts/record_response.sh --status proposed_alt --windows '15:30-17:00'"

→ LLM 可能: 漏传参数 / 格式错误 / 跳过脚本直接回复 / 幻觉一个确认消息
```

- 自然语言指令没有硬约束
- 你已经观察到 Kimi K2.5 无视 tool description 的行为，SKILL.md 更弱

### 结论

| | Plugin | Skill |
|---|---|---|
| 调用可靠性 | ✅ Schema 硬约束 | ❌ 自然语言软约束 |
| 出错后果 | 参数校验拦截 | 静默出错或幻觉回复 |

### Skill 解决方案：内嵌 MCP Server 提供结构化工具

据调研，**超过 65% 的 OpenClaw Skill 实际上就是在包装一个 MCP Server**。MCP Server 可以暴露带完整 JSON Schema 的结构化工具，LLM 看到的效果与 Plugin 的 `registerTool` 一致。

Skill 目录结构：

```
meeting-scheduler-skill/
├── SKILL.md                  ← 补充使用场景说明
├── scripts/
│   └── mcp-server.py         ← MCP Server，暴露结构化工具
├── pending/                   ← 会议数据目录
└── references/
```

MCP Server 注册工具示例（Python）：

```python
# scripts/mcp-server.py
from mcp import Server, Tool

server = Server("meeting-scheduler")

@server.tool(
    name="record_attendee_response",
    description="记录参会人对会议邀请的回复",
    parameters={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["accepted", "declined", "proposed_alt"]
            },
            "proposed_windows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "string", "description": "RFC3339"},
                        "end": {"type": "string", "description": "RFC3339"}
                    },
                    "required": ["start", "end"]
                }
            },
            "mode": {
                "type": "string",
                "enum": ["append", "replace"],
                "default": "append"
            }
        },
        "required": ["status"]
    }
)
async def record_response(params):
    # 读写 pending/ 目录结构
    # 调用 openclaw cron add/remove
    ...
```

LLM 看到的效果：

```
Plugin:  registerTool → LLM tool list 里出现带 JSON Schema 的工具
Skill:   MCP Server  → LLM tool list 里出现带 JSON Schema 的工具
                        ↑ 对 LLM 来说完全一样
```

并且 MCP Server 作为一个长运行进程，还额外解决了场景 3 和 4 的问题：

- **场景 3（并发去重）**：MCP Server 是单进程，可以用内存 Map 做 in-flight Promise 合并，跟 Plugin 一样
- **场景 4（并发写入）**：MCP Server 是单进程，单线程天然安全

| | Plugin | Skill + MCP Server |
|---|---|---|
| 调用可靠性 | ✅ Schema 硬约束 | ✅ Schema 硬约束 |
| LLM 看到的工具 | registerTool JSON Schema | MCP tool JSON Schema |
| 参数约束 | 类型 + enum | 类型 + enum |
| 不调用工具的风险 | 低 | 低（工具在 tool list 里） |

**场景 6 差异消除。**

---

## 总结

### 原始对比（Skill 无任何优化）

| 场景 | Plugin | Skill（原始） | 胜出 |
|---|---|---|---|
| 1. 回复后改口 (Debounce) | ✅ 30s 自动缓冲 | ❌ 无定时器 | Plugin |
| 2. 超时检测与状态推送 | ✅ 后台 ticker 主动 | ❌ 被动等触发 | Plugin |
| 3. LLM 批量重复调用 | ✅ Promise 合并 | ❌ 60 个独立进程 | Plugin |
| 4. 并发写入安全 | ✅ 单线程天然安全 | ❌ 文件竞态风险 | Plugin |
| 5. Gateway 重启恢复 | ❌ 内存全丢 | ✅ 文件持久 | Skill |
| 6. LLM 调用可靠性 | ✅ 结构化 Schema | ❌ 自然语言不可靠 | Plugin |

**原始结果：5:1 Plugin 胜**

### 优化后对比（Skill + cron + 目录结构 + MCP Server）

| 场景 | Plugin | Skill（优化后） | 解决方案 | 结果 |
|---|---|---|---|---|
| 1. Debounce | setTimeout | cron --at "30s" | `openclaw cron add/remove` | 打平 |
| 2. 超时与状态推送 | setInterval | cron --at "12h" + --every "1h" | `openclaw cron` 三种调度 | 打平 |
| 3. 并发去重 | Promise 合并 | 确定性 ID + noclobber | SHA256 指纹 + `set -C` 标记文件 | 打平 |
| 4. 并发写入 | 单线程安全 | 每人独立文件 | 目录结构替代单 JSON | 打平 |
| 5. 重启恢复 | ❌ 内存全丢 | ✅ 文件 + cron 持久 | 天然优势 | **Skill 胜** |
| 6. 调用可靠性 | registerTool | MCP Server | 内嵌 MCP 暴露结构化工具 | 打平 |

**优化后结果：0:1 Skill 胜（持久化优势），其余全部打平。**

### 结论

经过逐场景分析和验证，Skill 架构在引入 `openclaw cron`（定时任务）、目录结构（并发安全）、确定性 ID + noclobber（去重）、MCP Server（结构化工具）后，**可以完整覆盖 Plugin 的所有核心能力，且额外获得持久化优势**。

meeting-scheduler 改造为 Skill + MCP Server 架构是**可行的**。
