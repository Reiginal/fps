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

  ammo(cur, reserve, name, slotIndex, reloadT) {
    if (cur !== this._lastAmmo) {
      this._lastAmmo = cur;
      this.el.ammo.textContent = cur;
      this.el.ammoWrap.classList.toggle('empty', cur === 0);
    }
    this.el.reserve.textContent = `/ ${reserve}`;
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

  // 撃破の多い順。同数なら戦死が少ないほうを上に出す（撃ち合いに勝っている側）。
  // 渡された配列は呼ぶ側の物なので、並べ替える前に写しを取る
  _rankRows(rows, markTop) {
    const list = (rows || []).slice()
      .sort((a, b) => ((b.kills | 0) - (a.kills | 0)) || ((a.deaths | 0) - (b.deaths | 0)));
    return list.map((r, i) => {
      const cls = 'sbrow' + (r.me ? ' me' : '') + (markTop && i === 0 ? ' win' : '');
      const ping = Number.isFinite(r.ping) ? `${Math.round(r.ping)}ms` : '—';
      return `<div class="${cls}"><div class="c1">${i + 1}</div>`
        + `<div class="cn">${esc(r.name)}</div>`
        + `<div class="c">${r.kills | 0}</div><div class="c">${r.deaths | 0}</div>`
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
      e.root.style.opacity = clamp(1 - (d - 12) / 90, 0.45, 1).toFixed(2);
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

  matchInfo(score, limit, timeLeftS) {
    const t = Math.max(0, Math.round(timeLeftS || 0));
    const key = `${score}/${limit}/${t}`;
    if (key === this._lastMatch) return;   // 毎フレーム呼ばれる。変わった時だけ触る
    this._lastMatch = key;
    this.el.matchScore.textContent = `${score | 0} / ${limit | 0}`;
    this.el.matchTime.textContent = `残り ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.el.matchTime.classList.toggle('urgent', t <= 30);
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
