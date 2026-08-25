/**
 * 音质偏好归一与候选表（§3.1，netease+qq 共用归一入口）。纯函数，可单测。
 *
 * 行为保真（高危）：候选表内容与降级切片顺序、normalizeQualityPreference 的别名表与默认回退 'hires'
 * 一旦改动会改变取址的音质探测/降级链路。C4b 接 config.music.defaultQuality 时默认值仍应为 'hires'（零回归）。
 */

export interface QualityCandidate {
  level: string;
  label: string;
  br?: number;
  svip?: boolean;
  prefix?: string;
  ext?: string;
}

/** 网易云音质候选（降序：母带→高清→无损→极高→标准）。 */
export const NETEASE_QUALITY_CANDIDATES: QualityCandidate[] = [
  { level: "jymaster", br: 1999000, label: "超清母带", svip: true },
  { level: "hires", br: 1999000, label: "高清臻音" },
  { level: "lossless", br: 1411000, label: "无损" },
  { level: "exhigh", br: 999000, label: "极高" },
  { level: "standard", br: 128000, label: "标准" },
];

/** QQ 音质候选模板（文件前缀 + 扩展名 + 档位）。 */
export const QQ_QUALITY_CANDIDATE_TEMPLATES: QualityCandidate[] = [
  { prefix: "RS01", ext: ".flac", level: "hires", label: "Hi-Res FLAC" },
  { prefix: "F000", ext: ".flac", level: "lossless", label: "无损 FLAC" },
  { prefix: "M800", ext: ".mp3", level: "exhigh", label: "320k MP3" },
  { prefix: "M500", ext: ".mp3", level: "standard", label: "128k MP3" },
  { prefix: "C400", ext: ".m4a", level: "aac", label: "AAC/M4A" },
];

/** 把别名（master/flac/320/hq 等）归一到 5 档标准 level；空/未知一律回退 'hires'。 */
export function normalizeQualityPreference(value: unknown): string {
  const raw = String(value || "").toLowerCase().trim();
  if (["jymaster", "master", "studio", "svip"].includes(raw)) return "jymaster";
  if (["hires", "hi-res", "highres", "zhenyin", "spatial"].includes(raw)) return "hires";
  if (["lossless", "flac", "sq"].includes(raw)) return "lossless";
  if (["exhigh", "high", "320", "320k", "hq"].includes(raw)) return "exhigh";
  if (["standard", "normal", "128", "128k", "std"].includes(raw)) return "standard";
  return "hires";
}

/** 从归一后的目标档位在候选表里找起点并 slice（得到向下降级的探测序列）。 */
export function qualityCandidatesFrom(target: unknown, candidates: QualityCandidate[]): QualityCandidate[] {
  const normalized = normalizeQualityPreference(target);
  let start = candidates.findIndex((item) => item.level === normalized);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
