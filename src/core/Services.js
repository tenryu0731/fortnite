/**
 * Services — explicit service locator.
 * Subsystems resolve peers through this instead of importing each other, which
 * keeps the dependency graph acyclic and makes initialisation order visible.
 */
export class Services {
  constructor() { this._m = new Map(); }

  set(name, value) { this._m.set(name, value); return value; }

  /** Throws on a missing service — a silent `undefined` here is always a bug. */
  get(name) {
    const v = this._m.get(name);
    if (v === undefined) throw new Error(`Service "${name}" is not registered`);
    return v;
  }

  has(name) { return this._m.has(name); }
  peek(name) { return this._m.get(name); }
  keys() { return [...this._m.keys()]; }
}
