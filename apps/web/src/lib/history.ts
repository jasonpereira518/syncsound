/** Undo/redo stack of snapshots. A gesture's base is captured on its first edit and recorded on commit. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private base: T | null = null;

  constructor(
    private readonly limit = 50,
    private readonly equals: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  ) {}

  /** call before applying an edit, with the state before the edit */
  beginEdit(current: T): void {
    if (this.base === null) this.base = current;
  }

  /** call after the edit with the new state; records one undo step for the whole gesture */
  commit(current: T): void {
    const base = this.base;
    this.base = null;
    if (base === null || this.equals(base, current)) return;
    this.past.push(base);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  get editing() {
    return this.base !== null;
  }

  undo(current: T): T | null {
    this.commit(current);
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  get canUndo() {
    return this.past.length > 0 || this.base !== null;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
    this.base = null;
  }
}
