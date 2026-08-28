/**
 * The pure semantic reference an owned selector receives for the instance it
 * is selecting beneath.
 *
 * Runtime identity is `family + semantic key + owner semantic path`, so a
 * selector that only saw the direct owner key could not tell
 * `Organization[A]/Workspace[main]` from `Organization[B]/Workspace[main]`.
 * The reference is a linked chain up to the root of the ownership tree, so
 * the whole semantic path is available without redundantly embedding ancestor
 * identity into keys.
 *
 * It is deliberately pure: no Scope, no services, no physical generation, no
 * mutable runtime state. Selectors stay pure functions of control state and
 * semantic identity.
 */
export interface Owner<out K, out Parent> {
  /** The owning family's human-readable name. */
  readonly family: string
  /** The owning instance's semantic key. */
  readonly key: K
  /** The owner's own owner: another `Owner`, or `null` at the root. */
  readonly parent: Parent
}
