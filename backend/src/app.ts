import express from "express"
import helmet from "helmet"
import cors from "cors"
import { env } from "./config/env.js"
import { apiRouter } from "./routes/index.js"
import { errorHandler, notFound, rateLimiter, requestId } from "./middleware/index.js"

/**
 * Middleware order matters and is fixed here (master prompt §32):
 *
 *   helmet -> cors -> request id -> body -> rate limit -> router -> 404 -> errors
 *
 * Request IDs are assigned before rate limiting so a 429 is still traceable.
 */
export function createApp() {
  const app = express()

  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  // Chain reads produce bigints (drops, UBA, wei) and `JSON.stringify` throws on them. Amounts
  // are serialized as decimal strings throughout the API anyway — a float would lose precision
  // on values that represent money.
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  )

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }))

  const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/server-to-server requests carry no Origin header.
        if (!origin) return callback(null, true)
        if (allowedOrigins.includes(origin)) return callback(null, true)
        // Never a wildcard: this API sets credentials: true.
        callback(new Error(`Origin ${origin} is not allowed by PayFlux CORS policy.`))
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Request-ID",
        "Idempotency-Key",
      ],
      exposedHeaders: ["X-Request-ID", "Idempotent-Replay"],
      credentials: true,
      maxAge: 600,
    }),
  )

  app.use(requestId)
  app.use(express.json({ limit: "256kb" }))
  app.use(rateLimiter)

  app.get("/", (_req, res) => {
    res.json({
      name: "PayFlux API",
      version: "0.1.0",
      network: "Flare Coston2 + XRPL Testnet",
      docs: "/v1/health",
    })
  })

  app.use("/v1", apiRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
