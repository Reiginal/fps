// 「destinationから辿り着けるノードの数」で測る。
// ブラウザは末端を切り離せば上流ごと解放するので、生き残っているかどうかは
// 繋がった数ではなく「出力へ到達できるか」で決まる
import '../server/dom-stub.js';
const all = [];
const param = () => ({ value: 0, setValueAtTime(){return this;}, linearRampToValueAtTime(){return this;},
  exponentialRampToValueAtTime(){return this;}, setTargetAtTime(){return this;}, cancelScheduledValues(){return this;} });
const node = (e={}) => {
  const n = { _to: new Set(), connect(x){ this._to.add(x); }, disconnect(){ this._to.clear(); },
    start(){}, stop(){}, gain: param(), frequency: param(), Q: param(), detune: param(), ...e };
  all.push(n); return n;
};
globalThis.window = globalThis.window || {};
window.AudioContext = class {
  constructor(){ this.currentTime=0; this.sampleRate=48000; this.destination=node(); this.state='running'; }
  createGain(){return node();} createOscillator(){return node({type:'sine'});}
  createBiquadFilter(){return node({type:'lowpass'});}
  createDynamicsCompressor(){return node({threshold:param(),knee:param(),ratio:param(),attack:param(),release:param()});}
  createConvolver(){return node({buffer:null});} createDelay(){return node({delayTime:param()});}
  createWaveShaper(){return node({curve:null,oversample:'none'});}
  createStereoPanner(){return node({pan:param()});}
  createBufferSource(){return node({buffer:null,loop:false,playbackRate:param()});}
  createBuffer(c,l){return {length:l,numberOfChannels:c,getChannelData:()=>new Float32Array(l)};}
};
const { AudioEngine } = await import('../src/core/audio.js');
const a = new AudioEngine();

/* _startAmbience（init内から呼ばれる）は、環境音の「軋み」と「遠景の撃ち合い」を
   setTimeoutで自分自身に予約する形で鳴らす。実時間で待つと軋みだけで最短4秒かかるので、
   init()を呼んでいる間だけsetTimeoutを横取りして、予約された関数を実行せずに集めておく。
   遅延の長さで見分ける: 軋みは4000〜9000ms、遠景の撃ち合いは固定3000ms
   （撃ち合いは連射をさらにsetTimeoutで組むので、そちらは触らずに済ませたい） */
let creakFn = null;
{
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { if (ms >= 4000) creakFn = fn; return 0; };
  a.init();
  globalThis.setTimeout = realSetTimeout;
}
const dest = a.ctx.destination;
// destinationへ到達できるノードを数える
const reach = () => {
  let n = 0;
  for (const x of all) {
    const seen = new Set(); const q = [x];
    while (q.length) {
      const c = q.pop();
      if (c === dest) { n++; break; }
      if (seen.has(c)) continue;
      seen.add(c);
      if (c._to) for (const t of c._to) q.push(t);
    }
  }
  return n;
};
const base = reach();

console.log('\n[1] 環境音の「軋み」も、鳴らした分がちゃんと片付く（22ebdfc）');
let creakOk;
{
  const realSetTimeout = globalThis.setTimeout;
  const realRandom = Math.random;
  const captured = !!creakFn;
  console.log(`  ${captured ? '○' : '× 失敗:'} 軋みの予約が捕まえられている`);
  Math.random = () => 0;   // 0.55未満に倒して、必ず鳴る側を通す
  // creak自身も次の分をsetTimeoutで自分に予約するが、ここは実時間のsetTimeoutの
  // ままでよい（このテストが終わるまでに実際には来ない遅延なので、何も起きない）
  creakFn?.();
  Math.random = realRandom;

  const afterCreak = reach();
  const rang = afterCreak > base;
  console.log(`  ${rang ? '○' : '× 失敗:'} 軋みが繋がった（${afterCreak}）`);

  a.ctx.currentTime += 10;   // stopAt(2.0秒)・_reap(2.4秒)を余裕を持って超える
  // ctx.currentTimeは進めても、_reapの回収自体は実時間のsetIntervalが
  // 実際に1回走らないと動かない。下の本編と同じ1.4秒の待ちを使う
  await new Promise((r) => realSetTimeout(r, 1400));
  const afterReap = reach();
  console.log(`  ${afterReap <= base ? '○' : '× 失敗:'} 片付いた後は起動時と同じ（${afterReap}）`);
  creakOk = captured && rang && afterReap <= base;
}

console.log('\n[2] 1試合ぶん鳴らした音が、片っ端から出力へ繋がりっぱなしにならない');
const cam = { position:{x:0,y:1.6,z:0}, rotation:{y:0} }, at = { x:1, y:1, z:-1 };
for (let i=0;i<1200;i++){ a.ctx.currentTime=i*0.1;
  a.gunshot({volume:0.7,bodyFreq:300,crackFreq:3600,bodyDecay:0.2,tailDecay:0.6,thumpFrom:110,thumpTo:44}, at, cam);
  a.impact('concrete', at, cam); }
for (let i=0;i<3000;i++) a.footstep(0.8,'asphalt',at,cam);
for (let i=0;i<300;i++){ a.hurt(0.4); a.hitmarker(false); }
const peak = reach();
a.ctx.currentTime += 60;
setTimeout(() => {
  const after = reach();
  console.log(`  起動直後に出力へ繋がっているノード: ${base}`);
  console.log(`  1試合ぶん鳴らした直後: ${peak}`);
  console.log(`  回収が走った後: ${after}`);
  // 起動時の固定分より増えていたら、鳴らすたびに溜まり続けている。
  // 溜まるとブラウザのノード上限に当たって、そこから先は何も鳴らなくなる
  const ok = after <= base && creakOk;
  console.log(`\n  ${after <= base ? '○' : '× 失敗:'} 鳴らし終わった音が出力から切り離されている`);
  console.log(ok ? '\n全部通った' : '\n1件以上 失敗');
  process.exit(ok ? 0 : 1);
}, 1400);
