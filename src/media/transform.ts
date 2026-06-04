/**
 * Image fit-to-budget: shrink an oversize image until it fits a byte budget,
 * using Bun's native image pipeline (zero dependencies, no native-addon build).
 *
 * The problem this solves: a 4 MB macOS screenshot base64-encodes to ~5.6 MB,
 * which blows Anthropic's 5 MB-per-image wall and earns a deterministic 400.
 * Rather than just rejecting it, we downscale + re-encode it under the cap so
 * the user's "what is this?" still works. Vision models gain nothing from more
 * than ~1568px on the long edge (Anthropic's own guidance), so the downscale is
 * lossless in practice — it throws away pixels the model would have ignored.
 *
 * The engine is {@link https://bun.com/docs/runtime/image | Bun.Image}, a
 * Sharp-shaped pipeline added in Bun 1.3.14 (`.resize().jpeg().bytes()`). It is
 * feature-detected: on a runtime without `Bun.Image` (or when every attempt
 * fails) the functions return `null` and the caller falls back to rejecting the
 * item — nothing here ever throws into the submit path.
 *
 * @module media/transform
 */

import { base64EncodedSize } from "./limits.ts"

/** The pixel ceiling worth sending to a vision model; larger just burns tokens. */
export const VISION_LONG_EDGE_PX = 1568

/** Quality ladder walked (high → low) when re-encoding a lossy format. */
const QUALITY_LADDER = [85, 75, 65, 55, 45] as const

/** Dimension ladder (fractions of the first target) walked when quality alone won't fit. */
const SCALE_LADDER = [1, 0.75, 0.5] as const

/** A Bun.Image-like handle. Declared structurally so this module doesn't hard-depend on Bun types. */
interface BunImageLike {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height?: number,
    opts?: { fit?: "inside" | "fill"; withoutEnlargement?: boolean },
  ): BunImageLike
  jpeg(opts?: { quality?: number }): BunImageLike
  png(opts?: { palette?: boolean; colors?: number; dither?: boolean }): BunImageLike
  bytes(): Promise<Uint8Array>
}

interface BunImageCtor {
  new (input: Uint8Array): BunImageLike
}

/** The live `Bun.Image` constructor, or `null` on a runtime that lacks it. */
function bunImage(): BunImageCtor | null {
  const ctor = (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image
  return typeof ctor === "function" ? (ctor as BunImageCtor) : null
}

/** True when this runtime can transform images (i.e. `Bun.Image` exists). */
export function canTransformImages(): boolean {
  return bunImage() !== null
}

/** What {@link fitImageToBudget} produced. */
export interface FitResult {
  /** The re-encoded, under-budget bytes. */
  bytes: Uint8Array
  /** Mime type of {@link bytes} (the output format may differ from the input). */
  mimeType: string
  /** Output dimensions in pixels. */
  width: number
  height: number
  /** Human-readable summary of what was done, e.g. `"3600×2338→1568×1018 jpeg q75"`. */
  strategy: string
}

export interface FitOptions {
  /** The hard ceiling on the BASE64-ENCODED size (what the API actually weighs). */
  maxEncodedBytes: number
  /** Longest-edge ceiling in px. Default {@link VISION_LONG_EDGE_PX}. */
  maxLongEdge?: number
}

/**
 * Shrink `bytes` until its base64 encoding fits `maxEncodedBytes`, or return
 * `null` if even the most aggressive attempt can't (or this runtime has no
 * image backend).
 *
 * Strategy, cheapest-effective first:
 *   1. Cap the long edge at `maxLongEdge` (a 4K screenshot → 1568px is a huge
 *      win on its own and costs the model nothing).
 *   2. Re-encode as JPEG, walking the quality ladder down.
 *   3. If quality alone won't fit, step the dimensions down too.
 *
 * JPEG is the output: it is the universal lossy format every provider accepts,
 * and screenshots/photos shrink dramatically with imperceptible loss at q75+.
 * (PNG palette mode is great for flat UI art but unreliable for photos; we keep
 * this function predictable.)
 *
 * Pure-ish: reads no globals beyond `Bun.Image`, does no I/O, never throws.
 */
export async function fitImageToBudget(
  bytes: Uint8Array,
  opts: FitOptions,
): Promise<FitResult | null> {
  const Image = bunImage()
  if (!Image) return null

  const maxLongEdge = opts.maxLongEdge ?? VISION_LONG_EDGE_PX

  let srcW: number
  let srcH: number
  try {
    const meta = await new Image(bytes).metadata()
    srcW = meta.width
    srcH = meta.height
  } catch {
    return null // undecodable / unsupported format
  }
  if (srcW <= 0 || srcH <= 0) return null

  const longEdge = Math.max(srcW, srcH)
  // The first target never enlarges: min(source, ceiling).
  const baseTarget = Math.min(longEdge, maxLongEdge)

  for (const scale of SCALE_LADDER) {
    const target = Math.max(1, Math.round(baseTarget * scale))
    for (const quality of QUALITY_LADDER) {
      let out: Uint8Array
      try {
        out = await new Image(bytes)
          .resize(target, undefined, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality })
          .bytes()
      } catch {
        return null // backend rejected the op (e.g. unsupported decode)
      }
      if (base64EncodedSize(out.length) <= opts.maxEncodedBytes) {
        const scaledW = Math.round(srcW * Math.min(1, target / longEdge))
        const scaledH = Math.round(srcH * Math.min(1, target / longEdge))
        return {
          bytes: out,
          mimeType: "image/jpeg",
          width: scaledW,
          height: scaledH,
          strategy: `${srcW}×${srcH}→${scaledW}×${scaledH} jpeg q${quality}`,
        }
      }
    }
  }
  return null
}
