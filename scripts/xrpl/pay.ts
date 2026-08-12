/**
 * Pay a PayFlux payment intent from an XRPL Testnet wallet.
 *
 * This exists because of one hard requirement: the transfer must carry a 32-byte memo holding the
 * payment reference. That memo is what FDC decodes and reports, and it is how the payment is bound
 * to the intent — without it the funds arrive and match nothing. Most faucet UIs cannot set memos,
 * which makes an otherwise simple demo unreasonably fiddly.
 *
 * The script reads the intent from the API, so the destination, the exact amount and the memo all
 * come from PayFlux rather than being retyped.
 *
 *   npx tsx scripts/xrpl/pay.ts <paymentId>                # uses XRPL_WALLET_SEED from .env
 *   npx tsx scripts/xrpl/pay.ts <paymentId> --seed sEd7...
 *   npx tsx scripts/xrpl/pay.ts --fund                     # create + fund a testnet wallet
 *   npx tsx scripts/xrpl/pay.ts <paymentId> --underpay 5   # send 5% less, to exercise partial pay
 *
 * Testnet only. It refuses to run against XRPL mainnet.
 */
import { Client, Wallet, xrpToDrops, dropsToXrp, type Payment } from "xrpl"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env" })
dotenv.config()

const API = process.env.PAYFLUX_API_URL ?? "http://localhost:4000"
const XRPL_WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233"

if (!/altnet|testnet|devnet/i.test(XRPL_WS)) {
  fail(`XRPL_WS_URL does not look like a testnet endpoint: ${XRPL_WS}. Refusing to send.`)
}

interface Args {
  paymentId?: string
  seed?: string
  fund: boolean
  underpayPercent?: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fund: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === "--fund") args.fund = true
    else if (value === "--seed") args.seed = argv[++i]
    else if (value === "--underpay") args.underpayPercent = Number(argv[++i])
    else if (!value.startsWith("--")) args.paymentId = value
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const client = new Client(XRPL_WS)
  await client.connect()

  try {
    if (args.fund) {
      await fundWallet(client)
      return
    }

    if (!args.paymentId) {
      fail(
        "Usage: npx tsx scripts/xrpl/pay.ts <paymentId> [--seed sEd...] [--underpay <percent>]\n" +
          "       npx tsx scripts/xrpl/pay.ts --fund",
      )
    }

    const seed = args.seed ?? process.env.XRPL_WALLET_SEED
    if (!seed) {
      fail(
        "No wallet seed. Pass --seed, set XRPL_WALLET_SEED in .env, or run with --fund to create one.",
      )
    }

    const wallet = Wallet.fromSeed(seed)
    console.log(`\nPaying from ${wallet.address}`)

    // --- read the intent from PayFlux -----------------------------------
    const payment = await fetchPayment(args.paymentId)

    if (payment.selectedAsset !== "XRP") {
      fail(
        `Payment ${payment.id} is set to pay in ${payment.selectedAsset ?? "(nothing yet)"}. ` +
          `Choose the XRP route at checkout first — this script only sends XRP.`,
      )
    }
    const instructions = payment.paymentInstructions
    if (!instructions?.destinationAddress || !instructions.memoDataHex) {
      fail(
        `Payment ${payment.id} has no XRPL instructions yet. Select the XRP route at ` +
          `/checkout/${payment.id} first.`,
      )
    }

    const expiresAt = new Date(payment.expiresAt)
    if (expiresAt.getTime() < Date.now()) {
      fail(`Payment ${payment.id} expired at ${payment.expiresAt}. Create a new one.`)
    }

    let drops = xrpToDrops(instructions.amount)
    if (args.underpayPercent) {
      // Deliberately short, to exercise the partially_paid path.
      drops = ((BigInt(drops) * BigInt(100 - args.underpayPercent)) / 100n).toString()
      console.log(`  Underpaying by ${args.underpayPercent}% on purpose.`)
    }

    console.log(`  Reference:   ${payment.paymentReference}`)
    console.log(`  Destination: ${instructions.destinationAddress}`)
    console.log(`  Amount:      ${dropsToXrp(drops)} XRP`)
    console.log(`  Memo:        ${instructions.memoDataHex}`)
    console.log(`  Expires:     ${payment.expiresAt}`)

    // --- check the wallet can cover it ----------------------------------
    const balance = await client.getXrpBalance(wallet.address).catch(() => 0)
    // XRPL holds a base reserve (currently 1 XRP on testnet) that cannot be spent.
    const spendable = Number(balance) - 1
    if (spendable < Number(dropsToXrp(drops))) {
      fail(
        `Wallet holds ${balance} XRP, which does not cover ${dropsToXrp(drops)} XRP plus the ` +
          `1 XRP account reserve. Fund it at https://faucet.altnet.rippletest.net/accounts`,
      )
    }

    // --- send -----------------------------------------------------------
    const tx: Payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: instructions.destinationAddress,
      Amount: drops,
      Memos: [
        {
          // A single 32-byte memo is exactly what FDC reads as the standard payment reference.
          // More than one, or a different length, and the reference comes back empty.
          Memo: { MemoData: instructions.memoDataHex },
        },
      ],
    }

    console.log("\nSubmitting…")
    const result = await client.submitAndWait(tx, { wallet })
    const meta = result.result.meta

    const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown"
    if (code !== "tesSUCCESS") {
      fail(`XRPL rejected the payment: ${code}`)
    }

    const hash = result.result.hash
    console.log(`\n  Sent: ${hash}`)
    console.log(`  ${process.env.XRPL_EXPLORER_URL ?? "https://testnet.xrpl.org"}/transactions/${hash}`)

    // The watcher will find this on its own; nudging just removes the polling delay.
    await fetch(`${API}/v1/payments/${payment.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionHashHint: hash }),
    }).catch(() => undefined)

    console.log(`\n  PayFlux is verifying. Watch it at:`)
    console.log(`    http://localhost:3000/status/${payment.id}`)
    console.log(
      `\n  The FDC voting round genuinely takes a few minutes — that wait is the cost of a\n` +
        `  trust-minimised proof, not the demo being slow.\n`,
    )
  } finally {
    await client.disconnect()
  }
}

async function fundWallet(client: Client) {
  console.log("Requesting a funded XRPL Testnet wallet…")
  const { wallet, balance } = await client.fundWallet()

  console.log(`\n  Address: ${wallet.address}`)
  console.log(`  Seed:    ${wallet.seed}`)
  console.log(`  Balance: ${balance} XRP`)
  console.log(`\nAdd to .env so the script can reuse it:\n  XRPL_WALLET_SEED=${wallet.seed}`)
  console.log(
    `\nThis is a disposable testnet wallet with no real value — do not reuse it anywhere else.\n`,
  )
}

interface PayFluxPayment {
  id: string
  selectedAsset?: string
  paymentReference: string
  expiresAt: string
  paymentInstructions?: {
    destinationAddress: string
    amount: string
    memoDataHex?: string
  }
}

async function fetchPayment(id: string): Promise<PayFluxPayment> {
  const response = await fetch(`${API}/v1/payments/${id}`).catch(() => {
    fail(`Could not reach the PayFlux API at ${API}. Is it running? (npm run dev:api)`)
  })
  if (!response.ok) {
    fail(`PayFlux returned HTTP ${response.status} for payment ${id}.`)
  }
  return (await response.json()) as PayFluxPayment
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

main().catch((error) => {
  console.error("\n  ✗ Payment failed:\n")
  console.error(error)
  process.exit(1)
})
