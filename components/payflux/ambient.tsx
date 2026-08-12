"use client"

import { useEffect, useState } from "react"

/**
 * The animated background layer.
 *
 * Three things this handles that a bare iframe does not:
 *
 * 1. **No pop-in.** A cross-origin iframe takes seconds to paint, so the page showed flat violet
 *    and then snapped to the 3D scene. The bloom below is painted immediately and the scene fades
 *    in over it, so the first frame already looks deliberate and nothing jumps.
 *
 * 2. **No third-party badge.** Spline stamps "Built with Spline" in the bottom-right of the
 *    embed. It is inside a cross-origin frame, so it cannot be styled away — instead the iframe is
 *    rendered taller than its container and the overflow is clipped, putting the badge off-canvas.
 *
 * 3. **Reduced motion is respected.** The scene is continuous animation. When the OS asks for
 *    reduced motion it is never loaded at all, which also saves the download.
 */

/** Enough to clip the badge and its margin at any viewport width. */
const BADGE_CLIP_PX = 96

const SPLINE_SCENE = "https://my.spline.design/motiontrails-mQJiWP02BoJRJj7QScWZ8Yil/"

export function AmbientBackground() {
  const [loaded, setLoaded] = useState(false)

  /*
   * Defaults to true so the iframe is in the server-rendered HTML and the browser starts fetching
   * it during parse rather than after hydration — the scene is heavy and that head start matters.
   *
   * Reduced-motion users lose nothing by this: the frame renders at opacity 0 until it loads, and
   * the effect below unmounts it on the first commit, so the scene is never visible to them.
   */
  const [allowMotion, setAllowMotion] = useState(true)

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setAllowMotion(!query.matches)

    const onChange = (event: MediaQueryListEvent) => setAllowMotion(!event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden>
      <AmbientBloom />

      {allowMotion ? (
        <iframe
          src={SPLINE_SCENE}
          title=""
          tabIndex={-1}
          frameBorder="0"
          onLoad={() => setLoaded(true)}
          className={`absolute inset-x-0 top-0 w-full transition-opacity duration-1000 ease-out ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          // Taller than the container so the bottom strip — and the Spline badge in it — is
          // clipped by the parent's overflow-hidden.
          style={{ height: `calc(100% + ${BADGE_CLIP_PX}px)` }}
        />
      ) : null}
    </div>
  )
}

/**
 * The static ground. Also used on data-dense screens, where a moving background behind a table of
 * transaction hashes is actively hostile.
 */
export function AmbientBloom({ className }: { className?: string }) {
  return (
    <div
      className={className ?? "absolute inset-0 opacity-70"}
      aria-hidden
      style={{
        backgroundImage:
          "radial-gradient(60rem 40rem at 78% -10%, rgba(239,68,68,0.18), transparent 60%)," +
          "radial-gradient(50rem 30rem at 5% 100%, rgba(168,136,184,0.22), transparent 65%)",
      }}
    />
  )
}
