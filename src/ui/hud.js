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
      ammo: $('ammo'), reserve: $('reserve'), ammoWrap: $('ammoWrap'),
      weapon: $('weapon'), reloading: $('reloading'),
      slots: document.querySelectorAll('.slot'),
      wave: $('wave'), remain: $('remain'), score: $('score'),
      killfeed: $('killfeed'),
      banner: $('banner'), bannerMain: $('bannerMain'), bannerSub: $('bannerSub'),
      overlay: $('overlay'), panel: $('panel'),
      speedlines: $('speedlines'),
      // 対戦で使う分。1人用では触らないので、無くても既存の表示は動く
      matchBox: $('matchBox'), matchScore: $('matchScore'), matchTime: $('matchTime'),
      plates: $('plates'), netstat: $('netstat'),
      scoreboard: $('scoreboard'), sbRows: $('sbRows'),
      finalboard: $('finalboard'), fbRows: $('fbRows'), fbNote: $('fbNote'),
      minimap: $('minimap'), zonewarn: $('zonewarn'), zoneSub: $('zoneSub'),
      rosterRows: $('rosterRows'),
      healWrap: $('healWrap'), healBar: $('healBar'), healFill: $('healFill'),
      healPips: $('healPips'), healState: $('healState'), slotHeal: $('slotHeal'),
      elim: $('elim'), elimName: $('elimName'), elimTag: $('elimTag'),
    };
    this.markerTimer = 0;
    this.crossHitTimer = 0;
    this.bannerTimer = 0;
    this.dirIndicators = [];
    this._lastGap = -1;
    this._lastHealth = -1;
    this._lastAmmo = -1;
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

    // 撃った人の点。時間で薄くなる
    if (blips) {
      for (const b of blips) {
        if (b.t <= 0) continue;
        ctx.beginPath();
        ctx.arc(px(b.x), py(b.z), Math.max(2, w / 46), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 96, 64, ${b.t.toFixed(3)})`;
        ctx.fill();
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

  ammo(cur, reserve, name, slotIndex, reloadT, melee = false) {
    // 近接武器は弾を持たない。数字を出すと「9999発の銃」に見える。
    // 欄ごと消さずに横線を置くのは、消すと下段の並びが動いて目が泳ぐため
    const shown = melee ? '—' : cur;
    if (shown !== this._lastAmmo) {
      this._lastAmmo = shown;
      this.el.ammo.textContent = shown;
      this.el.ammoWrap.classList.toggle('empty', !melee && cur === 0);
    }
    this.el.reserve.textContent = melee ? '' : `/ ${reserve}`;
    if (this.el.weapon.textContent !== name) {
      this.el.weapon.textContent = name;
      this.el.slots.forEach((s, i) => s.classList.toggle('on', i === slotIndex));
    }
    if (reloadT > 0) {
      this.el.reloading.textContent = 'リロード中';
      this.el.reloading.style.opacity = 1;
    } else {
      this.el.reloading.style.opacity = 0;
    }
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
    this.el.wave.textContent = `第${n}波`;
    this.el.remain.textContent = `残敵 ${remaining}名`;
  }

  score(v) { this.el.score.textContent = v.toLocaleString('en-US'); }

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
  elimX(name, headshot = false) {
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
    if (show) this.el.sbRows.innerHTML = this._rankRows(rows, false);
    this.el.scoreboard.classList.toggle('hidden', !show);
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
        root.innerHTML = '<div class="pname"></div><div class="pbar"><div class="pfill"></div></div>';
        this.el.plates.appendChild(root);
        e = { root, name: root.firstChild, bar: root.lastChild, fill: root.lastChild.firstChild, txt: null };
        this.plateEls.set(p.id, e);
      }
      if (e.txt !== p.name) { e.txt = p.name; e.name.textContent = p.name; }

      const d = Math.max(0, p.dist || 0);
      // 遠いほど小さく薄く。遠くの名前が近くの相手と同じ大きさで並ぶと、
      // どっちが目の前にいるのか札から読めない。
      // ただし縮めきると字がつぶれて誰か分からなくなるので、下限で止める
      const k = clamp(1 - (d - 6) / 90, 0.55, 1);
      const hp = clamp(p.hp ?? 100, 0, 100);
      e.root.style.left = `${Math.round(p.x)}px`;
      e.root.style.top = `${Math.round(p.y)}px`;
      e.root.style.fontSize = `${(15 * k).toFixed(1)}px`;
      // 距離のぶんの薄さに、発砲からの経過ぶんを掛ける。
      // fadeが0へ落ちる＝撃ってから時間が経ったということなので、札もそのまま消える。
      // ぱっと消すのではなく薄れさせるのは、消えた瞬間を「今そこから離れた」と
      // 誤読させないため
      const fade = p.fade == null ? 1 : clamp(p.fade * 1.6, 0, 1);
      e.root.style.opacity = (clamp(1 - (d - 12) / 90, 0.45, 1) * fade).toFixed(2);
      // 重なった時は近いほうを手前に。奥の名前が手前に来ると両方読めなくなる
      e.root.style.zIndex = Math.max(0, 999 - Math.round(d));
      // 満タンの相手にまでバーを出すと、居るだけで画面が線だらけになる
      e.bar.style.display = hp >= 100 ? 'none' : 'block';
      e.bar.style.width = `${Math.round(46 * k)}px`;
      e.fill.style.width = `${hp}%`;
      e.root.classList.toggle('hurt', hp < 34);
    }
    // 見えなくなった相手・抜けた相手の札を片付ける
    for (const [id, e] of this.plateEls) {
      if (!shown.has(id)) { e.root.remove(); this.plateEls.delete(id); }
    }
  }

  /** 回線の具合。空文字で消える */
  netStatus(text) {
    const t = text || '';
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
  matchInfo(mine, theirs, limit, phase, left) {
    const t = Math.max(0, Math.round(left || 0));
    const key = `${mine}-${theirs}/${limit}/${phase}/${t}`;
    if (key === this._lastMatch) return;   // 毎フレーム呼ばれる。変わった時だけ触る
    this._lastMatch = key;

    this.el.matchScore.textContent = `${mine | 0} － ${theirs | 0}`;
    // 点差で色を変える。数字だけだとどちらが自分か一瞬迷う
    this.el.matchScore.classList.toggle('lead', mine > theirs);
    this.el.matchScore.classList.toggle('behind', mine < theirs);

    let sub;
    let urgent = false;
    if (phase === 0) sub = '相手を待っています';
    else if (phase === 2) sub = `次のラウンドまで ${Math.max(1, t)}`;
    else if (phase === 3) sub = '試合終了';
    else {
      sub = `${limit | 0}本先取 ／ 残り ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      urgent = t <= 15;
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
    const list = (rows || []).slice()
      .sort((a, b) => ((b.rounds | 0) - (a.rounds | 0)) || (a.id - b.id));
    // 毎フレーム呼ばれるので、中身が変わった時だけDOMを触る
    const key = list.map((r) => `${r.id}:${r.name}:${r.rounds | 0}:${r.me ? 1 : 0}`).join('|');
    if (key === this._lastRoster) return;
    this._lastRoster = key;
    el.innerHTML = list.map((r) => `<div class="rname${r.me ? ' me' : ''}">`
      + `${esc(r.name)}<span class="rw">${r.rounds | 0}</span></div>`).join('');
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
