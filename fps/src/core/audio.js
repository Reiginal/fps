// 音源ファイルを持たず、ノイズとフィルタで効果音を合成する。
// 銃声は距離で「音量が変わる」のではなく「別の音になる」。近くは乾いたクラック、
// 中距離は残響が主役、遠くは低音のドスンだけが届く。ここを作り分けないと
// どれだけ層を重ねても平坦に聞こえる。

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
  metal:    { lp: 2800, thump: 118, decay: 0.085, grit: 0.24, gritFreq: 5400, gritQ: 1.8, ring: 0.62, partials: [186, 471, 1237], vol: 1.1 },
  wood:     { lp: 1400, thump: 128, decay: 0.055, grit: 0.22, gritFreq: 2100, gritQ: 1.2, ring: 0.34, partials: [243, 617, 1490], vol: 0.9 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    // 空間の開け具合(0=壁が近い 1=開けている)。init前に呼ばれても値だけ覚えておく
    this.openness = 0.65;
    this._lowHp = 0;
    this._heartTimer = null;
    // 同時発音が増えすぎた時に層を間引くための負荷カウンタ
    this._load = 0;
    this._loadAt = 0;
  }

  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    const ctx = new Ctx();
    this.ctx = ctx;

    // 突発的な銃声で音が割れないよう最後に軽く潰す
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);

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
    this.master.gain.value = 0.75;
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
    this._startAmbience();
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
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
    // 遠い音は空気に高域を食われる
    if (dist > 12) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 - (dist - 12) * hfLoss, 700, 16000);
      const out = ctx.createGain();
      g.connect(lp);
      lp.connect(out);
      return out;
    }
    return g;
  }

  _out(node, wet = 0.35, slap = 0) {
    node.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = wet;
    node.connect(send);
    send.connect(this.reverbSend);
    if (slap > 0) {
      const s2 = this.ctx.createGain();
      s2.gain.value = slap;
      node.connect(s2);
      s2.connect(this.slapSend);
    }
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
      const crackGain = ctx.createGain();
      crack.connect(hp); hp.connect(crackGain); crackGain.connect(bus);
      this._env(crackGain, t, 0.9 * wCrack, 0.0005, rnd(0.026, 0.042));
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
    this._env(bodyGain, t + rnd(0.0005, 0.004), 1.0 * wBody, 0.0015, bodyDecay * jDecay);
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
      this._env(tailGain, t + rnd(0.004, 0.022), 0.45 * wTail, 0.006, tailLen);
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
      this._env(oscGain, t, 0.7 * wSub, 0.002, 0.075 * jDecay);
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
      this._env(subGain, t, 0.42 * wSub, 0.006, 0.13);
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
  _magRelease(t) {
    this._metal(t, {
      partials: [2450, 3980], vol: 0.28, decay: 0.016,
      ring: 0.35, noiseFreq: 3600, noiseQ: 3.0, wet: 0.12,
    });
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
      ring: 0.55, noiseFreq: 1900, noiseQ: 1.4, wet: 0.18,
    });
  }

  // 挿入。重い塊が入って止まる音。低い倍音を厚めに、最後に嵌るカチッ
  _magIn(t) {
    this._metal(t, {
      partials: [172, 383, 908], vol: 0.5, decay: 0.05,
      ring: 0.7, noiseFreq: 900, noiseQ: 0.9, noiseType: 'lowpass', wet: 0.22,
    });
    this._metal(t + rnd(0.03, 0.045), {
      partials: [1320, 2870], vol: 0.26, decay: 0.014,
      ring: 0.4, noiseFreq: 3100, noiseQ: 2.6, wet: 0.14,
    });
  }

  // ボルト。バネがジャッと鳴ってから、前進して硬く止まる
  _bolt(t) {
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
      partials: [296, 1490, 3120, 5240], vol: 0.55, decay: 0.028,
      ring: 0.62, noiseFreq: 2600, noiseQ: 1.2, wet: 0.24,
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

  // 命中通知。短いサイン波。頭に当たったら高く鳴らす
  hitmarker(headshot = false) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = headshot ? 1750 : 1150;
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, 0.11, 0.001, 0.035);
    // 通知音は耳鳴りの向こうでも聞こえるべきなので、被弾フィルタを迂回する
    g.connect(this.postBus);
    o.start(t); o.stop(t + 0.12);
    if (headshot) {
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.setValueAtTime(1750, t + 0.045);
      o2.frequency.setValueAtTime(2400, t + 0.06);
      const g2 = ctx.createGain();
      o2.connect(g2);
      this._env(g2, t + 0.045, 0.09, 0.001, 0.04);
      g2.connect(this.postBus);
      o2.start(t + 0.045); o2.stop(t + 0.18);
    }
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
    this._env(g, t, 0.4 + amt * 0.3, 0.002, 0.16);
    src.start(t, Math.random()); src.stop(t + 0.5);

    // 世界の音を落とす。戻す時定数を重さで変えると、軽い被弾は一瞬で復帰する
    const ef = this.earFilter.frequency;
    ef.cancelScheduledValues(t);
    ef.setValueAtTime(Math.max(ef.value, 1200), t);
    ef.linearRampToValueAtTime(lerp(5200, 850, amt), t + 0.02);
    ef.setTargetAtTime(20000, t + 0.06, 0.45 + amt * 1.5);

    const rg = this.ringGain.gain;
    rg.cancelScheduledValues(t);
    rg.setValueAtTime(Math.max(rg.value, 0.0001), t);
    rg.linearRampToValueAtTime(0.02 + amt * 0.055, t + 0.025);
    rg.setTargetAtTime(0.0001, t + 0.06, 0.6 + amt * 1.7);
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

  // 遠くの銃声と風。無音だと戦場に見えないので薄く敷く
  _startAmbience() {
    const ctx = this.ctx;
    const wind = this._noiseSource(0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.035;
    wind.connect(lp); lp.connect(g); g.connect(this.master);
    wind.start();

    // 風の強さをゆっくり揺らす
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    lfo.start();

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
