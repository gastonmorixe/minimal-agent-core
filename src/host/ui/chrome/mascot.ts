/**
 * Tiny ASCII cat mascot with swappable expressions.
 *
 * Each cat is three rows wide, monospace-aligned:
 *
 * ```text
 *     /\_/\         ← ears
 *    ( ^.^ )        ← face   (the expressive row)
 *     > ω <         ← mouth
 * ```
 *
 * The middle row carries the personality; the ears and mouth stay
 * mostly stable across moods. Use `catRows(expr)` when you want the
 * three lines individually (e.g. to right-align next to a multi-line
 * header), or `catBlock(expr)` for a single newline-joined string.
 *
 * This module is presentation-only — no ANSI, no I/O. Callers compose
 * color and layout on top.
 *
 * @module ui/chrome/mascot
 */

export type CatExpression =
  | "curious"
  | "happy"
  | "sleepy"
  | "thinking"
  | "focused"
  | "surprised"
  | "love"
  | "error"
  | "smug"
  | "asleep"
  | "angry"
  | "crying"

export interface Cat {
  /** Top row: ears. */
  ears: string
  /** Middle row: face — the expressive bit. */
  face: string
  /** Bottom row: mouth / chin. */
  mouth: string
}

/**
 * The full mood spectrum. All entries share the same column width so
 * they can be swapped in place without re-flowing surrounding layout.
 */
export const CATS: Record<CatExpression, Cat> = {
  curious: { ears: " /\\_/\\", face: "( o.o )", mouth: " > ^ <" },
  happy: { ears: " /\\_/\\", face: "( ^.^ )", mouth: " > ω <" },
  sleepy: { ears: " /\\_/\\", face: "( -.- )", mouth: " > ‿ <" },
  thinking: { ears: " /\\_/\\", face: "( o.O )", mouth: " > ~ <" },
  focused: { ears: " /\\_/\\", face: "( •.• )", mouth: " > - <" },
  surprised: { ears: " /\\_/\\", face: "( O.O )", mouth: " > o <" },
  love: { ears: " /\\_/\\", face: "( ♥.♥ )", mouth: " > ‿ <" },
  error: { ears: " /\\_/\\", face: "( x.x )", mouth: " > _ <" },
  smug: { ears: " /\\_/\\", face: "( ¬.¬ )", mouth: " > ˘ <" },
  asleep: { ears: " /\\_/\\", face: "( =.= )", mouth: " > z <" },
  angry: { ears: " /\\_/\\", face: "( >.< )", mouth: " > ^ <" },
  crying: { ears: " /\\_/\\", face: "( ;.; )", mouth: " > _ <" },
}

/**
 * The "cutest by default" expression used for the startup header
 * mascot. `happy` was picked over `curious` because the `^.^` eyes
 * + `ω` mouth combo reads as actively cheerful rather than neutral.
 */
export const DEFAULT_CAT: CatExpression = "happy"

/**
 * Return the three rows of a cat as a tuple `[ears, face, mouth]`.
 * Useful when you want to right-align the cat next to a multi-line
 * banner — render row N alongside header line N.
 */
export function catRows(expr: CatExpression = DEFAULT_CAT): readonly [string, string, string] {
  const cat = CATS[expr]
  return [cat.ears, cat.face, cat.mouth] as const
}

/**
 * Return the cat as a single newline-joined string. Suitable for
 * `console.log(catBlock())` or splash banners.
 */
export function catBlock(expr: CatExpression = DEFAULT_CAT): string {
  return catRows(expr).join("\n")
}

/**
 * Return just the face row (e.g. `( ^.^ )`) for one-line prompt
 * prefixes where a 3-row mascot is too tall.
 */
export function catFace(expr: CatExpression = DEFAULT_CAT): string {
  return CATS[expr].face
}
