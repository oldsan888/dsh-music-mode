/**
 * 离线播客 DJ 节拍分析的纯 DSP 数值工具 + RBJ 二阶 IIR 双二阶滤波器（dj-beatmap DSP TS 化 · D1）。
 *
 * 逐字保真下沉 legacy/dj-analyzer.cjs 行 4-64（clamp01 / clampRange / percentile / median / makeBiquad / runBiquad）。
 * 全为纯数值函数（runBiquad 就地推进滤波器状态，对同一输入序列确定性可测）。常量 / 公式 / 浮点表达式书写顺序
 * **逐字不可改**——IIR 反馈对累加顺序敏感，分位/兜底语义（`Number(v)||0`、空数组 → 0.001）也须保真。
 * 配套 tests/music-dj-dsp.test.ts 对拍 CJS（同输入 TS === CJS）。
 */

/** 钳到 [0,1]；`Number(v)||0` 兜底（NaN/空 → 0）。 */
export function clamp01(v: unknown): number {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

/** 强转数（NaN → 0）后钳到 [min,max]。兜底值是 0（非 min）。 */
export function clampRange(v: unknown, min: number, max: number): number {
  const n = Number(v) || 0;
  return Math.max(min, Math.min(max, n));
}

/**
 * 第 p 分位（先等距降采样到 maxSamples 再升序排序取值）。空输入 → 0.001；选中假值 → 0.001（保护后续除法分母）。
 * 不原地排原数组（slice 出新数组排序）。
 */
export function percentile(arr: ArrayLike<number> | null | undefined, p: number, maxSamples?: number): number {
  const len = arr ? arr.length : 0;
  if (!len) return 0.001;
  const ms = maxSamples || 16000;
  let sample: number[];
  if (len <= ms) {
    sample = Array.prototype.slice.call(arr) as number[];
  } else {
    sample = new Array(ms);
    const step = (len - 1) / (ms - 1);
    for (let i = 0; i < ms; i++) sample[i] = (arr as ArrayLike<number>)[Math.min(len - 1, Math.floor(i * step))] || 0;
  }
  sample.sort((a, b) => a - b);
  return sample[Math.max(0, Math.min(sample.length - 1, Math.floor(sample.length * p)))] || 0.001;
}

/** 中位（过滤非有限值后升序，偶数取右中位 floor(len*0.5)）；空 → 0。 */
export function median(vals: number[]): number {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length * 0.5)] : 0;
}

export interface BiquadState {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/**
 * RBJ Audio EQ Cookbook 双二阶系数（已除 a0 归一化）+ 零初始状态。
 * type==='highpass' 走高通，其余（含 'lowpass' 及任何字符串）走低通——不可改成枚举抛错。
 * freq 夹到 [8, sr*0.45]；Q 兜底 0.707。
 */
export function makeBiquad(type: string, freq: number, q: number, sr: number): BiquadState {
  freq = Math.max(8, Math.min(freq, sr * 0.45));
  const w0 = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * (q || 0.707));
  let b0: number, b1: number, b2: number;
  if (type === "highpass") {
    b0 = (1 + cos) * 0.5;
    b1 = -(1 + cos);
    b2 = (1 + cos) * 0.5;
  } else {
    b0 = (1 - cos) * 0.5;
    b1 = 1 - cos;
    b2 = (1 - cos) * 0.5;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const inv = 1 / a0;
  return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv, x1: 0, x2: 0, y1: 0, y2: 0 };
}

/** Direct Form I 单样本：先算 y，再推进状态 x2←x1←x、y2←y1←y。就地改 st。表达式顺序不可重排。 */
export function runBiquad(st: BiquadState, x: number): number {
  const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}
