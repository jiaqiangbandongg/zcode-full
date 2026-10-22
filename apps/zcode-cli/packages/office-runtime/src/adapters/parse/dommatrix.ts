/**
 * Minimal 2D DOMMatrix for pdf.js in Node. pdf.js constructs one at module load and uses it for
 * rendering paths the server never takes (it only extracts text); its own fallback needs the native
 * @napi-rs/canvas package, which a bundled plugin cannot ship.
 */
class Matrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: ArrayLike<number> | Matrix2D) {
    if (init && "a" in init)
      [this.a, this.b, this.c, this.d, this.e, this.f] = [
        init.a,
        init.b,
        init.c,
        init.d,
        init.e,
        init.f,
      ];
    else if (init && init.length >= 6)
      [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init).slice(0, 6);
  }

  get is2D() {
    return true;
  }

  get isIdentity() {
    return (
      this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
    );
  }

  private set(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    return this;
  }

  multiplySelf(m: Matrix2D | ArrayLike<number>) {
    const o = m instanceof Matrix2D ? m : new Matrix2D(m);
    return this.set(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
  }

  preMultiplySelf(m: Matrix2D | ArrayLike<number>) {
    const o = new Matrix2D(m);
    o.multiplySelf(this);
    return this.set(o.a, o.b, o.c, o.d, o.e, o.f);
  }

  translateSelf(x = 0, y = 0) {
    return this.multiplySelf([1, 0, 0, 1, x, y]);
  }

  scaleSelf(sx = 1, sy = sx) {
    return this.multiplySelf([sx, 0, 0, sy, 0, 0]);
  }

  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this.set(NaN, NaN, NaN, NaN, NaN, NaN);
    return this.set(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }

  multiply(m: Matrix2D | ArrayLike<number>) {
    return new Matrix2D(this).multiplySelf(m);
  }

  translate(x = 0, y = 0) {
    return new Matrix2D(this).translateSelf(x, y);
  }

  scale(sx = 1, sy = sx) {
    return new Matrix2D(this).scaleSelf(sx, sy);
  }

  inverse() {
    return new Matrix2D(this).invertSelf();
  }

  transformPoint(point: { x?: number; y?: number } = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

export function installDomMatrix() {
  const scope = globalThis as { DOMMatrix?: unknown };
  scope.DOMMatrix ??= Matrix2D;
}
