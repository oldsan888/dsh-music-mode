import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }, // 串行,避免 DB 干扰
    setupFiles: ["./tests/setup.ts"],
    env: {
      // 测试使用独立数据库，不污染开发数据
      SQLITE_PATH: "./data/test.db",
      // 日志静默：避免新 scoped logger 在 79 个用例下刷屏 / 落盘污染
      LOG_LEVEL: "silent",
      LOG_TO_FILE: "false",
      RUNTIME_CONFIG_MASTER_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      // 强制关 TTS dump：开发 .env 常开着 TTS_DEBUG_DUMP=1，别让测试往 data/tts-debug 写垃圾
      // （tts-debug-dump.test.ts 用 vi.stubEnv 显式开，不受此影响）
      TTS_DEBUG_DUMP: "0",
    },
  },
});
