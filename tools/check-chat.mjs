// 発言の検査。
//
// ここは他人が打った文字列がそのまま自分の画面へ届く唯一の口なので、
// このリポジトリで一番危ない場所になる。身内で遊ぶ前提でも、
// **エスケープを抜かすと発言に細工した人が他人の画面を書き換えられる。**
// だから「通ること」より「危ない物が通らないこと」を重点的に測る。
//
//   node tools/check-chat.mjs
import '../server/dom-stub.js';
import { CHAT_MAX } from '../src/net/protocol.js';

/* ------------------------------------------------ 最小限の偽DOM */

// dom-stub.js の getElementById は null を返す作りなので、
// そのままだと Chat が組み立てられない。ここで要る分だけ用意する
// （check-hud.mjs と同じやり方）。
// innerHTML を読めるようにしてあるのが肝で、
// **細工した発言がタグとして残っていないか**をここで見る
const mkEl = (id) => {
  const classes = new Set();
  const el = {
    id,
    tagName: 'DIV',
    value: '',
    _html: '',
    kids: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of String(v).split(' ')) if (c) classes.add(c); },
    get innerHTML() {
      // 子がいる時は子を並べた形を返す。ここが素のタグかどうかを見る
      if (this.kids.length) return this.kids.map((k) => `<div class="${k.className}">${k._html}</div>`).join('');
      return this._html;
    },
    set innerHTML(v) { this._html = String(v); this.kids.length = 0; },
    get children() { return this.kids; },
    appendChild(c) { this.kids.push(c); c._parent = this; return c; },
    remove() {
      const p = this._parent;
      if (p) p.kids.splice(p.kids.indexOf(this), 1);
    },
    focus() {}, blur() {},
  };
  return el;
};

const els = new Map();
// dom-stub.js の document をそのまま使い、要る2つだけ差し替える。
// 丸ごと置き換えると、地形が作るcanvasまでこちらへ来て組めなくなる
const realCreate = globalThis.document.createElement.bind(globalThis.document);
globalThis.document.getElementById = (id) => {
  if (!els.has(id)) els.set(id, mkEl(id));
  return els.get(id);
};
globalThis.document.createElement = (tag) => (
  String(tag).toLowerCase() === 'div' ? mkEl('') : realCreate(tag)
);

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { Chat } = await import('../src/ui/chat.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const room = getRoom(world);
for (const s of [...room.slots.values()]) room.leave(s);

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};

console.log('\n[1] 発言が全員へ届く');
const a = join('あき');
const b = join('ばん');
room.chat(a.slot, 'そっち行った');
const lastOf = (c) => c.sent.filter((m) => m.t === 'c').pop();
ok(!!lastOf(a.conn), '言った本人にも届く（自分の発言が流れたか確かめられる）');
ok(!!lastOf(b.conn), '相手にも届く');
ok(lastOf(b.conn).name === 'あき', `誰が言ったかが入っている（${lastOf(b.conn).name}）`);
ok(lastOf(b.conn).m === 'そっち行った', '中身がそのまま届く');

console.log('\n[2] 画面へ出す時にHTMLとして解釈されない');
// ここが本題。細工した発言を実際に流し込んで、素のタグが残らないことを見る
{
  const chat = new Chat();
  const attack = '<img src=x onerror=alert(1)>';
  chat.push('わるいひと', attack);
  const html = chat.el.log.innerHTML;
  ok(!html.includes('<img'), '画像のタグが素で入らない');
  // 打たれた文字列がそのままの形で残っていないこと。
  // onerror という単語だけを探すのは誤り。エスケープ済みの文の中に
  // 文字として残るのが正しい姿で、それを失敗と数えてしまう
  ok(!html.includes(attack), '打たれた形のままでは残らない');
  ok(html.includes('&lt;img'), `文字として出ている（${html.slice(html.indexOf('&lt;'), html.indexOf('&lt;') + 24)}…）`);

  // 名前の側も同じ口になる。本文だけ通して名前を素通しにすると意味が無い
  chat.clear();
  chat.push('<b>ぼす</b>', 'ふつうの発言');
  ok(!chat.el.log.innerHTML.includes('<b>ぼす'), '名前もそのままタグにならない');
}

console.log('\n[3] 画面に残る行数を抑えている');
{
  const chat = new Chat();
  // 前の検査で足した行が同じ入れ物に残っている（画面は1つしかないので当然）。
  // 空にしてから数えないと、数えているのが自分の行かどうか分からない
  chat.clear();
  for (let i = 0; i < 30; i++) chat.push('あき', `${i}行目`);
  const lines = chat.el.log.children.length;
  ok(lines <= 8, `古い行は消える（今 ${lines}行）`);
}

console.log('\n[4] 長さの上限が決まっている');
ok(CHAT_MAX > 0 && CHAT_MAX <= 200, `1発言は${CHAT_MAX}文字まで`);

for (const s of [...room.slots.values()]) room.leave(s);
void b;

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
