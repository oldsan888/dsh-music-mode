/**
 * 解码 / 取流 IO 层（dj-beatmap DSP TS 化 · D4）——逐字保真下沉 legacy/dj-analyzer.cjs 的
 * decodePodcastDjEnergyRange（行 384-486）与 analyzePodcastDjStreamFull（行 760-858）。
 *
 * mpg123-decoder（WASM）解码 + HTTP 取流（UA / Referer / 可选 Range）；纯 DSP 累积复用 D3 makeEnergyAccumulator、
 * 节拍图复用 D2 builder。WASM / 网络经 deps 可注入（loadDecoder / fetchFn）——单测注入假依赖验 IO 编排（reader 循环 /
 * limitSec 早停 / tail flush / decoder.free / Range / throw 条件），真 WASM 解码靠真音频冒烟（端到端对拍 CJS）。
 */

import { makeEnergyAccumulator, type DecodedChunk, type EnergyResult } from "./decode-core.js";
import { buildBeatMapFromLowEnergy, type DjBeatMap } from "./beatmap.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface MpegDecoderLike {
  ready: Promise<unknown>;
  decode(data: Uint8Array): DecodedChunk;
  free(): void;
}
interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | ArrayLike<number> | null }>;
  cancel(): Promise<void> | void;
}
interface ResponseLike {
  ok: boolean;
  status: number;
  body: { getReader(): ReaderLike } | null;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; redirect?: "error"; signal?: AbortSignal }) => Promise<ResponseLike>;

export interface DecodeDeps {
  loadDecoder?: () => Promise<MpegDecoderLike>;
  fetchFn?: FetchLike;
}

export interface DecodeOpts {
  durationSec?: number;
  limitSec?: number;
  range?: string;
  userAgent?: string;
  preferQualityFullStream?: boolean;
}

const MAX_DECODE_BYTES = 128 * 1024 * 1024;
const MAX_DECODE_WALL_MS = 2 * 60 * 1000;

async function defaultLoadDecoder(): Promise<MpegDecoderLike> {
  const mod = (await import("mpg123-decoder")) as { MPEGDecoder: new (o: { enableGapless: boolean }) => MpegDecoderLike };
  const decoder = new mod.MPEGDecoder({ enableGapless: false });
  await decoder.ready;
  return decoder;
}

function toUint8(value: Uint8Array | ArrayLike<number>): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** decodePodcastDjEnergyRange：HTTP 取流 + mpg123 解码 → 能量包络（limitSec 早停 / Range 局部解码）。 */
export async function decodePodcastDjEnergyRange(audioUrl: string, opts: DecodeOpts = {}, deps: DecodeDeps = {}): Promise<EnergyResult> {
  const loadDecoder = deps.loadDecoder || defaultLoadDecoder;
  const fetchFn = deps.fetchFn || (fetch as unknown as FetchLike);
  const durationHint = Math.max(0, Number(opts.durationSec) || 0);
  const hopSec = durationHint > 4200 ? 0.0125 : 0.01;
  const limitSec = Math.max(0, Number(opts.limitSec) || 0);
  const acc = makeEnergyAccumulator(hopSec);
  let chunks = 0;
  let receivedBytes = 0;
  const decoder = await loadDecoder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_DECODE_WALL_MS);
  try {
    const headers: Record<string, string> = { "User-Agent": opts.userAgent || DEFAULT_UA, Referer: "https://music.163.com/" };
    if (opts.range) headers.Range = opts.range;
    const resp = await fetchFn(audioUrl, { headers, redirect: "error", signal: controller.signal });
    if (!resp.ok && resp.status !== 206) throw new Error("Audio fetch failed: " + resp.status);
    if (!resp.body) throw new Error("Audio response has no body");
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      receivedBytes += value.length;
      if (receivedBytes > MAX_DECODE_BYTES) { await reader.cancel(); throw new Error("Audio response exceeds decode limit"); }
      chunks++;
      acc.feed(decoder.decode(toUint8(value)));
      if (limitSec && acc.effectiveSr && acc.effectiveSamples / acc.effectiveSr >= limitSec) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      if (chunks % 12 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    acc.feed(decoder.decode(new Uint8Array(0)));
  } finally {
    clearTimeout(timeout);
    decoder.free();
  }
  return acc.finalize(chunks);
}

/** analyzePodcastDjStreamFull：整段流式解码（无 Range / 无 limitSec）→ 节拍图 + 附加 decode 字段。 */
export async function analyzePodcastDjStreamFull(audioUrl: string, opts: DecodeOpts = {}, deps: DecodeDeps = {}): Promise<DjBeatMap> {
  const loadDecoder = deps.loadDecoder || defaultLoadDecoder;
  const fetchFn = deps.fetchFn || (fetch as unknown as FetchLike);
  const durationHint = Math.max(0, Number(opts.durationSec) || 0);
  const hopSec = durationHint > 9000 ? 0.0125 : 0.01;
  const acc = makeEnergyAccumulator(hopSec);
  let chunks = 0;
  let receivedBytes = 0;
  const decoder = await loadDecoder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_DECODE_WALL_MS);
  try {
    const resp = await fetchFn(audioUrl, { redirect: "error", signal: controller.signal, headers: { "User-Agent": opts.userAgent || DEFAULT_UA, Referer: "https://music.163.com/" } });
    if (!resp.ok || !resp.body) throw new Error("Audio fetch failed: " + resp.status);
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      receivedBytes += value.length;
      if (receivedBytes > MAX_DECODE_BYTES) { await reader.cancel(); throw new Error("Audio response exceeds decode limit"); }
      chunks++;
      acc.feed(decoder.decode(toUint8(value)));
      if (chunks % 12 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    acc.feed(decoder.decode(new Uint8Array(0)));
  } finally {
    clearTimeout(timeout);
    decoder.free();
  }
  const result = acc.finalize(chunks);
  const effectiveDuration = result.duration;
  const duration = effectiveDuration || durationHint;
  const map = buildBeatMapFromLowEnergy(result.lowEnergy, result.hitEnergy, result.hopSec, duration);
  map.decode = {
    chunks,
    decodedSamples: result.decode.decodedSamples,
    sampleRate: result.decode.sampleRate,
    effectiveSampleRate: result.decode.effectiveSampleRate,
    frames: result.decode.frames,
    requestedDurationSec: durationHint,
    effectiveDurationSec: effectiveDuration,
    fullStreamQuality: !!opts.preferQualityFullStream,
  };
  return map;
}
