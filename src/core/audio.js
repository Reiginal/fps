// 音源ファイルを持たず、ノイズとフィルタで効果音を合成する。
// 銃声は距離で「音量が変わる」のではなく「別の音になる」。近くは乾いたクラック、
// 中距離は残響が主役、遠くは低音のドスンだけが届く。ここを作り分けないと
// どれだけ層を重ねても平坦に聞こえる。
import { VOLUME_DEF } from './settings.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
// 0→1の滑らかな遷移。距離帯の混ぜ具合に使う
const step = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const SOUND_SPEED = 343;

// 足音の素材別パラメータ。踏み込みの低音・粒立ち・共鳴で「踏んだ物」を作り分ける。
// partialsは非整数比にしてある。整数比にすると楽器の音程に聞こえて金属に感じない
const SURFACES = {
  dirt:     { lp: 950,  thump: 74,  decay: 0.055, grit: 0.55, gritFreq: 2400, gritQ: 0.9, ring: 0,    partials: null,             vol: 1.0 },
  gravel:   { lp: 1150, thump: 80,  decay: 0.05,  grit: 0.8,  gritFreq: 3200, gritQ: 0.8, ring: 0,    partials: null,             vol: 1.0 },
  asphalt:  { lp: 1700, thump: 96,  decay: 0.042, grit: 0.34, gritFreq: 3800, gritQ: 1.1, ring: 0,    partials: null,             vol: 0.95 },
  concrete: { lp: 1900, thump: 104, decay: 0.04,  grit: 0.3,  gritFreq: 4200, gritQ: 1.3, ring: 0.08, partials: [820, 1970],      vol: 0.95 },
  // ringを0.62から0.10へ、倍音も3本から2本の低い所へ落とす。
  // 前は186/471/1237Hzという調律された倍音を長い余韻付きで鳴らしていて、
  // これは「叩かれた金属の棒」＝鉄琴の作り方そのものだった。
  // 実際の鉄板は踏むと鳴るのではなく「ぼこっ」と凹んで軋む。
  // 余韻を削って、倍音を濁った近い2本にすると打楽器に聞こえなくなる
  metal:    { lp: 1900, thump: 124, decay: 0.062, grit: 0.30, gritFreq: 4200, gritQ: 1.1, ring: 0.10, partials: [173, 268], vol: 0.95 },
  wood:     { lp: 1400, thump: 128, decay: 0.055, grit: 0.22, gritFreq: 2100, gritQ: 1.2, ring: 0.34, partials: [243, 617, 1490], vol: 0.9 },
};

/**
 * 倒した合図の候補。遊びながらKキーで切り替えて聴き比べる。
 *
 * なぜ候補を並べるのか: 「気持ちよくない」と言われるたびに1案ずつ作り直して
 * 5回外した。こちらは音を聴けないので、1往復で1案しか試せないやり方だと
 * いつまでも当たらない。質感の方向が違う案を先に並べて、その場で比べてもらう。
 *
 * 5案は3つの軸で振り分けてある。
 *   ・倍音が整数比か非整数比か … 整数比は楽器の音程に、非整数比は金属や鐘になる
 *   ・音程を持たせるか否か     … ノイズ主体にすると音程感が消えて打撃寄りになる
 *   ・低音を混ぜるか           … 低音は重さになるが、混ぜすぎると歯切れが鈍る
 *
 * どの案も共通で守っている所は3つ。立ち上がりを1ms以下にする（鈍ると
 * 弾いた感じが消える）、主な成分を2〜6kHzに置く（銃声は低音が主役なので、
 * ここに置くと撃ち合いの中でも埋もれない）、350ms以内に終わらせる。
 */
/**
 * 倒した合図の設定。
 *
 * ここに至った経緯: 「軽い」「甲高い」「デデンにして」と何度も作り直した。
 * こちらは音を聴けないので良し悪しの判定ができず、7回とも外した。
 * 一時期はロビーにつまみを出して遊ぶ側が直接回せるようにしていたが、
 * 決まったので畳んだ。作り直したくなったら、まずこの値を触る。
 *
 * 各項目が何を動かすか:
 *   hits   … 打点の数。1でドン、2でデデン、3でデデデン
 *   pitch  … 全体の高さ。下げるほど重く、上げるほど鋭くなる
 *   gap    … 打点の間隔(秒)。詰めるほど1発に近づく
 *   tail   … 最後の打点の余韻。伸ばすと鳴り物、詰めると打楽器に寄る
 *   weight … 低い所の量。これが「重さ」。0にすると軽い通知音になる
 *   edge   … 上の芯の量。「甲高い⇔こもる」はここで決まる
 *   drive  … 歪みの量。上げると倍音が増えて太くなるが、行きすぎると割れた音になる
 *
 * 数字の当たりを付ける時は tools/sound-lab.mjs で書き出して測る。
 * 低音の割合・重心・長さ・打点の数が数字で出る
 */
export const KILL_TUNE = {
  hits: 2, pitch: 1, gap: 0.155, tail: 1, weight: 1, edge: 0.3, drive: 2.8, level: 1,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    /* 全体の音量。**init前に設定画面から呼ばれる。**
       音は「クリックしてから」でないと起こせないのに、設定は起動直後に読み込まれるので、
       ここで値だけ覚えておいて init のときに写す。既定値は settings.js が持つ
       （2箇所に数字を書くと必ず片方が古くなる） */
    this.volume = VOLUME_DEF;
    // 空間の開け具合(0=壁が近い 1=開けている)。init前に呼ばれても値だけ覚えておく
    this.openness = 0.65;
    this._lowHp = 0;
    this._heartTimer = null;
    // 同時発音が増えすぎた時に層を間引くための負荷カウンタ
    this._load = 0;
    this._loadAt = 0;
    // 鳴らし終わって切り離す順番待ち。まとめて片付けるための待ち行列
    this._graveyard = [];
    this._reaper = null;

    // 選んだキル音は端末に覚えさせる。決まった後に遊び直すたび
    // 1番へ戻ると、せっかく選んだ意味がない
  }

  /**
   * 音を起こす。ブラウザは操作を起点にしないとWebAudioを動かしてくれない。
   * @param ambience 環境音を流すか。測定(tools/sound-lab.mjs)ではfalseにする
   */
  init({ ambience = true } = {}) {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    const ctx = new Ctx();
    this.ctx = ctx;

    // 出口の頭打ち。ここへ来た波の頭を丸めて、1.0を絶対に超えさせない。
    //
    // なぜ要るか: 効果音の素材ノイズには「突発の山」をわざと混ぜてあり、
    // 鳴らすたびに素材のどこから読み始めるかを乱数で変えている。
    // 山を引いた回だけ音が跳ね上がり、実測すると同じ銃声が0.70〜1.12まで
    // 揺れていた。1.0を超えた回は波の頭が平らに切られて「バリッ」と割れる。
    // 全体の音量を下げて逃げると、割れない代わりに常時痩せた音になる。
    // 曲線で丸めれば、普段の音はそのままで、跳ねた回だけが抑えられる。
    //
    // 0.72までは素通し。そこから上を滑らかに寝かせて0.97へ漸近させる
    const limiter = ctx.createWaveShaper();
    {
      const n = 2048;
      const c = new Float32Array(n);
      const KNEE = 0.72, CEIL = 0.97;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(x);
        const y = a <= KNEE
          ? a
          : KNEE + (CEIL - KNEE) * Math.tanh((a - KNEE) / (CEIL - KNEE));
        c[i] = Math.sign(x) * y;
      }
      limiter.curve = c;
      limiter.oversample = '4x';
    }
    limiter.connect(ctx.destination);

    // 突発的な銃声で音が割れないよう最後に軽く潰す
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    // 戻りを速くする。0.18秒は打点を2つ続けて鳴らす音（デデン）の間隔155msより
    // 長く、1発目で沈んだまま2発目が来て、2発目だけ半分の大きさになっていた。
    // 出口に頭打ちを入れたので、ここは強く掛ける必要がなくなっている
    comp.release.value = 0.09;
    comp.connect(limiter);

    // 被弾時に世界の音だけを丸めるための段。耳鳴りや心音はこれを迂回して
    // 素通しで鳴らす（実際、爆発の直後は外の音だけが遠のいて耳鳴りは近い）
    this.postBus = ctx.createGain();
    this.postBus.connect(comp);

    this.earFilter = ctx.createBiquadFilter();
    this.earFilter.type = 'lowpass';
    this.earFilter.frequency.value = 20000;
    this.earFilter.Q.value = 0.4;
    this.earFilter.connect(this.postBus);

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.earFilter);

    /* -------------------------------------------------- 残響と初期反射 */
    // 硬く短い残響と、開けた長い残響を2本持ってクロスフェードさせる。
    // 1本を伸び縮みさせるだけでは「壁が近い」硬さが出ない
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;

    this.tightVerb = ctx.createConvolver();
    this.tightVerb.buffer = this._impulse(0.6, 5.0, 9);
    this.tightGain = ctx.createGain();
    this.reverbSend.connect(this.tightVerb);
    this.tightVerb.connect(this.tightGain);
    this.tightGain.connect(this.master);

    this.openVerb = ctx.createConvolver();
    this.openVerb.buffer = this._impulse(2.6, 2.3, 3);
    this.openGain = ctx.createGain();
    this.reverbSend.connect(this.openVerb);
    this.openVerb.connect(this.openGain);
    this.openGain.connect(this.master);

    // 遠くの壁から返る一枚跳ね返り。残響とは別に「パーン…パン」の間を作る。
    // これがあると屋外の広場らしさが一気に出る
    this.slapSend = ctx.createGain();
    this.slapSend.gain.value = 1;
    this.slapDelay = ctx.createDelay(0.6);
    this.slapDelay.delayTime.value = 0.12;
    this.slapFilter = ctx.createBiquadFilter();
    this.slapFilter.type = 'lowpass';
    this.slapFilter.frequency.value = 2200;
    this.slapFeedback = ctx.createGain();
    this.slapFeedback.gain.value = 0.24;
    this.slapGain = ctx.createGain();
    this.slapGain.gain.value = 0.4;
    this.slapSend.connect(this.slapDelay);
    this.slapDelay.connect(this.slapFilter);
    this.slapFilter.connect(this.slapFeedback);
    this.slapFeedback.connect(this.slapDelay);
    this.slapFilter.connect(this.slapGain);
    this.slapGain.connect(this.master);
    this.slapGain.connect(this.reverbSend);

    this.noise = this._noiseBuffer(2.0);

    this._buildTinnitus();
    this._buildBreath();

    this.ready = true;
    this._loadAt = ctx.currentTime;
    this.setEnvironment(this.openness);
    // 環境音と息づかいは鳴りっぱなしなので、1つの効果音を測りたい時は邪魔になる。
    // tools/sound-lab.mjs がここをfalseで呼ぶ。
    // 切り忘れたまま測った時は、5案とも「長さ2000ms・低音22%」というそっくりな
    // 数字が出た。測っていたのは環境音のうなりだった
    if (ambience) this._startAmbience();
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  /**
   * 全体の音量。設定画面のつまみから来る。
   *
   * 掛ける場所を master にしてあるのは、ここが**世界の音の入口**だから。
   * ここより下流には出口の頭打ちと圧縮しか居ないので、下げても音の質が変わらない。
   * 逆に一番下流（destination の手前）で下げると、頭打ちを通った後を削ることになり、
   * 小さくしたのに割れたままになる。
   *
   * init前に呼ばれても値だけ覚える。壊れた値は無視して今の値を保つ
   * （0にはできる必要があるので、falsyを弾く形にはしない）
   */
  setVolume(v) {
    const g = clamp(Number(v), 0, 1);
    if (!Number.isFinite(g)) return this.volume;
    this.volume = g;
    if (this.master) this.master.gain.value = g;
    return this.volume;
  }

  /* ------------------------------------------------------------ 素材 */

  _noiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // spikesは初期反射の本数。壁が近い空間はここが立って「硬さ」になる
  _impulse(seconds, decay, spikes = 0) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 立ち上がりに少し間を置くと「広い空間」に聞こえる
        const early = t < 0.02 ? t / 0.02 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
      for (let k = 0; k < spikes; k++) {
        const idx = Math.floor(len * rnd(0.008, 0.14));
        d[idx] += (Math.random() * 2 - 1) * 0.8 * Math.pow(1 - idx / len, decay * 0.5);
      }
    }
    return buf;
  }

  // ノイズ源を1本作って返す。offsetをずらして毎回違う波形にする
  _noiseSource(playbackRate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = playbackRate;
    return s;
  }

  _env(gain, t0, peak, attack, decay, curve = 2.2) {
    const g = gain.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setTargetAtTime(0.0001, t0 + attack, decay / curve);
  }

  // 直近の発音数をざっくり見る。撃ち合いが密になった時に層を間引いて
  // 音が団子になるのと、ノード生成が増えすぎるのを同時に防ぐ
  _busy(t, add = 1) {
    this._load = Math.max(0, this._load - (t - this._loadAt) * 7);
    this._loadAt = t;
    this._load += add;
    return this._load;
  }

  _dist(position, camera) {
    if (!position || !camera) return 0;
    return Math.hypot(
      position.x - camera.position.x,
      position.y - camera.position.y,
      position.z - camera.position.z,
    );
  }

  /**
   * 音の定位。カメラ基準で左右の振りと距離減衰を手計算する。
   * PannerNodeより軽く、どのブラウザでも同じ鳴り方になる。
   */
  _place(input, position, camera, refDist = 8, dist = null, hfLoss = 260) {
    const ctx = this.ctx;
    if (!position || !camera) {
      const g = ctx.createGain();
      input.connect(g);
      return g;
    }
    const dx = position.x - camera.position.x;
    const dy = position.y - camera.position.y;
    const dz = position.z - camera.position.z;
    if (dist === null) dist = Math.hypot(dx, dy, dz);

    const atten = 1 / (1 + Math.pow(dist / refDist, 1.7));

    // カメラの右方向ベクトルとの内積で左右を決める
    const yaw = camera.rotation.y;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = clamp((dx * inv) * rx + (dz * inv) * rz, -1, 1);

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    g.gain.value = atten;
    if (panner) {
      panner.pan.value = pan * 0.85;
      input.connect(panner);
      panner.connect(g);
    } else {
      input.connect(g);
    }
    // 途中に挟んだノードも後で切り離す。返り値だけ切っても、
    // その手前のpannerやフィルタはinputに繋がったまま残る
    if (panner) this._reap([panner], 3.2);
    // 遠い音は空気に高域を食われる
    if (dist > 12) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 - (dist - 12) * hfLoss, 700, 16000);
      const out = ctx.createGain();
      g.connect(lp);
      lp.connect(out);
      this._reap([g, lp], 3.2);
      return out;
    }
    return g;
  }

  /**
   * 鳴らし終わった音を出力へ繋ぐ。
   *
   * 繋いだノードは必ず後で切り離す。WebAudioはstop()したソースこそ自動で片付くが、
   * その下流のGainやBiquadFilterはmasterに繋がったまま残り続ける。
   * 実測すると1試合ぶん（銃声1200・足音3000・被弾300）で67,295個が生き残っていた。
   * 増え続けるとブラウザのノード上限に当たってcreateGain()が失敗し始め、
   * そこから先は何も鳴らなくなる。「遊んでいると音が消える」の正体がこれ。
   *
   * lifeは切り離すまでの秒数。鳴り終わる前に切ると音が途中で欠けるので、
   * 一番長い尾（残響2.6秒）より余裕を持たせた既定にしてある
   */
  _out(node, wet = 0.35, slap = 0, life = 3.2) {
    const dead = [node];
    node.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = wet;
    node.connect(send);
    send.connect(this.reverbSend);
    dead.push(send);
    if (slap > 0) {
      const s2 = this.ctx.createGain();
      s2.gain.value = slap;
      node.connect(s2);
      s2.connect(this.slapSend);
      dead.push(s2);
    }
    this._reap(dead, life);
  }

  /**
   * 指定秒後にノードを切り離す。
   * setTimeoutを1本ずつ持つと同時発音の数だけタイマーが並ぶので、
   * 期限つきの待ち行列に積んで1本のタイマーでまとめて片付ける
   */
  _reap(nodes, life) {
    const at = (this.ctx.currentTime + life) * 1000;
    this._graveyard.push({ at, nodes });
    if (this._reaper) return;
    this._reaper = setInterval(() => {
      const now = this.ctx ? this.ctx.currentTime * 1000 : Infinity;
      let i = 0;
      while (i < this._graveyard.length) {
        const e = this._graveyard[i];
        if (e.at > now) { i++; continue; }
        for (const n of e.nodes) {
          try { n.disconnect(); } catch { /* 既に切れている */ }
        }
        // 末尾を詰めて削る。spliceだと同時発音が多い時に毎回配列を作り直す
        this._graveyard[i] = this._graveyard[this._graveyard.length - 1];
        this._graveyard.pop();
      }
      if (this._graveyard.length === 0) {
        clearInterval(this._reaper);
        this._reaper = null;
      }
    }, 500);
  }

  /* ------------------------------------------------------ 環境（空間） */

  /**
   * 周囲の開け具合を伝える。0=壁に囲まれている 1=開けた広場。
   * main.js側でプレイヤーから数本レイを飛ばし、平均距離を0..1に正規化して渡す想定。
   * 毎フレーム呼んで良いように、値は時定数付きで滑らかに追従させる。
   */
  setEnvironment(openness = 0.65) {
    const o = clamp(openness, 0, 1);
    this.openness = o;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const tau = 0.35;
    // 狭いほど硬く短い残響、開けているほど長く尾を引く残響
    this.tightGain.gain.setTargetAtTime(lerp(0.85, 0.12, o), t, tau);
    this.openGain.gain.setTargetAtTime(lerp(0.10, 0.80, o), t, tau);
    this.reverbSend.gain.setTargetAtTime(lerp(0.34, 0.62, o), t, tau);
    // 壁が近い＝跳ね返りが早く何度も返る。開けている＝遅く一発だけ返る
    this.slapDelay.delayTime.setTargetAtTime(lerp(0.028, 0.185, o), t, tau);
    this.slapFeedback.gain.setTargetAtTime(lerp(0.36, 0.12, o), t, tau);
    this.slapGain.gain.setTargetAtTime(lerp(0.50, 0.30, o), t, tau);
    this.slapFilter.frequency.setTargetAtTime(lerp(3000, 1500, o), t, tau);
  }

  /* ------------------------------------------------------------ 銃声 */

  /**
   * profile: { volume, bodyFreq, crackFreq, bodyDecay, tailDecay, thumpFrom, thumpTo,
   *            distance(位置を渡さない時の距離指定), mech(排莢機構の音を出すか) }
   * positionとcameraを省くと「自分の銃」＝距離0として鳴る。
   */
  gunshot(profile = {}, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const {
      volume = 1, bodyFreq = 620, crackFreq = 3600,
      bodyDecay = 0.13, tailDecay = 0.42, thumpFrom = 105, thumpTo = 44,
      mech = true,
    } = profile;

    const spatial = !!(position && camera);
    const dist = spatial ? this._dist(position, camera) : (profile.distance ?? 0);
    // 音速ぶんの到達遅れ。遠い銃声が一拍遅れて届くと距離が体で分かる
    const t = ctx.currentTime + Math.min(dist / SOUND_SPEED, 0.28);
    // 遠景の撃ち合いは何発重なっても手前の音を痩せさせない
    const busy = this._busy(t, dist > 60 ? 0.3 : 1);

    // 距離帯ごとの重み。近＝クラック、中＝胴体と残響、遠＝低音のドスンだけ
    const wCrack = Math.pow(1 - step(3, 34, dist), 1.1);
    const wBody = lerp(1, 0.18, step(6, 60, dist));
    const wTail = lerp(0.35, 1.0, step(4, 30, dist));
    const wSub = 1 - step(1.5, 11, dist);
    const wBoom = step(22, 75, dist);

    // 1発ごとの揺らぎ。ここが狭いと連射が同じ音の反復に聞こえて一気に安くなる
    const jPitch = rnd(0.88, 1.14);
    const jVol = rnd(0.9, 1.08);
    const jDecay = rnd(0.85, 1.2);

    const bus = ctx.createGain();
    // 位置を渡さず距離だけ指定された場合（遠景の環境音）は_placeが減衰を掛けないので、
    // ここで手計算しておく。これを忘れると遠くの銃声が真横で鳴る
    const farAtten = !spatial && dist > 0 ? 1 / (1 + Math.pow(dist / 26, 1.4)) : 1;
    bus.gain.value = volume * jVol * farAtten;

    const stopAt = t + Math.max(tailDecay * 2.4, bodyDecay * 3) + 0.6;

    // 1. 立ち上がりの鋭いクラック。近距離だけの成分で、遠くでは空気に食われて消える
    if (wCrack > 0.03) {
      const crack = this._noiseSource(jPitch);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = crackFreq * rnd(0.9, 1.12) * lerp(1, 0.45, step(2, 30, dist));
      // 上にも蓋をする。ハイパスだけだとノイズが20kHzまで平らに伸びて、
      // 測ると7kHz以上だけで全体の35%を占めていた。この帯が主役になった音は
      // 銃声ではなく「サーッ」という雨や砂嵐に聞こえる。
      // 実際の発砲音も8kHzより上は空気に食われてすぐ落ちる
      const hlp = ctx.createBiquadFilter();
      hlp.type = 'lowpass';
      hlp.frequency.value = rnd(7600, 9400);
      hlp.Q.value = 0.6;
      const crackGain = ctx.createGain();
      crack.connect(hp); hp.connect(hlp); hlp.connect(crackGain); crackGain.connect(bus);
      this._env(crackGain, t, 0.49 * wCrack, 0.0005, rnd(0.026, 0.042));
      crack.start(t, Math.random() * 1.5); crack.stop(t + 0.25);
    }

    // 2. 胴体。共振させた低めのバンドで「押し」を出す
    const body = this._noiseSource(jPitch * rnd(0.95, 1.05));
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    const bf = bodyFreq * rnd(0.88, 1.12);
    bp.frequency.setValueAtTime(bf * 3.2, t);
    bp.frequency.exponentialRampToValueAtTime(bf * 0.55, t + bodyDecay * 1.6 * jDecay);
    bp.Q.value = rnd(2.6, 4.4);
    const bodyGain = ctx.createGain();
    body.connect(bp); bp.connect(bodyGain); bodyGain.connect(bus);
    // ごく僅かに遅らせる。クラックと完全同時だと1枚の板に潰れる
    this._env(bodyGain, t + rnd(0.0005, 0.004), 0.96 * wBody, 0.0015, bodyDecay * jDecay);
    body.start(t, Math.random() * 1.5); body.stop(stopAt);

    // 3. 尾。距離が伸びるほど主役になり、開けた場所ほど長く伸びる。
    //    連射が続くと尾は前の尾に埋もれて聞こえないので、その時だけ省く
    if (busy < 9) {
      const tail = this._noiseSource(rnd(0.7, 0.95));
      const tf = ctx.createBiquadFilter();
      tf.type = 'bandpass';
      tf.frequency.value = rnd(700, 1250) * lerp(1, 0.55, step(10, 60, dist));
      tf.Q.value = rnd(0.55, 0.9);
      const tailGain = ctx.createGain();
      tail.connect(tf); tf.connect(tailGain); tailGain.connect(bus);
      const tailLen = tailDecay * jDecay * lerp(0.6, 1.7, this.openness) * lerp(1, 1.9, step(8, 50, dist));
      this._env(tailGain, t + rnd(0.004, 0.022), 0.38 * wTail, 0.006, tailLen);
      tail.start(t, Math.random() * 1.5); tail.stop(stopAt);
    }

    // 4. 腹に来る低音。至近だけ。マズルフラッシュと同時に胸を押される感じを作る
    if (wSub > 0.03) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(thumpFrom * rnd(0.92, 1.1), t);
      osc.frequency.exponentialRampToValueAtTime(thumpTo * rnd(0.9, 1.1), t + 0.09);
      const oscGain = ctx.createGain();
      osc.connect(oscGain); oscGain.connect(bus);
      this._env(oscGain, t, 0.78 * wSub, 0.002, 0.085 * jDecay);
      osc.start(t); osc.stop(t + 0.2);

      // サブベース。閃光の一瞬だけ床が鳴るような圧を足す。
      // 単体では聞こえないくらいで良い（聞こえると安いブーストになる）
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(56, t);
      sub.frequency.exponentialRampToValueAtTime(29, t + 0.16);
      const subGain = ctx.createGain();
      sub.connect(subGain); subGain.connect(bus);
      // 出しすぎるとコンプが低音に反応して他の音まで毎発沈むので控えめに
      this._env(subGain, t, 0.44 * wSub, 0.006, 0.14);
      sub.start(t); sub.stop(t + 0.32);
    }

    // 5. 遠距離のドスン。高域は全部落ちて低い塊だけが届く。
    //    距離減衰で消えないよう、低域は減りにくい前提で持ち上げる
    if (wBoom > 0.03) {
      const boom = this._noiseSource(rnd(0.25, 0.4));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = rnd(150, 260);
      lp.Q.value = 1.4;
      const bg = ctx.createGain();
      boom.connect(lp); lp.connect(bg); bg.connect(bus);
      // 低音は距離で減りにくい。_placeの一律減衰で消えてしまうぶんを押し戻す
      this._env(bg, t, 0.9 * wBoom * (spatial ? 1 + dist / 26 : 1), 0.008, rnd(0.16, 0.26));
      boom.start(t, Math.random() * 1.5); boom.stop(t + 0.7);
    }

    // 6. 自分の銃だけ、機関部が動く金属音を薄く重ねる。
    //    銃声が「発射炎」だけでなく「機械」に聞こえるようになる
    if (mech && dist < 3 && busy < 7) {
      this._metal(t + rnd(0.022, 0.04), {
        partials: [1180, 2670, 4310], vol: 0.09, decay: 0.03,
        ring: 0.5, noiseFreq: 4200, noiseQ: 2.4, wet: 0.1,
      });
    }

    let out = this._place(bus, position, camera, 14, dist, 300);
    if (!spatial && dist > 12) {
      // 遠景も高域を落とす。近くで鳴らした音をそのまま小さくしただけだと距離が出ない
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 - (dist - 12) * 300, 500, 16000);
      const g2 = ctx.createGain();
      out.connect(lp); lp.connect(g2);
      out = g2;
    }
    // 遠いほど残響と跳ね返りに送る割合を増やす＝空間そのものが鳴っている状態
    this._out(out, lerp(0.45, 1.0, step(2, 45, dist)), lerp(0.5, 0.95, step(2, 45, dist)));
  }

  /* -------------------------------------------------- 金属音の共通部品 */

  // 打撃のノイズ + 非整数比の倍音。倍音を整数比にすると楽器の音程に聞こえて
  // 金属に感じないので、必ずずらして積む
  _metal(t, opts = {}) {
    const ctx = this.ctx;
    const {
      partials = [420, 980, 1750], vol = 0.4, decay = 0.09, ring = 0.5,
      noiseFreq = 3000, noiseQ = 1.6, noiseType = 'bandpass',
      position = null, camera = null, wet = 0.2, refDist = 6,
    } = opts;

    const bus = ctx.createGain();
    bus.gain.value = 1;

    const src = this._noiseSource(rnd(0.85, 1.2));
    const f = ctx.createBiquadFilter();
    f.type = noiseType;
    f.frequency.value = noiseFreq * rnd(0.9, 1.12);
    f.Q.value = noiseQ;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, vol, 0.0008, decay);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay * 4 + 0.3);

    let longest = decay * 4;
    for (let i = 0; i < partials.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = partials[i] * rnd(0.96, 1.05);
      const og = ctx.createGain();
      o.connect(og); og.connect(bus);
      const d = decay * (2.4 - i * 0.5) * ring * rnd(0.8, 1.25);
      this._env(og, t, (vol * ring) / (1 + i * 0.9), 0.0015, Math.max(0.01, d));
      o.start(t); o.stop(t + Math.max(0.05, d * 4));
      longest = Math.max(longest, d * 4);
    }

    const out = this._place(bus, position, camera, refDist);
    this._out(out, wet, wet * 0.4);
    return longest;
  }

  /* ------------------------------------------------- 機械的なカチッ音 */
  click(freq = 2200, vol = 0.5, decay = 0.03, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this._noiseSource(rnd(0.9, 1.15));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * rnd(0.92, 1.1);
    f.Q.value = rnd(1.8, 2.8);
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, vol, 0.001, decay);
    const out = this._place(g, position, camera, 6);
    this._out(out, 0.18, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.2);
  }

  /* ---------------------------------------------------------- リロード */

  // マガジンリリース。指で押すボタンの小さいカチッ＋バネ
  // ここも鳴り物になっていた。2450/3980Hzを余韻0.35で鳴らすと鈴になる。
  // 弾倉止めは金属の爪が外れる音で、音程を持たない「カチッ」。
  // 倍音を低く濁らせて余韻をほぼ消し、代わりに粒立ちを上げる
  _magRelease(t) {
    this._metal(t, {
      partials: [880, 1310], vol: 0.30, decay: 0.010,
      ring: 0.05, noiseFreq: 2800, noiseQ: 1.2, wet: 0.05,
    });
  }

  /**
   * 機械が止まる時の低い一撃。装填のカチャカチャが軽く聞こえるのは、
   * 高い倍音と擦れの音しか鳴らしていないから。実物は重い金属の塊が動いて
   * 止まるので、必ず低い所が一緒に鳴る。測ると装填音は30〜250Hzの取り分が
   * 0.7%しかなく、重心は5420Hzにあった＝上だけで鳴っていた
   */
  _thunk(t, f0, f1, vol, decay) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * rnd(0.92, 1.08), t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, vol, 0.002, decay);
    this._out(g, 0.08, 0.05);
    o.start(t); o.stop(t + decay * 4 + 0.1);
  }

  // マガジン抜去。金属が擦れて滑り、抜けきった所で軽く鳴る
  _magOut(t) {
    const ctx = this.ctx;
    const src = this._noiseSource(rnd(0.5, 0.7));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(rnd(1500, 1900), t);
    f.frequency.exponentialRampToValueAtTime(rnd(600, 780), t + 0.11);
    f.Q.value = 1.1;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.2, 0.012, 0.075);
    this._out(g, 0.16, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.4);
    this._metal(t + rnd(0.075, 0.1), {
      partials: [640, 1490, 2380], vol: 0.22, decay: 0.03,
      ring: 0.09, noiseFreq: 1900, noiseQ: 1.1, wet: 0.08,
    });
  }

  // 挿入。重い塊が入って止まる音。低い倍音を厚めに、最後に嵌るカチッ
  _magIn(t) {
    this._thunk(t, 118, 68, 0.62, 0.06);
    this._metal(t, {
      // 弾倉が座る音。ring 0.7は「鳴らす」量で、実物は詰まって止まるだけ
      partials: [148, 262], vol: 0.5, decay: 0.038,
      ring: 0.10, noiseFreq: 900, noiseQ: 0.9, noiseType: 'lowpass', wet: 0.10,
    });
    this._metal(t + rnd(0.03, 0.045), {
      partials: [760, 1090], vol: 0.26, decay: 0.010,
      ring: 0.06, noiseFreq: 3100, noiseQ: 1.3, wet: 0.06,
    });
  }

  // ボルト。バネがジャッと鳴ってから、前進して硬く止まる
  _bolt(t) {
    this._thunk(t + 0.055, 146, 82, 0.70, 0.055);
    const ctx = this.ctx;
    const src = this._noiseSource(rnd(1.1, 1.4));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(rnd(2600, 3200), t);
    f.frequency.exponentialRampToValueAtTime(rnd(1300, 1700), t + 0.06);
    f.Q.value = 2.2;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.24, 0.004, 0.04);
    this._out(g, 0.14, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.3);
    // 前進して閉鎖。ここが一番硬い音になる
    this._metal(t + rnd(0.05, 0.07), {
      // 4本の高い倍音をring 0.62で鳴らすと、閉鎖ではなく金属の鐘になる。
      // 閉鎖は重い塊が受けに当たって止まる音なので、低い2本を短く切る
      partials: [268, 640], vol: 0.55, decay: 0.020,
      ring: 0.08, noiseFreq: 2600, noiseQ: 1.0, wet: 0.10,
    });
  }

  // 工程ごとに別の音で組む。同じclickの周波数違いだと「操作している」感じが出ない
  reload(duration = 2) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    this._magRelease(t + 0.04);
    this._magOut(t + duration * 0.30);
    this._magIn(t + duration * 0.64);
    this._bolt(t + duration * 0.86);
  }

  /**
   * 1発だけ押し込む音。ショットガンのように1発ずつ入れる武器で、
   * 弾が1つ増えるたびに鳴らす。
   *
   * reload() を短くした物ではない。あれは「抜く→落とす→差す→引く」の
   * 4工程を時間の中に並べた物で、1発ずつ入れる動作にはその工程が無い。
   * ここは「布に包まれた物が受けに当たって止まる」1回だけ。
   * 硬すぎると弾倉を差した音に聞こえるので、低い方へ寄せて余韻を切る
   */
  shell() {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 掴んで運ぶ所の擦れ。これが無いと、何もない所から急に音が出る
    this._metal(t, {
      partials: [520, 810], vol: 0.10, decay: 0.014,
      ring: 0.04, noiseFreq: 2200, noiseQ: 1.1, wet: 0.05,
    });
    // 押し込んで止まる所。1発ずつの装填はここが本体
    const at = t + rnd(0.045, 0.065);
    this._thunk(at, 132, 76, 0.34, 0.045);
    this._metal(at, {
      partials: [186, 305], vol: 0.30, decay: 0.026,
      ring: 0.07, noiseFreq: 1100, noiseQ: 0.9, noiseType: 'lowpass', wet: 0.08,
    });
  }

  /* ------------------------------------------------------------ 足音 */

  /**
   * surfaceは 'dirt' | 'gravel' | 'asphalt' | 'concrete' | 'metal' | 'wood'。
   * 旧シグネチャ footstep(強さ, 位置, カメラ) でも壊れないよう引数を受け直す。
   */
  footstep(intensity = 0.7, surface = 'dirt', position = null, camera = null) {
    if (surface && typeof surface === 'object') { camera = position; position = surface; surface = 'dirt'; }
    this._step(intensity, surface, position, camera, 1);
  }

  // 着地。踏み込みが深く、低音と擦れが伸びる
  land(intensity = 1, surface = 'dirt', position = null, camera = null) {
    if (surface && typeof surface === 'object') { camera = position; position = surface; surface = 'dirt'; }
    this._step(Math.min(1.4, intensity * 1.3), surface, position, camera, 2.1);
  }

  _step(intensity, surface, position, camera, weight) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = SURFACES[surface] ?? SURFACES.dirt;
    const vol = 0.16 * intensity * s.vol;

    const bus = ctx.createGain();
    bus.gain.value = 1;

    // 踏み込みの低音。素材が硬いほど高く短い
    const th = ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(s.thump * rnd(0.85, 1.2), t);
    th.frequency.exponentialRampToValueAtTime(s.thump * 0.55, t + 0.06);
    const thg = ctx.createGain();
    th.connect(thg); thg.connect(bus);
    this._env(thg, t, vol * 1.5 * weight, 0.003, s.decay * weight);
    th.start(t); th.stop(t + 0.3);

    // 表面の粒立ち。土や砂利はここが主役
    const src = this._noiseSource(rnd(0.7, 1.25));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(s.gritFreq * rnd(0.8, 1.25), t);
    f.frequency.exponentialRampToValueAtTime(s.lp * rnd(0.7, 1.1), t + s.decay * 2);
    f.Q.value = s.gritQ;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, vol * s.grit * (1 + (weight - 1) * 0.4), 0.002, s.decay * (1 + weight * 0.3));
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.5);

    // 爪先が擦れて抜ける音。踵が着いた少し後に鳴る。
    //
    // これが無いと1歩が「1点」で鳴って、機械が刻んでいるように聞こえる。
    // 実際の1歩は踵が着いてから爪先で蹴り出すまでに幅があり、
    // その2つの間隔が歩き方そのものになる。走るほど間隔が詰まって擦れが強い。
    // 走りの足音が安っぽかったのは、速く鳴らしているだけで
    // 「蹴り出している」音が1つも入っていなかったため
    // 間隔は短く、量は控えめに。前は最大6cm近く遅れて音量も0.42倍あり、
    // 1歩が「タッ・シャッ」と2回鳴って別の生き物の足音になっていた。
    // 実際の1歩は2つの音が重なって聞こえるくらいの近さで、
    // 擦れは踏み込みに混ざって聞こえるだけ
    const scuff = 0.016 + (2.1 - weight) * 0.008 + rnd(0, 0.006);
    const ssrc = this._noiseSource(rnd(0.35, 0.6));
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.setValueAtTime(s.gritFreq * 0.55, t + scuff);
    sf.frequency.exponentialRampToValueAtTime(s.gritFreq * 0.22, t + scuff + 0.09);
    sf.Q.value = 0.7;
    const sg = ctx.createGain();
    ssrc.connect(sf); sf.connect(sg); sg.connect(bus);
    // 重い着地ほど強く擦る。歩きでは薄く、走りと着地でしっかり出る
    this._env(sg, t + scuff, vol * 0.20 * weight, 0.004, s.decay * 1.1);
    ssrc.start(t + scuff, Math.random() * 1.5);
    ssrc.stop(t + scuff + 0.35);

    const out = this._place(bus, position, camera, 5);
    this._out(out, surface === 'metal' ? 0.34 : 0.18, surface === 'metal' ? 0.3 : 0.12);

    // 金属板は踏むと共鳴する。コンテナや斜路の上だけ音が別物になるのが分かる
    if (s.partials && s.ring > 0.05) {
      this._metal(t + 0.002, {
        partials: s.partials, vol: vol * s.ring * weight, decay: s.decay * 1.4,
        ring: 1.0, noiseFreq: s.lp, noiseQ: 1.0, position, camera, refDist: 5, wet: 0.3,
      });
    }
  }

  /* ------------------------------------------------------------ 着弾 */

  // 素材で高域の質感を変える
  impact(kind = 'concrete', position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const tone = { concrete: 2400, metal: 5200, wood: 1500, flesh: 700 }[kind] ?? 2400;
    const src = this._noiseSource(rnd(0.85, 1.2));
    const f = ctx.createBiquadFilter();
    f.type = kind === 'metal' ? 'bandpass' : 'lowpass';
    f.frequency.value = tone * rnd(0.85, 1.2);
    f.Q.value = kind === 'metal' ? 6 : 1;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, kind === 'flesh' ? 0.5 : 0.34, 0.001, kind === 'metal' ? 0.16 : 0.06);
    const out = this._place(g, position, camera, 10);
    this._out(out, 0.4, 0.3);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.5);

    // 金属は跳弾のキーンを足す
    if (kind === 'metal' && Math.random() < 0.6) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = rnd(1400, 3200);
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.35, t + 0.35);
      const og = ctx.createGain();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 12; bp.frequency.value = base;
      o.connect(bp); bp.connect(og);
      this._env(og, t, 0.08, 0.004, 0.3);
      const o2 = this._place(og, position, camera, 10);
      this._out(o2, 0.5, 0.4);
      o.start(t); o.stop(t + 0.6);
    }
  }

  /* ------------------------------------------------------ 至近弾の風切り */

  /**
   * 敵の外れ弾が体の近くを抜けた時の音。distanceは弾道とプレイヤーの最短距離[m]。
   * panは-1(左)..1(右)。省くと左右ランダム。
   * これが無いと「撃たれている怖さ」が出ないので、外れ弾ほど大事。
   */
  whizBy(distance = 2, pan = null) {
    if (!this.ready || !this.enabled) return;
    if (distance > 5) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const near = clamp(1 - distance / 5, 0, 1);
    const vol = 0.06 + near * near * 0.55;
    const p = pan === null ? rnd(-0.85, 0.85) : clamp(pan, -1, 1);

    const bus = ctx.createGain();
    bus.gain.value = 1;

    // 通過に合わせて帯域を下げる。上から下へ滑るとドップラーに聞こえる
    const src = this._noiseSource(rnd(1.0, 1.35));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(rnd(2300, 3400), t);
    bp.frequency.exponentialRampToValueAtTime(rnd(600, 900), t + 0.05 + near * 0.035);
    bp.Q.value = rnd(1.3, 2.2);
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g); g.connect(bus);
    this._env(g, t, vol, 0.003, 0.045 + near * 0.03);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.4);

    // 至近弾は衝撃波のパチンが先に立つ。ここが「掠った」感の正体
    if (near > 0.5) {
      const snap = this._noiseSource(rnd(1.1, 1.4));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = rnd(4200, 6200);
      const sg = ctx.createGain();
      snap.connect(hp); hp.connect(sg); sg.connect(bus);
      this._env(sg, t, vol * 0.8 * near, 0.0004, 0.012);
      snap.start(t, Math.random() * 1.5);
      snap.stop(t + 0.15);
    }

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = p;
      bus.connect(panner);
      this._out(panner, 0.3, 0.35);
    } else {
      this._out(bus, 0.3, 0.35);
    }
  }

  /* ------------------------------------------------------------ 通知 */

  /**
   * 命中通知。当たった瞬間に耳元で鳴らす短い打点。
   *
   * 頭に当てた時は「高く」ではなく「鈍く」鳴らす。
   * 前は矩形波の1750→2400Hzを追い打ちで足していて、これは電子音の作り方
   * そのもの（矩形波は倍音が全部残るので、高い所で鳴らすと一番耳に刺さる）。
   * 頭に当たった手応えとして欲しいのは高さではなく重さなので、
   * 胴体より低い所へ落として、下へ滑らせ、低音を1枚敷く。
   */
  hitmarker(headshot = false) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // 矩形波1150Hzは電子的すぎて「当たった」より「通知が来た」に聞こえる。
    // 短い木を叩く音に寄せる。三角波を素早く下げると打点が出る
    const o = ctx.createOscillator();
    // 頭に当てた方はサイン波にする。三角波は3倍・5倍の倍音を持つので、
    // 620Hzで鳴らすと1860Hzと3100Hzが一緒に出て、そこが鈍さを消していた。
    // 胴の方は輪郭が欲しいので三角波のまま
    o.type = headshot ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(headshot ? 620 : 900, t);
    o.frequency.exponentialRampToValueAtTime(headshot ? 190 : 430, t + (headshot ? 0.09 : 0.055));
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, headshot ? 0.22 : 0.24, 0.001, headshot ? 0.075 : 0.05);
    // 通知音は耳鳴りの向こうでも聞こえるべきなので、被弾フィルタを迂回する
    g.connect(this.postBus);
    this._reap([g], 1.0);
    o.start(t); o.stop(t + 0.2);

    // 胴に当てた時の低音。測ると、当たった音は30〜250Hzの取り分が0.2%しかなく、
    // 音量も山が0.12と、キル音の6分の1しか出ていなかった。
    // 一番よく聞く音がこれでは、当てた手応えが最初から存在しない。
    //
    // ただし長くはできない。ライフルは0.094秒に1発なので、100msを超えると
    // 次の当たり音と重なって団子になる。短いまま重さだけ足す
    if (!headshot) {
      const lo = ctx.createOscillator();
      lo.type = 'sine';
      lo.frequency.setValueAtTime(210, t);
      lo.frequency.exponentialRampToValueAtTime(112, t + 0.055);
      const lg = ctx.createGain();
      lo.connect(lg); lg.connect(this.postBus);
      this._env(lg, t, 0.30, 0.0015, 0.048);
      this._reap([lg], 1.0);
      lo.start(t); lo.stop(t + 0.2);
      // 芯。低音だけ足すと輪郭が消えて「ボッ」になるので、上に点を打つ
      const tick = this._noiseSource(1.3);
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = 1750;
      bpf.Q.value = 1.1;
      const tg = ctx.createGain();
      tick.connect(bpf); bpf.connect(tg); tg.connect(this.postBus);
      this._env(tg, t, 0.13, 0.0006, 0.015);
      this._reap([tg, bpf], 1.0);
      tick.start(t, Math.random()); tick.stop(t + 0.1);
    }
    if (headshot) {
      // 重さのぶん。サイン波を190→95Hzへ落とす。倍音が無いので
      // 音程としてではなく「ドッ」という圧として聞こえる
      const lo = ctx.createOscillator();
      lo.type = 'sine';
      lo.frequency.setValueAtTime(190, t);
      lo.frequency.exponentialRampToValueAtTime(95, t + 0.09);
      const lg = ctx.createGain();
      lo.connect(lg); lg.connect(this.postBus);
      this._env(lg, t, 0.24, 0.0015, 0.085);
      this._reap([lg], 1.0);
      lo.start(t); lo.stop(t + 0.3);
      // 潰れる質感。低い所で切ったノイズを一瞬だけ。
      // 高い所を残すと結局「チッ」と鳴って鈍さが消えるので2.2kHzで蓋をする
      const th = this._noiseSource(0.55);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1300;
      // 2段重ねる。1段だと1オクターブで12dBしか落ちず、蓋をしたつもりでも
      // 2.5〜7kHzが22%残って「鈍く」ならなかった
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 1300;
      const tg = ctx.createGain();
      th.connect(lp); lp.connect(lp2); lp2.connect(tg); tg.connect(this.postBus);
      this._env(tg, t, 0.22, 0.001, 0.055);
      this._reap([tg, lp, lp2], 1.0);
      th.start(t, Math.random()); th.stop(t + 0.2);
    }
  }

  /* ------------------------------------------ 倒した合図（5案の作り） */

  /**
   * 倒した合図は「軽い」と何度も言われて作り直した。
   * 5回目までは勘で直していたが、tools/sound-lab.mjs で波形を書き出して
   * 測ったら、軽さの正体がはっきり数字で出た。
   *
   *   これまでの5案 … 30〜250Hzの取り分が 0.0〜0.4%、長さ100〜315ms、山2〜4本
   *   爆発          … 同じ帯が 42%、長さ2000ms
   *
   * つまり低い音がまったく入っていなかった。人が「重い」「迫力がある」と
   * 感じるのはこの帯で、ここが空だと上で何を鳴らしても薄い通知音にしかならない。
   * 加えて、純粋なサイン波は倍音が1本しか無いので、何本重ねても密度が出ない。
   *
   * 作り直しでは3つを土台にした。
   *   1. サブベース … 80Hz付近から40Hzへ落とす層。歪ませない（濁ると汚れになる）
   *   2. 歪み       … 中高域だけを軽く潰して倍音を増やす。同じ音量で密度が上がる
   *   3. 尾         … 300〜700msの余韻。短く切ると「ピッ」で終わって手応えが残らない
   */

  // 歪ませる曲線。tanhで軽く潰す。潰すほど倍音が増えて密度が出るが、
  // やりすぎると割れた音になるだけなので、係数は2〜3の範囲で使う
  _satCurve(k = 2.4) {
    const n = 1024;
    const c = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / norm;
    }
    return c;
  }

  /**
   * 倒した合図の土台。各案の声はここが返す入口へ繋ぐ。
   *   ・入口は歪み器。通った音は倍音が増えて太くなる
   *   ・同時に低音の層を1枚敷く。これが「重さ」そのもの
   * 低音を歪み器に通さないのは、潰すと輪郭が濁って重さではなく汚れになるため
   */
  _killBed(t, { sub = 1, subF0 = 86, subF1 = 41, subLen = 0.22, satK = 2.4, level = 0.5 } = {}) {
    const ctx = this.ctx;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._satC || (this._satC = this._satCurve(satK));
    // 歪ませた後に必ず蓋をする。tanhで潰すと倍音が上へ無限に伸びるので、
    // 掛けっぱなしだと音の重心が3kHzより上へ持って行かれて、
    // 低音を足したのに「シャリシャリして軽い」という妙な音になる。
    // 潰してから削るのが順番で、逆にすると密度だけ落ちる
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.7;
    const out = ctx.createGain();
    out.gain.value = level;
    shaper.connect(lp); lp.connect(out);
    // 耳鳴りのフィルタを迂回する。倒した知らせが被弾で埋もれると、
    // 撃ち合いの真っ最中＝一番知りたい時に限って聞こえない
    out.connect(this.postBus);
    this._reap([out, lp], 2.0);

    if (sub > 0) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(subF0, t);
      o.frequency.exponentialRampToValueAtTime(subF1, t + subLen);
      const g = ctx.createGain();
      o.connect(g); g.connect(this.postBus);
      this._env(g, t, 0.50 * sub, 0.002, subLen);
      this._reap([g], 2.0);
      o.start(t); o.stop(t + subLen * 4 + 0.2);
      // 低音だけだと聞こえない環境（ノートPCの内蔵スピーカー等）がある。
      // 2倍の所に薄く重ねると、低音が出ない機械でも重さの手掛かりが残る
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(subF0 * 2, t);
      o2.frequency.exponentialRampToValueAtTime(subF1 * 2, t + subLen);
      const g2 = ctx.createGain();
      o2.connect(g2); g2.connect(shaper);
      this._env(g2, t, 0.30 * sub, 0.002, subLen * 0.8);
      this._reap([g2], 2.0);
      o2.start(t); o2.stop(t + subLen * 4 + 0.2);
    }
    return shaper;
  }

  /**
   * 倒した合図の1音ぶん。
   * @param bend 1以外を渡すと、鳴っている間にその倍率まで音程を滑らせる
   * @param dest 繋ぎ先。省略すると歪みを通さずそのまま出る
   */
  _killTone(t, freq, level, attack, decay, type = 'sine', bend = 1, dest = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq * bend, t + decay);
    const g = this.ctx.createGain();
    o.connect(g); g.connect(dest || this.postBus);
    this._env(g, t, level, attack, decay);
    this._reap([g], 1.6);
    o.start(t); o.stop(t + attack + decay * 3 + 0.05);
  }

  /**
   * 倒した合図のノイズ層。帯域で切り出して打点を作る。
   * bandpassだと帯の中心が鳴って「チッ」に、highpassだと上が全部残って
   * 「シャッ」になる。前者は硬い物、後者は空気の抜けに聞こえる
   */
  _killNoise(t, level, decay, { hp = 0, bp = 0, q = 1, rate = 1.4 } = {}, dest = null) {
    const src = this._noiseSource(rate);
    const f = this.ctx.createBiquadFilter();
    if (bp) { f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q; }
    else { f.type = 'highpass'; f.frequency.value = hp; }
    const g = this.ctx.createGain();
    src.connect(f); f.connect(g); g.connect(dest || this.postBus);
    this._env(g, t, level, 0.0006, decay);
    this._reap([g, f], 1.6);
    src.start(t, Math.random()); src.stop(t + decay * 4 + 0.05);
  }

  /**
   * 打点を1つ。低い所で叩いて、音程を下へ落とす。
   *
   * 「デン」と聞こえるのは音程が下がるから。上げると「ディン」＝撞いた音になる。
   * 層は3つで、低音が重さ、胴が輪郭、頭の一瞬が打った感触を作る。
   */
  _killBeat(t, dest, {
    f0 = 120, f1 = 62, body = 220, bodyTo = 140,
    level = 1, len = 0.10, subLen = 0.09, edge = 0, punch = 700, weight = 1,
  }) {
    // 低音のつまみは、敷く低音の量だけでなく胴の落ち方も動かす。
    // 量だけ絞っても、胴が下まで滑り落ちるぶんの低い音が残って、
    // 0まで下げても3割しか軽くならなかった。落とす幅も一緒に縮める
    const fall = 0.45 + 0.55 * Math.min(1.4, weight);
    bodyTo = body - (body - bodyTo) * fall;
    const ctx = this.ctx;
    // 低音。歪ませずにpostBusへ直に出す。潰すと重さではなく濁りになる
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + subLen);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.postBus);
    this._env(g, t, 0.40 * level * weight, 0.0015, subLen);
    this._reap([g], 2.0);
    o.start(t); o.stop(t + subLen * 4 + 0.3);

    // 胴。三角波を歪ませて倍音を詰める。ここが無いと低音だけの唸りになって、
    // 何が鳴ったのか輪郭が読めない
    this._killTone(t, body, 0.56 * level, 0.001, len, 'triangle', bodyTo / body, dest);
    this._killTone(t + 0.002, body * 1.5, 0.26 * level, 0.001, len * 0.7, 'sine', bodyTo / body, dest);

    // 叩いた頭の一瞬。上を残すと甲高くなるので、低い所で切って厚みだけ足す
    this._killNoise(t, 0.30 * level, 0.014, { bp: punch, q: 0.8 }, dest);
    // 抜けを良くしたい時だけ、上に細い芯を置く
    if (edge > 0) this._killNoise(t, 0.16 * edge * level, 0.012, { bp: 2600, q: 1.6 }, dest);
  }

  /**
   * 倒した合図。打点をいくつか並べて鳴らす。最後の打点が本命で余韻を持つ。
   * 実際の値は上の KILL_TUNE。
   */
  _killShot(t, head) {
    const c = KILL_TUNE;
    const n = clamp(Math.round(c.hits), 1, 3);
    // 頭に当てた時だけ全体を長3度上げる。同じ音の音量違いでは差が伝わらない
    const p = c.pitch * (head ? 1.26 : 1);
    const bed = this._killBed(t, { sub: 0, satK: c.drive, level: 0.62 * c.level });

    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const at = t + c.gap * i;
      // 最後だけ低く長く大きく。手前は短い助走にする
      const k = last ? 1 : 0.62 + i * 0.06;
      // 手前の打点は、間隔より長く鳴らすと次の打点に被って1発に聞こえる。
      // 間隔を一番詰めた時に実際そうなって、2発目が消えていた
      const lead = Math.min(0.085, c.gap * 0.55);
      this._killBeat(at, bed, {
        f0: (last ? 112 : 132) * p, f1: (last ? 52 : 74) * p,
        body: (last ? 300 : 360) * p, bodyTo: (last ? 205 : 268) * p,
        level: (last ? 1.30 : 0.60) * k / (last ? 1 : 0.62),
        len: last ? 0.24 * c.tail : lead,
        subLen: last ? 0.20 * c.tail : lead * 0.82,
        weight: c.weight, edge: c.edge,
        punch: (last ? 850 : 980) * p,
      });
    }

    // 最後の打点の余韻。完全5度で重ねると濁らずに伸びる。
    // これが無いと叩いて終わりで、「ン」の残りが出ない
    const end = t + c.gap * (n - 1);
    this._killTone(end + 0.01, 190 * p, 0.26 * c.weight, 0.004, 0.40 * c.tail, 'sine', 0.88, bed);
    this._killTone(end + 0.01, 285 * p, 0.20 * c.weight, 0.004, 0.32 * c.tail, 'sine', 0.88, bed);
    this._killNoise(end + 0.03, 0.06, 0.32 * c.tail, { bp: 700 * p, q: 0.7 }, bed);
    // 芯を上げた時だけ、上に伸びる余韻も足す。ここが「抜け」を作る
    if (c.edge > 0.05) {
      this._killNoise(end + 0.02, 0.05 * c.edge, 0.26 * c.tail, { bp: 3200 * p, q: 1.1 }, bed);
    }
  }

  kill(headshot = false) {
    if (!this.ready || !this.enabled) return;
    this._killShot(this.ctx.currentTime, headshot);
  }

  /**
   * 自分が倒れた時。
   *
   * 敵が倒れる音(death)とは別物にしてある。あちらは「向こうで何かが倒れた」を
   * 場の中で鳴らす音だが、こちらは自分にしか聞こえない音なので、
   * 場に馴染ませる必要がない。遠慮なく前に出す。
   *
   * 作りは3層:
   *   1. 落ちる低音 … 倒れ込む重さ。ここが無いと「点数が止まった」だけになる
   *   2. 潰れたノイズ … 地面に着く音
   *   3. 尾を引く高い音 … 耳鳴り。撃たれて意識が飛ぶ側の合図で、
   *      これがあると音が途切れずに結果画面へ繋がる
   */
  /**
   * 自分が倒れた。**画面が結果へ切り替わるまで、一番長く聴かされる音。**
   *
   * 前の作りを測ったら、こういう形をしていた:
   *
   *   超低 33.6% ／ 低 7.0% ／ **中低 2.2%** ／ 中 19.2% ／ **高 35.4%**
   *
   * つまり**一番下と一番上しか無い。** 胴体（250〜800Hz）が空っぽで、
   * そのぶん3.1kHzの純音（耳鳴り）が音の主役になっていた。
   * 純音は素材として一番安っぽく聞こえるので、それが主役だと全体が安く聞こえる。
   * 比較として爆発は 23.8 / 10.1 / 24.3 / 21.2 / 9.4 と満遍なく埋まっている。
   *
   * 直した後:
   *
   *   超低 25.5% ／ 低 14.5% ／ **中低 23.7%** ／ 中 18.6% ／ **高 13.2%** ／ 打点2つ
   *
   * **どこが効いたのかも1つずつ測った。** 思っていたのと違った:
   *
   *   ・耳鳴りの音量を 0.075 → 0.013 に落とす … 中低が 17.7 → 23.7（一番効いた）
   *     35%を占めていた物が減ると、残り全部の取り分がそのぶん上がる
   *   ・着地の低域切りを 420 → 640Hz へ開ける … 中低が 21.3 → 23.7
   *   ・胴体の層を足す … 中低が 22.6 → 23.7（**思ったより効いていない**）
   *
   * つまり「胴体が空だったから足した」より、
   * **「純音が場所を取りすぎていたから退かした」のほうが本体**だった。
   * 足す前に、大きすぎる物を探すほうが先。
   *
   * 打点が2つになったのは、落ちる低音を0.95秒から0.3秒へ縮めて
   * 着地の手前で切ったから。鳴りっぱなしだと着地が別の出来事に聞こえない。
   */
  playerDown() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 1. 落ちる低音。高い所から下へ滑らせる。**ここが「重さ」そのもの**
    const lo = ctx.createOscillator();
    lo.type = 'sine';
    lo.frequency.setValueAtTime(180, t);
    lo.frequency.exponentialRampToValueAtTime(52, t + 0.42);
    const lg = ctx.createGain();
    lo.connect(lg); lg.connect(this.postBus);
    /* **着地の手前で切る。** 前は0.95秒かけて減衰していて、
       その間ずっと音が鳴り続けているせいで、着地の音が「別の出来事」として
       立たなかった（測ると打点が1つのまま＝崩れたのか着いたのか耳から分からない）。
       落ちている間の音は、着いた時点で終わるのが本来の形でもある */
    this._env(lg, t, 0.34, 0.006, 0.3);
    this._reap([lg], 1.2);
    lo.start(t); lo.stop(t + 0.7);

    /* 2. 胴体。400〜600Hzのノイズを幅を持たせて鳴らす。
       歪み器に通すのは、素のノイズだと「サー」で終わって物が崩れる音にならないため。
       **帯の取り分としては1ポイントほどしか動かない**（測った）。
       ここが持っているのは「崩れていく」という形のほうで、
       数字を直したのは耳鳴りを退かしたことのほう */
    const body = this._noiseSource(0.85);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(640, t);
    bp.frequency.exponentialRampToValueAtTime(480, t + 0.55);
    bp.Q.value = 0.75;
    const sat = ctx.createWaveShaper();
    sat.curve = this._satCurve(2.0);
    sat.oversample = '2x';
    /* 歪ませた後を低めで切る。**歪みは倍音を上へ伸ばす**ので、
       そのまま出すとせっかく足した胴体が高域の足しにしかならない
       （実測で 高2.5k-7k が22.6%まで上がった） */
    const bodyLp = ctx.createBiquadFilter();
    bodyLp.type = 'lowpass';
    bodyLp.frequency.value = 1100;
    const bg = ctx.createGain();
    body.connect(bp); bp.connect(sat); sat.connect(bodyLp); bodyLp.connect(bg); bg.connect(this.postBus);
    // 減衰を短くするのは、長く伸ばすと次の打点（着地）を覆い隠して
    // 出来事が1つに聞こえるため（実測で打点が2→1に戻った）
    this._env(bg, t, 1.5, 0.01, 0.24);
    this._reap([bg], 1.4);
    body.start(t); body.stop(t + 0.95);

    // 胴体の芯。ノイズだけだと高さが定まらないので、同じ帯に音程を1本置く
    const mid = ctx.createOscillator();
    mid.type = 'triangle';
    mid.frequency.setValueAtTime(540, t);
    mid.frequency.exponentialRampToValueAtTime(215, t + 0.5);
    const mg = ctx.createGain();
    mid.connect(mg); mg.connect(this.postBus);
    this._env(mg, t, 0.46, 0.004, 0.46);
    this._reap([mg], 1.2);
    mid.start(t); mid.stop(t + 0.7);

    /* 3. 地面に着く音。**2つ目の打点。**
       低音の滑りが終わった所に置く。前は薄すぎて（0.30）打点として数えられず、
       測ると打点1個のまま＝出来事が1つしか無い音だった。
       低域切りを420Hzから640Hzへ開けてあるのは、閉じたままだと
       この音が全部「超低」へ入って、胴体の帯に何も残らないため */
    const thud = this._noiseSource(1.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(640, t);
    const tg = ctx.createGain();
    thud.connect(lp); lp.connect(tg); tg.connect(this.postBus);
    this._env(tg, t + 0.48, 0.78, 0.003, 0.3);
    this._reap([tg], 1.6);
    thud.start(t + 0.48); thud.stop(t + 1.0);

    // 着地に低い芯を重ねる。ノイズだけだと「バサッ」で止まって、地面の硬さが出ない
    const floor = ctx.createOscillator();
    floor.type = 'sine';
    floor.frequency.setValueAtTime(96, t + 0.48);
    floor.frequency.exponentialRampToValueAtTime(44, t + 0.84);
    const fg = ctx.createGain();
    floor.connect(fg); fg.connect(this.postBus);
    this._env(fg, t + 0.48, 0.28, 0.004, 0.36);
    this._reap([fg], 1.6);
    floor.start(t + 0.48); floor.stop(t + 1.0);

    /* 4. 余韻。**純音（サイン波1本）は使わない。**
       前は3.1kHzのサイン波を「耳鳴り」として鳴らしていた。音量を35%から
       13%まで落としても、**「甲高いピュー」が不快**だと言われた。
       音量の問題ではなく、**純音そのものが耳につく**のが原因。
       サイン波は自然界にほぼ無い音なので、小さくても耳が必ず拾い上げる。

       替わりに、低めの雑音を1枚だけ残す。同じ「音が切れない」役目を果たしつつ、
       高さを持たないので「鳴っている」と意識されない。
       中心を900Hzまで下げてあるのは、2kHzより上に山があると
       どんな作り方でも「ピー」に寄るため */
    const air = this._noiseSource(0.7);
    const ap = ctx.createBiquadFilter();
    ap.type = 'bandpass';
    ap.frequency.setValueAtTime(900, t);
    ap.frequency.exponentialRampToValueAtTime(420, t + 1.1);
    ap.Q.value = 1.1;
    const ag = ctx.createGain();
    air.connect(ap); ap.connect(ag); ag.connect(this.postBus);
    this._env(ag, t + 0.05, 0.12, 0.12, 0.9);
    this._reap([ag], 1.8);
    air.start(t); air.stop(t + 1.6);

    /* 遠くの低い唸り。倒れた後の「まだ世界は続いている」を残す。
       ここも高さを持たせない（音程が聞こえると、それはそれで耳につく）ので、
       低い所へ薄く1枚だけ */
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.setValueAtTime(74, t);
    hum.frequency.exponentialRampToValueAtTime(58, t + 1.4);
    const hg = ctx.createGain();
    hum.connect(hg); hg.connect(this.postBus);
    this._env(hg, t + 0.1, 0.1, 0.2, 1.1);
    this._reap([hg], 1.8);
    hum.start(t); hum.stop(t + 1.6);
  }

  /**
   * 誰かがロビーに入ってきた合図。「ピコン」。
   *
   * これは戦闘中に鳴る音ではなく、**別の作業をしている人に気づかせる音**なので、
   * 作りの狙いが他と違う。他の音は場に馴染ませるが、これは馴染ませない。
   *
   * - 高い2音を上がる形で並べる。上がる音は「来た・増えた」に聞こえる。
   *   下がると「終わった・抜けた」になるので、入室に下降は使わない
   * - サイン波にする。ノイズや倍音の多い波は環境音に紛れて、
   *   画面を見ていない人には聞こえない
   * - 距離減衰も残響も通さない。場所を持たない音なので、
   *   位置を付けると「どこかで鳴った」になって用を成さない
   */
  lobbyJoin() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // 1音目は短く切る。2音目と繋がって「ピー」になると呼びかけに聞こえない
    const beep = (at, freq, vol, len) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, at);
      const g = ctx.createGain();
      o.connect(g);
      // 立ち上がりを0にすると先頭がプチッと鳴るので、わずかに寝かせる
      this._env(g, at, vol, 0.004, len);
      // 被弾で耳鳴りが掛かっている最中でも聞こえてほしいので、そのフィルタは迂回する
      g.connect(this.postBus);
      this._reap([g], 1.2);
      o.start(at); o.stop(at + len + 0.05);
    };
    beep(t, 1320, 0.22, 0.075);
    beep(t + 0.085, 1980, 0.20, 0.16);
  }

  /**
   * 爆発。銃声と同じ3層の作りだが、比率が逆になる。
   * 銃声は高いクラックが主役で低音が支え。爆発は低音が主役で、
   * 高域は「立ち上がりの割れ」として一瞬だけ乗る。
   * ここを銃声と同じ比率で作ると、ただの大きい銃声になって爆発に聞こえない
   */
  explosion(position, camera) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    // 音は光より遅い。近いと同時、遠いと遅れて届く
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);

    // (1) 低音の押し。90Hzから20Hzへ落として腹に来る成分を作る
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    // 低音を1本から2本に。62Hzと94Hzをずらして重ねると唸りが出て太くなる。
    // 1本だと音程のはっきりした「ボン」になって、玩具の破裂音に近づく
    sub.frequency.setValueAtTime(rnd(58, 70), t);
    sub.frequency.exponentialRampToValueAtTime(16, t + 0.85);
    const sg = ctx.createGain();
    sub.connect(sg);
    this._env(sg, t, 0.66, 0.004, 0.75);
    this._out(this._place(sg, position, camera, 30, dist), 0.5, 0.5);
    sub.start(t); sub.stop(t + 1.6);

    // 2本目の低音。1本目とわずかにずらして唸りを作る。
    // 同じ周波数を重ねても音量が増えるだけだが、ずらすと「うねる」ぶん体積が出る
    const sub2 = ctx.createOscillator();
    sub2.type = 'sine';
    sub2.frequency.setValueAtTime(rnd(88, 104), t);
    sub2.frequency.exponentialRampToValueAtTime(24, t + 0.6);
    const sg2 = ctx.createGain();
    sub2.connect(sg2);
    this._env(sg2, t, 0.42, 0.004, 0.5);
    this._out(this._place(sg2, position, camera, 28, dist), 0.5, 0.5);
    sub2.start(t); sub2.stop(t + 1.2);

    // (2) 割れ。立ち上がりの一瞬だけ高域を通す
    const crack = this._noiseSource(rnd(0.9, 1.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.18);
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    crack.connect(bp); bp.connect(cg);
    this._env(cg, t, 0.48, 0.002, 0.20);
    this._out(this._place(cg, position, camera, 22, dist), 0.45, 0.6);
    crack.start(t, Math.random()); crack.stop(t + 0.6);

    // (3) 尾。低く長く引いて空間の広さを出す
    const tail = this._noiseSource(0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 1.1);
    const tg = ctx.createGain();
    tail.connect(lp); lp.connect(tg);
    this._env(tg, t + 0.03, 0.42, 0.02, 1.5);
    this._out(this._place(tg, position, camera, 26, dist), 0.7, 0.8);
    tail.start(t, Math.random()); tail.stop(t + 2.0);
  }

  /**
   * 刃が物に当たった音。当たった相手で鳴り方を変える。
   *
   * 全部同じ鈍い音にしていた時期があるが、遊んで
   * 「ナイフを障害物にやったらカンカン鳴ってほしい」と言われた。
   * 肉に刺さる音と鉄板を叩く音が同じでは、何に当たったのか耳から分からない。
   *
   * kind は着弾の材質分けと同じ言葉を使う（flesh / metal / wood / concrete）。
   * 分けているのは3つ:
   *   刺さる … 芯が低くて余韻が無い。「ドスッ」
   *   叩く   … 澄んだ倍音が重なって長く残る。「カンッ」
   *   突く   … その中間。木は短く、コンクリは芯だけ
   */
  stab(position, camera, kind = 'concrete') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const flesh = kind === 'flesh';
    const bus = ctx.createGain();
    const ends = [];

    if (kind === 'metal') {
      /* 金属を叩いた音。
         鐘や鉄板の倍音は整数倍に並ばない（1:2:3ではなく1:2.76:5.40のように散る）。
         整数倍で重ねると「音程のある楽器」になってしまい、鉄を叩いた感じが出ない。
         散らした3本を高いQで長めに残すと「カンッ」と鳴って尾が引く */
      const base = rnd(1180, 1520);
      const ratios = [1, 2.71, 5.13];
      /* 音量。ここは最初この5倍にしていて、実測すると山が0.58〜0.92まで振れていた。
         銃声(0.67)より大きい音が壁を擦るたびに鳴る状態。
         しかも5分の1にしても山は0.38までしか下がらず、**比例していなかった**。
         出口のリミッターに突っ込んでいて、潰れたぶんだけ数字が動かなくなっていた。
         潰れる手前まで下げてあるのがこの値で、山は0.42（肉0.57・木0.45と同じ範囲） */
      const gains = [0.053, 0.030, 0.018];
      const decays = [0.34, 0.22, 0.14];
      for (let i = 0; i < ratios.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        // わずかに下がる。叩いた直後の張りが抜けていく所
        o.frequency.setValueAtTime(base * ratios[i], t);
        o.frequency.exponentialRampToValueAtTime(base * ratios[i] * 0.985, t + decays[i]);
        const g = ctx.createGain();
        o.connect(g); g.connect(bus);
        this._env(g, t, gains[i], 0.001, decays[i]);
        o.start(t); o.stop(t + 0.9);
        ends.push(o);
      }
      // 打点。刃が当たった瞬間の硬い当たり。これが無いと「後から鳴り出す」ように聞こえる
      const src = this._noiseSource(0.35);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2600;
      const g = ctx.createGain();
      src.connect(f); f.connect(g); g.connect(bus);
      this._env(g, t, 0.065, 0.001, 0.02);
      src.start(t, Math.random()); src.stop(t + 0.4);

      // 物がぶつかった手応え。倍音だけだと250〜800Hzの取り分が1.2%まで落ちて、
      // 鉄板ではなく鈴を鳴らしたように聞こえる（実測して足した。今は15.2%）。
      // 短く切るので「カン」の頭にしか乗らない
      const th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(420, t);
      th.frequency.exponentialRampToValueAtTime(180, t + 0.06);
      const thg = ctx.createGain();
      th.connect(thg); thg.connect(bus);
      this._env(thg, t, 0.050, 0.001, 0.045);
      th.start(t); th.stop(t + 0.3);
      ends.push(th);
      // 残響へ多めに送る。金属は周りへ響く物なので、乾いていると板ではなく紙に聞こえる
      this._out(this._place(bus, position, camera, 10), 0.32, 0.22);
      return;
    }

    // 突き当たりの芯。硬い物ほど高く短い
    const core = flesh ? 160 : kind === 'wood' ? 300 : 240;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(core, t);
    o.frequency.exponentialRampToValueAtTime(flesh ? 70 : core * 0.46, t + 0.05);
    const og = ctx.createGain();
    o.connect(og); og.connect(bus);
    this._env(og, t, 0.30, 0.002, flesh ? 0.07 : 0.05);

    // 擦れ。刃が入って止まるまでの短いノイズ
    const src = this._noiseSource(rnd(0.5, 0.8));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = flesh ? 700 : kind === 'wood' ? 2400 : 1600;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, flesh ? 0.26 : 0.16, 0.002, 0.06);

    this._out(this._place(bus, position, camera, 8), 0.2, 0.1);
    o.start(t); o.stop(t + 0.3);
    src.start(t, Math.random()); src.stop(t + 0.3);
  }

  /** 刃を振る音。空気を切る「ヒュッ」だけ。金属は鳴らさない（振っただけでは鳴らない） */
  swing() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this._noiseSource(rnd(1.1, 1.4));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // 通り過ぎる間に帯域が上がって下がる。これが「横切った」に聞こえる
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.06);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.16);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g);
    this._env(g, t, 1.30, 0.010, 0.12);
    this._out(g, 0.12, 0.05);
    src.start(t, Math.random()); src.stop(t + 0.4);

    // 押しのける空気。帯域を絞ったシュッという音だけだと、
    // measureで低音の取り分が0.6%しかなく、細い糸のような音になっていた。
    // 速く動く物は必ず低い所の空気も動かす
    const air = this._noiseSource(rnd(0.35, 0.5));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.exponentialRampToValueAtTime(620, t + 0.07);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.18);
    lp.Q.value = 0.8;
    const ag = ctx.createGain();
    air.connect(lp); lp.connect(ag);
    this._env(ag, t, 1.45, 0.014, 0.15);
    this._out(ag, 0.10, 0.04);
    air.start(t, Math.random()); air.stop(t + 0.45);
  }

  /* -------------------------------------------------- 被弾・耳鳴り・生体 */

  // 耳鳴り。2本を僅かにずらすと単音のピーではなく「詰まった」鳴りになる
  _buildTinnitus() {
    const ctx = this.ctx;
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0.0001;
    this.ringGain.connect(this.postBus);
    for (const f of [4720, 6180]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f > 5000 ? 0.4 : 1;
      o.connect(g); g.connect(this.ringGain);
      o.start();
    }
  }

  // 呼吸。息の帯域をゆっくり開閉させるだけで「人間が中にいる」音になる
  _buildBreath() {
    const ctx = this.ctx;
    const src = this._noiseSource(0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 620;
    bp.Q.value = 0.9;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0.0001;
    src.connect(bp); bp.connect(this.breathGain);
    this.breathGain.connect(this.postBus);
    src.start();

    // 吸って吐くの往復。depthを上げると息が荒くなる
    this.breathLfo = ctx.createOscillator();
    this.breathLfo.type = 'sine';
    this.breathLfo.frequency.value = 0.42;
    this.breathDepth = ctx.createGain();
    this.breathDepth.gain.value = 0;
    this.breathLfo.connect(this.breathDepth);
    this.breathDepth.connect(this.breathGain.gain);
    const fMod = ctx.createGain();
    fMod.gain.value = 260;
    this.breathLfo.connect(fMod);
    fMod.connect(bp.frequency);
    this.breathLfo.start();
  }

  /**
   * 体力を伝える。0..1。低体力で心音と息が立ち上がる。
   * 毎フレーム呼んで良い（変化が小さい時は何もしない）。
   */
  setVitals(healthFraction = 1, alive = true) {
    const frac = clamp(healthFraction, 0, 1);
    // 45%を切ってから効き始める。常時鳴っていると緊張感が擦り切れる
    const low = alive ? clamp((0.45 - frac) / 0.45, 0, 1) : 0;
    if (Math.abs(low - this._lowHp) < 0.02 && !(low > 0 && !this._heartTimer)) return;
    this._lowHp = low;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.breathDepth.gain.setTargetAtTime(low * 0.055, t, 0.5);
    this.breathLfo.frequency.setTargetAtTime(0.35 + low * 0.55, t, 0.8);
    if (low > 0.02 && !this._heartTimer) this._heartLoop();
  }

  _heartLoop() {
    this._heartTimer = null;
    if (!this.ready || !this.enabled || this._lowHp <= 0.02) return;
    const t = this.ctx.currentTime + 0.03;
    const vol = 0.10 + this._lowHp * 0.26;
    this._heartBeat(t, vol);
    this._heartBeat(t + 0.17, vol * 0.62);
    const bpm = 64 + this._lowHp * 62;
    this._heartTimer = setTimeout(() => this._heartLoop(), 60000 / bpm);
  }

  // 心音。低い正弦を短く落とすだけで胸を叩く音になる
  _heartBeat(t, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(31, t + 0.1);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.postBus);
    this._reap([g], 1.2);
    this._env(g, t, vol, 0.008, 0.07);
    o.start(t); o.stop(t + 0.3);
  }

  /**
   * 被弾。amountは0..1（受けたダメージの重さ）。
   * 世界の音が丸まり、耳鳴りだけが素通しで残る＝殴られた直後の聞こえ方。
   */
  hurt(amount = 0.4) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amt = clamp(amount, 0, 1);

    const src = this._noiseSource(rnd(0.4, 0.6));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = rnd(320, 440);
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(this.postBus);
    this._reap([g, f], 1.2);
    this._env(g, t, 0.4 + amt * 0.3, 0.002, 0.16);
    src.start(t, Math.random()); src.stop(t + 0.5);

    // 世界の音を落とす。戻す時定数を重さで変えると、軽い被弾は一瞬で復帰する
    const ef = this.earFilter.frequency;
    ef.cancelScheduledValues(t);
    // こもらせる量も戻る速さも控えめにする。
    // 3460Hzまで落として時定数1秒で戻す形だと、連射を受けている間ずっと
    // こもったままになり、被弾が続く＝一番音を聴きたい場面で何も聞こえなくなる。
    // 一瞬だけ落として素早く戻す（撃たれた実感は出るが情報は失わない）
    ef.setValueAtTime(Math.max(ef.value, 3000), t);
    ef.linearRampToValueAtTime(lerp(9000, 4200, amt), t + 0.02);
    ef.setTargetAtTime(20000, t + 0.05, 0.10 + amt * 0.22);

    // 耳鳴り（キーン）は鳴らさない。撃たれるたびに高い正弦波が数秒残るのは
    // 情報を1つも足さないうえ、次の撃ち合いの音を聴き取る邪魔にしかならない。
    // 「撃たれた」の実感は上の earFilter（世界の音がこもる）だけで足りる
  }

  death(position, camera) {
    if (!this.ready || !this.enabled) return;
    this.impact('flesh', position, camera);
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.28;
    const src = this._noiseSource(rnd(0.5, 0.75));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = rnd(420, 580);
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.3, 0.006, 0.2);
    const out = this._place(g, position, camera, 10);
    this._out(out, 0.4, 0.25);
    src.start(t, Math.random()); src.stop(t + 0.7);
  }

  /* ---------------------------------------------------------- 環境音 */

  // 遠くの銃声と風。無音だと戦場に見えないので薄く敷く。
  //
  // 以前は「1本のノイズをローパスに通して0.07Hzで揺らす」だけだった。
  // 帯域が1つしかないので、耳が数秒で慣れて「ずっと同じ音」になる。
  // 自然界の風がそう聞こえないのは、低い唸り・中域のさざめき・高域の擦れが
  // それぞれ別の速さで動いているから。層を3つに分けて、揺らす周期を
  // 互いに素にならない程度にずらす（同じ周期だと3層が揃って脈打つ）
  _startAmbience() {
    const ctx = this.ctx;

    // 層を1つ作る。rateは再生速度＝ざらつきの細かさ、
    // freqはローパスの高さ、lfoHzは強弱の揺れる速さ
    const layer = (rate, type, freq, q, level, lfoHz, depth) => {
      const src = this._noiseSource(rate);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q) f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();

      const lfo = ctx.createOscillator();
      lfo.frequency.value = lfoHz;
      const lg = ctx.createGain();
      lg.gain.value = depth;
      lfo.connect(lg); lg.connect(g.gain);
      lfo.start();
      return { f, g };
    };

    // 低い唸り。建物の間を抜ける風の芯。一番ゆっくり動く
    layer(0.16, 'lowpass', 150, 0, 0.020, 0.043, 0.012);
    // 中域のさざめき。ここが「屋外にいる」感を作る
    // 中域は一番耳につく帯。0.020は流しっぱなしだと「サー」として残り続けるので半分に
    layer(0.30, 'bandpass', 520, 0.9, 0.009, 0.071, 0.007);
    // 高域の擦れ。金網や砂が鳴る帯。速く動かすと落ち着かないので浅く
    // 高域は完全に落とす。2.6kHz以上のノイズは音量を絞っても不快さだけが残る
    layer(0.85, 'lowpass', 1400, 0, 0.004, 0.113, 0.003);

    // 遠くの金属が軋む音。風の層とは無関係に、思い出したように鳴る。
    // 周期的な物が1つも無いと、耳は全体を「ノイズ」として1枚に畳んでしまう。
    // たまに輪郭のある音が入ると、そのたびに空間の広さを聞き直すことになる
    const creak = () => {
      if (!this.ctx) return;
      if (this.enabled && Math.random() < 0.55) {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const base = rnd(70, 150);
        o.frequency.setValueAtTime(base, t);
        // ゆっくり上げると「重い物が撓む」に聞こえる。下げると崩れる音になる
        o.frequency.exponentialRampToValueAtTime(base * rnd(1.15, 1.5), t + rnd(0.5, 1.1));
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = rnd(300, 700);
        bp.Q.value = 3.5;
        const g = ctx.createGain();
        o.connect(bp); bp.connect(g); g.connect(this.master);
        this._env(g, t, rnd(0.010, 0.022), 0.35, rnd(0.6, 1.2));
        o.start(t); o.stop(t + 2.0);
        // 止めたoは自動で片付くが、下流のbp/gはmasterに繋がったまま残る。
        // ここだけ_reap()を呼び忘れていて、ロビーで待っている間も含めて
        // 20〜40秒に1回、masterへノードが繋がりっぱなしで積み上がっていた
        this._reap([bp, g], 2.4);
      }
      setTimeout(creak, rnd(14000, 34000));
    };
    setTimeout(creak, rnd(4000, 9000));

    // 遠景の撃ち合い。distanceを渡して遠距離帯の合成に乗せる。
    // 単発と連射を混ぜると「別の場所で戦闘が続いている」ように聞こえる
    const distant = () => {
      if (!this.ctx) return;
      if (this.enabled && Math.random() < 0.7) {
        const d = rnd(90, 220);
        const burst = Math.random() < 0.45 ? Math.floor(rnd(2, 5)) : 1;
        for (let i = 0; i < burst; i++) {
          setTimeout(() => this.gunshot({
            volume: rnd(0.5, 0.9), bodyFreq: rnd(210, 290), crackFreq: 1200,
            bodyDecay: 0.3, tailDecay: 1.1, thumpFrom: 70, thumpTo: 30,
            distance: d, mech: false,
          }), i * rnd(85, 130));
        }
      }
      setTimeout(distant, rnd(2600, 8600));
    };
    setTimeout(distant, 3000);
  }
}
