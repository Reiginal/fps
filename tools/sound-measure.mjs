// 音を測る道具。tools/sound-lab.mjs（書き出して表を見る）と
// tools/check-sound.mjs（数字が悪化していないかの検査）が両方これを使う。
//
// 「軽い」「かっこいい」は感想だが、その正体は数字で出る。
//   ・低音の割合  … ここが空だと何をやっても軽い。迫力は250Hz以下が担う
//   ・重心        … エネルギーがどの高さに集まっているか。高いほど細く鋭い
//   ・長さ        … 短すぎると「ピッ」で終わって余韻の気持ちよさが出ない
//   ・山の数      … 倍音がいくつ立っているか。少ないと痩せて聞こえる
import { writeFileSync } from 'node:fs';
import { OfflineCtx } from './offline-audio.mjs';

export const SR = 48000;

/* 並びの最大値。**Math.max(...arr) を使わない。**
   3秒ぶんの波形（14万点）を展開すると引数が積めなくなって
   「Maximum call stack size exceeded」で落ちる。
   2.6秒までは通っていたので、長い音を測ろうとした時に初めて出た */
function maxOf(arr, floor = 0) {
  let m = floor;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/* ------------------------------------------------------------ 波形の解析 */

// 基数2のFFT。実部と虚部をその場で書き換える
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// 帯ごとの取り分。人が「重い/軽い」と感じる分かれ目に合わせて切ってある
export const BANDS = [
  ['超低 30-90Hz', 30, 90],
  ['低 90-250Hz', 90, 250],
  ['中低 250-800', 250, 800],
  ['中 800-2.5k', 800, 2500],
  ['高 2.5k-7k', 2500, 7000],
  ['超高 7k+', 7000, 20000],
];

export function analyze(L, R) {
  const n = L.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

  let peak = 0, peakAt = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) { peak = a; peakAt = i; }
  }

  // 鳴っている長さ。山から-40dBまで落ちきった所を終わりとみなす
  const floor = peak * 0.01;
  let end = 0;
  for (let i = n - 1; i >= 0; i--) if (Math.abs(mono[i]) > floor) { end = i; break; }

  // 立ち上がり。山の1割から山までにかかった時間
  let riseFrom = peakAt;
  for (let i = peakAt; i >= 0; i--) {
    if (Math.abs(mono[i]) < peak * 0.1) { riseFrom = i; break; }
  }

  let sum = 0;
  for (let i = 0; i < n; i++) sum += mono[i] * mono[i];
  const rms = Math.sqrt(sum / n);

  // 打点の数と、それぞれの大きさ。
  //
  // なぜ要るか: 「デデン」のように2発鳴らす音は、1発しか鳴っていなくても
  // 帯の取り分や重心は同じように出る。形そのものを数えないと
  // 「2発にした」が本当かどうかを確かめられない。
  //
  // 数え方は山の「際立ち」で見る。単純に敷居を超えた回数を数えると、
  // 余韻のノイズの揺れまで打点として拾って5〜6発と出た（実際そうなった）。
  // 2つの山の間が充分に凹んでいる時だけ、別々の打点として数える
  const W = Math.floor(SR * 0.004);   // 4msで均す
  const raw = new Float32Array(Math.ceil(n / W));
  for (let i = 0; i < raw.length; i++) {
    let m = 0;
    for (let k = i * W; k < Math.min(n, (i + 1) * W); k++) m = Math.max(m, Math.abs(mono[k]));
    raw[i] = m;
  }
  // 20msで均す。ノイズの細かい揺れを消して、打点の輪郭だけ残す
  const env = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let sm = 0, c = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(raw.length - 1, i + 2); k++) { sm += raw[k]; c++; }
    env[i] = sm / c;
  }
  const envPeak = maxOf(env, 1e-9);

  // 一度おさまってから、また大きくなった所を次の打点として数える。
  // 山の形を調べる方式も書いてみたが、余韻の細かい揺れの扱いで
  // こちらが2発、あちらが1発と食い違って、どちらが正しいのか判断できなかった。
  // 「45%を超えたら打点、20%を下回ったら次を待つ」なら読んで分かるし、
  // 実際の包み（1発目83 → 2 → 2発目100）とも一致する
  const ON = envPeak * 0.45;
  const OFF = envPeak * 0.20;
  const hitTimes = [];
  const hitLevels = [];
  let inHit = false;
  for (let i = 0; i < env.length; i++) {
    if (!inHit && env[i] >= ON) {
      inHit = true;
      hitTimes.push((i * W) / SR);
      hitLevels.push(env[i] / envPeak);
    } else if (inHit) {
      if (env[i] > hitLevels[hitLevels.length - 1] * envPeak) {
        hitLevels[hitLevels.length - 1] = env[i] / envPeak;
      }
      if (env[i] < OFF) inHit = false;
    }
  }

  // スペクトル。全体を1枚のFFTで見る。
  // 上限を65536(=1.36秒)にしていた時は、2秒かかる装填音の後半（ボルトが
  // 前進する音）が窓の外に落ちて、測っていたのが音の前半だけになっていた
  let N = 1;
  while (N < Math.min(n, 262144)) N <<= 1;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N && i < n; i++) {
    // ハン窓。窓を掛けないと端の切れ目が全周波数に漏れる
    re[i] = mono[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);

  const half = N / 2;
  const mag = new Float32Array(half);
  let total = 0;
  for (let i = 0; i < half; i++) {
    mag[i] = Math.hypot(re[i], im[i]);
    total += mag[i];
  }

  const bands = BANDS.map(([name, lo, hi]) => {
    let s = 0;
    const a = Math.floor((lo / SR) * N), b = Math.ceil((hi / SR) * N);
    for (let i = a; i < Math.min(half, b); i++) s += mag[i];
    return { name, pct: total ? (s / total) * 100 : 0 };
  });

  // 重心。エネルギーの中心がどの高さにあるか
  let num = 0;
  for (let i = 0; i < half; i++) num += (i * SR) / N * mag[i];
  const centroid = total ? num / total : 0;

  // 目立つ山。倍音がいくつ立っているかの目安
  const peaks = [];
  const maxMag = maxOf(mag, 0);
  for (let i = 2; i < half - 2; i++) {
    if (mag[i] > mag[i - 1] && mag[i] > mag[i + 1] && mag[i] > maxMag * 0.12) {
      peaks.push({ hz: (i * SR) / N, m: mag[i] });
    }
  }
  peaks.sort((a, b) => b.m - a.m);

  return {
    peak,
    rms,
    lenMs: ((end - riseFrom) / SR) * 1000,
    attackMs: ((peakAt - riseFrom) / SR) * 1000,
    bands,
    centroid,
    hits: hitTimes.length,
    // 打点ごとの大きさ（一番大きい所を1とした割合）。
    // 「デデン」は2発目が本命なので、2つ目の方が大きくないと形にならない
    hitLevels,
    // 打点の間隔(ms)。デデンの「デ」と「デン」がどれだけ離れているか
    gapMs: hitTimes.length > 1 ? (hitTimes[1] - hitTimes[0]) * 1000 : 0,
    peaks: peaks.slice(0, 6).map((p) => Math.round(p.hz)),
    lowPct: bands[0].pct + bands[1].pct,
  };
}

/* -------------------------------------------------------------- wav書き出し */

export function writeWav(path, L, R, trimTo) {
  const n = Math.min(L.length, trimTo || L.length);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const cl = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(cl(L[i]), 44 + i * 4);
    buf.writeInt16LE(cl(R[i]), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

/* ------------------------------------------------------------ 鳴らして測る */

/**
 * 音を1つ鳴らして、波形と解析結果を返す。
 * @param play  AudioEngineを受け取って音を鳴らす関数
 * @param wav   書き出し先。省略すると測るだけ
 */
export async function capture(play, { seconds = 2.0, wav = null } = {}) {
  const ctx = new OfflineCtx(SR);
  globalThis.window = globalThis.window || {};
  window.AudioContext = function () { return ctx; };
  const { AudioEngine } = await import('../src/core/audio.js');
  const a = new AudioEngine();
  // 環境音を切って起こす。切らないと測りたい音に環境音のうなりが被って
  // どの案も同じ数字になる（実際それで一度測り損ねた）
  a.init({ ambience: false });
  a.breathGain?.gain.setValueAtTime(0, 0);
  a.breathDepth?.gain.setValueAtTime(0, 0);
  play(a);
  const [L, R] = ctx.render(seconds);
  const info = analyze(L, R);
  if (wav) {
    // 無音の尻尾まで書き出すと、聴く時に間延びする
    const trim = Math.min(L.length, Math.floor(((info.lenMs + 120) / 1000) * SR));
    writeWav(wav, L, R, trim);
  }
  return info;
}
