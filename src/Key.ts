/**
 * Semantic key identity for lifetime families.
 *
 * A value belongs in the semantic key only when changing it should replace
 * that lifetime for semantic runtime reasons. JavaScript reference equality is
 * never used implicitly; every definition selects an explicit `Key`.
 *
 * `encode` defines semantic equality: two keys are semantically equal exactly
 * when their encodings are equal. The encoding must be injective but may
 * contain any characters — the runtime escapes it before building internal
 * identifiers.
 */
export interface Key<in out A> {
  readonly encode: (value: A) => string
}

const make = <A>(encode: (value: A) => string): Key<A> => ({ encode })

export const string: Key<string> = make((a) => JSON.stringify(a))

export const number: Key<number> = make((a) => (Object.is(a, -0) ? "-0" : String(a)))

export const boolean: Key<boolean> = make((a) => String(a))

const null_: Key<null> = make(() => "null")
export { null_ as null }

/**
 * Structural key over named fields, each with its own `Key`. Field order does
 * not affect equality.
 */
export const struct = <Fields extends Record<string, Key<any>>>(
  fields: Fields
): Key<{ readonly [F in keyof Fields]: Fields[F] extends Key<infer A> ? A : never }> => {
  const names = Object.keys(fields).sort()
  // Every component encoding is framed rather than spliced into a
  // delimiter-separated string: component encodings are arbitrary strings, so
  // raw concatenation can collide even when each component encoder is
  // injective. `JSON.stringify` over [name, encoding] pairs in canonical
  // field order escapes the components, which keeps the composition
  // injective.
  return make((value) =>
    JSON.stringify(names.map((n) => [n, fields[n]!.encode((value as any)[n])]))
  )
}
