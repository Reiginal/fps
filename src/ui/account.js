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

/* 面ごとの見せ方。**1枚のDOMを4通りに着替えさせる表。**
   email/name/pass はその欄を出すか、newPass はブラウザの補完へ
   「新しいパスワードを決めている所」と伝えるか。
   swap が空の面には、切り替えの文字リンクを出さない */
const MODES = {
  login: {
    title: 'ログイン', sub: '買った物が端末を跨いで残ります', go: 'ログイン',
    swap: 'アカウントを作る', email: true, name: false, pass: true, newPass: false,
  },
  register: {
    title: '新規登録', sub: 'メールアドレスとパスワードだけです', go: '登録',
    swap: 'アカウントを持っている（ログインする）',
    email: true, name: true, pass: true, newPass: true,
  },
  forgot: {
    title: 'パスワードの再設定',
    sub: '登録したメールアドレスへ、再設定のリンクを送ります',
    go: 'リンクを送る', swap: 'ログインに戻る',
    email: true, name: false, pass: false, newPass: false,
  },
  reset: {
    title: '新しいパスワード',
    sub: '決めると、今までのログインは全部切れます',
    go: '決定', swap: '',
    // メールのリンクから来た人なので、誰かはもう分かっている
    email: false, name: false, pass: true, newPass: true,
  },
};

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
      row: $('acctRow'), who: $('acctWho'),
      open: $('acctOpen'), new: $('acctNew'), out: $('acctOut'),
      title: $('acTitle'), sub: $('acSub'), status: $('acStatus'),
      email: $('acEmail'), emailField: $('acEmailField'),
      name: $('acName'), nameField: $('acNameField'),
      pass: $('acPass'), passField: $('acPassField'),
      close: $('acClose'), swap: $('acSwap'), go: $('acGo'),
      forgot: $('acForgot'), forgotRow: $('acForgotRow'),
    };

    /** 今ログインしている人。していなければnull */
    this.user = null;
    /** この置き場に会員証の仕組みがあるか。無ければ行ごと出さない */
    this.available = false;
    /** ログイン状態が変わった時に呼ぶ。名前欄の差し替えは呼ぶ側の仕事 */
    this.onChange = () => {};

    /* 今どの面か。**4つある。**
         login    … 入る
         register … 作る
         forgot   … パスワードを忘れた（メールアドレスだけ打つ）
         reset    … 新しいパスワードを決める（メールのリンクから来た人だけ）
       1枚のDOMを使い回すのは、行き来するたびに入力が消えるのを避けるため */
    this.mode = 'login';
    /* 再設定の合言葉。**URLから受け取って、ここで預かる。**
       画面に出さないのは、貼り付けて共有される事故を減らすため */
    this._resetToken = '';
    this._busy = false;

    // addEventListenerではなく代入。DOMは1組しかないので、
    // 2回作られた時に古い方まで動くのを防ぐ（netmenu.jsと同じ作法）
    // ホームから直接どちらの面でも開ける。開いてから切り替えさせない
    this.el.open.onclick = () => this.show('login');
    this.el.new.onclick = () => this.show('register');
    this.el.out.onclick = () => this._logout();
    this.el.close.onclick = () => this.hide();
    // 「忘れた」からは必ずログインの面へ戻す（登録の面へ行っても意味が無い）
    this.el.swap.onclick = () => this._setMode(this.mode === 'register' ? 'login' : 'register');
    this.el.forgot.onclick = () => this._setMode('forgot');
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
    this._resetNote();
    this.onChange(this.user);
  }

  /* 再設定のリンクを踏んで来た時。**URLから合言葉を取って、すぐ消す。**
     残したままにすると、履歴・共有・スクショから拾える所に
     パスワードを変えられる文字列が居座ることになる。
     台帳を持たない置き場では画面ごと無いので、何も出さない */
  _resetNote() {
    const q = new URLSearchParams(location.search);
    const t = q.get('reset');
    if (!t) return;
    q.delete('reset');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    if (!this.available) return;
    this._resetToken = t;
    this.show('reset');
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
    if (v === '1') this.show('login');
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
    const inside = !!this.user;
    if (inside) {
      // 残高は0でも出す。**出さないと「まだ1枚も無い」が分からない**
      const coins = Number(this.user.coins ?? 0).toLocaleString();
      who.innerHTML = `<b>${escapeHtml(this.user.name)}</b> でログイン中`
        + `<br>コイン <b>${coins}</b>枚`
        + (this.user.verified ? '' : '　メールの確認がまだです');
    } else {
      who.textContent = 'ログインしていません';
    }
    // 入っている時は出る口だけ、入っていない時は入る口だけを出す
    open.classList.toggle('hidden', inside);
    this.el.new.classList.toggle('hidden', inside);
    out.classList.toggle('hidden', !inside);
  }

  /**
   * 残高を差し替える。試合の終わりにサーバーが配った値をそのまま入れる。
   * **数え直さない。** こちらでも足すと、届いた値とずれた時に
   * どちらが本当か分からなくなる（台帳が持っている値だけが本当）
   */
  setCoins(coins) {
    if (!this.user || typeof coins !== 'number') return;
    this.user.coins = coins;
    this._paint();
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  show(mode = 'login') {
    if (!this.available) return;
    this._setMode(mode);
    this._say('');
    this.el.root.classList.remove('hidden');
    // 新しいパスワードを決める面では、打ってもらう所はパスワードだけ
    (mode === 'reset' ? this.el.pass : this.el.email).focus();
  }

  hide() { this.el.root.classList.add('hidden'); }

  /* 面を切り替える。**入力は消さない。**
     打ち間違えて往復するたびに消えるのが一番いらつく。

     **1枚のDOMを4通りに着替えさせている。**見出し・説明・ボタンの文言と、
     出す入力欄の組み合わせだけが違う。表にしてあるのは、
     if を4つ並べると必ずどこかの面だけ文言が古くなるため */
  _setMode(mode) {
    this.mode = MODES[mode] ? mode : 'login';
    const m = MODES[this.mode];
    const {
      title, sub, swap, go, name, pass,
      emailField, nameField, passField, forgotRow,
    } = this.el;
    title.textContent = m.title;
    sub.textContent = m.sub;
    go.textContent = m.go;
    /* **どこへ行くのかを文で書く。**「ログイン」「新規登録」の単語だけだと、
       今どちらの面にいて押すとどうなるのかが読めない */
    swap.textContent = m.swap;
    swap.parentElement.classList.toggle('hidden', !m.swap);
    emailField.classList.toggle('hidden', !m.email);
    nameField.classList.toggle('hidden', !m.name);
    passField.classList.toggle('hidden', !m.pass);
    // 「忘れた」への入口はログインの面だけ。登録の面に出すと、
    // まだアカウントが無い人が押すことになる
    forgotRow.classList.toggle('hidden', this.mode !== 'login');
    // 名前の初期値は、ホームで打っていた物を引き継ぐ。もう一度打たせない
    if (this.mode === 'register' && !name.value) name.value = $('nmName')?.value || '';
    // ブラウザのパスワード補完へ、今どの面かを伝える
    pass.autocomplete = m.newPass ? 'new-password' : 'current-password';
    this._say('');
  }

  _say(text, bad = false) {
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('bad', !!bad);
  }

  _lock(on) {
    this._busy = on;
    for (const b of [this.el.go, this.el.swap, this.el.close]) b.disabled = on;
    // 送っている最中に面を切り替えられると、返事が来た時にどちらの結果か分からなくなる
  }

  async _submit() {
    if (this._busy) return;
    const m = MODES[this.mode];
    const email = this.el.email.value.trim();
    const password = this.el.pass.value;
    const name = this.el.name.value.trim();

    // 打ち終わる前に押された時。サーバーまで行かせずここで返す
    if (m.email && !email) { this._say('メールアドレスを入れてください', true); return; }
    if (m.pass && !password) { this._say('パスワードを入れてください', true); return; }
    if (this.mode === 'register' && !name) { this._say('名前を入れてください', true); return; }

    this._lock(true);
    this._say({
      login: '確かめています…', register: '登録しています…',
      forgot: '送っています…', reset: '変えています…',
    }[this.mode]);
    let r;
    try {
      r = await this._send({ email, password, name });
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

    /* 「忘れた」だけは画面を閉じない。**送った後に見る物が無いと、
       押せたのかどうかが分からない。**居ない人でもここへ来る
       （サーバーが言い分けないので）ので、文言も「あれば送った」にする */
    if (this.mode === 'forgot') {
      this.el.pass.value = '';
      this._say('登録があれば、メールを送りました。受信箱を見てください');
      return;
    }

    this.user = r.user;
    this._resetToken = '';
    // パスワードは画面に残さない。次に開いた時に入ったままなのは気持ちが悪い
    this.el.pass.value = '';
    this._paint();
    this.onChange(this.user);
    this.hide();
  }

  /* どの口へ投げるか。面ごとに1行ずつ。
     ここを_submitの中でifで分けていた頃は、面が2つしか無かった */
  _send({ email, password, name }) {
    if (this.mode === 'register') {
      return api('/api/register', { method: 'POST', body: { email, password, name } });
    }
    if (this.mode === 'forgot') {
      return api('/api/forgot', { method: 'POST', body: { email } });
    }
    if (this.mode === 'reset') {
      return api('/api/reset', { method: 'POST', body: { token: this._resetToken, password } });
    }
    return api('/api/login', { method: 'POST', body: { email, password } });
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
