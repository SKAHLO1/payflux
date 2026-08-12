import { z } from "zod"
import dotenv from "dotenv"

dotenv.config({ path: "../.env" })
dotenv.config()

/**
 * Configuration is validated once, at boot, and the process refuses to start if the networks are
 * inconsistent (master prompt §51). Mixing Coston and Coston2, or testnet and mainnet, is the
 * single most likely way to produce convincing-looking but meaningless demo data.
 */

const COSTON2_CHAIN_ID = 114

/**
 * Treats an empty value as absent.
 *
 * `.env.example` ships every optional key present-but-blank so the file documents itself. Without
 * this, `COSTON2_PRIVATE_KEY=` fails its regex and the process refuses to boot — which turns
 * "copy the example and run it" into a hard error rather than a stack that reports UNAVAILABLE
 * and keeps going. Blank means unset, everywhere.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional())

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // --- Network identity -------------------------------------------------
  FLARE_NETWORK: z.literal("coston2").default("coston2"),
  FLARE_CHAIN_ID: z.coerce.number().int().default(COSTON2_CHAIN_ID),
  COSTON2_RPC_URL: z.string().url().default("https://coston2-api.flare.network/ext/C/rpc"),
  COSTON2_EXPLORER_URL: z.string().url().default("https://coston2-explorer.flare.network"),

  XRPL_NETWORK: z.literal("testnet").default("testnet"),
  XRPL_RPC_URL: z.string().url().default("https://s.altnet.rippletest.net:51234"),
  XRPL_WS_URL: z.string().default("wss://s.altnet.rippletest.net:51233"),
  XRPL_EXPLORER_URL: z.string().url().default("https://testnet.xrpl.org"),

  // --- Flare Data Connector ---------------------------------------------
  /** Attestation verifier server that turns a raw request into an ABI-encoded FDC request. */
  FDC_VERIFIER_URL: z.string().url().default("https://fdc-verifiers-testnet.flare.network"),
  /**
   * Flare publishes an open API key for the *testnet* verifier, documented in their FDC guides
   * and starter kits. Defaulting to it means a fresh clone can verify a payment without hunting
   * for credentials. It is public, testnet-only, and overridable — nothing secret is baked in.
   */
  FDC_VERIFIER_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().default("00000000-0000-0000-0000-000000000000"),
  ),
  /** Data Availability layer used to retrieve the Merkle proof for a finalized round. */
  FDC_DA_LAYER_URL: z.string().url().default("https://ctn2-data-availability.flare.network"),
  FDC_DA_LAYER_API_KEY: optional(z.string()),

  // --- Signing ----------------------------------------------------------
  /**
   * Coston2 signer used to submit FDC attestation requests and PaymentRegistry writes.
   * Never committed, never sent to the frontend, never written to Firestore (§46, §47).
   */
  COSTON2_PRIVATE_KEY: optional(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),

  PAYMENT_REGISTRY_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),

  // --- Merchant demo config --------------------------------------------
  MERCHANT_XRPL_ADDRESS: optional(z.string()),
  MERCHANT_FLARE_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  MERCHANT_WEBHOOK_URL: optional(z.string().url()),
  MERCHANT_WEBHOOK_SECRET: optional(z.string().min(16)),

  // --- API surface ------------------------------------------------------
  /**
   * Bootstrap keys, `keyId:merchantId:secret`. Developer-owned keys are created in the dashboard
   * and stored hashed; these exist so the API, tests and demo store work before anyone signs in.
   */
  PAYFLUX_API_KEYS: z.string().default(""),
  MAX_API_KEYS_PER_ACCOUNT: z.coerce.number().int().min(1).max(50).default(5),
  /**
   * Outstanding FAssets collateral reservations one account may hold.
   *
   * Each reservation costs the operator a non-refundable C2FLR fee (~1.7 C2FLR per lot on
   * Coston2) and is lost if the customer never pays. Without a cap, repeatedly selecting the XRP
   * route and walking away drains the operator's balance — and once it is empty, no payment on
   * the deployment can be verified at all.
   */
  MAX_OPEN_RESERVATIONS_PER_ACCOUNT: z.coerce.number().int().min(1).max(20).default(3),
  /**
   * C2FLR held back from collateral reservations to keep the API operational.
   *
   * FDC attestation requests and PaymentRegistry writes also cost gas. If reservations consume
   * the entire balance, verification stops for everyone — including payments already in flight.
   */
  MIN_OPERATIONAL_C2FLR: z.coerce.number().min(0).default(5),
  /**
   * How long a rotated key keeps working. Long enough to deploy the successor and confirm
   * traffic has moved; a leaked key should be rotated with graceHours 0 instead.
   */
  API_KEY_ROTATION_GRACE_HOURS: z.coerce.number().int().min(0).max(168).default(24),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  PAYMENT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Tolerance for amount matching, in basis points of the expected amount. */
  AMOUNT_TOLERANCE_BPS: z.coerce.number().int().min(0).max(1000).default(50),

  // --- Persistence ------------------------------------------------------
  FIREBASE_PROJECT_ID: optional(z.string()),
  FIREBASE_CLIENT_EMAIL: optional(z.string()),
  FIREBASE_PRIVATE_KEY: optional(z.string()),

  /**
   * Development-only switch. When true the API serves clearly-labelled DEMO MODE data instead of
   * touching any chain. It is refused in production and every response it produces carries
   * `"mode": "DEMO"` so it can never be mistaken for the real demonstration (master prompt §57).
   */
  PAYFLUX_DEMO_MODE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
})

export type Env = z.infer<typeof schema>

function fail(message: string): never {
  console.error(`\n[payflux] configuration error: ${message}\n`)
  process.exit(1)
}

function load(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    fail(
      `invalid environment:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    )
  }

  const env = parsed.data

  if (env.FLARE_CHAIN_ID !== COSTON2_CHAIN_ID) {
    fail(
      `FLARE_CHAIN_ID is ${env.FLARE_CHAIN_ID} but PayFlux targets Coston2 (${COSTON2_CHAIN_ID}). ` +
        `Refusing to start rather than silently mixing networks.`,
    )
  }

  // Guard against the classic Coston / Coston2 mix-up.
  if (/(^|[^2])coston([^2]|$)/i.test(env.COSTON2_RPC_URL) && !/coston2/i.test(env.COSTON2_RPC_URL)) {
    fail(`COSTON2_RPC_URL looks like a Coston (not Coston2) endpoint: ${env.COSTON2_RPC_URL}`)
  }
  if (/\bs1\.ripple\.com|xrplcluster\.com\b/i.test(env.XRPL_RPC_URL)) {
    fail(`XRPL_RPC_URL points at XRPL mainnet. PayFlux is testnet-only.`)
  }

  if (env.PAYFLUX_DEMO_MODE && env.NODE_ENV === "production") {
    fail("PAYFLUX_DEMO_MODE cannot be enabled in production.")
  }

  return env
}

export const env = load()

/** Which capabilities are genuinely wired up right now. Drives the UNAVAILABLE badges in the UI. */
export interface Capabilities {
  coston2Rpc: boolean
  coston2Signer: boolean
  paymentRegistry: boolean
  fdcVerifier: boolean
  fdcDataAvailability: boolean
  xrplWatcher: boolean
  ftsoPricing: boolean
  fassetsSettlement: boolean
  firestore: boolean
  googleSignIn: boolean
  demoMode: boolean
}

export function capabilities(): Capabilities {
  return {
    coston2Rpc: Boolean(env.COSTON2_RPC_URL),
    coston2Signer: Boolean(env.COSTON2_PRIVATE_KEY),
    paymentRegistry: Boolean(env.PAYMENT_REGISTRY_ADDRESS),
    fdcVerifier: Boolean(env.FDC_VERIFIER_API_KEY),
    fdcDataAvailability: Boolean(env.FDC_DA_LAYER_URL),
    xrplWatcher: Boolean(env.MERCHANT_XRPL_ADDRESS),
    ftsoPricing: Boolean(env.COSTON2_RPC_URL),
    // Resolved dynamically from the AssetManager; this only reports whether we can even look.
    fassetsSettlement: Boolean(env.COSTON2_RPC_URL && env.COSTON2_PRIVATE_KEY),
    firestore: Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
    // Same credentials as Firestore: one Firebase service account covers both.
    googleSignIn: Boolean(
      env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
    ),
    demoMode: env.PAYFLUX_DEMO_MODE,
  }
}

export const NETWORKS = {
  flare: {
    name: "Flare Coston2",
    shortName: "Coston2",
    chainId: COSTON2_CHAIN_ID,
    explorer: env.COSTON2_EXPLORER_URL,
    txUrl: (hash: string) => `${env.COSTON2_EXPLORER_URL}/tx/${hash}`,
    addressUrl: (address: string) => `${env.COSTON2_EXPLORER_URL}/address/${address}`,
  },
  xrpl: {
    name: "XRPL Testnet",
    shortName: "XRPL Testnet",
    explorer: env.XRPL_EXPLORER_URL,
    txUrl: (hash: string) => `${env.XRPL_EXPLORER_URL}/transactions/${hash}`,
    addressUrl: (address: string) => `${env.XRPL_EXPLORER_URL}/accounts/${address}`,
  },
} as const
