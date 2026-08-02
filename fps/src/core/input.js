// キーボード・マウス・ポインタロックの受け口。
// マウス移動量は毎フレーム消費して溜め込まない（消費し忘れると視点がすっ飛ぶ）。
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this._pressedThisFrame = new Set();
    this._onLockChange = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedThisFrame.add(e.code);
      // スペースでページがスクロールしたりタブが移動すると台無しになる
      if (['Space', 'Tab', 'KeyR', 'ControlLeft'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.buttons.fill(false); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) { this.keys.clear(); this.buttons.fill(false); }
      this._onLockChange?.(this.locked);
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons[e.button] = true;
      e.preventDefault();
    });
    addEventListener('mouseup', (e) => { this.buttons[e.button] = false; });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  onLockChange(fn) { this._onLockChange = fn; }

  requestLock() {
    this.dom.requestPointerLock?.();
  }

  pressed(code) { return this._pressedThisFrame.has(code); }
  down(code) { return this.keys.has(code); }

  // 移動入力を -1..1 で返す（斜め移動が速くならないよう正規化する）
  moveVector(out) {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z -= 1;
    if (this.keys.has('KeyS')) z += 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  // 1フレーム分のマウス移動をラジアンに変換して取り出す
  takeLook() {
    const yaw = -this.mouseDX * this.sensitivity;
    const pitch = (this.invertY ? 1 : -1) * this.mouseDY * this.sensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { yaw, pitch };
  }

  endFrame() { this._pressedThisFrame.clear(); }
}
