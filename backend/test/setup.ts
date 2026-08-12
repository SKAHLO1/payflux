/**
 * Test environment.
 *
 * Set before any module imports `config/env`, which validates once at load and exits on failure.
 * These are deliberately Coston2/XRPL-Testnet values — the config guard rejects anything else,
 * and the tests should be running against the same network guard as production.
 */
process.env.NODE_ENV = "test"

/**
 * Force the in-memory store.
 *
 * `config/env.ts` calls `dotenv.config({ path: "../.env" })`, so once a developer creates a real
 * `.env` the test process inherits their live Firebase service account — and the suite starts
 * writing test accounts, API keys and audit events into a production Firestore. Blanking these
 * before any import makes the tests hermetic regardless of what is on disk.
 *
 * dotenv does not overwrite variables that are already set, so assigning "" here wins.
 */
process.env.FIREBASE_PROJECT_ID = ""
process.env.FIREBASE_CLIENT_EMAIL = ""
process.env.FIREBASE_PRIVATE_KEY = ""
process.env.FLARE_NETWORK = "coston2"
process.env.FLARE_CHAIN_ID = "114"
process.env.PAYFLUX_API_KEYS = "key_test:merchant_demo:sk_test_secret_value_1234567890"
process.env.ALLOWED_ORIGINS = "http://localhost:3000"
process.env.MERCHANT_XRPL_ADDRESS = "rPayFluxDemoMerchantAddress000000000"
process.env.MERCHANT_FLARE_ADDRESS = "0x1111111111111111111111111111111111111111"
process.env.MERCHANT_WEBHOOK_SECRET = "whsec_test_secret_value_abcdef"
process.env.PAYMENT_TTL_SECONDS = "900"
process.env.QUOTE_TTL_SECONDS = "300"
process.env.AMOUNT_TOLERANCE_BPS = "50"

export const TEST_API_KEY = "sk_test_secret_value_1234567890"
export const TEST_MERCHANT_ID = "merchant_demo"
