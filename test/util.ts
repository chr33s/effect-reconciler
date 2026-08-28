import { Data, Effect } from "effect"

/** A test expectation that never became true in time. */
export class TestTimeout extends Data.TaggedError("TestTimeout")<{
  readonly message: string
}> {}

/** Startup failure injected by a test's `start` Effect. */
export class StartupFailed extends Data.TaggedError("StartupFailed")<{
  readonly reason: string
}> {}

/** Poll until the condition holds (or fail after 5s). Convergence is
 * asynchronous, so tests await observable consequences instead of commits. */
export const eventually = (
  condition: () => boolean,
  label = "condition"
): Effect.Effect<void, TestTimeout> => {
  const loop: Effect.Effect<void> = Effect.suspend(() =>
    condition() ? Effect.void : Effect.andThen(Effect.sleep(5), loop)
  )
  return loop.pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () =>
        Effect.fail(new TestTimeout({ message: `eventually: ${label} not met within 5s` }))
    })
  )
}

/** Window of real time in which nothing further is expected to happen. */
export const settle = Effect.sleep(60)

export const count = (log: ReadonlyArray<string>, entry: string): number =>
  log.filter((e) => e === entry).length
