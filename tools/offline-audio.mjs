// WebAudioをNodeの中で実際に計算して、音の波形そのものを取り出す。
//
// なぜこれを書くか:
// これまで音は「聴いてもらって、駄目と言われたら勘で作り直す」しかなかった。
// こちらは音を聴けないので、1往復で1案しか試せず、5回作り直しても当たらなかった。
//
// だが音は波であって、波は数字で測れる。ブラウザが鳴らしているのと同じ計算を
// ここで回して波形を作れば、
//   ・低い音がどれだけ入っているか（「軽い」の正体はここが空なこと）
//   ・どれだけ長く鳴っているか
//   ・音の重心がどの高さにあるか
// を測れる。作った音がなぜ軽いのかを、勘ではなく数字で言えるようになる。
// さらに書き出したwavをそのまま渡せば、ゲームを起動せずに聴き比べてもらえる。
//
// 実装しているのはsrc/core/audio.jsが実際に使うノードだけ。
// 全部のWebAudioを再現する物ではない。

const SR = 48000;

/* ------------------------------------------------------------ 自動化の値 */

// 時刻で変化する値。WebAudioのAudioParamと同じ約束で動かす。
// ノードを繋ぐこともできる（LFOで音量や周波数を揺らす使い方）。
// 繋がった物は自動化の値に足し算される
class Param {
  constructor(value, ctx = null) {
    this.value = value;
    this.events = [];   // {type, time, value, tc}
    this.inputs = [];
    this.ctx = ctx;
    this._cache = null;
  }

  _push(e) {
    this.events.push(e);
    this.events.sort((a, b) => a.time - b.time);
    return this;
  }

  setValueAtTime(v, t) { return this._push({ type: 'set', time: t, value: v }); }
  linearRampToValueAtTime(v, t) { return this._push({ type: 'lin', time: t, value: v }); }
  exponentialRampToValueAtTime(v, t) { return this._push({ type: 'exp', time: t, value: v }); }
  setTargetAtTime(v, t, tc) { return this._push({ type: 'target', time: t, value: v, tc }); }
  cancelScheduledValues(t) {
    this.events = this.events.filter((e) => e.time < t);
    return this;
  }

  // ある時刻の値。前後の予定を見て、間を補間する
  at(t) {
    const ev = this.events;
    if (!ev.length) return this.value;
    if (t < ev[0].time) return ev[0].type === 'set' ? this.value : this.value;

    let i = 0;
    while (i + 1 < ev.length && ev[i + 1].time <= t) i++;
    const e = ev[i];
    const next = ev[i + 1];

    // 次が傾斜なら、そこへ向かって補間する
    if (next && (next.type === 'lin' || next.type === 'exp')) {
      const v0 = this._valueOfEvent(i);
      const span = next.time - e.time;
      const k = span > 0 ? (t - e.time) / span : 1;
      if (next.type === 'lin') return v0 + (next.value - v0) * k;
      // 指数の傾斜は0を跨げない。WebAudioと同じく極小値で下駄を履かせる
      const a = Math.max(1e-6, Math.abs(v0)) * Math.sign(v0 || 1);
      const b = Math.max(1e-6, Math.abs(next.value)) * Math.sign(next.value || 1);
      return a * Math.pow(b / a, k);
    }

    if (e.type === 'target') {
      const start = this._valueOfEvent(i, true);
      return e.value + (start - e.value) * Math.exp(-(t - e.time) / Math.max(1e-6, e.tc));
    }
    return this._valueOfEvent(i);
  }

  /**
   * n サンプルぶんの値を一気に作る。
   * 自動化で決まる値に、繋がっているノードの出力を足す。
   * 1サンプルずつ at() を呼ぶ作りだと、繋がった側を毎回描き直すことになる
   */
  values(n) {
    if (this._cache && this._cache.length === n) return this._cache;
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.at(i / sr);
    for (const src of this.inputs) {
      const [l, r] = src.render(n);
      for (let i = 0; i < n; i++) out[i] += (l[i] + r[i]) * 0.5;
    }
    this._cache = out;
    return out;
  }

  // i番目の予定が「始まる時点」の値
  _valueOfEvent(i, before = false) {
    const e = this.events[i];
    if (e.type === 'target' && before) {
      return i > 0 ? this._valueOfEvent(i - 1) : this.value;
    }
    if (e.type === 'target') return e.value;
    return e.value;
  }
}

/* ---------------------------------------------------------------- ノード */

let nextId = 1;

class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this.id = nextId++;
    this.inputs = [];
    this._out = null;
  }

  // 繋ぎ先はノードでもパラメータでもよい。
  // パラメータへ繋ぐのは、音量や周波数を別の音で揺らす使い方（LFO）
  connect(dst) {
    if (dst && dst.inputs && !dst.inputs.includes(this)) dst.inputs.push(this);
    return dst;
  }

  disconnect() {
    for (const n of this.ctx.nodes) {
      const i = n.inputs.indexOf(this);
      if (i >= 0) n.inputs.splice(i, 1);
      for (const k of Object.keys(n)) {
        const p = n[k];
        if (p && p.inputs && p !== n) {
          const j = p.inputs.indexOf(this);
          if (j >= 0) p.inputs.splice(j, 1);
        }
      }
    }
  }

  // 入力を全部足した物。左右2本で持つ
  _sumInputs(n) {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (const src of this.inputs) {
      const [l, r] = src.render(n);
      for (let i = 0; i < n; i++) { L[i] += l[i]; R[i] += r[i]; }
    }
    return [L, R];
  }

  // 一度計算したら覚えておく。1つのノードが複数へ繋がっていても2回計算しない
  render(n) {
    if (this._out) return this._out;
    // 循環していたら無音を返して止める（本来この作りに循環は無い）
    this._out = [new Float32Array(n), new Float32Array(n)];
    const got = this._process(n);
    this._out = got;
    return got;
  }

  _process(n) { return this._sumInputs(n); }
}

class GainNode extends Node {
  constructor(ctx) { super(ctx); this.gain = new Param(1, ctx); }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    const g = this.gain.values(n);
    for (let i = 0; i < n; i++) { L[i] *= g[i]; R[i] *= g[i]; }
    return [L, R];
  }
}

class OscillatorNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.type = 'sine';
    this.frequency = new Param(440, ctx);
    this.detune = new Param(0, ctx);
    this._start = Infinity;
    this._stop = Infinity;
  }

  start(t = 0) { this._start = t; }
  stop(t) { this._stop = t; }

  _process(n) {
    const sr = this.ctx.sampleRate;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let phase = 0;
    const a = Math.max(0, Math.floor(this._start * sr));
    const b = Math.min(n, Math.floor((this._stop === Infinity ? n / sr : this._stop) * sr));
    const fv = this.frequency.values(n);
    const dv = this.detune.values(n);
    for (let i = a; i < b; i++) {
      const f = Math.max(0, fv[i] * Math.pow(2, dv[i] / 1200));
      phase += f / sr;
      if (phase > 1) phase -= Math.floor(phase);
      const p = phase;
      let v;
      switch (this.type) {
        case 'square': v = p < 0.5 ? 1 : -1; break;
        case 'sawtooth': v = 2 * p - 1; break;
        case 'triangle': v = 4 * Math.abs(p - 0.5) - 1; break;
        default: v = Math.sin(p * Math.PI * 2);
      }
      L[i] = v; R[i] = v;
    }
    return [L, R];
  }
}

class BufferSourceNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new Param(1, ctx);
    this._start = Infinity;
    this._offset = 0;
    this._stop = Infinity;
  }

  start(t = 0, offset = 0) { this._start = t; this._offset = offset; }
  stop(t) { this._stop = t; }

  _process(n) {
    const sr = this.ctx.sampleRate;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    if (!this.buffer) return [L, R];
    const d = this.buffer.getChannelData(0);
    const len = d.length;
    let pos = this._offset * sr;
    const a = Math.max(0, Math.floor(this._start * sr));
    const b = Math.min(n, Math.floor((this._stop === Infinity ? n / sr : this._stop) * sr));
    const rv = this.playbackRate.values(n);
    for (let i = a; i < b; i++) {
      const rate = rv[i];
      let p = pos;
      if (this.loop) p %= len;
      else if (p >= len) break;
      // 線形補間。整数で拾うと再生速度を変えた時に段が出る
      const i0 = Math.floor(p);
      const i1 = this.loop ? (i0 + 1) % len : Math.min(len - 1, i0 + 1);
      const fr = p - i0;
      const v = d[i0] * (1 - fr) + d[i1] * fr;
      L[i] = v; R[i] = v;
      pos += rate;
    }
    return [L, R];
  }
}

// RBJのフィルタ係数。lowpass/highpass/bandpassだけ実装する
class BiquadFilterNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new Param(350, ctx);
    this.Q = new Param(1, ctx);
    this.gain = new Param(0, ctx);
  }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    const sr = this.ctx.sampleRate;
    // 係数は64サンプルごとに作り直す。周波数を動かす使い方が少ないので十分
    const BLOCK = 64;
    const fv = this.frequency.values(n);
    const qv = this.Q.values(n);
    for (const ch of [L, R]) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let s = 0; s < n; s += BLOCK) {
        const f0 = Math.min(sr * 0.49, Math.max(10, fv[s]));
        const q = Math.max(0.0001, qv[s]);
        const w0 = (2 * Math.PI * f0) / sr;
        const cw = Math.cos(w0), sw = Math.sin(w0);
        const alpha = sw / (2 * q);
        let b0, b1, b2, a0, a1, a2;
        if (this.type === 'highpass') {
          b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
          a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        } else if (this.type === 'bandpass') {
          b0 = alpha; b1 = 0; b2 = -alpha;
          a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        } else {
          b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
          a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
        const end = Math.min(n, s + BLOCK);
        for (let i = s; i < end; i++) {
          const x0 = ch[i];
          const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          ch[i] = y0;
        }
      }
    }
    return [L, R];
  }
}

// 音を歪ませる。WaveShaperは「軽い音を太くする」ための本命なので実装する
class WaveShaperNode extends Node {
  constructor(ctx) { super(ctx); this.curve = null; this.oversample = 'none'; }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    if (!this.curve) return [L, R];
    const c = this.curve;
    const m = c.length - 1;
    for (const ch of [L, R]) {
      for (let i = 0; i < n; i++) {
        // -1..1 を曲線の添字へ写す
        const x = Math.min(1, Math.max(-1, ch[i]));
        const p = ((x + 1) / 2) * m;
        const i0 = Math.floor(p);
        const i1 = Math.min(m, i0 + 1);
        const fr = p - i0;
        ch[i] = c[i0] * (1 - fr) + c[i1] * fr;
      }
    }
    return [L, R];
  }
}

class StereoPannerNode extends Node {
  constructor(ctx) { super(ctx); this.pan = new Param(0, ctx); }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    const pv = this.pan.values(n);
    for (let i = 0; i < n; i++) {
      const p = Math.min(1, Math.max(-1, pv[i]));
      const a = ((p + 1) * Math.PI) / 4;
      const l = Math.cos(a), r = Math.sin(a);
      const mono = (L[i] + R[i]) * 0.5;
      L[i] = mono * l * 1.414;
      R[i] = mono * r * 1.414;
    }
    return [L, R];
  }
}

class DelayNode extends Node {
  constructor(ctx) { super(ctx); this.delayTime = new Param(0, ctx); }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    const sr = this.ctx.sampleRate;
    const oL = new Float32Array(n), oR = new Float32Array(n);
    const dv = this.delayTime.values(n);
    for (let i = 0; i < n; i++) {
      const d = Math.floor(dv[i] * sr);
      const j = i - d;
      if (j >= 0) { oL[i] = L[j]; oR[i] = R[j]; }
    }
    return [oL, oR];
  }
}

// 畳み込み。残響のIRは長いので、間引いた多点の反射で近似する。
// キル音は残響を通らない（postBusへ直に出る）ので、ここの精度は結果に効かない
class ConvolverNode extends Node {
  constructor(ctx) { super(ctx); this.buffer = null; }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    if (!this.buffer) return [L, R];
    const ir = this.buffer.getChannelData(0);
    const sr = this.ctx.sampleRate;
    const oL = new Float32Array(n), oR = new Float32Array(n);
    // IRから96点だけ拾って反射として足す
    const TAPS = 96;
    const stepN = Math.max(1, Math.floor(ir.length / TAPS));
    for (let k = 0; k < TAPS; k++) {
      const idx = k * stepN;
      if (idx >= ir.length) break;
      const amp = ir[idx] * stepN * 0.02;
      if (Math.abs(amp) < 1e-5) continue;
      const d = Math.floor((idx / ir.length) * (ir.length / sr) * sr);
      for (let i = d; i < n; i++) {
        oL[i] += L[i - d] * amp;
        oR[i] += R[i - d] * amp;
      }
    }
    return [oL, oR];
  }
}

// 単純な圧縮。閾値を超えたぶんを比で押さえ、時定数で戻す
class DynamicsCompressorNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.threshold = new Param(-24, ctx);
    this.knee = new Param(30, ctx);
    this.ratio = new Param(12, ctx);
    this.attack = new Param(0.003, ctx);
    this.release = new Param(0.25, ctx);
    this.reduction = 0;
  }

  _process(n) {
    const [L, R] = this._sumInputs(n);
    const sr = this.ctx.sampleRate;
    const th = this.threshold.value;
    const ratio = Math.max(1, this.ratio.value);
    const aC = Math.exp(-1 / (sr * Math.max(0.0001, this.attack.value)));
    const rC = Math.exp(-1 / (sr * Math.max(0.0001, this.release.value)));
    let env = 0;
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const c = lvl > env ? aC : rC;
      env = c * env + (1 - c) * lvl;
      const db = 20 * Math.log10(Math.max(1e-8, env));
      let g = 1;
      if (db > th) g = Math.pow(10, ((th + (db - th) / ratio) - db) / 20);
      L[i] *= g; R[i] *= g;
    }
    return [L, R];
  }
}

/* -------------------------------------------------------------- 文脈本体 */

export class OfflineCtx {
  constructor(sampleRate = SR) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = [];
    this.destination = this._reg(new Node(this));
  }

  _reg(n) { this.nodes.push(n); return n; }

  createGain() { return this._reg(new GainNode(this)); }
  createOscillator() { return this._reg(new OscillatorNode(this)); }
  createBiquadFilter() { return this._reg(new BiquadFilterNode(this)); }
  createBufferSource() { return this._reg(new BufferSourceNode(this)); }
  createStereoPanner() { return this._reg(new StereoPannerNode(this)); }
  createDelay() { return this._reg(new DelayNode(this)); }
  createConvolver() { return this._reg(new ConvolverNode(this)); }
  createWaveShaper() { return this._reg(new WaveShaperNode(this)); }
  createDynamicsCompressor() { return this._reg(new DynamicsCompressorNode(this)); }

  createBuffer(channels, length) {
    const data = [];
    for (let i = 0; i < channels; i++) data.push(new Float32Array(length));
    return {
      length, numberOfChannels: channels, sampleRate: this.sampleRate,
      getChannelData: (i) => data[i],
    };
  }

  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }

  /** 積んだ予定を全部計算して、左右の波形を返す */
  render(seconds) {
    const n = Math.floor(seconds * this.sampleRate);
    for (const node of this.nodes) {
      node._out = null;
      for (const k of Object.keys(node)) {
        if (node[k] && node[k] instanceof Param) node[k]._cache = null;
      }
    }
    return this.destination.render(n);
  }
}
