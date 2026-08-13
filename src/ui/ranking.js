// ホーム画面の隅に出しっぱなしにする順位表。
//
// なぜ要るか（2026-08-12に足した理由）: **誰かが新しく登録してくれた時に、それが分かる。**
// 遊んだ記録はサーバーに1つも残っていない（撃破数も波もその端末の中だけ）ので、
// 「人が来たかどうか」を知る手立てが今はこれしか無い。
//
// 順位は**遊んだ量**で付ける（勝利×100・撃破×2・到達波×5。server/wallet.jsのSCORE）。
// コインでは付けない。残高は買うと減るし、**稼いだ総額は台帳から直に足せる**ので、
// どちらも「遊んだ記録」にならない
// （2026-08-12に「稼いだコインの総額、微妙だな。俺ら金もらってるからね、DBで」）。
//
// **押せない。** ホームのボタンの上に透明な板を敷かないよう、
// CSSで pointer-events を切ってある（見るだけの物なので操作は要らない）。
const $ = (id) => document.getElementById(id);

/* 返事を待つ間の上限。返らないサーバーを待ち続けても、
   ここは「出れば嬉しい」種類の物なので短く切る（account.jsの15秒より短い） */
const TIMEOUT_MS = 6000;
/* 開き直すたびに聞きに行くが、**間を空ける。**
   ホームとロビーを行き来するだけで毎回叩くと、
   サーバーの連投止め(/api/meと同じ物)に当たって429が返る */
const AGAIN_MS = 20_000;

export class Ranking {
  constructor() {
    this.el = { root: $('rank'), list: $('rkList'), foot: $('rkFoot') };
    this._at = 0;
    this._busy = false;
  }

  /**
   * ホームを開いた時に呼ぶ。**間を空けて聞き直す。**
   * @param force 前回からの間を無視して聞き直す（登録した直後など）
   */
  async refresh(force = false) {
    if (!this.el.root) return;
    const now = Date.now();
    if (this._busy || (!force && now - this._at < AGAIN_MS)) return;
    this._busy = true;
    this._at = now;
    try {
      const res = await fetch('/api/ranking', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json();
      this._draw(json);
    } catch {
      /* 出せないだけ。**この表が出ないことでは何も困らない**ので、
         画面にエラーを出さない（ホームの隅に赤い字が出る方が邪魔） */
    } finally {
      this._busy = false;
    }
  }

  /** 台帳の無い置き場や、まだ誰もいない時は枠ごと隠す */
  _draw(json) {
    const rows = Array.isArray(json?.rows) ? json.rows : [];
    const { root, list, foot } = this.el;
    if (!json?.ok || !json.accounts || !rows.length) {
      root.classList.add('hidden');
      return;
    }
    root.classList.remove('hidden');
    list.innerHTML = '';
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      /* **1位の目印は rk1。top にしてはいけない。**
         index.html には枠を持たない .top（HUDの上帯）が居て、
         あちらは position:absolute なので、掴まれた行だけが枠から抜けて
         枠いっぱいに広がる。2026-08-12から実際にそうなっていて、
         1位の行だけ位置も右端も揃っていなかった
         （2026-08-13に「ランキングの表示おかしいw」）*/
      if (i === 0) li.className = 'rk1';
      const rank = document.createElement('i');
      rank.textContent = String(i + 1);
      const name = document.createElement('b');
      // **サーバーから来た文字はテキストとして入れる。**
      // innerHTMLで組むと、名前に入れられたタグがそのまま動く
      name.textContent = r.name || '名無し';
      const val = document.createElement('span');
      val.textContent = Number(r.score || 0).toLocaleString();
      /* 勝った回数を名前の横に小さく出す。**点だけだと何で上がったか読めない。**
         0勝の人には出さない（「0勝」と並ぶと、勝てていないことが強調される） */
      if (Number(r.wins) > 0) {
        const w = document.createElement('em');
        w.textContent = `${Number(r.wins)}勝`;
        name.append(' ');
        name.append(w);
      }
      li.append(rank, name, val);
      list.appendChild(li);
    });
    const n = Number(json.players || rows.length);
    /* 人数と点の付き方は行を分ける。1行に繋げると枠の幅で折り返して、
       「波」と「×5」が別々の行に割れていた */
    foot.textContent = `登録 ${n}人`;
    const how = document.createElement('b');
    how.textContent = '勝利×100 撃破×2 波×5';
    foot.append(how);
  }

  hide() { this.el.root?.classList.add('hidden'); }
}
