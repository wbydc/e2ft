// Chunks arrive out of order when they travel on several connections; this holds them until the run starting
// at `next` is complete, so the file is still written in order.
export class Reorder<T> {
  /** The first index not taken yet. */
  public next = 0;
  private readonly held = new Map<number, T>();

  constructor(private readonly window: number) {}

  /** False for a duplicate; throws past the window, which a sender that respects acks never reaches. */
  public put(i: number, value: T): boolean {
    if (i < this.next || this.held.has(i)) return false;
    if (i >= this.next + this.window) throw new Error("chunk beyond the window");
    this.held.set(i, value);

    return true;
  }

  /** The contiguous run from `next`, in order; `next` moves past it. */
  public take(): T[] {
    const run: T[] = [];
    for (let value = this.held.get(this.next); value !== undefined; value = this.held.get(this.next)) {
      this.held.delete(this.next++);
      run.push(value);
    }

    return run;
  }
}
