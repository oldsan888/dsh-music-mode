export type MemoryType = "episodic" | "semantic";
export type MemoryStatus =
  | "active"
  | "pending"
  | "superseded"
  | "archived"
  | "deleted";

export type SourceType =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "system_inference"
  | "behavior_signal";

export interface MemorySource {
  conversation_id: string;
  message_id: string | null;
  source_type: SourceType;
}

export interface MemoryObject {
  memory_id: string;
  user_id: string;
  scope: "user" | "session";
  type: MemoryType;
  namespace: string;
  key: string | null;
  content: string;
  raw_quote: string | null;
  value: unknown | null;
  tags: string[];
  importance: number;
  confidence: number;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
  source: MemorySource;
  evidence_ids: string[];
  superseded_by: string | null;
  embedding_pending: boolean;
  /** 被召回/复用次数（Memory v2：检索打分的频率维度）。 */
  access_count: number;
  /** 记忆分层（Memory v3）：1=核心层 2=活跃层 3=归档层。 */
  tier: number;
}

export interface Message {
  message_id: string;
  conversation_id: string;
  user_id: string;
  session_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}

export interface Item {
  id: string;
  type: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionState {
  current_topic: string | null;
  current_task: string | null;
  last_user_intent: string | null;
  current_item: Item | null;
  previous_item: Item | null;
  recent_items: (Item & { used_at: number })[];
  mood: string | null;
  last_tool_results: Record<string, unknown> | null;
}

export interface SessionMemory {
  session_id: string;
  user_id: string;
  conversation_id: string;
  recent_messages: Message[];
  state: SessionState;
  updated_at: number;
  expires_at: number;
}

export interface MemoryContextPack {
  core_profile: {
    user_md: string;
    version: number;
  } | null;
  agent_profile: {
    agent_md: string;
    version: number;
  } | null;
  persistent_facts: string[];
  active_rules: string[];
  recent_events: string[];
  /** 跨记忆关联说明（Memory v3 LLM rerank，仅 recall 意图产出）。 */
  association_note?: string | null;
  session_state: Partial<SessionState>;
  recent_dialogue: Message[];
}

export interface UserCoreProfile {
  user_id: string;
  user_md: string;
  version: number;
  source_memory_ids: string[];
  char_count: number;
  status: "active" | "archived";
  dirty_at: string | null;
  dirty_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentProfile {
  profile_id: string;
  agent_md: string;
  version: number;
  char_count: number;
  updated_at: string;
}

export interface CoreProfileEvent {
  event_id: string;
  user_id: string;
  action: "add" | "replace" | "remove" | "rebuild" | "manual_override" | string;
  section: "user" | "agent" | string;
  old_text: string | null;
  new_text: string | null;
  evidence_ids: string[];
  source: string;
  created_at: string;
}

/* ─────────── Memory Extraction (Hot Path) ─────────── */

export interface MemoryCandidate {
  memory_type:
    | "identity"
    | "preference"
    | "negative_preference"
    | "communication_rule"
    | "music_preference"
    | "music_behavior"
    | "project_context"
    | "event";
  scope: "long_term" | "session" | "temporary";
  key: string | null;
  content: string;
  value: unknown;
  confidence: number;
  importance: number;
  evidence_text: string;
  tags: string[];
}

export interface MemoryExtractionResult {
  should_write: boolean;
  confidence: number;
  reason: string;
  candidates: MemoryCandidate[];
}

export type Intent =
  | "play_control"      // 下一首 / 暂停 / 大点声
  | "refer_previous"    // 刚刚那首 / 上一首
  | "set_identity"      // 叫我 XX / 我是 XX
  | "set_rule"          // 以后简洁 / 默认中文
  | "remember"          // 记住 XX
  | "forget"            // 忘掉 XX / 删除
  | "recall"            // 你还记得 XX 吗
  | "general";          // 其它

/** 消息来源通道：web=浏览器聊天（现有）；feishu=飞书机器人。dube 据此调整措辞/行为
 *  ——飞书侧无播放器，音乐指令要靠网页执行（orchestrator prompt 注入 + 飞书中继，见 plans/2026-07-07-feishu-channel）。 */
export type ChannelKind = "web" | "feishu";

export interface TurnInput {
  user_id: string;
  session_id: string;
  conversation_id: string;
  user_message: string;
  /** 来源通道（缺省 web）。feishu 时 orchestrator 注入「本条来自飞书」提示行。 */
  channel?: ChannelKind;
  /** 用户【发信息】的时刻（UTC 文本 'YYYY-MM-DD HH:MM:SS'）——定时任务的时间基准锚。
   *  网页=请求到达时刻；飞书=event.message.create_time。缺省则调度工具回退到执行时刻。见 plans/2026-07-07-scheduled-tasks §1。 */
  received_at?: string;
}

export interface TurnResult {
  turn_id: string;
  assistant_response: string;
  context_pack: MemoryContextPack;
  detected_intent: Intent;
  timings_ms: Record<string, number>;
}
