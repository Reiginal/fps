// HUDはDOMで描く。Canvasに描くより文字が締まって見えるし、CSSで調整が効く。
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 名前は他人の端末から届く文字列。そのまま流すとタグとして解釈されるので、
// HTMLを組み立てる所は必ずここを通す
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'),
      cUp: $('cUp'), cDown: $('cDown'), cLeft: $('cLeft'), cRight: $('cRight'),
      cross: $('cross'), dot: $('dot'),
      marker: $('marker'),
      dirs: $('dirs'),
      health: $('health'), healthFill: $('healthFill'), healthBlock: $('healthBlock'),
      staminaBar: $('staminaBar'), staminaFill: $('staminaFill'),
      ammo: $('ammo'), reserve: $('reserve'), ammoWrap: $('ammoWrap'),
      weapon: $('weapon'), reloading: $('reloading'),
      // 武器の札は数が変わる（ソロは波が進むと1本増え、ガンゲームは1本しか持たない）。
      // 入れ物だけ掴んでおいて、中身は weaponSlots() が組む。
      // querySelectorAll('.slot')で最初の4枚を控えていた頃は、
      // 増えた札に印が付かず、減らした札に印が残っていた
      slotBox: $('slots'),
      wave: $('wave'), remain: $('remain'), score: $('score'),
      killfeed: $('killfeed'),
      banner: $('banner'), bannerMain: $('bannerMain'), bannerSub: $('bannerSub'),
      overlay: $('overlay'), panel: $('panel'),
      speedlines: $('speedlines'),
      // 対戦で使う分。1人用では触らないので、無くても既存の表示は動く
      matchBox: $('matchBox'), matchScore: $('matchScore'), matchTime: $('matchTime'),
      plates: $('plates'), netstat: $('netstat'),
      scoreboard: $('scoreboard'), sbRows: $('sbRows'), matchStage: $('matchStage'),
      finalboard: $('finalboard'), fbRows: $('fbRows'), fbNote: $('fbNote'),
      minimap: $('minimap'), zonewarn: $('zonewarn'), zoneSub: $('zoneSub'),
      rosterRows: $('rosterRows'),
      healWrap: $('healWrap'), healBar: $('healBar'), healFill: $('healFill'),
      healPips: $('healPips'), healState: $('healState'), slotHeal: $('slotHeal'),
      slotQuick: $('slotQuick'),
      slotRange: $('slotRange'),
      elim: $('elim'), elimName: $('elimName'), elimTag: $('elimTag'),
      achfeed: $('achfeed'),
      voice: $('voice'), voiceText: $('voiceText'),
      spectate: $('spectate'), specName: $('specName'), specHint: $('specHint'),
      specHp: $('specHp'),
      tutorial: $('tutorial'), tutMain: $('tutMain'), tutSub: $('tutSub'),
    };
    this.markerTimer = 0;
    this.crossHitTimer = 0;
    this.bannerTimer = 0;
    this.dirIndicators = [];
    this._lastGap = -1;
    // 観戦の札に今出ている中身。同じ値で毎フレーム書き込まないための控え
    this._specKey = '';
    // チュートリアルの課題札も同じ（毎フレーム呼ばれる前提の作り）
    this._tutKey = '';
    this._lastHealth = -1;
    this._lastStamina = '';
    this._lastAmmo = -1;
    // 武器の札。今出ている並びと、印が付いている位置
    this._slotKey = '';
    this._slotOn = -1;
    this._lastQuick = '';
    this.mode = 'solo';
    // 名札は毎フレーム作り直すと1秒に60回DOMを捨てることになるので、idで使い回す
    this.plateEls = new Map();
    this._lastMatch = '';
    this._lastRoster = '';
    this._lastHeal = '';
    this._elimAt = -1e9;
    this._elimStreak = 0;

    /* ------------------------------------------------------ ミニマップ */
    // 地形は動かないので、起動時に真上から1枚焼いた物を使い回す。
    // 毎フレームやるのは「その1枚を貼って、上に点と矢印を描く」だけ
    this.mapImage = null;
    this.mapExtent = 0;      // 焼いた1枚が覆うワールドの半径(m)
    this._mapCtx = null;
    this._lastZoneWarn = null;
  }

  /**
   * ミニマップの下敷きを受け取る。imageは真上から焼いたcanvas、
   * extentはその1枚が覆うワールドの半径(m)。中心はワールド原点
   */
  setMinimap(image, extent) {
    const el = this.el.minimap;
    if (!el) return;
    this.mapImage = image;
    this.mapExtent = extent;
    // 寸法を測る前に出す。display:noneのままではclientWidthが0で返る
    el.classList.remove('hidden');
    // CSS寸法と実画素を合わせる。合わせないと高DPI画面で点も線もぼやける
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const css = el.clientWidth || 168;
    el.width = Math.round(css * dpr);
    el.height = Math.round(css * dpr);
    this._mapCtx = el.getContext('2d');
  }

  /**
   * 毎フレーム描く。
   *   me    … { x, z, yaw } 自分の位置と向き
   *   blips … [{ x, z, t }] 出したい点。tは0〜1で、小さいほど薄く消える
   *   zone  … 戦闘範囲の半径(m)。0なら描かない（ソロ）
   *   view  … 中心から何mぶんを枠に収めるか。対戦は戦闘範囲だけを拡大して見せる。
   *           場内全域(44m)のまま出すと、戦う所が枠の真ん中の小さな丸に潰れる
   */
  minimap(me, blips, zone = 0, view = 0) {
    const ctx = this._mapCtx;
    if (!ctx || !this.mapImage) return;
    const el = this.el.minimap;
    const w = el.width, h = el.height;
    const R = view > 0 ? view : this.mapExtent;
    // 1mあたりの画素数
    const scale = w / (R * 2);
    // ワールド(x,z) → キャンバス。画面の右が+X、下が+Z（焼く時にそう向けてある）
    const px = (x) => (x + R) * scale;
    const py = (z) => (z + R) * scale;

    ctx.clearRect(0, 0, w, h);
    // 焼いた1枚から、今見せたい範囲にあたる部分だけを切り出して枠いっぱいに貼る
    const img = this.mapImage;
    const src = (img.width * R) / this.mapExtent;
    const sx = (img.width - src) / 2;
    ctx.drawImage(img, sx, sx, src, src, 0, 0, w, h);

    // 戦闘範囲の円。外側を暗く落として「ここから先は外」を面で見せる
    if (zone > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.arc(px(0), py(0), zone * scale, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(8, 10, 14, 0.62)';
      ctx.fill('evenodd');
      ctx.restore();
      ctx.beginPath();
      ctx.arc(px(0), py(0), zone * scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 70, 50, 0.85)';
      ctx.lineWidth = Math.max(1, w / 130);
      ctx.stroke();
    }

    /* 撃った人の点。時間で薄くなる。
       味方(mate)は撃っていなくても出て、薄れず、色が違う。
       2対2で「味方が今どこにいるか」を知る手段がここしか無い
       （名札は見えている時だけなので、別の部屋にいる味方は分からない） */
    if (blips) {
      for (const b of blips) {
        if (b.t <= 0) continue;
        ctx.beginPath();
        ctx.arc(px(b.x), py(b.z), Math.max(2, w / (b.mate ? 42 : 46)), 0, Math.PI * 2);
        ctx.fillStyle = b.mate
          ? 'rgba(80, 230, 160, 0.95)'
          : `rgba(255, 96, 64, ${b.t.toFixed(3)})`;
        ctx.fill();
        // 味方だけ縁を付ける。色だけだと、地図の明るい所で見失う
        if (b.mate) {
          ctx.strokeStyle = 'rgba(5, 7, 10, 0.85)';
          ctx.lineWidth = Math.max(1, w / 150);
          ctx.stroke();
        }
      }
    }

    // 自分。ヨー0で前方が-Z＝画面の上なので、キャンバスを-yawだけ回すと
    // 上向きに描いた三角がそのまま向いている方向を指す
    ctx.save();
    ctx.translate(px(me.x), py(me.z));
    ctx.rotate(-me.yaw);
    const r = Math.max(3, w / 30);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.62, r * 0.72);
    ctx.lineTo(0, r * 0.34);
    ctx.lineTo(-r * 0.62, r * 0.72);
    ctx.closePath();
    ctx.fillStyle = '#63d2ff';
    ctx.strokeStyle = 'rgba(5, 7, 10, 0.9)';
    ctx.lineWidth = Math.max(1, w / 150);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** 戦闘範囲の外に出た警告。onがfalseで消える */
  zoneWarn(on, sub = '') {
    const el = this.el.zonewarn;
    if (!el) return;
    // 毎フレームclassListとtextContentを触るとレイアウトが走るので、
    // 変わった時だけ書く
    const key = on ? sub : null;
    if (key === this._lastZoneWarn) return;
    this._lastZoneWarn = key;
    el.classList.toggle('hidden', !on);
    if (on) this.el.zoneSub.textContent = sub;
  }

  show(on) { this.el.hud.classList.toggle('on', on); }

  /** gapは中心からの画素数。スプレッドの実値をそのまま反映させる */
  crosshair(gap, ads) {
    const g = Math.round(gap);
    if (g !== this._lastGap) {
      this._lastGap = g;
      const len = ads ? 5 : 9;
      this.el.cUp.style.cssText = `width:2px;height:${len}px;left:-1px;top:${-g - len}px`;
      this.el.cDown.style.cssText = `width:2px;height:${len}px;left:-1px;top:${g}px`;
      this.el.cLeft.style.cssText = `height:2px;width:${len}px;top:-1px;left:${-g - len}px`;
      this.el.cRight.style.cssText = `height:2px;width:${len}px;top:-1px;left:${g}px`;
    }
    // 覗いている間は線を消してドットだけ残す
    const vis = ads ? 0 : 1;
    if (this._lastVis !== vis) {
      this._lastVis = vis;
      for (const k of ['cUp', 'cDown', 'cLeft', 'cRight']) this.el[k].style.opacity = vis;
    }
  }

  hitmarker(headshot) {
    this.markerTimer = 0.22;
    this.el.marker.classList.toggle('head', !!headshot);
    this.el.marker.style.opacity = 1;
    this.el.marker.style.transform = 'scale(1)';
    this.crossHitTimer = 0.12;
    this.el.cross.classList.add('hit');
  }

  health(v, max) {
    const r = Math.max(0, v) / max;
    if (v !== this._lastHealth) {
      this._lastHealth = v;
      this.el.health.textContent = Math.max(0, Math.ceil(v));
      this.el.healthFill.style.width = `${r * 100}%`;
      this.el.healthBlock.classList.toggle('low', r < 0.34);
    }
  }

  /**
   * 走れる息。**満タンの時は棒ごと消す。**
   * 常に出ていると「減っていないこと」を毎秒確かめさせることになるし、
   * 走りに息が要ると気づくのは減った時なので、その時だけ出れば足りる。
   *
   *   v      … 残り（0〜1）
   *   spent  … 切れて走り直せない状態か（色を変えて知らせる）
   *
   * 毎フレーム呼ばれるので、変わった時だけDOMを触る
   */
  stamina(v, spent) {
    const bar = this.el.staminaBar;
    if (!bar) return;
    // 幅は0.5%刻みまで。1画素も動かない差で書き込みを起こさない
    const pct = Math.round(Math.max(0, Math.min(1, v)) * 200) / 2;
    const on = pct < 100;
    const key = `${pct}/${on ? 1 : 0}/${spent ? 1 : 0}`;
    if (key === this._lastStamina) return;
    this._lastStamina = key;
    this.el.staminaFill.style.width = `${pct}%`;
    bar.classList.toggle('on', on);
    bar.classList.toggle('spent', !!spent);
  }

  ammo(cur, reserve, name, slotIndex, reloadT, melee = false, thrownLeft = null) {
    // 近接武器は弾を持たない。数字を出すと「9999発の銃」に見える。
    // 欄ごと消さずに横線を置くのは、消すと下段の並びが動いて目が泳ぐため。
    // 投げ物で残りが分かる時（ソロの手榴弾）はその数を出す
    const shown = thrownLeft != null ? thrownLeft : (melee ? '—' : cur);
    if (shown !== this._lastAmmo) {
      this._lastAmmo = shown;
      this.el.ammo.textContent = shown;
      this.el.ammoWrap.classList.toggle('empty', thrownLeft === 0 || (!melee && cur === 0));
    }
    // 予備弾も毎フレーム書いていた。文字を作って書き込むぶんの仕事が毎回乗る
    const rest = melee || thrownLeft != null ? '' : `/ ${reserve}`;
    if (rest !== this._lastReserve) {
      this._lastReserve = rest;
      this.el.reserve.textContent = rest;
    }
    if (slotIndex !== this._slotOn) {
      this._slotOn = slotIndex;
      this._markSlot();
    }
    if (this.el.weapon.textContent !== name) this.el.weapon.textContent = name;
    // 装填中かどうかも、変わった時だけ触る
    const loading = reloadT > 0;
    if (loading !== this._lastLoading) {
      this._lastLoading = loading;
      if (loading) this.el.reloading.textContent = 'リロード中';
      this.el.reloading.style.opacity = loading ? 1 : 0;
    }
  }

  /**
   * 数字キーに載らない武器の札（Qで出す狙撃銃）。**2行目、包帯と同じ行に置く。**
   * 1〜4の続きに並べると「5」に見えるのに5では出ない、という嘘になるので、
   * 番号の行とは分けてある。
   *
   *   name … 呼び名。nullで畳む（支給される前・対戦）
   *   on   … 今それを持っているか
   */
  quickSlot(name, on) {
    const el = this.el.slotQuick;
    if (!el) return;
    const key = `${name || ''}/${on ? 1 : 0}`;
    if (key === this._lastQuick) return;
    this._lastQuick = key;
    if (name) el.textContent = `Q ${name}`;
    el.classList.toggle('hide', !name);
    el.classList.toggle('on', !!on);
  }

  /**
   * 射撃訓練場だけのショットガン(E)の札。**Qと同じ作り。**
   *
   * 2026-08-11に「射撃訓練場に行った時のショットガンのEっていうのは、
   * 画面の右下のあそこに出てないじゃん。出してよ」と言われて足した。
   * 出せるようにしただけで札を出していなかったので、**知る方法が無かった**
   * （訓練場の上の一行にだけ書いてあった）。
   *
   * nameがnullなら畳む。訓練場の外では持てないので、そこでは常に畳まれる。
   *
   * **同じ値で呼ばれた時は何もしない**（毎フレーム呼ばれる。quickSlotと同じ）
   */
  rangeSlot(name, on) {
    const el = this.el.slotRange;
    if (!el) return;
    const key = `${name || ''}/${on ? 1 : 0}`;
    if (key === this._lastRange) return;
    this._lastRange = key;
    if (name) el.textContent = `E ${name}`;
    el.classList.toggle('hide', !name);
    el.classList.toggle('on', !!on);
  }

  /** 今持っている札に印を付ける。札を組み直した時と、持ち替えた時だけ呼ぶ */
  _markSlot() {
    const box = this.el.slotBox;
    if (!box) return;
    for (let i = 0; i < box.children.length; i++) {
      box.children[i].classList.toggle('on', i === this._slotOn);
    }
  }

  /**
   * 武器の札を組み直す。**持ち物が変わった時だけ**触る（毎フレーム呼ばれる）。
   *
   * 札の数が動くのは2つの場面:
   *   ・ガンゲームで今の段の1本だけになる（1枚）
   *   ・手榴弾を使い切った（枚数はそのままで、その1枚が薄くなる）
   *
   * 数字キーに載らない武器（Qの狙撃銃）はここには入らない。あちらは quickSlot が持つ
   *
   * 最後のを「札を消す」にしないのは、消すと後ろの番号が繰り上がって、
   * 押し慣れた数字と出てくる武器が変わってしまうため。
   *
   * items … [{ name:'ライフル', out:false }, ...] 並びがそのまま1,2,3…になる
   */
  weaponSlots(items) {
    const box = this.el.slotBox;
    if (!box) return;
    const key = items.map((it) => `${it.name}${it.out ? '/x' : ''}`).join('|');
    if (key === this._slotKey) return;
    this._slotKey = key;
    // lastChildではなくchildrenで消す。本物のDOMではタグの間の改行が
    // テキストの子として入っていて、lastChildだとそれを消しにいく
    while (box.children.length > items.length) {
      box.children[box.children.length - 1].remove();
    }
    while (box.children.length < items.length) {
      const el = document.createElement('div');
      el.className = 'slot';
      box.appendChild(el);
    }
    for (let i = 0; i < items.length; i++) {
      const el = box.children[i];
      const text = `${i + 1} ${items[i].name}`;
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('out', !!items[i].out);
    }
    this._markSlot();
  }

  /**
   * 包帯の残数と、巻いている進捗。表示は体力の隣に集めてある。
   *   left    … 残りの数
   *   healing … 巻き終わるまでの残り秒（0なら巻いていない）
   *   total   … 巻くのにかかる秒数
   *   out     … 手に持っているか。持っただけではまだ回復しないので、
   *             ここで「次にクリックする」ことまで書かないと手が止まる
   *   max     … 1ラウンドに持てる数。玉をいくつ並べるかに使う
   */
  bandage(left, healing, total, out = false, max = 2) {
    const wrap = this.el.healWrap;
    if (!wrap) return;
    // 玉の数は持てる数に合わせて作る。index.html側に固定で書いておくと、
    // 持てる数を変えた時に画面だけ古い数のまま取り残される
    const pips = this.el.healPips;
    while (pips.children.length < max) pips.appendChild(document.createElement('i'));
    while (pips.children.length > max) pips.lastChild.remove();
    const on = healing > 0;
    // 毎フレーム呼ばれるので、見た目が変わる時だけDOMを触る。
    // 進み具合だけは細かく動かしたいので、20段階に丸めて鍵に混ぜる
    const key = `${left}/${out ? 1 : 0}/${on ? Math.round((1 - healing / total) * 40) : -1}`;
    if (key === this._lastHeal) return;
    this._lastHeal = key;

    wrap.classList.toggle('none', left <= 0 && !on);
    wrap.classList.toggle('out', out && !on);
    wrap.classList.toggle('busy', on);
    this.el.healState.textContent = on ? '巻いている' : (out ? '左クリックで巻く' : 'F 包帯');
    // 残数は玉で出す。持っている本数がそのまま形として見える
    for (let i = 0; i < pips.children.length; i++) {
      pips.children[i].classList.toggle('on', i < left);
    }
    if (on) this.el.healFill.style.width = `${((1 - healing / total) * 100).toFixed(0)}%`;

    // 右下の札は「Fで出せる」を覚えてもらうためだけの物なので文言は動かさない。
    // 使えるかどうかの色だけ変える
    const slot = this.el.slotHeal;
    if (slot) {
      slot.classList.toggle('ready', left > 0 && !on && !out);
      slot.classList.toggle('busy', on || out);
    }
  }

  wave(n, remaining) {
    // 毎フレーム呼ばれる。数字が動くのは湧きと撃破の瞬間だけなので、その時だけ書く
    const key = n * 1000 + remaining;
    if (key === this._lastWave) return;
    this._lastWave = key;
    this.el.wave.textContent = `第${n}波`;
    this.el.remain.textContent = `残敵 ${remaining}名`;
  }

  score(v) { this.el.score.textContent = v.toLocaleString('en-US'); }

  /**
   * ガンゲームで今どの武器か。st は0から数えた段、of は全部の段数。
   *
   * of が2より小さい遊び方（デスマッチ）では畳む。
   * 「1/1」と出しても意味が無く、場所を取るだけになる
   */
  stage(st, of) {
    const el = this.el.matchStage;
    if (!el) return;
    const show = of >= 2;
    el.classList.toggle('hidden', !show);
    if (!show) { el.textContent = ''; return; }
    const now = Math.min(st + 1, of);
    const left = of - now;
    el.textContent = left > 0
      ? `武器 ${now} / ${of}　あと${left}本`
      : `最後の武器　倒したら勝ち`;
  }

  kill(text, headshot) {
    const d = document.createElement('div');
    d.className = 'kill' + (headshot ? ' head' : '');
    d.textContent = text;
    this._pushFeed(d);
  }

  // 出しっぱなしにすると画面の右が埋まるので、時間で消して本数も抑える
  _pushFeed(el) {
    this.el.killfeed.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = 0;
      setTimeout(() => el.remove(), 320);
    }, 3400);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
  }

  /**
   * 声の状態。**自分が今送っているかどうかを出す。**
   *
   * ここが見えないのが一番痛い。押しているつもりで押せていない／
   * 離したつもりで押しっぱなし、がどちらも起きて、どちらも本人には分からない。
   *
   * @param state 'off'=何も出さない / 'talk'=送信中 / 'nomic'=マイクが使えない
   */
  voice(state, text = '') {
    const el = this.el.voice;
    if (!el) return;
    el.classList.toggle('hidden', state === 'off');
    el.classList.toggle('off', state === 'nomic');
    if (this.el.voiceText && text) this.el.voiceText.textContent = text;
  }

  /**
   * 実績の解除を知らせる札。左下に出して数秒で消える。
   *
   * キルログと別の場所へ出すのは、**撃った直後に解除されることが多い**から。
   * 同じ列に混ぜると、倒した知らせに紛れて読まれないまま流れていく。
   *
   * 撃ち合いの最中に出るので、画面の真ん中には絶対に置かない。
   * 「良いことが起きた」を伝えるために視界を塞ぐのは本末転倒になる
   */
  achievement(name, desc = '') {
    if (!this.el.achfeed) return;
    const card = document.createElement('div');
    card.className = 'achcard';
    const head = document.createElement('div');
    head.className = 'achhead';
    head.textContent = '実績 解除';
    const title = document.createElement('div');
    title.className = 'achname';
    title.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'achdesc';
    sub.textContent = desc;
    card.append(head, title, sub);
    this.el.achfeed.appendChild(card);
    // 一度に何個も解除されることがある（初撃破と3連続撃破が同時など）ので、
    // 上限を置いて古い物から消す。積み上がると画面の下半分が埋まる
    while (this.el.achfeed.children.length > 3) this.el.achfeed.firstChild.remove();
    setTimeout(() => {
      card.style.transition = 'opacity .4s';
      card.style.opacity = 0;
      setTimeout(() => card.remove(), 420);
    }, 4200);
  }

  /**
   * 倒した瞬間のバナー。画面中央のやや下に一瞬だけ出す。
   *
   * このメソッドは main.js から2箇所（1人用の撃破と対戦のキル）で
   * 呼ばれていたのに、実体がずっと無かった。呼んだ瞬間に例外になるので、
   * バナーが出ないだけでなく、同じ関数の後ろにある得点加算とキルログまで
   * 巻き添えで飛んでいた。呼び先が在るかどうかは tools/check-calls.mjs で
   * 見るようにした。
   *
   * @param name 倒した相手の名前。1人用は敵に名前が無いので空でよい
   * @param headshot 頭に当てて倒したか。色を青へ振って格を上げる
   */
  /**
   * 観戦中の札（対戦で倒れている間、誰の目線で見ているか）。
   * nameにnullを渡すと畳む。
   *
   * **同じ値で呼ばれても2度目からDOMを触らない。** 倒れている間ずっと
   * 毎フレーム呼ばれるので、そのたびに文字を書き込むと
   * 見えない所でレイアウトを計算し直すことになる（tools/check-hud.mjsの[軽さ]）
   *
   * @param name 見ている人の名前。nullで畳む
   * @param canSwitch 他にも生きている人がいるか。1人しかいない時は切り替えの案内を消す
   */
  /** チュートリアル中の見た目（波・得点・地図を隠す。中身はCSSの#hud.tutorial） */
  setTutorial(on) { this.el.hud.classList.toggle('tutorial', !!on); }

  /**
   * チュートリアルの課題札。mainにnullで畳む。
   * 毎フレーム呼ばれる前提なので、同じ文なら2度目からDOMを触らない
   * （tools/check-hud.mjsの[軽さ]の流儀。文言側も残り秒を整数で丸めていて、
   * 値が変わるのは秒に1回程度＝この控えとちょうど噛み合う）
   */
  tutorial(main, sub = '') {
    const el = this.el.tutorial;
    if (!el) return;
    const key = main === null || main === undefined ? '' : `${main}|${sub}`;
    if (key === this._tutKey) return;
    this._tutKey = key;
    if (!key) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    this.el.tutMain.textContent = main;
    this.el.tutSub.textContent = sub;
  }

  /**
   * 課題をクリアした瞬間の一発合図。札に✓と緑を出して、少し置いて自分で消す。
   * 文言の書き換え(tutorial)と別口なのは、こちらがクリアの瞬間にしか呼ばれない
   * 一発物だから（毎フレーム物の「同じ値なら触らない」ガードとは性質が違う）。
   * holdSはmain.js側の文言を止める秒数と同じ値が渡ってくる（ずれると
   * 緑が消えた後も前の課題の文が残る、の中途半端な見た目になる）
   */
  tutorialDone(holdS = 0.85) {
    const el = this.el.tutorial;
    if (!el) return;
    el.classList.add('done');
    clearTimeout(this._tutDoneTimer);
    this._tutDoneTimer = setTimeout(() => el.classList.remove('done'), holdS * 1000);
  }

  /**
   * 観戦の札。nameがnullで消える。
   *
   * hpは見ている人の体力（maxで割った割合ではなく実数）。
   * **これが無いと、観戦中は画面のどこにも体力が出ない。**
   * 自分の体力の棒は0のまま消えているので、見ている相手が
   * あと1発なのか満タンなのかが分からず、見ていて何も起きていないように見える。
   *
   * 毎フレーム呼ばれる前提なので、値が変わった時しかDOMを触らない
   */
  spectating(name, canSwitch = false, hp = null, maxHp = 0) {
    const el = this.el.spectate;
    if (!el) return;
    const shown = hp == null ? '' : String(Math.max(0, Math.ceil(hp)));
    const key = name === null || name === undefined
      ? '' : `${name}|${canSwitch ? 1 : 0}|${shown}`;
    if (key === this._specKey) return;
    this._specKey = key;
    if (!key) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    this.el.specName.textContent = name;
    this.el.specHint.classList.toggle('hidden', !canSwitch);
    const hpEl = this.el.specHp;
    if (hpEl) {
      hpEl.textContent = shown;
      // 割合で見る。対戦の体力は260、1人用は130なので実数では線が引けない
      const r = maxHp > 0 && hp != null ? hp / maxHp : 1;
      hpEl.classList.toggle('low', r < 0.34);
    }
  }

  elim(name, headshot = false) {
    const el = this.el.elim;
    if (!el) return;

    // 5秒以内に続けて倒したら連続数を出す。1回目は出さない。
    // 溜めずに即出しなのは、次の敵と撃ち合っている最中に「2連続」が
    // 見えることに意味があるから（終わってから集計しても手応えにならない）
    const now = performance.now();
    this._elimStreak = now - this._elimAt < 5000 ? this._elimStreak + 1 : 1;
    this._elimAt = now;

    this.el.elimName.textContent = name || '';
    this.el.elimTag.textContent = this._elimStreak >= 2
      ? `${this._elimStreak}連続`
      : (headshot ? '頭部' : '');
    el.classList.toggle('head', !!headshot);

    // 連続で倒すと2回目以降のアニメーションが走らない。
    // 同じ要素に同じclassを付け直すだけでは再生されないので、
    // 一度外して読み出しを挟み（ここでブラウザに状態を確定させる）、付け直す
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  banner(main, sub, duration = 2.4) {
    this.el.bannerMain.textContent = main;
    this.el.bannerSub.textContent = sub;
    this.bannerTimer = duration;
    this.el.banner.style.transition = 'opacity .2s';
    this.el.banner.style.opacity = 1;
  }

  /** 撃たれた方向を画面中心のリングで示す。angleは自分の向き基準のラジアン */
  damageFrom(angle) {
    const d = document.createElement('div');
    d.className = 'dmgdir';
    d.style.transform = `rotate(${angle}rad)`;
    this.el.dirs.appendChild(d);
    this.dirIndicators.push({ el: d, life: 1.1 });
  }

  sprinting(on) {
    // 毎フレーム呼ばれる。同じ値でも書けば書いた分の仕事が乗るので、変わった時だけ
    if (this._lastSprint === on) return;
    this._lastSprint = on;
    this.el.speedlines.style.opacity = on ? 0.85 : 0;
  }

  update(dt) {
    if (this.markerTimer > 0) {
      this.markerTimer -= dt;
      const t = Math.max(0, this.markerTimer / 0.22);
      this.el.marker.style.opacity = t;
      this.el.marker.style.transform = `scale(${1 + (1 - t) * 0.45})`;
    }
    if (this.crossHitTimer > 0) {
      this.crossHitTimer -= dt;
      if (this.crossHitTimer <= 0) this.el.cross.classList.remove('hit');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.style.opacity = 0;
    }
    for (let i = this.dirIndicators.length - 1; i >= 0; i--) {
      const d = this.dirIndicators[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.el.remove();
        this.dirIndicators.splice(i, 1);
      } else {
        d.el.style.opacity = Math.min(1, d.life / 0.5);
      }
    }
  }

  /* ------------------------------------------------------------ 対戦 */

  /** 対戦では波の数に意味がないので、上部左を得点に差し替える */
  setMode(mode) {
    this.mode = mode === 'versus' ? 'versus' : 'solo';
    this.el.hud.classList.toggle('versus', this.mode === 'versus');
    // 1人用へ戻った時に名札や戦績が残っていると、敵が出てくる画面に
    // 誰もいない相手の名前が浮いたままになる
    if (this.mode === 'solo') {
      this.scoreboard(null, false);
      this.nameplates(null);
      this.netStatus('');
      this.matchEnd(null, false);
    }
  }

  /** Tabを押している間だけ出す想定。キーの取得は呼ぶ側 */
  scoreboard(rows, show) {
    /* Tabを押している間、中身を毎フレーム作り直していた。
       人数ぶんのHTMLを組み立てて丸ごと入れ替える処理なので、
       押しっぱなしにしている間ずっとその仕事が乗る。変わった時だけにする */
    if (show) {
      const key = (rows || []).map((r) => `${r.id}:${r.rounds | 0}:${r.kills | 0}:${r.deaths | 0}:${Math.round(r.ping || 0)}`).join('|');
      if (key !== this._lastBoard) {
        this._lastBoard = key;
        this.el.sbRows.innerHTML = this._rankRows(rows, false);
      }
    }
    if (this._lastBoardShow !== show) {
      this._lastBoardShow = show;
      this.el.scoreboard.classList.toggle('hidden', !show);
    }
  }

  /** 試合終了の最終順位。showをfalseで畳む */
  matchEnd(rows, show, note = '') {
    if (show) {
      this.el.fbRows.innerHTML = this._rankRows(rows, true);
      this.el.fbNote.textContent = note;
    }
    this.el.finalboard.classList.toggle('hidden', !show);
  }

  // 取ったラウンドの多い順。勝敗を決めているのはラウンド数なので、
  // ここを撃破数で並べると戦績表の1位と実際の勝者が食い違う回が出る。
  // 同数なら撃破の多いほうを上に出す。
  // 渡された配列は呼ぶ側の物なので、並べ替える前に写しを取る
  _rankRows(rows, markTop) {
    const list = (rows || []).slice()
      .sort((a, b) => ((b.rounds | 0) - (a.rounds | 0)) || ((b.kills | 0) - (a.kills | 0)));
    return list.map((r, i) => {
      const cls = 'sbrow' + (r.me ? ' me' : '') + (markTop && i === 0 ? ' win' : '');
      const ping = Number.isFinite(r.ping) ? `${Math.round(r.ping)}ms` : '—';
      return `<div class="${cls}"><div class="c1">${i + 1}</div>`
        + `<div class="cn">${esc(r.name)}</div>`
        + `<div class="c">${r.rounds | 0}</div><div class="c">${r.kills | 0}</div>`
        + `<div class="cp">${ping}</div></div>`;
    }).join('');
  }

  /**
   * 相手の頭上の名札。xyは頭の少し上の画面座標(px)。
   * 壁の向こうかどうかは呼ぶ側で判定して、見えている相手だけ渡す
   */
  nameplates(list) {
    const shown = new Set();
    for (const p of (list || [])) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      shown.add(p.id);

      let e = this.plateEls.get(p.id);
      if (!e) {
        const root = document.createElement('div');
        root.className = 'plate';
        root.innerHTML = '<div class="pname"></div><div class="pgun hidden"></div>'
          + '<div class="pbar"><div class="pfill"></div></div>';
        this.el.plates.appendChild(root);
        e = {
          root,
          name: root.children[0],
          gun: root.children[1],
          bar: root.children[2],
          fill: root.children[2].firstChild,
          txt: null,
          gunTxt: null,
        };
        this.plateEls.set(p.id, e);
      }
      if (e.txt !== p.name) { e.txt = p.name; e.name.textContent = p.name; }
      /* 何を持っているか。**ガンゲームで一番要る情報。**
         倒すたびに武器が替わるのに、他人の姿はどの銃でもほぼ同じ形なので、
         札に書かないと相手が今どの段にいるのかが分からない。
         毎フレーム呼ばれる所なので、変わった時だけ書く */
      const gun = p.gun || '';
      if (e.gunTxt !== gun) {
        e.gunTxt = gun;
        e.gun.textContent = gun;
        e.gun.classList.toggle('hidden', !gun);
      }

      const d = Math.max(0, p.dist || 0);
      // 遠いほど小さく薄く。遠くの名前が近くの相手と同じ大きさで並ぶと、
      // どっちが目の前にいるのか札から読めない。
      // ただし縮めきると字がつぶれて誰か分からなくなるので、下限で止める
      const k = clamp(1 - (d - 6) / 90, 0.55, 1);
      const hp = clamp(p.hp ?? 100, 0, 100);
      /* ここから下は、他のHUDと同じ「変わった時だけ書く」。
         前は毎フレーム10個の style を無条件で書いていて、しかも位置が
         left/top だったので、書くたびに配置のやり直し(reflow)まで走っていた。
         位置はtransformへ移す。transformは配置に効かないので、
         動いても合成し直すだけで済む。
         末尾のtranslate(-50%,-100%)は、CSSが持っていた「足元でなく頭上に
         中央揃えで置く」ための錨をこちらへ引き取った物 */
      const tf = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      if (e.tf !== tf) { e.tf = tf; e.root.style.transform = tf; }
      const fs = `${(15 * k).toFixed(1)}px`;
      if (e.fs !== fs) { e.fs = fs; e.root.style.fontSize = fs; }
      // 距離のぶんの薄さに、発砲からの経過ぶんを掛ける。
      // fadeが0へ落ちる＝撃ってから時間が経ったということなので、札もそのまま消える。
      // ぱっと消すのではなく薄れさせるのは、消えた瞬間を「今そこから離れた」と
      // 誤読させないため
      const fade = p.fade == null ? 1 : clamp(p.fade * 1.6, 0, 1);
      const op = (clamp(1 - (d - 12) / 90, 0.45, 1) * fade).toFixed(2);
      if (e.op !== op) { e.op = op; e.root.style.opacity = op; }
      // 重なった時は近いほうを手前に。奥の名前が手前に来ると両方読めなくなる
      const z = Math.max(0, 999 - Math.round(d));
      if (e.z !== z) { e.z = z; e.root.style.zIndex = z; }
      // 満タンの相手にまでバーを出すと、居るだけで画面が線だらけになる
      const barOn = hp < 100;
      if (e.barOn !== barOn) { e.barOn = barOn; e.bar.style.display = barOn ? 'block' : 'none'; }
      const barW = `${Math.round(46 * k)}px`;
      if (e.barW !== barW) { e.barW = barW; e.bar.style.width = barW; }
      const fill = `${hp}%`;
      if (e.fill2 !== fill) { e.fill2 = fill; e.fill.style.width = fill; }
      const hurt = hp < 34;
      if (e.hurt !== hurt) { e.hurt = hurt; e.root.classList.toggle('hurt', hurt); }
      /* 味方の札は色を変える。**2対2で一番困るのは味方を撃つこと。**
         味方には弾が当たらない作りにしてあるが、撃っている本人は
         「当たらない」ことに気づけない（外したのと見分けが付かない）ので、
         狙う前に色で分かる必要がある */
      const mate = !!p.mate;
      if (e.mate !== mate) { e.mate = mate; e.root.classList.toggle('mate', mate); }
    }
    // 見えなくなった相手・抜けた相手の札を片付ける
    for (const [id, e] of this.plateEls) {
      if (!shown.has(id)) { e.root.remove(); this.plateEls.delete(id); }
    }
  }

  /** 回線の具合。空文字で消える */
  netStatus(text) {
    const t = text || '';
    if (t === this._lastNet) return;   // 毎フレーム呼ばれる。変わった時だけ触る
    this._lastNet = t;
    this.el.netstat.textContent = t;
    this.el.netstat.classList.toggle('hidden', t === '');
  }

  /**
   * 画面の上にずっと出す点数。1対1なので「自分 － 相手」の形で常に両方見せる。
   * 自分の取得数だけ出すと、あと何本で負けるのかが分からない。
   *   mine/theirs … 取ったラウンド数
   *   limit       … 先取本数
   *   phase       … protocol.jsのPHASE
   *   left        … 今の局面の残り秒
   */
  /**
   * 画面の上に出す試合の状況。
   *
   * mineは自分の取得数、theirsは自分以外で一番取っている人の数。
   * 3人以上いると相手が1人に決まらないので、**今追うべき相手＝先頭**とだけ比べる。
   * 全員ぶん並べても撃ち合いの最中には読めない（誰が何本かは右上の一覧が持つ）。
   *
   * leaderは先頭の人の名前。あと1本で勝ちの人がいる時だけ、そこを名指しで出す。
   * デスマッチは3人4人と増えるほど「誰が近いのか」が見えなくなるので、
   * その1点だけは撃ち合いの最中でも分かるようにしておく
   */
  matchInfo(mine, theirs, limit, phase, left, leader = '') {
    const t = Math.max(0, Math.round(left || 0));
    const key = `${mine}-${theirs}/${limit}/${phase}/${t}/${leader}`;
    if (key === this._lastMatch) return;   // 毎フレーム呼ばれる。変わった時だけ触る
    this._lastMatch = key;

    this.el.matchScore.textContent = `${mine | 0} － ${theirs | 0}`;
    // 点差で色を変える。数字だけだとどちらが自分か一瞬迷う
    this.el.matchScore.classList.toggle('lead', mine > theirs);
    this.el.matchScore.classList.toggle('behind', mine < theirs);

    let sub;
    let urgent = false;
    if (phase === 0) sub = '席に着いて準備完了を押してください';
    else if (phase === 2) sub = `次のラウンドまで ${Math.max(1, t)}`;
    else if (phase === 3) sub = '試合終了';
    else {
      const top = Math.max(mine | 0, theirs | 0);
      // 王手。あと1本で試合が決まる状態は、時計より先に知りたい
      if (top >= (limit | 0) - 1 && top > 0) {
        sub = (mine | 0) >= (limit | 0) - 1
          ? 'あと1本で勝ち'
          : `${leader || '相手'}があと1本で勝ち`;
        urgent = true;
      } else {
        sub = `${limit | 0}本先取 ／ 残り ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        urgent = t <= 15;
      }
    }
    this.el.matchTime.textContent = sub;
    this.el.matchTime.classList.toggle('urgent', urgent);
  }

  /**
   * 右上の参加者一覧。今このサーバーに誰がいるかを常に出す。
   * 1人で待っている間も自分の名前だけは出す。空欄だと、繋がっているのか
   * サーバーが死んでいるのかが画面から判別できない
   */
  roster(rows) {
    const el = this.el.rosterRows;
    if (!el) return;
    /* 毎フレーム呼ばれるので、中身が変わった時だけDOMを触る。
       前は変わったかを調べるためにslice→sort→map→joinを毎フレームやっていて、
       「触らない」ためだけに配列2本と文字列を毎回作って捨てていた。
       数字1個に畳んで比べれば、変わっていないフレームでは何も作らない */
    let key = ((rows?.length || 0) * 31) | 0;
    for (const r of (rows || [])) {
      key = ((key * 33) + (r.id | 0) * 7 + (r.rounds | 0) * 131 + (r.me ? 1 : 0)) | 0;
      // 名前の変わり目も拾う（入り直しで同じidに別の名前が付くことがある）
      const n = r.name || '';
      for (let i = 0; i < n.length; i++) key = ((key * 33) + n.charCodeAt(i)) | 0;
    }
    if (key === this._lastRoster) return;
    this._lastRoster = key;
    const list = (rows || []).slice()
      .sort((a, b) => ((b.rounds | 0) - (a.rounds | 0)) || (a.id - b.id));
    // 先頭に印を付ける。3人4人と増えると、並び順だけでは
    // 「今は誰が一番なのか」が一瞬で読めなくなる。
    // 全員0本の時は誰も先頭ではない（開始直後に1人だけ光ると誤解する）
    const top = list.length ? (list[0].rounds | 0) : 0;
    el.innerHTML = list.map((r) => {
      const lead = top > 0 && (r.rounds | 0) === top;
      return `<div class="rname${r.me ? ' me' : ''}${lead ? ' lead' : ''}">`
        + `${esc(r.name)}<span class="rw">${r.rounds | 0}</span></div>`;
    }).join('');
  }

  /** 対戦のキルログ。他人同士の行が流れる中で、自分が絡んだ行だけ拾えるようにする */
  killVersus(killer, victim, headshot, byMe, onMe) {
    const d = document.createElement('div');
    d.className = 'kill' + (headshot ? ' head' : '') + (byMe ? ' byme' : '') + (onMe ? ' onme' : '');
    d.innerHTML = `<b>${esc(killer)}</b><span class="vs">▸</span>${esc(victim)}`
      + (headshot ? '<span class="hs">頭部</span>' : '');
    this._pushFeed(d);
  }

  /* -------------------------------------------------------- 画面全体 */

  overlay(html) {
    this.el.panel.innerHTML = html;
    this.el.overlay.classList.remove('hidden');
  }

  hideOverlay() { this.el.overlay.classList.add('hidden'); }
}
