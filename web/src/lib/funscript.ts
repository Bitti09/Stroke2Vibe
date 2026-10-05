// Funscript parsing/serialization with multi-axis ("axes") support.
// Mirrors the semantics of auto/Stroke2VibeAuto.cpp: stable-sort by `at`, dedupe
// keeping the last of each duplicate timestamp (map[at]=pos semantics).

export interface Action {
  at: number // ms, sorted ascending, unique
  pos: number // 0-100
}

export interface FunscriptAxis {
  id: string
  actions: Action[]
}

export interface Funscript {
  version: string
  metadata: unknown
  axes: FunscriptAxis[] // ordered as in the file; top-level actions are NOT included here
  actions: Action[] // top-level actions = L0
  doc: Record<string, unknown> // full parsed document
}

function extractActions(arr: unknown): Action[] {
  if (!Array.isArray(arr)) throw new Error('"actions" is not an array')
  return arr.map((e) => {
    if (typeof e !== 'object' || e === null) throw new Error('malformed action entry')
    const o = e as Record<string, unknown>
    const at = o.at
    const pos = o.pos
    if (typeof at !== 'number' || typeof pos !== 'number') throw new Error('malformed action entry')
    return { at: Math.round(at), pos } as Action
  })
}

/** Sort by `at` and dedupe duplicates (last wins). */
export function normalizeActions(input: Action[]): Action[] {
  return dedupe([...input].sort((a, b) => a.at - b.at))
}

export function dedupe(input: Action[]): Action[] {
  const out: Action[] = []
  for (const a of input) {
    if (out.length > 0 && out[out.length - 1].at === a.at) out[out.length - 1].pos = a.pos
    else out.push(a)
  }
  return out
}

export function parseFunscript(text: string): Funscript {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`)
  }
  if (typeof doc !== 'object' || doc === null) throw new Error('root is not a JSON object')
  const d = doc as Record<string, unknown>

  const actions = extractActions(d.actions ?? [])
  const axes: FunscriptAxis[] = []
  if (Array.isArray(d.axes)) {
    for (const ax of d.axes) {
      if (typeof ax !== 'object' || ax === null) continue
      const a = ax as Record<string, unknown>
      if (typeof a.id !== 'string') continue
      if (!Array.isArray(a.actions)) continue
      try {
        axes.push({ id: a.id, actions: extractActions(a.actions) })
      } catch {
        /* keep other axes even if one is malformed */
      }
    }
  }

  return {
    version: typeof d.version === 'string' ? d.version : '1.0',
    metadata: d.metadata,
    actions: normalizeActions(actions),
    axes,
    doc: d,
  }
}

/** Find an axis by id, case-insensitive. */
export function findAxis(fs: Funscript, id: string): FunscriptAxis | undefined {
  const want = id.toLowerCase()
  return fs.axes.find((a) => a.id.toLowerCase() === want)
}

export function hasAxis(fs: Funscript, id: string): boolean {
  return findAxis(fs, id) !== undefined
}

/** Build a new document with the given axes set (replacing by id, keeping order + other fields). */
export function withAxes(fs: Funscript, axes: FunscriptAxis[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fs.doc }
  out.axes = axes
  return out
}

/** Set axes on a funscript (replacing existing entries by id, appending new ones). */
export function setAxes(fs: Funscript, axes: FunscriptAxis[]): void {
  for (const ax of axes) {
    const existing = findAxis(fs, ax.id)
    if (existing) {
      // remap: replace the whole entry (incl. id case, e.g. legacy "v0" -> "V0")
      existing.id = ax.id
      existing.actions = normalizeActions(ax.actions)
    } else {
      fs.axes.push({ id: ax.id, actions: normalizeActions(ax.actions) })
    }
  }
  fs.doc = { ...fs.doc, axes: fs.axes.map((a) => ({ id: a.id, actions: a.actions })) }
  fs.axes = (fs.doc.axes as FunscriptAxis[]).map((a) => ({ id: a.id, actions: a.actions as Action[] }))
}

/** Add or replace a single axis (e.g. a generated A0 vacuum track). */
export function setAxis(fs: Funscript, axis: FunscriptAxis): void {
  setAxes(fs, [axis])
}

// ---------------------------------------------------------------------------
// Serialization round-trips through JSON.parse, so unknown fields already in
// `doc` survive. When embedding converted axes we rebuild `axes` from objects.
export function serialize(fs: Funscript): string {
  return JSON.stringify(fs.doc)
}

export function download(filename: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
