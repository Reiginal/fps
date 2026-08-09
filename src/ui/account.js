// 会員証の画面。ログインと新規登録を1枚で兼ねる。
//
// DOMはindex.htmlに置いてあるので、ここは値の出し入れと、
// サーバーへの問い合わせだけ持つ（netmenu.jsと同じ作りだが、
// あちらは通信を一切持たないのに対して、こちらは持つ。
// 対戦の接続と違って、ここの通信は普通のHTTPで完結して他へ影響しないため）。
//
// **台帳を持たないサーバーでは、行ごと消えて何も出ない。**
// /api/me が404を返すのがその合図。素材ファイルが無くても遊べるのと同じで、
// 台帳が無くても今まで通り名前を打って遊べる状態を壊さない。
//
// 2枚に分けず1枚にしてあるのは、打ち間違えて行き来するたびに
// 入力が消えるのが煩わしいため。見出しとボタンの文言だけ差し替える。

const $ = (id) => document.getElementById(id);

/* 返事を待つ間の上限。返らないサーバーを待ち続けると、
   押した本人には「固まった」としか見えない */
const TIMEOUT_MS = 15_000;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // Cookieを送る・受け取る。同じ場所へのfetchなら既定で付くが、
    // 明示しておかないと将来ドメインを分けた時に静かに壊れる
    credentials: 'same-origin',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  /* 404は「この置き場に会員証の仕組みが無い」。中身は読まない。
     「/api/me」はこれを返さない（台帳が無くても200で accounts:false と答える）。
     ここへ来るのは登録・ログイン・ログアウトの口だけ */
  if (res.status === 404) return { off: true };
  let json = null;
  try { json = await res.json(); } catch { /* 中身が無い返事もある */ }
  return { status: res.status, ...(json || {}) };
}

export class AccountMenu {
  constructor() {
    this.el = {
      root: $('account'),
      row: $('acctRow'), who: $('acctWho'), open: $('acctOpen'), out: $('acctOut'),
      title: $('acTitle'), sub: $('acSub'), status: $('acStatus'),
      email: $('acEmail'), name: $('acName'), nameField: $('acNameField'), pass: $('acPass'),
      close: $('acClose'), swap: $('acSwap'), go: $('acGo'),
    };

    /** 今ログインしている人。していなければnull */
    this.user = null;
    /** この置き場に会員証の仕組みがあるか。無ければ行ごと出さない */
    this.available = false;
    /** ログイン状態が変わった時に呼ぶ。名前欄の差し替えは呼ぶ側の仕事 */
    this.onChange = () => {};

    this._register = false;   // 今「新規登録」の面か
    this._busy = false;

    // addEventListenerではなく代入。DOMは1組しかないので、
    // 2回作られた時に古い方まで動くのを防ぐ（netmenu.jsと同じ作法）
    this.el.open.onclick = () => this.show(false);
    this.el.out.onclick = () => this._logout();
    this.el.close.onclick = () => this.hide();
    this.el.swap.onclick = () => this._setMode(!this._register);
    this.el.go.onclick = () => this._submit();
    // Enterで送れないと、パスワードを打った後にマウスへ持ち替えることになる
    for (const i of [this.el.email, this.el.name, this.el.pass]) {
      i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this._submit(); } };
    }
  }

  /** 今の状態をサーバーへ聞く。起動時に1回だけ */
  async refresh() {
    let r;
    try {
      r = await api('/api/me');
    } catch {
      // 繋がらない。会員証は無いものとして扱う（遊べなくはならない）
      r = { off: true };
    }
    /* accounts:false は「この置き場に台帳が無い」。off は繋がらなかった時。
       どちらでも行ごと出さない（押しても何も起きないボタンは、無いより分かりにくい） */
    this.available = !r.off && r.accounts !== false;
    this.user = r.user || null;
    this._paint();
    this._verifiedNote();
    this.onChange(this.user);
  }

  /* 確認メールのリンクを踏んで戻ってきた時の印。
     サーバーは /?verified=1 へ戻すだけなので、印を読んで文言を出したら
     URLからは消す（読み込み直すたびに出続けるのを防ぐ） */
  _verifiedNote() {
    const q = new URLSearchParams(location.search);
    const v = q.get('verified');
    if (v == null) return;
    this._say(v === '1'
      ? 'メールアドレスを確認しました'
      : 'リンクが古いか、既に使われています', v !== '1');
    if (v === '1') this.show(false);
    q.delete('verified');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
  }

  /* ホームの行の見た目。**ここだけが「今どうなっているか」を描く。**
     押した時に個別に書き換える形にすると、必ずどこかで食い違う */
  _paint() {
    const { row, who, open, out } = this.el;
    row.classList.toggle('hidden', !this.available);
    if (!this.available) return;
    if (this.user) {
      who.innerHTML = `<b>${escapeHtml(this.user.name)}</b> でログイン中`
        + (this.user.verified ? '' : '<br>メールの確認がまだです');
      open.classList.add('hidden');
      out.classList.remove('hidden');
    } else {
      who.textContent = 'ログインしていません';
      open.classList.remove('hidden');
      out.classList.add('hidden');
    }
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  show(register = false) {
    if (!this.available) return;
    this._setMode(register);
    this._say('');
    this.el.root.classList.remove('hidden');
    this.el.email.focus();
  }

  hide() { this.el.root.classList.add('hidden'); }

  /* ログインの面と新規登録の面を切り替える。**入力は消さない。**
     打ち間違えて往復するたびに消えるのが一番いらつく */
  _setMode(register) {
    this._register = !!register;
    const { title, sub, swap, go, nameField, name, pass } = this.el;
    title.textContent = this._register ? '新規登録' : 'ログイン';
    sub.textContent = this._register
      ? 'メールアドレスとパスワードだけです'
      : '買った物が端末を跨いで残ります';
    swap.textContent = this._register ? 'ログイン' : '新規登録';
    go.textContent = this._register ? '登録' : 'ログイン';
    nameField.classList.toggle('hidden', !this._register);
    // 名前の初期値は、ホームで打っていた物を引き継ぐ。もう一度打たせない
    if (this._register && !name.value) name.value = $('nmName')?.value || '';
    // ブラウザのパスワード補完へ、今どちらの面かを伝える
    pass.autocomplete = this._register ? 'new-password' : 'current-password';
    this._say('');
  }

  _say(text, bad = false) {
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('bad', !!bad);
  }

  _lock(on) {
    this._busy = on;
    for (const b of [this.el.go, this.el.swap, this.el.close]) b.disabled = on;
  }

  async _submit() {
    if (this._busy) return;
    const email = this.el.email.value.trim();
    const password = this.el.pass.value;
    const name = this.el.name.value.trim();

    // 打ち終わる前に押された時。サーバーまで行かせずここで返す
    if (!email || !password) { this._say('メールアドレスとパスワードを入れてください', true); return; }
    if (this._register && !name) { this._say('名前を入れてください', true); return; }

    this._lock(true);
    this._say(this._register ? '登録しています…' : '確かめています…');
    let r;
    try {
      r = this._register
        ? await api('/api/register', { method: 'POST', body: { email, password, name } })
        : await api('/api/login', { method: 'POST', body: { email, password } });
    } catch {
      this._lock(false);
      this._say('サーバーに繋がりません。少し待ってからもう一度', true);
      return;
    }
    this._lock(false);

    if (r.off) { this.available = false; this._paint(); this.hide(); return; }
    // 文言はサーバーが作った物をそのまま出す。
    // こちら側でも同じ判定を書くと、片方だけ直した時に食い違う
    if (!r.ok) { this._say(r.error || 'うまくいきませんでした', true); return; }

    this.user = r.user;
    // パスワードは画面に残さない。次に開いた時に入ったままなのは気持ちが悪い
    this.el.pass.value = '';
    this._paint();
    this.onChange(this.user);
    this.hide();
  }

  async _logout() {
    if (this._busy) return;
    this._lock(true);
    try { await api('/api/logout', { method: 'POST' }); } catch { /* 切れていても札は捨てる */ }
    this._lock(false);
    this.user = null;
    this._paint();
    this.onChange(null);
  }
}

/* 名前は他人にも出る文字列なので、そのまま innerHTML へ入れない。
   textContent で足りる所は textContent を使っているが、
   ここは <b> と <br> を混ぜたいので、値の方を無害にしてから入れる */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
