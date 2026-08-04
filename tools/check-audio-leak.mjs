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
const a = new AudioEngine(); a.init();
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
  const ok = after <= base;
  console.log(`\n  ${ok ? '○' : '× 失敗:'} 鳴らし終わった音が出力から切り離されている`);
  console.log(ok ? '\n全部通った' : '\n1件 失敗');
  process.exit(ok ? 0 : 1);
}, 1400);
