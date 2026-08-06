// 声で話す層の検査。
//
// **見られる所と見られない所がはっきり分かれる層。** 先に線を引いておく。
//
//   見られる … 合図が誰に渡るか／誰と繋ぐか／どちらから声をかけるか／
//              抜けた人の片付け／マイクを断った時／設定
//   見られない … 実際に声が聞こえるか／音質／遅れ／エコー
//
// 見られない所は人が確かめるしかないので、PRの動作確認に必ず書く。
// ここでやるのは、**聞こえない時に「作りが悪いのか回線が悪いのか」を切り分けられる**
// ようにしておくこと。下の項目が全部通っていれば、残る原因は回線と端末だけになる。
//
// 特に見張りたいのが4つ。
//
//   1. **敵チームへ合図が渡る。** 渡ると、書き換えた手元から敵の声を聞ける。
//      **作戦がそのまま漏れる**ので、2対2が成立しなくなる
//   2. **両側から同時に声をかける。** ぶつかってどちらも繋がらない。
//      番号の小さい方からだけ、が守られているか
//   3. **抜けた人の繋ぎが残る。** 残ると繋ぎが増え続けて、そのうち音が途切れる
//   4. **マイクを断ると遊べなくなる。** 一番やってはいけない壊れ方
//
//   node tools/check-voice.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { PHASE, EV, Sv } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const room = getRoom(world);
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); };

/* 入る。**本物と同じ順番でロビーを配る。**
   room.join() 自体はロビーを配らない（お迎えより先に配ると、入ってきた本人が
   まだ受け口を繋いでいなくて捨てられるため）。配るのは server/index.js の仕事で、
   繋ぐ相手の一覧もそこに相乗りしている。ここを省くと、本物では届く物が
   届かないまま検査することになる */
const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  room.sendLobby();
  return { conn, slot };
};

/** その人へ最後に届いた「繋ぐ相手の一覧」 */
const peersOf = (p) => {
  for (let i = p.conn.sent.length - 1; i >= 0; i--) {
    const m = p.conn.sent[i];
    if (m.t !== Sv.EVENT || !Array.isArray(m.e)) continue;
    const ev = m.e.find((x) => x.e === EV.VOICE);
    if (ev) return ev.p;
  }
  return null;
};

console.log('\n[1] 誰と繋ぐかはサーバーが決める');
// **手元が自分で決める形にすると、書き換えるだけで敵チームへ繋いで作戦を聞ける**
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const a = join('あき');
  const b = join('ばん');
  ok(room.voicePeers(a.slot).includes(b.slot.id), 'デスマッチでは部屋の全員が同じ輪');
  ok(!room.voicePeers(a.slot).includes(a.slot.id), '自分は入らない');

  // 一覧が本人へ配られている。配られないと、手元は誰へ繋げばいいか分からない
  ok(Array.isArray(peersOf(a)), '繋ぐ相手の一覧が届いている');
  ok(peersOf(a).includes(b.slot.id), `中身も合っている（${peersOf(a).join('、')}）`);
}

console.log('\n[2] 2対2では味方だけ');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('team');
  const ps = ['あき', 'ばん', 'しい', 'えむ'].map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  const [a, b, c, d] = ps;

  ok(room.voicePeers(a.slot).includes(b.slot.id), '味方は輪に入る');
  ok(!room.voicePeers(a.slot).includes(c.slot.id), '敵は輪に入らない');
  ok(!room.voicePeers(a.slot).includes(d.slot.id), 'もう1人の敵も入らない');
  ok(room.voicePeers(c.slot).includes(d.slot.id), '相手チームも同じ決まり');
  ok(peersOf(a).length === 1, `届く一覧も味方1人だけ（${peersOf(a).length}人）`);
}

console.log('\n[3] 席に着く前は全員と話せる');
// **座る前から相談できないと、チーム分けそのものが決められない。**
// そこが一番喋りたい場面
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('team');
  const a = join('あき');
  const b = join('ばん');
  room.takeSeat(a.slot, 0);
  // bはまだ立っている
  ok(room.voicePeers(a.slot).includes(b.slot.id), '片方が立っている間は繋がる');
  room.takeSeat(b.slot, 2);   // 敵側へ座った
  ok(!room.voicePeers(a.slot).includes(b.slot.id), '敵側へ座った時点で切れる');
}

console.log('\n[4] 合図は輪の中にしか渡らない');
// **ここが漏れると、2対2で敵の作戦がそのまま聞ける**
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('team');
  const ps = ['あき', 'ばん', 'しい'].map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i === 2 ? 2 : i));
  const [a, b, c] = ps;
  b.conn.sent.length = 0;
  c.conn.sent.length = 0;

  ok(room.signal(a.slot, b.slot.id, { sdp: 'なにか' }) === true, '味方へは渡る');
  const got = b.conn.sent.find((m) => m.t === Sv.VSIG);
  ok(!!got, '相手に届いている');
  ok(got.from === a.slot.id, '送り主が入っている（どちらへ返せばいいか分かる）');
  ok(got.d?.sdp === 'なにか', '中身がそのまま渡っている');

  ok(room.signal(a.slot, c.slot.id, { sdp: 'ひみつ' }) === false, '敵へは渡らない');
  ok(!c.conn.sent.some((m) => m.t === Sv.VSIG), '敵に何も届いていない');

  ok(room.signal(a.slot, a.slot.id, { sdp: 'x' }) === false, '自分自身へは渡らない');
  ok(room.signal(a.slot, 99999, { sdp: 'x' }) === false, '居ない相手へは渡らない');
  ok(room.signal(a.slot, b.slot.id, undefined) === false, '中身が無い物は渡さない');
}

console.log('\n[5] サーバーは中身を読まない');
// 読むと、そこが壊れた電文を食わせる入口になる
{
  const src = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = src.split('signal(from, toId, d) {')[1]?.split('\n  }')[0] || '';
  ok(body.length > 0, '渡す所が見つかった');
  // d.sdp や d.type を見に行っていないこと。見た瞬間、形の検査が要る物になる
  ok(!/\bd\.\w/.test(body), `中身の項目を1つも見ていない（${(body.match(/\bd\.\w+/g) || []).join('、') || 'なし'}）`);
  ok(/voicePeers\(from\)/.test(body), '渡してよい相手かどうかだけ見ている');

  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const handler = index.split('function onVoiceSignal(conn, m) {')[1]?.split('\n}')[0] || '';
  ok(handler.length > 0, '受け口がある');
  ok(!/m\.d\.\w/.test(handler), '受け口でも中身を覗いていない');
}

console.log('\n[6] 抜けた人は輪から外れる');
// 残すと、切れた相手へ繋ぎ続けて繋ぎが増える
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const a = join('あき');
  const b = join('ばん');
  ok(peersOf(a).includes(b.slot.id), '2人いる時は繋ぐ');
  a.conn.sent.length = 0;
  room.leave(b.slot);
  ok(Array.isArray(peersOf(a)), '抜けた時に一覧が配り直される');
  ok(peersOf(a).length === 0, `輪から外れている（${peersOf(a).length}人）`);
  ok(room.signal(a.slot, b.slot.id, { sdp: 'x' }) === false, '抜けた人へは渡らない');
}

console.log('\n[7] どちらから声をかけるか');
// **両側から同時に出すとぶつかって、どちらも繋がらない**
{
  globalThis.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; this.localDescription = { type: 'offer' }; }
    addTrack() {}
    close() { this.connectionState = 'closed'; }
    async createOffer() { return { type: 'offer' }; }
    async createAnswer() { return { type: 'answer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
  };
  /* Nodeのnavigatorは読み取り専用なので、代入では差し替えられない。
     ここで断る形にしてあるのは、**断られた時に遊べなくなるのが一番痛い**ため
     （[9]でそこを見る） */
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => { throw new Error('断られた'); } } },
  });

  const { VoiceChat } = await import('../src/net/voice.js');
  const sent = [];
  const v = new VoiceChat((to, d) => sent.push({ to, d }));
  v.myId = 5;
  v.setEnabled(true);

  v.setPeers([9]);
  ok(v.peers.has(9), '番号が大きい相手へは自分から声をかける');
  v.setPeers([]);
  v.setPeers([2]);
  ok(!v.peers.has(2), '番号が小さい相手へは自分からは声をかけない（待つ側になる）');

  // 待つ側でも、相手から来たら繋ぐ
  await v.receive(2, { sdp: { type: 'offer' } });
  ok(v.peers.has(2), '相手から来たら繋ぐ');
  // 輪の外から来た合図は受けない
  await v.receive(77, { sdp: { type: 'offer' } });
  ok(!v.peers.has(77), '輪の外から来た合図は受けない');
}

console.log('\n[8] 入り切りと片付け');
{
  const { VoiceChat } = await import('../src/net/voice.js');
  const v = new VoiceChat(() => {});
  v.myId = 1;
  v.setEnabled(true);
  v.setPeers([2, 3]);
  ok(v.peers.size === 2, `2人と繋ぐ（${v.peers.size}）`);

  // 増えた人だけ繋ぎ、減った人だけ切る。毎回全部繋ぎ直すと声が途切れる
  v.setPeers([3, 4]);
  ok(v.peers.has(3) && v.peers.has(4) && !v.peers.has(2),
    `差だけ動く（今 ${[...v.peers.keys()].join('、')}）`);

  v.setEnabled(false);
  ok(v.peers.size === 0, '切ると全部畳む');
  v.setEnabled(true);
  ok(v.peers.size === 2, '入れ直すと繋ぎ直す');
  v.dispose();
  ok(v.peers.size === 0, '片付けで全部消える');
}

console.log('\n[9] マイクを断っても遊べる');
// **一番やってはいけない壊れ方。** 断った人が遊べなくなる
{
  const { VoiceChat } = await import('../src/net/voice.js');
  const v = new VoiceChat(() => {});
  v.myId = 1;
  v.setEnabled(true);
  let threw = false;
  try {
    await v._ensureMic();
    v.setTalking(true);
    v.setPeers([2]);
    await v.receive(2, { sdp: { type: 'offer' } });
  } catch { threw = true; }
  ok(!threw, '断られても例外を外へ出さない');
  ok(v.micDenied === true, '断られた事は覚えている（画面に出すため）');
  ok(v.peers.has(2), '聞く側としては繋ぐ（相手の声は聞こえる）');
  v.dispose();
}

console.log('\n[10] 押して話す');
{
  const { VoiceChat, PTT_CODE } = await import('../src/net/voice.js');
  ok(PTT_CODE === 'KeyV', `キーはV（${PTT_CODE}）`);
  // WASD・しゃがみ(Ctrl/C)・リロード(R)・包帯(F)・武器(1〜4)と当たらないこと
  const used = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'KeyC',
    'ControlLeft', 'ShiftLeft', 'Space', 'Tab', 'Escape', 'Enter',
    'Digit1', 'Digit2', 'Digit3', 'Digit4'];
  ok(!used.includes(PTT_CODE), '他の操作とぶつかっていない');

  const v = new VoiceChat(() => {});
  v.setEnabled(true);
  v.setTalking(true);
  ok(v.talking === true, '押している間だけ立つ');
  v.setTalking(false);
  ok(v.talking === false, '離すと落ちる');
  // 切っている時は、押しても送らない
  v.setEnabled(false);
  v.setTalking(true);
  ok(v.talking === false, 'ボイスチャットを切っている時は押しても送らない');
}

console.log('\n[11] 手元の繋ぎ込み');
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/case EV\.VOICE/.test(main), '繋ぐ相手の一覧を受けている');
  ok(/onVoiceSignal\s*=/.test(main), '合図を受けている');
  ok(/voice\.myId = net\.id/.test(main), '自分の番号を渡している（どちらから声をかけるかに要る）');
  // 畳まないと、抜けた後もマイクが開いたままになる
  ok(/_leaveMatch[\s\S]{0,900}?voice\?\.dispose\(\)/.test(main), '試合から抜ける時に畳んでいる');
  // 発言を打っている最中にVを押すと、字がそのまま送信になる
  ok(/chat\?\.typing[\s\S]{0,80}?PTT_CODE|PTT_CODE[\s\S]{0,80}?chat\?\.typing/.test(main),
    '発言を打っている最中は送らない');

  const settings = readFileSync(new URL('../src/core/settings.js', import.meta.url), 'utf8');
  ok(/key: 'voice'/.test(settings), '設定にボイスチャットの入り切りがある');
  ok(/key: 'voiceVol'/.test(settings), '設定に声の音量がある');

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  /* 繋ぐ相手の一覧はロビーの電文に相乗りしている。
     **入った直後にロビーを配らないと、最初の1人には一覧が届かない** */
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const onJoin = index.split('function onJoin(conn, m) {')[1]?.split('\n}')[0] || '';
  ok(/sendLobby\(\)/.test(onJoin), '入った時にロビー（と繋ぐ相手の一覧）を配っている');

  ok(html.includes('id="voice"'), '送信中を出す場所がある');
  ok(/id="voice"[^>]*class="[^"]*hidden/.test(html), '普段は出ていない');
}

clear();
room.phase = PHASE.WAIT;
room.setMode('dm');

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
