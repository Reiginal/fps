// 繋がってから試合が始まるまでの画面。
// DOMはindex.htmlに置いてあるので、ここは配られた席の中身を描くのと、
// 押された席を統合側へ渡すことだけ持つ。通信は一切やらない（netmenu.jsと同じ作法）。
//
// 席の正しい姿を持っているのはサーバーで、この画面はその写しを描いているだけ。
// 押した瞬間に自分の画面だけ座らせると、埋まっていた席を押した時に
// 「座れたように見えて座れていない」状態が残る。押したら送るだけにして、
// 絵が変わるのは必ずサーバーから届いた後にする。
import { SEATS_PER_TEAM, TEAM_NAME } from '../net/protocol.js';

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
      seats: [$('lbSeatsA'), $('lbSeatsB')],
      stand: $('lbStand'),
      leave: $('lbLeave'),
      standUp: $('lbStandUp'),
    };

    // 統合側が差し替える。初期値を空関数にしておくと、繋ぎ忘れても画面が落ちない
    this.onSeat = () => {};
    this.onLeave = () => {};

    // 自分がどれかを知らないと、自分の席に印を付けられない
    this.myId = -1;

    this.el.leave.onclick = () => this.onLeave();
    this.el.standUp.onclick = () => this.onSeat(-1, 0);

    this._build();
    this.render({ rows: [], why: '' });
  }

  /* 席のボタンは最初に1度だけ作る。
     届くたびに作り直すと、押そうとした瞬間にボタンが消えて空振りする */
  _build() {
    this.seatEls = [[], []];
    for (let team = 0; team < 2; team++) {
      const box = this.el.seats[team];
      box.innerHTML = '';
      for (let seat = 0; seat < SEATS_PER_TEAM; seat++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lbseat';
        b.onclick = () => this.onSeat(team, seat);
        box.appendChild(b);
        this.seatEls[team].push(b);
      }
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
   * rows は [[id, name, team, seat]]。teamとseatが-1なら、その人はまだ立っている
   */
  render({ rows = [], why = '' } = {}) {
    // 席番号から座っている人を引けるようにしておく
    const bySeat = [[], []];
    const standing = [];
    for (const r of rows) {
      const [id, name, team, seat] = r;
      if (team === 0 || team === 1) bySeat[team][seat] = { id, name };
      else standing.push({ id, name });
    }

    for (let team = 0; team < 2; team++) {
      for (let seat = 0; seat < SEATS_PER_TEAM; seat++) {
        const b = this.seatEls[team][seat];
        const who = bySeat[team][seat];
        b.classList.toggle('taken', !!who);
        b.classList.toggle('me', !!who && who.id === this.myId);
        b.disabled = !!who && who.id !== this.myId;
        b.innerHTML = who
          ? esc(who.name)
          : `<span>${TEAM_NAME[team]}${seat + 1} 空席</span>`;
      }
    }

    this.el.why.textContent = why;
    this.el.stand.textContent = standing.length
      ? `まだ席にいない人: ${standing.map((p) => p.name).join('、')}`
      : '';
    // 自分が座っていない時に「席を降りる」を押せても何も起きない
    const meSeated = rows.some((r) => r[0] === this.myId && (r[2] === 0 || r[2] === 1));
    this.el.standUp.disabled = !meSeated;
  }
}
