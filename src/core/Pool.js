/**
 * Pool — fixed-capacity free-list. Keeps per-frame allocation at zero for
 * particles, damage numbers, decals and other high-churn objects.
 */
export class Pool {
  constructor(factory, capacity, reset) {
    this._factory = factory;
    this._reset = reset;
    this._free = new Array(capacity);
    this._capacity = capacity;
    for (let i = 0; i < capacity; i++) this._free[i] = factory(i);
    this._freeCount = capacity;
    this.live = [];
  }

  get capacity() { return this._capacity; }
  get freeCount() { return this._freeCount; }

  /** Returns null when exhausted; callers decide whether to recycle the oldest. */
  acquire() {
    if (this._freeCount === 0) return null;
    const obj = this._free[--this._freeCount];
    this.live.push(obj);
    return obj;
  }

  release(obj) {
    const i = this.live.indexOf(obj);
    if (i < 0) return false;
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    if (this._reset) this._reset(obj);
    this._free[this._freeCount++] = obj;
    return true;
  }

  /** Release by index while iterating `live` backwards. */
  releaseAt(i) {
    const obj = this.live[i];
    this.live[i] = this.live[this.live.length - 1];
    this.live.pop();
    if (this._reset) this._reset(obj);
    this._free[this._freeCount++] = obj;
    return obj;
  }

  releaseAll() {
    for (let i = this.live.length - 1; i >= 0; i--) this.releaseAt(i);
  }
}
