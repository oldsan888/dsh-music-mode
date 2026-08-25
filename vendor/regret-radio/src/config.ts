import "dotenv/config";

/**
 * 单一配置入口（ADR-7）。所有可调项一律在此读入并强类型化；业务代码只读 config.*，
 * 禁止直接读 process.env、禁止散落硬编码字面量。
 *
 * 三类：① AI 凭据/端点（09 起全可选：缺失则 AI 关闭、纯播放器可用，运行时可经前端配置覆盖，见 plans/09）
 *      ② 行为默认值 ③ 调参旋钮。明细与编号 F1–F12 见 plans/02-config-and-logging.md。
 */

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

function csv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// Embedding 可以单独配 KEY/BASE_URL;不配则回落到主 LLM 那一组（主 LLM 也可空 → 走运行时配置或 AI 关闭）
const embeddingApiKey = opt("EMBEDDING_API_KEY") || opt("API_KEY");
const embeddingBaseUrl = opt("EMBEDDING_API_BASE_URL") || opt("API_BASE_URL");

export const config = {
  security: {
    /**
     * 32-byte key encoded as 64 hexadecimal characters. It never enters SQLite.
     * Without it, runtime configuration UIs must not persist credentials.
     */
    runtimeConfigMasterKey: opt("RUNTIME_CONFIG_MASTER_KEY"),
  },
  server: {
    host: opt("SERVER_HOST", "127.0.0.1"), // F11：单机默认仅本机；局域网访问改 0.0.0.0
    port: num("PORT", 8080),
    logLevel: process.env.LOG_LEVEL ?? process.env.LOG ?? "info",
    dataDir: opt("DATA_DIR", "data"),
  },
  llm: {
    apiKey: opt("API_KEY"),
    baseUrl: opt("API_BASE_URL"),
    model: opt("LLM_MODEL"),
    modelPro: opt("LLM_MODEL_PRO", process.env.LLM_MODEL),
    thinkingDefault: bool("LLM_THINKING_DEFAULT", false),
    defaultTemperature: num("LLM_DEFAULT_TEMPERATURE", 0.4), // F7：原 llm.ts 硬编码 0.4
    maxTokens: num("LLM_MAX_TOKENS", 0), // F7：0 = 不下发（保持原行为）；>0 才约束长回复
    chatTemperature: num("LLM_CHAT_TEMPERATURE", 0.55), // 收尾：orchestrator-stream 对话温度（原硬编码 0.55，高于 defaultTemperature 0.4 以保住更活的话风）
    // 审计 H2 真机实锤：聊天主路径 chatStream 此前零超时，MiMo 真挂起 2 分钟全靠用户放弃才结束。
    // 只量「首个流事件」（含 thinking 的 reasoning_content delta）——深度思考模式首响本来就慢
    // （6 秒级正常），90s 才算真挂起；首个 chunk 一到就 clearTimeout，之后绝不再超时（正常长回复
    // 不许误杀）。0 = 禁用（保留逃生舱，遇到极端厂商可关）。
    firstChunkTimeoutMs: num("LLM_FIRST_CHUNK_TIMEOUT_MS", 90000),
  },
  embedding: {
    apiKey: embeddingApiKey,
    baseUrl: embeddingBaseUrl,
    model: opt("EMBEDDING_MODEL"),
    dim: num("EMBEDDING_DIM", 1536),
    // 审计 H2：embed() 底层继承 OpenAI SDK 默认 10 分钟超时——recall_memory 工具路径同步 await
    // embed，挂起会悬挂聊天工具执行；fillEmbedding 批量回填也逐条同步调用。默认 10s，够小 JSON
    // 向量请求；失败/超时仍 fail-open（embed 降级返回空向量，调用方不因此挡聊天）。
    timeoutMs: num("EMBEDDING_TIMEOUT_MS", 10000),
  },
  tts: {
    // F1/F4：真实合成在 synth.ts，模型名/采样率改为读以下字段（删 synth.ts 硬编码）
    modelPreset: opt("TTS_MODEL_PRESET", "mimo-v2.5-tts"),
    modelDesign: opt("TTS_MODEL_DESIGN", "mimo-v2.5-tts-voicedesign"),
    modelClone: opt("TTS_MODEL_CLONE", "mimo-v2.5-tts-voiceclone"),
    defaultVoice: opt("TTS_DEFAULT_VOICE", "苏打"), // F3：synth.ts 兜底音色
    sampleRate: num("TTS_SAMPLE_RATE", 24000),
    channels: num("TTS_CHANNELS", 1),
    bitDepth: num("TTS_BIT_DEPTH", 16),
    // 编排（pipeline.ts）：并发/超时/重试/切分
    maxConcurrency: num("TTS_MAX_CONCURRENCY", 2),
    synthTimeoutMs: num("TTS_SYNTH_TIMEOUT_MS", 12000),
    synthRetries: num("TTS_SYNTH_RETRIES", 2),
    retryBackoffMs: num("TTS_RETRY_BACKOFF_MS", 300),
    // 阶段二·合成单元聚合（替代 TTS_SENT_MIN_LEN_*）：首单元达 aggFirstMin 句末即发（首响优先），
    // 后续攒到将超 aggMax 才发（大单元优先）；单句超上限按逗号顿号二次切。真机数据：短句演绎不稳、40s 巨句撞超时。
    aggFirstMin: num("TTS_AGG_FIRST_MIN", 8),
    aggFirstMax: num("TTS_AGG_FIRST_MAX", 40),
    aggMin: num("TTS_AGG_MIN", 15),
    aggMax: num("TTS_AGG_MAX", 80),
    // 阶段二·尾静音裁剪：clone/design 合成后裁尾部静音、保留 N ms 自然收尾（0=关）
    trimTrailingMs: num("TTS_TRIM_TRAILING_MS", 150),
    forceFail: bool("TTS_FORCE_FAIL", false),
    // TTS_DEBUG（交接文档 六-1）：每句合成 WAV + meta.jsonl 落盘，供 scripts/tts-analyze|roundtrip 分析。生产默认关。
    debugDump: bool("TTS_DEBUG_DUMP", false),
    debugDumpDir: opt("TTS_DEBUG_DUMP_DIR", "data/tts-debug"),
  },
  stt: {
    model: opt("STT_MODEL", "mimo-v2.5-asr"), // F2：transcribe.ts 改读此字段
    defaultLanguage: opt("STT_DEFAULT_LANGUAGE", "auto"),
    defaultMime: opt("STT_DEFAULT_MIME", "audio/wav"),
    uploadMaxBytes: num("UPLOAD_MAX_BYTES", 26214400), // 25MB
    // 音频理解模型（scripts/tts-audition.ts 审听用）：注意 mimo-v2.5-pro 无音频理解能力，必须用 mimo-v2.5
    understandModel: opt("AUDIO_UNDERSTAND_MODEL", "mimo-v2.5"),
  },
  weather: {
    apiKey: opt("WEATHER_API_KEY", ""),
    apiHost: opt("WEATHER_API_HOST", "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    defaultCity: opt("WEATHER_DEFAULT_CITY", "上海"), // 保真原实现 WEATHER_DEFAULT_LOCATION.name='上海'（兜底默认须等于原硬编码）
    // 审计 H1：和风 API + IP 粗定位都是小 JSON 响应，用 AbortSignal.timeout() 一把梭即可（无需分阶段）。
    // 失败走各自既有 catch/降级路径（qw 抛错→上层兜底 mood；fetchIpLocation 抛错→前端手动选城市）。
    fetchTimeoutMs: num("WEATHER_FETCH_TIMEOUT_MS", 8000),
  },
  sqlite: {
    path: opt("SQLITE_PATH", "./data/regret-radio.db"),
  },
  voice: {
    mode: opt("VOICE_MODE", "preset") as "preset" | "design" | "clone",
    presetVoice: opt("VOICE_PRESET", "苏打"),
    designPrompt: opt("VOICE_DESIGN_PROMPT", ""),
    refAudioPath: opt("VOICE_REF_AUDIO", ""),
    refAudioBase64: "", // 启动时从 refAudioPath 加载
    // 阶段二重写为「导演模式+一致性锚」：角色/场景/指导三维度，锚死跨单元的音色/响度/语速一致（治症状2/3/4）
    style: opt(
      "VOICE_STYLE",
      "你是参考音频里的说话人，像跟熟人自然闲聊的口吻。整段保持同一音色和响度，语速中等偏快且全程一致，句间停顿自然简短，中英混读时发音自然连贯。",
    ),
  },
  // F5：记忆系统 35 项调参旋钮全部迁 env（默认值即原硬编码，行为不变，可经 .env 覆盖）
  memory: {
    sessionTtlSec: num("MEM_SESSION_TTL_SEC", 7 * 24 * 3600),
    corefactsTtlSec: num("MEM_COREFACTS_TTL_SEC", 300),
    recentMessagesN: num("MEM_RECENT_MESSAGES_N", 10),
    // F6：核心画像上限（原硬编码在 server.ts）
    coreProfile: {
      maxChars: num("MEM_CORE_PROFILE_MAX_CHARS", 1400),
      maxFacts: num("MEM_CORE_PROFILE_MAX_FACTS", 24),
      // LLM 合成器（2026-07-04 任务②，workers/profile-synthesis.ts）
      minSourceFacts: num("MEM_CORE_PROFILE_MIN_SOURCE_FACTS", 5),
      refreshCooldownHours: num("MEM_CORE_PROFILE_REFRESH_COOLDOWN_HOURS", 6),
      synthTimeoutMs: num("MEM_CORE_PROFILE_SYNTH_TIMEOUT_MS", 45000),
      maxPerTick: num("MEM_CORE_PROFILE_MAX_PER_TICK", 5),
    },
    pendingPromotion: {
      evidenceThreshold: num("MEM_PROMOTION_EVIDENCE_THRESHOLD", 2),
      timeWindowDays: num("MEM_PROMOTION_TIME_WINDOW_DAYS", 14),
      confidenceMin: num("MEM_PROMOTION_CONFIDENCE_MIN", 0.7),
    },
    /* ── Memory v2: 检索打分（relevance · recency · importance · confidence + 频率）── */
    retrieval: {
      poolSize: num("MEM_RETRIEVAL_POOL_SIZE", 40),
      topK: num("MEM_RETRIEVAL_TOPK", 6),
      halflifeDays: num("MEM_RETRIEVAL_HALFLIFE_DAYS", 20),
      wRelevance: num("MEM_RETRIEVAL_W_RELEVANCE", 0.45),
      wRecency: num("MEM_RETRIEVAL_W_RECENCY", 0.2),
      wImportance: num("MEM_RETRIEVAL_W_IMPORTANCE", 0.25),
      wConfidence: num("MEM_RETRIEVAL_W_CONFIDENCE", 0.05),
      wFrequency: num("MEM_RETRIEVAL_W_FREQUENCY", 0.05),
      mmrLambda: num("MEM_RETRIEVAL_MMR_LAMBDA", 0.7),
      defaultRelevance: num("MEM_RETRIEVAL_DEFAULT_RELEVANCE", 0.3),
    },
    /* ── Memory v3: 语义向量召回 ── */
    semanticRetrieval: {
      topK: num("MEM_SEMANTIC_TOPK", 6),
    },
    /* ── Memory v3: 分层 ── */
    tier: {
      demoteDays: num("MEM_TIER_DEMOTE_DAYS", 30),
    },
    /* ── Memory v3: LLM Rerank（仅 recall，fail-open）── */
    rerankLLM: {
      enabled: bool("MEM_RERANK_LLM_ENABLED", true),
      maxCandidates: num("MEM_RERANK_LLM_MAX_CANDIDATES", 20),
      timeoutMs: num("MEM_RERANK_LLM_TIMEOUT_MS", 4000),
    },
    /* ── Memory v3: 相似向量合并 ── */
    merge: {
      distanceThreshold: num("MEM_MERGE_DISTANCE_THRESHOLD", 0.2),
    },
    /* ── Memory v2: Gate 反幻觉护栏 ── */
    gate: {
      minConfidence: num("MEM_GATE_MIN_CONFIDENCE", 0.35),
    },
    /* ── 维护循环（2026-07-03 重构 D6：后台生命周期收编进主进程）── */
    maintenance: {
      intervalMs: num("MEM_MAINTENANCE_INTERVAL_MS", 5 * 60 * 1000),
    },
  },
  // 定时任务调度器（plans/2026-07-07-scheduled-tasks）。tickMs=轮询间隔；
  // maxStaleMs=陈旧上限（宕机期错过超过它就标 expired 不补发，别发一天前的提醒，§2.1）。
  scheduler: {
    tickMs: num("SCHED_TICK_MS", 15 * 1000),
    maxStaleMs: num("SCHED_MAX_STALE_MS", 6 * 60 * 60 * 1000),
  },
  // 阶段5 自主主动性（plans/2026-07-07-phase5-proactivity-plan §2 护栏闸表）。
  // 全部是确定性闸的参数——LLM 只握最后一道弃权权，频率/时段/在场绝不交给模型判。
  proactive: {
    dailyCapInterlude: num("PROACTIVE_DAILY_CAP", 3), // 曲间搭话日封顶（按 kind 分开计数）
    minGapSongs: num("PROACTIVE_MIN_GAP_SONGS", 5), // 每 N 首封顶（去重 track_id，skipped 计入）
    minGapMinutes: num("PROACTIVE_MIN_GAP_MINUTES", 10), // 距上条主动发言的时间下限（防连跳秒开）
    activeChatGapMin: num("PROACTIVE_ACTIVE_CHAT_GAP_MIN", 3), // 最近用户发言 N 分钟内=正在聊，别插嘴
    responseWindowInterludeMin: num("PROACTIVE_RESPONSE_WINDOW_MIN", 10), // 在场回应窗（分钟）
    responseWindowAwayHours: num("PROACTIVE_RESPONSE_WINDOW_AWAY_HOURS", 12), // 离场回应窗（小时，checkin/morning）
    ignoredWindowDays: num("PROACTIVE_IGNORED_WINDOW_DAYS", 7), // 降频统计滑窗（天）——让「哑」不至永久死锁
    llmTimeoutMs: num("PROACTIVE_LLM_TIMEOUT_MS", 20000), // 单句生成超时（同 discover-ai）；失败=沉默
  },
  // 音乐网关（M2-C）。本处仅声明已有消费方的项（避免死配置）：
  // C2 媒体代理用 userAgent + mediaProxyAllowlist（F10）；F8/F9/F12/cookie 等随 C3/C4 增补。
  music: {
    userAgent: opt(
      "MUSIC_USER_AGENT",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    // F10：媒体代理白名单（安全边界）外置；默认即原实现硬编码集合
    mediaProxyAllowlist: csv("MEDIA_PROXY_ALLOWLIST", [
      "music.126.net",
      "music.163.com",
      "126.net",
      "qq.com",
      "qpic.cn",
      "gtimg.cn",
      "qqmusic.qq.com",
    ]),
    // F8：节拍图缓存目录。原实现硬编码绝对盘符路径且禁 C 盘——换机即废。
    // 改可移植相对路径（相对 cwd 解析），并去掉 C 盘禁忌（单机私人电台就该落在 data/ 下）。
    beatCacheDir: opt("BEAT_CACHE_DIR", "data/beatmaps"),
    // C4d-1：登录 cookie 持久化路径（去 __dirname，落 data/）。gateway.cjs 读同名 env + 同默认；
    // cookie-store 门面经 gateway 读写，C6 切 SQLite 时此处保留作迁移参照。
    cookieFile: opt("NETEASE_COOKIE_FILE", "data/.cookie"),
    qqCookieFile: opt("QQ_COOKIE_FILE", "data/.qq-cookie"),
    // F9：双源开关（一键禁某音源）。默认全开（零回归）；禁用时该源路由由网关 onRequest 钩子短路返回 disabled。
    neteaseEnabled: bool("MUSIC_NETEASE_ENABLED", true),
    qqEnabled: bool("MUSIC_QQ_ENABLED", true),
    // F12：取址默认音质（无 quality 参数时的回退）。默认 hires 保真原行为；可降为 standard 省流。
    defaultQuality: opt("MUSIC_DEFAULT_QUALITY", "hires"),
    // 审计 H1：媒体代理上游 fetch 无超时会挂起连接长期占用进程资源。这两个超时只管「连接期」——
    // 响应头到达（fetch 的 Promise resolve）即达成目的、立即 clearTimeout，body 流式转发阶段
    // 绝不受影响（治「播放中的歌被超时打断」）。audio 略宽松（上游偶尔慢启动），cover 更严格（小图）。
    audioProxyConnectTimeoutMs: num("MEDIA_PROXY_AUDIO_TIMEOUT_MS", 15000),
    coverProxyConnectTimeoutMs: num("MEDIA_PROXY_COVER_TIMEOUT_MS", 8000),
  },
  // 飞书机器人通道（plans/2026-07-07）。凭据可选：缺失则飞书关闭（不影响网页/播放器）。
  // 配了 APP_ID+APP_SECRET → env 锁定（前端只读，仿 AI 提供方的 .env 锁定）；否则前端运行时配置。
  feishu: {
    appId: opt("FEISHU_APP_ID"),
    appSecret: opt("FEISHU_APP_SECRET"),
    domain: opt("FEISHU_DOMAIN", "feishu"), // feishu（国内 open.feishu.cn）| lark（国际 larksuite）
    // v1 单用户：所有飞书来的消息固定映射到这个 RegretRadio user_id（想与网页共享记忆就设成网页的 user_id）。
    userId: opt("FEISHU_USER_ID", "feishu_main"),
    // 国内飞书默认直连（旁路环境 HTTP(S)_PROXY）：用户给国际 VPN 设的代理不该套到域内飞书上，
    // 否则 VPN 一关，SDK 的 axios 就把飞书请求打到本地代理端口 → ECONNREFUSED（真机实锤）。
    // 若你的网络必须走代理才能到飞书（如公司内网），设 FEISHU_USE_PROXY=true 保留代理。
    useProxy: bool("FEISHU_USE_PROXY", false),
    // 收到消息时给用户那条消息贴的「在处理」表情（答完自动移除）。飞书 emoji_type，见官方表情文案说明。
    reactionEmoji: opt("FEISHU_REACTION_EMOJI", "OnIt"),
    // 审计 M5：SDK 的 Lark.defaultHttpInstance = axios.create()（无 timeout，SDK 源码级坐实），
    // 消息/表情等 REST 调用可无限挂。只注入到 Client（REST）；WSClient 长连的 httpInstance
    // 仅用于 pullConnectConfig 一次性握手且该调用自带显式 timeout:15000（SDK 源码级坐实，
    // per-request config 会覆盖 instance 级默认）——两者本就是独立关注点，不合并处理。
    httpTimeoutMs: num("FEISHU_HTTP_TIMEOUT_MS", 8000),
  },
  // ADR-8：日志体系。级别（全局 + 单域 LOG_<SCOPE>）在 logger.ts 的 resolveLevel 里
  // 按需读 env（域级覆盖需动态生效），其余静态项集中在此。
  log: {
    level: process.env.LOG_LEVEL ?? process.env.LOG ?? "info",
    toFile: bool("LOG_TO_FILE", true),
    // 调试日志接口默认关闭；仅本机排障时显式开启，避免把运行日志暴露为普通 API。
    debugEndpoint: bool("DEBUG_LOG_ENDPOINT", false),
    dir: opt("LOG_DIR", "data/logs"),
    maxDays: num("LOG_MAX_DAYS", 14),
    format: (opt("LOG_FORMAT", "pretty") === "json" ? "json" : "pretty") as "pretty" | "json",
    maxStr: num("LOG_MAX_STR", 500),
    maxArr: num("LOG_MAX_ARR", 20),
    maxDepth: num("LOG_MAX_DEPTH", 6),
    audioBytesOnly: bool("LOG_AUDIO_BYTES_ONLY", true),
    redactKeys: csv("LOG_REDACT", [
      "API_KEY",
      "Authorization",
      "cookie",
      "refAudioBase64",
      "wav_b64",
      "app_secret", // 飞书 App Secret（凭据，全链路脱敏）
      "appsecret",
      "tenant_access_token", // 飞书租户令牌（绝不进日志）
    ]).map((s) => s.toLowerCase()),
  },
};

/**
 * 启动时打印的“生效配置摘要”（脱敏）——直接消除“改了 .env 不生效”的困惑。
 * 凭据只显示是否已配置（set/missing），绝不打印明文。
 */
export function configSummary(): Record<string, unknown> {
  return {
    server: { host: config.server.host, port: config.server.port, logLevel: config.server.logLevel },
    security: { runtimeConfigEncryption: config.security.runtimeConfigMasterKey ? "configured" : "missing" },
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKey: config.llm.apiKey ? "set" : "missing",
      temperature: config.llm.defaultTemperature,
      chatTemperature: config.llm.chatTemperature,
      maxTokens: config.llm.maxTokens || "unset",
      thinkingDefault: config.llm.thinkingDefault,
    },
    embedding: {
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      dim: config.embedding.dim,
      apiKey: config.embedding.apiKey ? "set" : "missing",
    },
    voice: { mode: config.voice.mode, preset: config.voice.presetVoice },
    tts: { modelPreset: config.tts.modelPreset, sampleRate: config.tts.sampleRate, maxConcurrency: config.tts.maxConcurrency },
    stt: { model: config.stt.model },
    memory: { retrievalTopK: config.memory.retrieval.topK, gateMinConfidence: config.memory.gate.minConfidence, rerankLLM: config.memory.rerankLLM.enabled },
    weather: { defaultCity: config.weather.defaultCity, apiKey: config.weather.apiKey ? "set" : "missing" },
    sqlite: { path: config.sqlite.path },
    log: { level: config.log.level, toFile: config.log.toFile, dir: config.log.dir, format: config.log.format },
    music: {
      proxyAllowlist: config.music.mediaProxyAllowlist.length,
      neteaseEnabled: config.music.neteaseEnabled,
      qqEnabled: config.music.qqEnabled,
      defaultQuality: config.music.defaultQuality,
      beatCacheDir: config.music.beatCacheDir,
      cookieFile: config.music.cookieFile,
      qqCookieFile: config.music.qqCookieFile,
    },
  };
}
