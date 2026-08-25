/**
 * 解码能量内核（dj-beatmap DSP TS 化 · D3）——把 legacy/dj-analyzer.cjs 的 decodePodcastDjEnergyRange 内
 * **纯 DSP 部分**（initFilters / processDecoded / pushFrame，行 407-443）抽出为可注入、可单测的内核：
 * 单声道下混 → 串联 hp(32Hz)/lp(178Hz) biquad → 按 sampleStep 抽点 → 帧 RMS(low)/峰值(hit) 聚合 → hopSize 分帧。
 *
 * IO（mpg123 WASM 解码 + HTTP 取流）留 D4；D4 每拿到一个 decode result 调 feed()，结束调 finalize(chunks)。
 * 逻辑逐字保真（biquad 复用 D1 已对拍的 makeBiquad/runBiquad），常量 sampleStep 档位 / hopSize / 下混 0.5 不可改。
 */

import { makeBiquad, runBiquad, type BiquadState } from "./dsp.js";

export interface EnergyFilters {
  sampleStep: number;
  effectiveSr: number;
  hopSize: number;
  hp: BiquadState;
  lp: BiquadState;
}

/** 对应 initFilters：按采样率定抽点档位与 effectiveSr/hopSize，建 hp/lp 双二阶。纯工厂。 */
export function makeEnergyFilters(sampleRate: number, hopSec: number): EnergyFilters {
  const sampleStep = sampleRate >= 44100 ? 4 : sampleRate >= 32000 ? 3 : 2;
  const effectiveSr = sampleRate / sampleStep;
  const hopSize = Math.max(80, Math.floor(effectiveSr * hopSec));
  const hp = makeBiquad("highpass", 32, 0.72, effectiveSr);
  const lp = makeBiquad("lowpass", 178, 0.82, effectiveSr);
  return { sampleStep, effectiveSr, hopSize, hp, lp };
}

/** mpg123-decoder 单次 decode 输出的子集（feed 所需）。 */
export interface DecodedChunk {
  samplesDecoded?: number;
  channelData?: Array<ArrayLike<number>>;
  sampleRate?: number;
}

export interface EnergyResult {
  lowEnergy: number[];
  hitEnergy: number[];
  hopSec: number;
  duration: number;
  decode: {
    chunks: number;
    decodedSamples: number;
    sampleRate: number;
    effectiveSampleRate: number;
    frames: number;
  };
}

export interface EnergyAccumulator {
  feed(result: DecodedChunk): void;
  finalize(chunks: number): EnergyResult;
  /** 供 IO 层 limitSec 早停判断（effectiveSamples / effectiveSr >= limitSec）。 */
  readonly effectiveSr: number;
  readonly effectiveSamples: number;
}

/**
 * 纯能量累积内核。状态封闭，feed() 逐 decode result 累积（首个 result 据其 sampleRate 懒初始化滤波器），
 * finalize() 补尾帧并返回 {lowEnergy,hitEnergy,hopSec,duration,decode}。biquad 状态跨 feed 连续（不可重置）。
 */
export function makeEnergyAccumulator(hopSec: number): EnergyAccumulator {
  const lowEnergy: number[] = [];
  const hitEnergy: number[] = [];
  let hp: BiquadState | null = null;
  let lp: BiquadState | null = null;
  let effectiveSr = 0;
  let sampleStep = 1;
  let hopSize = 0;
  let frameSum = 0;
  let framePeak = 0;
  let frameCount = 0;
  let effectiveSamples = 0;
  let decodedSamples = 0;

  function initFilters(sampleRate: number): void {
    if (effectiveSr) return;
    const f = makeEnergyFilters(sampleRate, hopSec);
    sampleStep = f.sampleStep;
    effectiveSr = f.effectiveSr;
    hopSize = f.hopSize;
    hp = f.hp;
    lp = f.lp;
  }

  function pushFrame(): void {
    const count = Math.max(1, frameCount);
    lowEnergy.push(Math.sqrt(frameSum / count));
    hitEnergy.push(framePeak);
    frameSum = 0;
    framePeak = 0;
    frameCount = 0;
  }

  function feed(result: DecodedChunk): void {
    if (!result || !result.samplesDecoded || !result.channelData || !result.channelData.length) return;
    const sr = result.sampleRate || 44100;
    initFilters(sr);
    const left = result.channelData[0];
    const right = result.channelData[1];
    const n = Math.min(result.samplesDecoded, left ? left.length : 0, right ? right.length : left ? left.length : 0);
    decodedSamples += n;
    for (let i = 0; i < n; i += sampleStep) {
      const x = right ? ((left[i] || 0) + (right[i] || 0)) * 0.5 : left[i] || 0;
      const y = runBiquad(lp as BiquadState, runBiquad(hp as BiquadState, x));
      const ay = Math.abs(y);
      frameSum += y * y;
      if (ay > framePeak) framePeak = ay;
      frameCount++;
      effectiveSamples++;
      if (frameCount >= hopSize) pushFrame();
    }
  }

  function finalize(chunks: number): EnergyResult {
    if (frameCount > 0) pushFrame();
    return {
      lowEnergy,
      hitEnergy,
      hopSec,
      duration: effectiveSr ? effectiveSamples / effectiveSr : 0,
      decode: {
        chunks,
        decodedSamples,
        sampleRate: effectiveSr ? effectiveSr * sampleStep : 0,
        effectiveSampleRate: effectiveSr,
        frames: lowEnergy.length,
      },
    };
  }

  return {
    feed,
    finalize,
    get effectiveSr() {
      return effectiveSr;
    },
    get effectiveSamples() {
      return effectiveSamples;
    },
  };
}
