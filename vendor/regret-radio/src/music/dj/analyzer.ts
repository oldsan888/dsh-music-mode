/**
 * 播客 DJ 节拍分析编排器（dj-beatmap DSP TS 化 · D5）——逐字保真下沉 legacy/dj-analyzer.cjs 的
 * analyzePodcastDjStream（行 740-758 路由器）/ analyzePodcastDjIntro（488-518 片头部分图）/
 * analyzePodcastDjRangeSamples（520-738 长曲多窗 byte-Range 采样投票合成）。
 *
 * 组装 D4 decode（decodePodcastDjEnergyRange / analyzePodcastDjStreamFull）+ D2 builder + D1 工具。三分支门限
 * （3300 / 7200 / 9000 / 14400）、shaped 采样分布、环形相位投票（phaseFromMap）、剖面插值（profileAt）、
 * 网格合成（pushRangeBeat）逐字。decode / HEAD fetch / 时钟经 deps 可注入，便于单测编排；真 WASM 解码靠真音频冒烟。
 */

import { clamp01, clampRange, percentile, median } from "./dsp.js";
import { buildBeatMapFromLowEnergy, type DjBeatMap } from "./beatmap.js";
import { decodePodcastDjEnergyRange, analyzePodcastDjStreamFull, type DecodeOpts } from "./decode.js";
import type { EnergyResult } from "./decode-core.js";
import { createLogger } from "../../logger.js";

const log = createLogger("music");

const FULL_STREAM_QUALITY_LIMIT_SEC = 7200;

type HeadFetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; redirect?: "error"; signal?: AbortSignal }) => Promise<{ headers: { get(k: string): string | null } }>;

export interface AnalyzeDeps {
  decodeRange?: (audioUrl: string, opts: DecodeOpts) => Promise<EnergyResult>;
  streamFull?: (audioUrl: string, opts: DecodeOpts) => Promise<DjBeatMap>;
  headFetch?: HeadFetchLike;
  now?: () => number;
}

interface ResolvedDeps {
  decodeRange: (audioUrl: string, opts: DecodeOpts) => Promise<EnergyResult>;
  streamFull: (audioUrl: string, opts: DecodeOpts) => Promise<DjBeatMap>;
  headFetch: HeadFetchLike;
  now: () => number;
}

function resolveDeps(deps: AnalyzeDeps): ResolvedDeps {
  return {
    decodeRange: deps.decodeRange || ((url, opts) => decodePodcastDjEnergyRange(url, opts)),
    streamFull: deps.streamFull || ((url, opts) => analyzePodcastDjStreamFull(url, opts)),
    headFetch: deps.headFetch || ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<{ headers: { get(k: string): string | null } }>),
    now: deps.now || Date.now,
  };
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 路由器：>3300 且 <=7200 走高音质整段流（失败回落 range）；>7200 走 range；否则整段流。 */
export async function analyzePodcastDjStream(audioUrl: string, opts: DecodeOpts = {}, deps: AnalyzeDeps = {}): Promise<DjBeatMap> {
  const d = resolveDeps(deps);
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) throw new Error("Invalid audio url");
  const durationSec = Math.max(0, Number(opts.durationSec) || 0);
  if (durationSec > 3300 && durationSec <= FULL_STREAM_QUALITY_LIMIT_SEC) {
    try {
      const map = await d.streamFull(audioUrl, Object.assign({}, opts, { preferQualityFullStream: true }));
      map.debug = Object.assign({}, map.debug || {}, { fullStreamQuality: true, requestedDurationSec: durationSec });
      return map;
    } catch (err) {
      log.warn("dj_full_stream_quality_fallback_range", { error: err instanceof Error ? err.message : String(err) });
      return analyzePodcastDjRangeSamples(audioUrl, opts, deps);
    }
  }
  if (durationSec > FULL_STREAM_QUALITY_LIMIT_SEC) {
    return analyzePodcastDjRangeSamples(audioUrl, opts, deps);
  }
  return d.streamFull(audioUrl, opts);
}

/** 片头部分图：解码前 introSec（+8 缓冲）→ 截帧 → builder，标 partial / partialUntilSec / fullDuration。 */
export async function analyzePodcastDjIntro(audioUrl: string, opts: DecodeOpts & { introSec?: number } = {}, deps: AnalyzeDeps = {}): Promise<DjBeatMap> {
  const d = resolveDeps(deps);
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) throw new Error("Invalid audio url");
  const requestedDuration = Math.max(0, Number(opts.durationSec) || 0);
  const introSec = clampRange(Number((opts as { introSec?: number }).introSec) || 180, 90, 240);
  const decoded = await d.decodeRange(audioUrl, { durationSec: introSec, userAgent: opts.userAgent, limitSec: introSec + 8 });
  const frameLimit = Math.max(1, Math.min(decoded.lowEnergy.length, Math.ceil((introSec + 2) / Math.max(0.001, decoded.hopSec || 0.01))));
  const lowEnergy = decoded.lowEnergy.slice(0, frameLimit);
  const hitEnergy = decoded.hitEnergy.slice(0, frameLimit);
  const mapDuration = Math.min(introSec, lowEnergy.length * decoded.hopSec);
  const map = buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, decoded.hopSec, mapDuration, d.now);
  map.partial = true;
  map.partialUntilSec = mapDuration;
  map.fullDuration = requestedDuration || 0;
  map.tempoSource = "podcast-dj-server-intro-offline";
  map.decode = Object.assign({}, decoded.decode || {}, {
    intro: true,
    requestedDurationSec: requestedDuration,
    effectiveDurationSec: decoded.duration,
    partialUntilSec: mapDuration,
  });
  map.debug = Object.assign({}, map.debug || {}, { intro: true, partialUntilSec: mapDuration });
  return map;
}

/** 长曲多窗采样：HEAD 取 content-length → shaped 采样点 → byte-Range 局部解码 builder → 相位投票合成贯穿网格。 */
export async function analyzePodcastDjRangeSamples(audioUrl: string, opts: DecodeOpts = {}, deps: AnalyzeDeps = {}): Promise<DjBeatMap> {
  const d = resolveDeps(deps);
  const duration = Math.max(0, Number(opts.durationSec) || 0);
  if (!duration) throw new Error("Long podcast analysis needs duration");

  let contentLength = 0;
  try {
    const head = await d.headFetch(audioUrl, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": opts.userAgent || DEFAULT_UA, Referer: "https://music.163.com/" },
    });
    contentLength = Number(head.headers.get("content-length") || 0) || 0;
  } catch {
    contentLength = 0;
  }
  if (!contentLength) {
    return d.streamFull(audioUrl, opts);
  }

  const sampleCount: number = duration > 14400 ? 12 : duration > 9000 ? 10 : 8;
  const sampleStarts: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const pos = sampleCount === 1 ? 0 : i / (sampleCount - 1);
    const shaped = i === 0 ? 0 : i === sampleCount - 1 ? 0.88 : 0.08 + pos * 0.80;
    sampleStarts.push(duration * shaped);
  }
  const sampleWindow = duration > 14400 ? 82 : duration > 9000 ? 88 : 96;
  const sampleMaps: Array<{ offset: number; map: DjBeatMap }> = [];
  let totalChunks = 0;
  let totalDecoded = 0;

  for (let i = 0; i < sampleStarts.length; i++) {
    const targetTime = Math.max(0, Math.min(duration - sampleWindow, sampleStarts[i]));
    const bytePerSec = contentLength / Math.max(1, duration);
    const prerollBytes = i === 0 ? 0 : Math.min(384 * 1024, Math.floor(bytePerSec * 4));
    const startByte = Math.max(0, Math.floor(targetTime * bytePerSec) - prerollBytes);
    const windowBytes = Math.max(768 * 1024, Math.floor(sampleWindow * bytePerSec) + prerollBytes + 128 * 1024);
    const endByte = Math.min(contentLength - 1, startByte + windowBytes);
    const approxOffset = (startByte / contentLength) * duration;
    const decoded = await d.decodeRange(audioUrl, {
      durationSec: sampleWindow,
      userAgent: opts.userAgent,
      range: "bytes=" + startByte + "-" + endByte,
    });
    totalChunks += decoded.decode.chunks || 0;
    totalDecoded += decoded.decode.decodedSamples || 0;
    const map = buildBeatMapFromLowEnergy(decoded.lowEnergy, decoded.hitEnergy, decoded.hopSec, decoded.duration || sampleWindow);
    if (map && map.visualBeatCount >= 8 && map.gridStep) {
      sampleMaps.push({ offset: approxOffset, map });
    }
  }

  if (!sampleMaps.length) {
    return {
      kicks: [],
      beats: [],
      pulseBeats: [],
      cameraBeats: [],
      duration,
      visualBeatCount: 0,
      tempoSource: "podcast-dj-server-range-empty",
      analyzedAt: d.now(),
    };
  }

  function phaseFromMap(map: DjBeatMap, baseStep: number): { phase: number; step: number } {
    const step = clampRange(baseStep || map.gridStep || 0.5, 0.32, 0.86);
    const beats = (map.cameraBeats && map.cameraBeats.length ? map.cameraBeats : map.beats || []).filter((b) => b && Number.isFinite(b.time) && b.time > 0.35);
    if (!beats.length) return { phase: 0, step };
    let sx = 0;
    let sy = 0;
    let total = 0;
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      const impact = b.impact == null ? b.strength || 0.3 : b.impact;
      const w = 0.2 + Math.pow(Math.max(0, impact), 1.45);
      const phase = ((b.time % step) + step) % step;
      const angle = (phase / step) * Math.PI * 2;
      sx += Math.cos(angle) * w;
      sy += Math.sin(angle) * w;
      total += w;
    }
    if (total <= 0) return { phase: ((beats[0].time % step) + step) % step, step };
    let angle = Math.atan2(sy / total, sx / total);
    if (angle < 0) angle += Math.PI * 2;
    return { phase: (angle / (Math.PI * 2)) * step, step };
  }

  const stepVotes: number[] = [];
  sampleMaps.forEach((s) => {
    const w = Math.max(1, Math.min(16, Math.round((s.map.visualBeatCount || 0) / 16)));
    for (let i = 0; i < w; i++) stepVotes.push(s.map.gridStep as number);
  });
  const globalStep = clampRange(median(stepVotes) || (sampleMaps[0].map.gridStep as number) || 0.5, 0.32, 0.86);
  const firstMap = sampleMaps[0].map;
  const firstBeat = (firstMap.cameraBeats || firstMap.beats || [])[0];
  let anchor = firstBeat && firstBeat.time ? firstBeat.time : 0;
  while (anchor - globalStep > 0.05) anchor -= globalStep;

  const profiles = sampleMaps
    .map((s) => {
      const beats = s.map.cameraBeats || s.map.beats || [];
      const impacts = beats.map((b) => (b.impact == null ? b.strength : b.impact)).filter((v) => Number.isFinite(v));
      const activeImpacts = impacts.filter((v) => v >= 0.1);
      const avgImpact = activeImpacts.length ? activeImpacts.reduce((a, b) => a + b, 0) / activeImpacts.length : 0.16;
      const hiImpact = impacts.length ? percentile(impacts, 0.9, 4000) : Math.max(0.55, avgImpact);
      const activity = beats.length / Math.max(20, s.map.duration || 20);
      const phaseInfo = phaseFromMap(s.map, globalStep);
      return {
        time: s.offset,
        avg: clampRange(avgImpact * clampRange(activity / 1.65, 0.38, 1.05), 0.08, 0.72),
        hi: clampRange(hiImpact, 0.18, 0.96),
        activity: clampRange(activity / 1.65, 0.18, 1.12),
        step: globalStep,
        anchor: s.offset + (phaseInfo.phase || 0),
      };
    })
    .sort((a, b) => a.time - b.time);

  function profileAt(time: number): { time: number; avg: number; hi: number; activity: number; step: number; anchor?: number } {
    if (profiles.length === 1) return profiles[0];
    let prev = profiles[0];
    let next = profiles[profiles.length - 1];
    for (let i = 0; i < profiles.length; i++) {
      if (profiles[i].time <= time) prev = profiles[i];
      if (profiles[i].time >= time) {
        next = profiles[i];
        break;
      }
    }
    if (prev === next) return prev;
    const mix = clamp01((time - prev.time) / Math.max(1, next.time - prev.time));
    return {
      time,
      avg: prev.avg + (next.avg - prev.avg) * mix,
      hi: prev.hi + (next.hi - prev.hi) * mix,
      activity: prev.activity + (next.activity - prev.activity) * mix,
      step: prev.step + (next.step - prev.step) * mix,
    };
  }

  const beats: any[] = [];
  let gridIndex = 0;
  function pushRangeBeat(t: number, stepOverride: number): void {
    const p = profileAt(t);
    const slot = gridIndex % 4;
    let combo = slot === 0 ? "downbeat" : slot === 1 ? "push" : slot === 2 ? "drop" : "rebound";
    const sectionEnergy = clamp01((p.avg - 0.055) / 0.54) * clampRange(p.activity || 0.5, 0.3, 1.1);
    const motion = (Math.sin(gridIndex * 1.618 + p.avg * 9.7) * 0.5 + Math.sin(gridIndex * 0.317) * 0.28) * (0.08 + sectionEnergy * 0.17);
    const rel = clamp01(0.12 + sectionEnergy * 0.7 + motion + (combo === "downbeat" ? 0.06 : 0));
    if (rel > 0.82 && combo !== "downbeat") combo = "accent";
    const visualRel = rel > 0.78 ? 0.78 + (rel - 0.78) * 0.5 : rel;
    const comboLift = combo === "downbeat" ? 0.1 * sectionEnergy : combo === "drop" ? 0.05 * sectionEnergy : combo === "accent" ? 0.075 * sectionEnergy : 0;
    const impact = clampRange(0.026 + Math.pow(visualRel, 1.48) * (0.42 + p.hi * 0.34) + comboLift, 0.02, 0.9);
    const strength = clampRange(0.15 + Math.pow(visualRel, 1.02) * 0.66 + comboLift * 0.68, 0.12, 0.93);
    const cameraActive = impact >= 0.105 || (combo === "downbeat" && sectionEnergy >= 0.16);
    const low = clampRange(0.5 + visualRel * 0.32 + (combo === "downbeat" ? 0.05 * sectionEnergy : 0) - (combo === "accent" ? 0.12 : 0), 0.42, 0.9);
    const body = clampRange(0.06 + visualRel * 0.15 + (combo === "push" ? 0.22 * sectionEnergy : 0) + (combo === "drop" ? 0.3 * sectionEnergy : 0), 0.045, 0.56);
    const snap = clampRange(0.025 + visualRel * 0.035 + (combo === "accent" ? 0.4 * sectionEnergy : 0) + (combo === "rebound" ? 0.12 * sectionEnergy : 0), 0.02, 0.62);
    beats.push({
      time: t,
      strength,
      confidence: 0.68 + visualRel * 0.22,
      impact,
      primary: cameraActive,
      camera: cameraActive,
      pulse: impact > 0.16 || (combo === "downbeat" && sectionEnergy >= 0.24),
      tone: "podcast-dj-server-range-grid",
      low,
      body,
      snap,
      mass: clampRange(low * 0.72 + Math.pow(visualRel, 1.22) * 0.24, 0.36, 0.94),
      sharpness: combo === "accent" ? 0.2 : 0.08,
      combo,
      step: stepOverride || p.step || globalStep,
      index: beats.length,
      dj: true,
      grid: true,
      kickOnly: true,
      server: true,
      sampled: true,
    });
    gridIndex++;
  }
  for (let si = 0; si < profiles.length; si++) {
    const p = profiles[si];
    const start = si === 0 ? 0 : (profiles[si - 1].time + p.time) * 0.5;
    const end = si === profiles.length - 1 ? duration : (p.time + profiles[si + 1].time) * 0.5;
    const localStep = globalStep;
    let t = Number.isFinite(p.anchor) ? p.anchor : anchor;
    while (t - localStep > start) t -= localStep;
    while (t < start) t += localStep;
    for (; t < end - 0.04; t += localStep) pushRangeBeat(t, localStep);
  }

  const cameraBeats = beats.filter((b) => b.camera !== false);
  const pulseBeats = beats
    .filter((b) => b.pulse !== false && (b.impact >= 0.16 || b.combo === "downbeat"))
    .map((b) => ({ time: b.time, strength: b.strength, impact: b.impact, combo: b.combo, low: b.low, body: b.body, snap: b.snap, dj: true }));

  return {
    kicks: beats.map((b) => b.time),
    beats,
    pulseBeats,
    cameraBeats,
    gridStep: globalStep,
    sectionSteps: profiles.map((p) => p.step),
    tempoSource: "podcast-dj-server-range-offline",
    duration,
    visualBeatCount: cameraBeats.length,
    analyzedAt: d.now(),
    debug: {
      rangeSampled: true,
      samples: sampleMaps.length,
      profiles,
      contentLength,
      decode: { chunks: totalChunks, decodedSamples: totalDecoded },
    },
  };
}
