/**
 * Replacement policy for a lifetime family: what happens when a desired
 * replacement must supersede a live physical instance in the same slot.
 */
export type ReplacementPolicy =
  | { readonly _tag: "Sequential" }
  | { readonly _tag: "Overlap" }

/**
 * The old lifetime must reach its finalization boundary before the latest
 * desired replacement starts. Use for exclusive devices, locks and other
 * resources that cannot safely overlap. This is the default policy.
 */
export const sequential = (): ReplacementPolicy => ({ _tag: "Sequential" })

/**
 * The new desired lifetime may start immediately while the old one is still
 * stopping. Physical overlap never weakens capability-generation isolation.
 */
export const overlap = (): ReplacementPolicy => ({ _tag: "Overlap" })
