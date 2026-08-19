/**
 * EventBus — decoupled pub/sub between subsystems.
 * `emit` dispatches immediately; `queue` defers to the end of the frame so that
 * handlers never mutate state a system is still iterating over.
 */
export class EventBus {
  constructor() {
    this._map = new Map();
    this._pending = [];
    this._swap = [];
  }

  on(type, fn) {
    let list = this._map.get(type);
    if (!list) { list = []; this._map.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this._map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._map.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload, type);
  }

  queue(type, payload) {
    this._pending.push(type, payload);
  }

  /** Dispatch everything queued this frame. Handlers may queue again for next frame. */
  flush() {
    if (this._pending.length === 0) return;
    const batch = this._pending;
    this._pending = this._swap;
    this._swap = batch;
    for (let i = 0; i < batch.length; i += 2) this.emit(batch[i], batch[i + 1]);
    batch.length = 0;
  }

  clear() { this._map.clear(); this._pending.length = 0; }
}
