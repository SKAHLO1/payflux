import { NextResponse } from "next/server"

/**
 * Server-side proxy to the PayFlux API.
 *
 * The merchant secret key lives here and only here. The browser never receives it, which is why
 * every merchant-scoped dashboard read goes through a Next route handler rather than calling the
 * API directly (master prompt §46, §47).
 */

const API_BASE = (process.env.PAYFLUX_API_URL ?? "http://localhost:4000").replace(/\/$/, "")
const API_KEY = process.env.PAYFLUX_SECRET_KEY

export async function proxy(path: string, init?: RequestInit) {
  if (!API_KEY) {
    return NextResponse.json(
      {
        error: {
          code: "API_KEY_NOT_CONFIGURED",
          message:
            "PAYFLUX_SECRET_KEY is not set on the Next server, so merchant data is UNAVAILABLE. " +
            "Add it to .env.local.",
        },
      },
      { status: 503 },
    )
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "X-API-Key": API_KEY,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    })

    const text = await response.text()
    return new NextResponse(text || "{}", {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "API_UNREACHABLE",
          message: `The PayFlux API at ${API_BASE} could not be reached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      },
      { status: 503 },
    )
  }
}
