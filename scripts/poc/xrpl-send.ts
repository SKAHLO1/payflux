import { env } from "../../backend/src/config/env.js"

/**
 * Sends an XRPL Testnet transfer carrying a PayFlux reference.
 *
 * Shared by both proof-of-concept scripts rather than duplicated, because the memo rule below is
 * the kind of detail that silently diverges once it exists in two places — and a transfer with
 * the wrong memo shape verifies against nothing.
 *
 * A wallet is funded from the testnet faucet when no seed is available, and the seed is printed
 * so the same wallet can be reused rather than begging the faucet on every run.
 */
export async function sendXrplPayment(
  destination: string,
  amountXrp: string,
  memoDataHex: string,
  options: { seed?: string; log?: (text: string) => void } = {},
): Promise<string> {
  const log = options.log ?? ((text: string) => console.log(`  ✓ ${text}`))
  const { Client, Wallet, xrpToDrops: toDrops } = await import("xrpl")

  const wsUrl = env.XRPL_WS_URL
  // A memo-carrying transfer to a mainnet address would be real money.
  if (!/altnet|testnet|devnet/i.test(wsUrl)) {
    throw new Error(`XRPL_WS_URL does not look like a testnet endpoint: ${wsUrl}. Refusing to send.`)
  }

  const client = new Client(wsUrl)
  await client.connect()

  try {
    let wallet
    if (options.seed) {
      wallet = Wallet.fromSeed(options.seed)
      log(`Paying from ${wallet.address}`)
    } else {
      log("No XRPL_WALLET_SEED set — funding a throwaway testnet wallet…")

      // The official testnet faucet. When it is slow or rate limited, the useful advice is to
      // stop asking it for a new wallet every run, not to go looking for another faucet.
      const funded = await client.fundWallet().catch((error) => {
        throw new Error(
          `The XRPL testnet faucet did not respond: ${error instanceof Error ? error.message : error}\n` +
            `  Reuse a funded wallet instead — it is faster than any faucet:\n` +
            `    set XRPL_WALLET_SEED in .env, or pass --seed sEd...\n` +
            `  To fund one by hand: https://faucet.altnet.rippletest.net/accounts\n` +
            `  Note: it must be XRPL *testnet*. FDC's testnet verifier does not index devnet.`,
        )
      })

      wallet = funded.wallet
      log(`Funded ${wallet.address} with ${funded.balance} XRP`)
      console.log(`\n  Reuse this wallet by adding to .env:\n    XRPL_WALLET_SEED=${wallet.seed}\n`)
    }

    const balance = Number(await client.getXrpBalance(wallet.address).catch(() => 0))
    // XRPL holds a base reserve (1 XRP on testnet) that can never be spent.
    if (balance - 1 < Number(amountXrp)) {
      throw new Error(
        `Wallet holds ${balance} XRP, which does not cover ${amountXrp} XRP plus the 1 XRP ` +
          `account reserve. Fund it at https://faucet.altnet.rippletest.net/accounts`,
      )
    }

    const result = await client.submitAndWait(
      {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: destination,
        Amount: toDrops(amountXrp),
        // Exactly one 32-byte memo. More than one, or a different length, and FDC reports an
        // empty standard payment reference and the transfer binds to nothing.
        Memos: [{ Memo: { MemoData: memoDataHex } }],
      },
      { wallet },
    )

    const meta = result.result.meta
    const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown"
    if (code !== "tesSUCCESS") throw new Error(`XRPL rejected the payment: ${code}`)

    return result.result.hash
  } finally {
    await client.disconnect()
  }
}
