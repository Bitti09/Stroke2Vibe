// Simple pub-sub so the sync loop can publish current axis values to UI widgets.
type Listener = (v0: number, v1: number, t: number) => void
const listeners = new Set<Listener>()

export function onAxisValue(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function emitAxis(v0: number, v1: number, t: number): void {
  for (const fn of listeners) fn(v0, v1, t)
}
