// 音まわりの検査。実際に鳴らすことはできないが、
// 「呼ぶと例外になる」だけはブラウザ無しで確実に潰せる。
//
// なぜ要るか: 足音へ足すつもりだった処理を、貼る位置を間違えて
// 弾の着弾の関数へ入れてしまい、着弾のたびに未定義変数で例外が上がった。
// 描画ループの中から呼ばれるので、そのまま画面が固まる。
// 構文チェックは通る（変数名として正しい）ので、実際に呼ぶまで気づけなかった。
//
//   node tools/check-audio.mjs
import '../server/dom-stub.js';

// WebAudioの最小限の偽物。ノードの形だけ揃えて、実際の音は作らない。
// ここで欲しいのは「参照できない変数を触っていないか」だけ
const param = () => ({
  value: 0,
  setValueAtTime() { return this; },
  linearRampToValueAtTime() { return this; },
  exponentialRampToValueAtTime() { return this; },
  setTargetAtTime() { return this; },
  cancelScheduledValues() { return this; },
});
const node = (extra = {}) => ({
  connect() {}, disconnect() {}, start() {}, stop() {},
  gain: param(), frequency: param(), Q: param(), detune: param(),
  ...extra,
});

globalThis.window = globalThis.window || {};
window.AudioContext = class {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = node();
    this.state = 'running';
  }

  createGain() { return node(); }
  createOscillator() { return node({ type: 'sine' }); }
  createBiquadFilter() { return node({ type: 'lowpass' }); }
  createDynamicsCompressor() {
    return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  }

  createConvolver() { return node({ buffer: null }); }
  createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
  createDelay() { return node({ delayTime: param() }); }
  createStereoPanner() { return node({ pan: param() }); }
  createBufferSource() { return node({ buffer: null, loop: false, playbackRate: param() }); }
  createBuffer(ch, len) {
    return { length: len, numberOfChannels: ch, getChannelData: () => new Float32Array(len) };
  }
};

const { AudioEngine } = await import('../src/core/audio.js');

let bad = 0;
const ok = (name, fn) => {
  try {
    fn();
    console.log(`  ○ ${name}`);
  } catch (e) {
    console.log(`  × 失敗: ${name} … ${e.message}`);
    bad++;
  }
};

const a = new AudioEngine();
const cam = { position: { x: 0, y: 1.6, z: 0 }, rotation: { y: 0 } };
const at = { x: 3, y: 1, z: -4 };

console.log('\n[1] 起動');
ok('init()', () => a.init());

console.log('\n[2] ゲーム中に鳴る音を全部1回ずつ呼ぶ');
ok('gunshot（近く）', () => a.gunshot({
  volume: 0.7, bodyFreq: 300, crackFreq: 3600, bodyDecay: 0.2, tailDecay: 0.6,
  thumpFrom: 110, thumpTo: 44,
}, at, cam));
ok('impact concrete', () => a.impact('concrete', at, cam));
ok('impact metal', () => a.impact('metal', at, cam));
ok('impact wood', () => a.impact('wood', at, cam));
ok('impact flesh', () => a.impact('flesh', at, cam));
for (const s of ['dirt', 'gravel', 'asphalt', 'concrete', 'metal', 'wood']) {
  ok(`footstep ${s}`, () => a.footstep(0.7, s, at, cam));
  ok(`land ${s}`, () => a.land(1.0, s, at, cam));
}
ok('reload', () => a.reload(2));
ok('hitmarker', () => a.hitmarker(false));
ok('hitmarker（頭）', () => a.hitmarker(true));
ok('death', () => a.death(at, cam));
ok('hurt', () => a.hurt(0.5));
ok('swing', () => a.swing());
ok('stab（壁）', () => a.stab(at, cam, false));
ok('stab（肉）', () => a.stab(at, cam, true));
ok('explosion', () => a.explosion(at, cam));
ok('whizBy', () => a.whizBy(1.5));
ok('click', () => a.click(2800, 0.3, 0.03));
ok('lobbyJoin（入室音）', () => a.lobbyJoin());
ok('playerDown（自分が倒れた）', () => a.playerDown());
ok('setEnvironment', () => a.setEnvironment(0.4));

console.log('\n[3] 遠く・開けた場所の銃声の尾が、途中でオシレータごと止まって切れないか');
{
  // stopAt(音源を止める時刻)は距離と開けた場所ほど伸びる尾(tailLen)に
  // 合わせて計算されるが、以前はtailDecayの生値しか見ておらず、
  // 遠景では尾がまだ2割前後の音量が残っている所でプツンと切れていた
  const b = new AudioEngine();
  b.init();
  b.setEnvironment(1.0);   // 一番開けた場所

  const stops = [];
  const wrap = (name) => {
    const orig = b.ctx[name].bind(b.ctx);
    b.ctx[name] = () => {
      const n = orig();
      const origStop = n.stop.bind(n);
      n.stop = (time) => { stops.push(time); return origStop(time); };
      return n;
    };
  };
  wrap('createOscillator');
  wrap('createBufferSource');

  b.gunshot({
    volume: 0.5, bodyFreq: 300, crackFreq: 3000, bodyDecay: 0.2, tailDecay: 1.1,
    thumpFrom: 105, thumpTo: 42,
  }, { x: 200, y: 1, z: 0 }, { position: { x: 0, y: 1, z: 0 }, rotation: { y: 0 } });

  const maxStop = Math.max(...stops);
  // 直す前の式(tailDecay*2.4+0.6 ≈ 3.24秒)だと、この距離・開けた場所の尾は
  // まだ音量が2割近く残ったまま止まっていた。直した後はほぼ聞こえなくなる
  // 6秒以上まで伸びているはず
  ok(`音源を止めるまでの長さが3.24秒(直す前の値)より十分長い（今 ${maxStop.toFixed(2)}秒）`,
    () => { if (maxStop < 6) throw new Error(`${maxStop.toFixed(2)}秒しかない`); });
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
