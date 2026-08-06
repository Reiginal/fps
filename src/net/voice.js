// 声で話す層。**ブラウザ同士を直接繋いで音を流す（WebRTC）。**
//
// なぜサーバーを通さないか: 音をサーバーが受けて配り直す形（SFU）にすると、
// 4人ぶんの音が全部512MBのマシンを通る。今のゲームと同居できないし、
// 重い部品とビルド手順が要る。**直接繋げば、音はサーバーを1バイトも通らない。**
// 4人でも1人が送るのは3本、上りで毎秒120kbps程度で収まる。
//
// サーバーがやるのは**合図の受け渡しだけ**。「繋ぎたい」「こちらの住所はこれ」を
// 相手へ転がす。そこは既にWebSocketがあるので、新しいサーバーが要らない。
//
// ---------------------------------------------------------------------------
// この層が抱えている厄介ごとは3つ。全部コードの中で名前を付けてある。
//
//   1. **両側から同時に声をかけると壊れる。** 2人が同時に「繋ぎたい」を出すと、
//      お互いの申し出がぶつかって、どちらも繋がらないまま終わる。
//      **番号の小さい方からだけ声をかける**と決めて避ける
//   2. **2割前後の人は直接繋がらない。** 携帯回線や会社のネットワークがそう。
//      今は公開されている住所案内(STUN)だけを使うので、その人達は声が届かない。
//      **届かなくてもゲームは普通に遊べる**形にしてある
//   3. **マイクを断る人がいる。** 断った人が遊べなくなるのが最悪なので、
//      断られたら「聞く側」として繋ぐ（相手の声は聞こえる）
// ---------------------------------------------------------------------------

/* 住所案内(STUN)。**公開されている物をそのまま使う。**
   自分で立てても中身は同じで、月額と手間だけが増える。
   ここが落ちていても「直接繋がる人だけ繋がる」に落ちるだけで、ゲームは動く */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** 押して話すのキー。WASDから遠く、しゃがみ(Ctrl/C)ともぶつからない */
export const PTT_CODE = 'KeyV';

export class VoiceChat {
  /**
   * @param send 合図を相手へ送る関数 (toId, data) => void
   */
  constructor(send) {
    this.send = send || (() => {});
    // 自分のid。**どちらから声をかけるかを決めるのに要る**
    this.myId = -1;
    // 相手のid -> { pc, audio, stream }
    this.peers = new Map();
    // マイクの音。許可されるまでnull
    this.local = null;
    // 遊ぶ側が入りにしているか。切っている間は繋ぎに行かない
    this.enabled = false;
    // 今しゃべっているか（押して話すのキーを押しているか）
    this.talking = false;
    // 相手の声の音量。設定から来る
    this.volume = 1;
    // マイクを断られたか。断られても聞く側として繋ぐ
    this.micDenied = false;
    // 次に繋ぐべき相手。サーバーから届いた並びをそのまま持つ
    this.wanted = [];
    /* 何か変わった時に呼ばれる口（画面へ出すため）。
       繋がった数・喋っているか・マイクが使えるか */
    this.onChange = () => {};
  }

  /** 今つながっている人数。画面に出す */
  get liveCount() {
    let n = 0;
    for (const p of this.peers.values()) if (p.pc?.connectionState === 'connected') n++;
    return n;
  }

  /** この端末で声が使えるか。使えない端末でも遊べる（何も起きないだけ） */
  static get supported() {
    return !!(globalThis.RTCPeerConnection && globalThis.navigator?.mediaDevices?.getUserMedia);
  }

  /* ------------------------------------------------------------ 出入り */

  /**
   * サーバーから届いた「繋ぐべき相手」の並びを反映する。
   *
   * **前と見比べて、増えた相手へ繋ぎ、減った相手を切る。**
   * 毎回全部繋ぎ直す形にすると、誰かが入るたびに全員の声が一瞬途切れる
   */
  setPeers(ids) {
    this.wanted = Array.isArray(ids) ? ids.filter(Number.isInteger) : [];
    if (!this.enabled) { this._dropAll(); return; }
    const want = new Set(this.wanted);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this._drop(id);
    // **番号の小さい方からだけ声をかける。** 両側から同時に出すとぶつかって
    // どちらも繋がらない。待つ側は相手の申し出が届いた時に繋ぐ
    for (const id of want) {
      if (this.peers.has(id)) continue;
      if (this.myId >= 0 && this.myId < id) this._connect(id, true);
    }
    this.onChange();
  }

  /** 入り切り。切った時は全部畳んでマイクも手放す */
  setEnabled(on) {
    const next = !!on;
    if (this.enabled === next) return;
    this.enabled = next;
    if (!next) {
      this._dropAll();
      this._stopMic();
    } else {
      this.setPeers(this.wanted);
    }
    this.onChange();
  }

  setVolume(v) {
    const n = Math.min(1, Math.max(0, Number(v)));
    this.volume = Number.isFinite(n) ? n : this.volume;
    for (const p of this.peers.values()) if (p.audio) p.audio.volume = this.volume;
  }

  /**
   * 押して話す。押している間だけマイクを開ける。
   *
   * **マイクそのものは開けっぱなしにして、送るかどうかだけ切り替える。**
   * 押すたびに許可を取り直す形にすると、押した瞬間に音が出るまで
   * 一拍かかって、言い出しの一言が毎回消える
   */
  setTalking(on) {
    const next = !!on && this.enabled;
    if (this.talking === next) return;
    this.talking = next;
    this._applyMic();
    this.onChange();
  }

  /** 相手から合図が届いた。中身はここだけが読む */
  async receive(from, d) {
    if (!this.enabled || !d) return;
    // まだ知らない相手から声をかけられた＝自分は待つ側
    let p = this.peers.get(from);
    if (!p) {
      if (!this.wanted.includes(from)) return;   // 輪の外からは受けない
      p = this._connect(from, false);
    }
    if (!p) return;
    try {
      if (d.sdp) {
        await p.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          await this._ensureMic();
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          this.send(from, { sdp: p.pc.localDescription });
        }
      } else if (d.ice) {
        await p.pc.addIceCandidate(d.ice);
      }
    } catch { /* 合図が壊れていただけ。繋がらないまま遊べる */ }
  }

  /** 全部畳む。試合から抜ける時に呼ぶ */
  dispose() {
    this._dropAll();
    this._stopMic();
  }

  /* ------------------------------------------------------------ 中身 */

  _connect(id, initiator) {
    const RTC = globalThis.RTCPeerConnection;
    if (!RTC) return null;
    let pc;
    try {
      pc = new RTC({ iceServers: ICE_SERVERS });
    } catch { return null; }

    /* 相手の声を出す場所。**素の音の部品(<audio>)へ繋ぐ。**
       ゲームの音の仕組み（距離で小さくする所）へ通すのは次の回。
       あちらは端末によって無音になるという報告が多い所なので、
       まず「聞こえる」を確かめてから足す */
    const audio = globalThis.document?.createElement?.('audio') || null;
    if (audio) {
      audio.autoplay = true;
      audio.volume = this.volume;
      // 画面には出さない。音を出すためだけに置く
      if (audio.style) audio.style.display = 'none';
      globalThis.document?.body?.appendChild?.(audio);
    }

    const p = { pc, audio, stream: null };
    this.peers.set(id, p);

    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, { ice: e.candidate }); };
    pc.ontrack = (e) => {
      p.stream = e.streams?.[0] || null;
      if (audio && p.stream) audio.srcObject = p.stream;
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      // 切れた繋ぎを残すと、次に同じ相手が来た時に古い方が邪魔をする
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._drop(id);
      this.onChange();
    };

    // 声をかける側だけが名刺(SDP)を作る
    if (initiator) {
      this._ensureMic()
        .then(() => pc.createOffer())
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.send(id, { sdp: pc.localDescription }))
        .catch(() => { /* 繋がらないまま遊べる */ });
    }
    return p;
  }

  _drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* 既に閉じている */ }
    if (p.audio) {
      p.audio.srcObject = null;
      p.audio.remove?.();
    }
  }

  _dropAll() { for (const id of [...this.peers.keys()]) this._drop(id); }

  /**
   * マイクを開ける。**断られても例外を外へ出さない。**
   * 断った人が遊べなくなるのが最悪なので、聞く側として繋ぎ続ける
   */
  async _ensureMic() {
    if (this.local || this.micDenied) return this.local;
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) { this.micDenied = true; return null; }
    try {
      this.local = await md.getUserMedia({
        audio: {
          // 同じ部屋で2人が遊ぶとエコーになる。ブラウザ側の消し込みを入りにする
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      this.micDenied = true;
      this.onChange();
      return null;
    }
    // 開けた時点では黙らせておく。押して話すなので、押されるまで送らない
    this._applyMic();
    for (const [, p] of this.peers) this._addLocal(p);
    this.onChange();
    return this.local;
  }

  _addLocal(p) {
    if (!this.local || !p?.pc?.addTrack) return;
    for (const track of this.local.getAudioTracks()) {
      try { p.pc.addTrack(track, this.local); } catch { /* 既に足してある */ }
    }
  }

  /* 送るかどうかはマイクの入り切りで決める。繋ぎ直さないので途切れない */
  _applyMic() {
    if (!this.local) return;
    for (const track of this.local.getAudioTracks()) track.enabled = this.talking;
  }

  _stopMic() {
    if (!this.local) return;
    for (const track of this.local.getAudioTracks()) { try { track.stop(); } catch { /* 既に止まっている */ } }
    this.local = null;
  }
}
