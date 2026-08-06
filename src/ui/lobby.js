// 繋がってから試合が始まるまでの画面。
// DOMはindex.htmlに置いてあるので、ここは配られた席の中身を描くのと、
// 押された席を統合側へ渡すことだけ持つ。通信は一切やらない（netmenu.jsと同じ作法）。
//
// 席の正しい姿を持っているのはサーバーで、この画面はその写しを描いているだけ。
// 押した瞬間に自分の画面だけ座らせると、埋まっていた席を押した時に
// 「座れたように見えて座れていない」状態が残る。押したら送るだけにして、
// 絵が変わるのは必ずサーバーから届いた後にする。
import { SEATS, CHARACTERS, MODE_LIST, LOBBY_ROW } from '../net/protocol.js';

const $ = (id) => document.getElementById(id);

// 名前がそのままHTMLとして解釈されると、名前に細工した人が
// 他人の画面を書き換えられる。出す前に必ず通す
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

export class Lobby {
  constructor() {
    this.el = {
      root: $('lobby'),
      why: $('lbWhy'),
      seats: $('lbSeats'),
      chars: $('lbChars'),
      stand: $('lbStand'),
      modes: $('lbModes'),
      modeDesc: $('lbModeDesc'),
      leave: $('lbLeave'),
      standUp: $('lbStandUp'),
      ready: $('lbReady'),
    };

    // 統合側が差し替える。初期値を空関数にしておくと、繋ぎ忘れても画面が落ちない
    this.onSeat = () => {};
    this.onLeave = () => {};
    this.onReady = () => {};
    this.onChar = () => {};
    this.onMode = () => {};
    // 今の遊び方。サーバーから届いた物を写すだけで、こちらでは決めない
    this.mode = MODE_LIST[0].id;
    // 自分が今どれを選んでいるか。印を付けるために持つ
    this.myChar = 0;

    // 自分がどれかを知らないと、自分の席に印を付けられない
    this.myId = -1;
    // 自分が準備完了を立てているか。押す時に「今の逆」を送るために持つ
    this.meReady = false;

    // ロビーで押す物はどれも「人が押した瞬間」なので、
    // 全画面へ入り直す機会にしてある。選択画面で断られていても、
    // 席や準備を押した所でもう一度頼める（試合が始まってからでは遅い）
    this.onPress = () => {};

    this.el.leave.onclick = () => this.onLeave();
    this.el.standUp.onclick = () => { this.onPress(); this.onSeat(-1, 0); };
    this.el.ready.onclick = () => { this.onPress(); this.onReady(!this.meReady); };

    this._build();
    this.render({ rows: [], why: '' });
  }

  /* 席のボタンは最初に1度だけ作る。
     届くたびに作り直すと、押そうとした瞬間にボタンが消えて空振りする */
  _build() {
    // 遊び方の候補。席や見た目と同じで、最初に1度だけ作る。
    // 押した瞬間に自分の画面だけ変えると、サーバーが断った時に
    // 「押したのに戻る」が説明できなくなるので、送るだけにする
    this.modeEls = [];
    this.el.modes.innerHTML = '';
    MODE_LIST.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lbmode';
      b.textContent = m.name;
      b.onclick = () => { this.onPress(); this.onMode(m.id); };
      this.el.modes.appendChild(b);
      this.modeEls.push(b);
    });

    // 見た目の候補。ここも最初に1度だけ作る
    this.charEls = [];
    this.el.chars.innerHTML = '';
    CHARACTERS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lbchar';
      // 色の四角と名前。名前はこちらが書いた固定の文字列なので、
      // 発言や他人の名前と違って外から細工されることが無い
      const sw = document.createElement('span');
      sw.className = 'lbswatch';
      sw.style.background = c.color;
      const label = document.createElement('span');
      label.textContent = c.name;
      b.appendChild(sw);
      b.appendChild(label);
      b.onclick = () => this.onChar(i);
      this.el.chars.appendChild(b);
      this.charEls.push(b);
    });

    // 席は1列に4つ。チーム分けは無く、座った人全員が互いに敵になる
    this.seatEls = [];
    const box = this.el.seats;
    box.innerHTML = '';
    for (let seat = 0; seat < SEATS; seat++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lbseat';
      b.onclick = () => { this.onPress(); this.onSeat(seat); };
      box.appendChild(b);
      this.seatEls.push(b);
    }
  }

  show(myId) {
    this.myId = myId;
    this.el.root.classList.remove('hidden');
  }

  hide() { this.el.root.classList.add('hidden'); }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  /**
   * サーバーから届いたロビーの中身を描く。
   * rows は [[id, name, seat, ready, chr]]。seatが-1なら、その人はまだ立っている
   */
  render({ rows = [], why = '', mode = null } = {}) {
    // 遊び方。届いていなければ今の物を保つ（人が出入りしただけの時に
    // 選択が既定へ戻ると、押し直しになる）
    if (mode) this.mode = mode;
    const cur = MODE_LIST.find((m) => m.id === this.mode) || MODE_LIST[0];
    this.modeEls.forEach((b, i) => b.classList.toggle('on', MODE_LIST[i].id === cur.id));
    this.el.modeDesc.textContent = cur.desc;

    // 席番号から座っている人を引けるようにしておく
    const bySeat = [];
    const standing = [];
    for (const r of rows) {
      const id = r[LOBBY_ROW.ID], name = r[LOBBY_ROW.NAME];
      const seat = r[LOBBY_ROW.SEAT], ready = r[LOBBY_ROW.READY];
      if (seat >= 0) bySeat[seat] = { id, name, ready: !!ready };
      else standing.push({ id, name });
    }

    for (let seat = 0; seat < SEATS; seat++) {
      const b = this.seatEls[seat];
      const who = bySeat[seat];
      b.classList.toggle('taken', !!who);
      b.classList.toggle('me', !!who && who.id === this.myId);
      b.classList.toggle('ready', !!who && who.ready);
      b.disabled = !!who && who.id !== this.myId;
      b.innerHTML = who ? esc(who.name) : `<span>${seat + 1}番 空席</span>`;
    }

    this.el.why.textContent = why;
    this.el.stand.textContent = standing.length
      ? `まだ席にいない人: ${standing.map((p) => p.name).join('、')}`
      : '';

    // 自分の行から、座っているか・準備を立てているか・どの見た目かを読む
    const me = rows.find((r) => r[LOBBY_ROW.ID] === this.myId);
    if (me && typeof me[LOBBY_ROW.CHR] === 'number') this.myChar = me[LOBBY_ROW.CHR] | 0;

    // 席に着いている他の人が使っている見た目は押せなくする。
    // サーバーも断るので押しても害は無いが、**押して無反応だと壊れているように見える**。
    // 誰が使っているかまで出すのは、「じゃあ別のにするか」を1回で決められるようにするため
    const takenBy = new Map();
    for (const r of rows) {
      const id = r[LOBBY_ROW.ID], name = r[LOBBY_ROW.NAME];
      const seat = r[LOBBY_ROW.SEAT], chr = r[LOBBY_ROW.CHR];
      if (id === this.myId || seat < 0 || typeof chr !== 'number') continue;
      takenBy.set(chr | 0, name);
    }
    this.charEls.forEach((b, i) => {
      b.classList.toggle('on', i === this.myChar);
      const who = takenBy.get(i);
      b.classList.toggle('taken', !!who);
      b.disabled = !!who;
      b.title = who ? `${who} が使用中` : '';
    });
    const meSeated = !!me && me[LOBBY_ROW.SEAT] >= 0;
    this.meReady = !!me && !!me[LOBBY_ROW.READY];

    // 座っていない時に押せても何も起きない。押せない事を見た目でも出す
    this.el.standUp.disabled = !meSeated;
    this.el.ready.disabled = !meSeated;
    this.el.ready.classList.toggle('on', this.meReady);
    this.el.ready.textContent = this.meReady ? '準備を取り消す' : '準備完了';
  }
}
