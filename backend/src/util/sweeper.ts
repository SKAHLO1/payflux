/**
 * Polling loops that get out of the way when there is nothing to do.
 *
 * Five sweepers poll Firestore on fixed intervals. At their original rates they issued ~38,000
 * queries a day between them, and Firestore bills a minimum of one document read per query even
 * when the result is empty — so an idle deployment spent most of a Spark plan's 50,000 daily
 * reads discovering that nothing had happened, then failed with RESOURCE_EXHAUSTED once real
 * traffic needed the rest.
 *
 * Two behaviours fix that, and both matter:
 *
 *   Idle backoff. A tick reports whether it found work. Consecutive empty ticks stretch the
 *   interval geometrically up to a ceiling, and the first tick that finds something snaps it
 *   straight back. A quiet deployment costs roughly an eighth of what it did; a busy one polls
 *   exactly as fast as before, because work resets the delay immediately.
 *
 *   Quota backoff. RESOURCE_EXHAUSTED means the daily allowance is gone and will not return
 *   until it resets. Retrying at full speed — which is what a plain setInterval does — consumes
 *   whatever trickles back and floods the log. That case jumps straight to the ceiling.
 *
 * Timing uses a self-scheduling setTimeout rather than setInterval, because the delay has to
 * change between runs, and because setInterval will happily queue overlapping ticks when a run
 * takes longer than its period.
 */

export interface SweeperOptions {
  /** Used only in log lines, so a failing loop is identifiable. */
  name: string
  /** Delay while work is being found. */
  intervalMs: number
  /** Ceiling for the idle delay. Defaults to 8x the base interval. */
  maxIntervalMs?: number
  /**
   * One pass. Return true when it found something to do — that is what keeps the loop fast.
   * Returning false, or nothing, counts as idle.
   */
  tick: () => Promise<boolean | void>
}

/** Firestore's gRPC status for a spent quota. */
const RESOURCE_EXHAUSTED = 8

function isQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === RESOURCE_EXHAUSTED
}

export function startSweeper({ name, intervalMs, maxIntervalMs, tick }: SweeperOptions): () => void {
  const ceiling = maxIntervalMs ?? intervalMs * 8
  let delay = intervalMs
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  /** Log a spent quota once per episode rather than on every tick. */
  let quotaReported = false

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, delay)
    // Never hold the process open for a poll — the API should still exit cleanly on SIGTERM.
    timer.unref?.()
  }

  const run = async () => {
    try {
      const didWork = await tick()

      if (didWork) {
        delay = intervalMs
        quotaReported = false
      } else {
        delay = Math.min(delay * 2, ceiling)
      }
    } catch (error) {
      if (isQuotaError(error)) {
        delay = ceiling
        if (!quotaReported) {
          quotaReported = true
          console.error(
            `[payflux] ${name}: Firestore quota exhausted. Backing off to ${ceiling / 1000}s. ` +
              `The Spark plan allows 50,000 reads a day and resets at midnight US/Pacific; ` +
              `upgrading to Blaze keeps the same free allowance and charges only beyond it.`,
          )
        }
      } else {
        delay = Math.min(delay * 2, ceiling)
        console.error(`[payflux] ${name} error:`, error)
      }
    } finally {
      schedule()
    }
  }

  schedule()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
