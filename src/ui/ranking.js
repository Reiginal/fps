// ホーム画面の隅に出しっぱなしにする順位表。
//
// なぜ要るか（2026-08-12に足した理由）: **誰かが新しく登録してくれた時に、それが分かる。**
// 遊んだ記録はサーバーに1つも残っていない（撃破数も波もその端末の中だけ）ので、
// 「人が来たかどうか」を知る手立てが今はこれしか無い。
//
// 順位は**稼いだコインの総額**で付ける。残高ではない。
// 残高は買うと減るので、**スキンを買った人ほど下に落ちる表**になる。
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
      if (i === 0) li.className = 'top';
      const rank = document.createElement('i');
      rank.textContent = String(i + 1);
      const name = document.createElement('b');
      // **サーバーから来た文字はテキストとして入れる。**
      // innerHTMLで組むと、名前に入れられたタグがそのまま動く
      name.textContent = r.name || '名無し';
      const val = document.createElement('span');
      val.textContent = Number(r.earned || 0).toLocaleString();
      li.append(rank, name, val);
      list.appendChild(li);
    });
    const n = Number(json.players || rows.length);
    foot.textContent = `登録 ${n}人 ・ 稼いだコインの総額`;
  }

  hide() { this.el.root?.classList.add('hidden'); }
}
