import { randomUUID } from "node:crypto"
import { env } from "../config/env.js"
import type {
  Account,
  ApiKeyRecord,
  AuditEvent,
  Merchant,
  PaymentClaim,
  PaymentEvent,
  PaymentIntent,
  Settlement,
  WebhookDelivery,
} from "../domain/types.js"

/**
 * Persistence.
 *
 * Firestore when credentials are present, an in-memory implementation otherwise so the API and
 * the test suite run without external services. Both satisfy the same interface, and neither
 * stores secrets: API keys are persisted only as hashes and signer keys never touch the store
 * at all (master prompt §46).
 */

export interface Store {
  readonly kind: "firestore" | "memory"

  createPayment(payment: PaymentIntent): Promise<PaymentIntent>
  updatePayment(id: string, patch: Partial<PaymentIntent>): Promise<PaymentIntent>
  getPayment(id: string): Promise<PaymentIntent | undefined>
  getPaymentByReference(reference: string): Promise<PaymentIntent | undefined>
  listPayments(merchantId: string, limit?: number): Promise<PaymentIntent[]>
  listExpirablePayments(now: Date): Promise<PaymentIntent[]>
  /** Across all merchants — used by the FDC finalization sweeper. */
  listPaymentsByStatus(status: PaymentIntent["status"], limit?: number): Promise<PaymentIntent[]>

  /**
   * Takes the processing claim on a payment, atomically.
   *
   * Returns the claimed payment, or undefined when the payment has moved on from
   * `expectedStatus` or another worker holds an unexpired claim. This is the one
   * compare-and-set in the store: `updatePayment` is a blind merge and cannot express
   * "only if nobody beat me to it", which is exactly what guarding an on-chain write needs.
   */
  claimPayment(
    id: string,
    expectedStatus: PaymentIntent["status"],
    claim: PaymentClaim,
  ): Promise<PaymentIntent | undefined>

  /** Drops the claim, and only if `owner` still holds it — never steals a successor's lease. */
  releasePayment(id: string, owner: string): Promise<void>

  appendEvent(event: Omit<PaymentEvent, "id">): Promise<PaymentEvent>
  listEvents(paymentId: string): Promise<PaymentEvent[]>

  saveSettlement(settlement: Settlement): Promise<Settlement>
  getSettlement(id: string): Promise<Settlement | undefined>
  listSettlements(merchantId: string, limit?: number): Promise<Settlement[]>

  getMerchant(id: string): Promise<Merchant | undefined>
  saveMerchant(merchant: Merchant): Promise<Merchant>
  /** Every merchant, so the XRPL watcher can poll each account's own destination address. */
  listMerchants(): Promise<Merchant[]>

  getAccount(id: string): Promise<Account | undefined>
  saveAccount(account: Account): Promise<Account>

  /** Looked up by key id on every authenticated request — indexed, never a scan. */
  getApiKey(keyId: string): Promise<ApiKeyRecord | undefined>
  saveApiKey(record: ApiKeyRecord): Promise<ApiKeyRecord>
  listApiKeys(accountId: string): Promise<ApiKeyRecord[]>

  /** Append-only: there is deliberately no update or delete. */
  appendAuditEvent(event: AuditEvent): Promise<AuditEvent>
  listAuditEvents(accountId: string, limit?: number): Promise<AuditEvent[]>

  saveWebhookDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>
  listWebhookDeliveries(merchantId: string, limit?: number): Promise<WebhookDelivery[]>
  listPendingWebhookDeliveries(now: Date): Promise<WebhookDelivery[]>

  /** Idempotency: returns the previously stored response for a key, or records a new one. */
  getIdempotentResponse(merchantId: string, key: string): Promise<{ requestHash: string; response: unknown } | undefined>
  saveIdempotentResponse(merchantId: string, key: string, requestHash: string, response: unknown): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

class MemoryStore implements Store {
  readonly kind = "memory" as const

  private payments = new Map<string, PaymentIntent>()
  private events = new Map<string, PaymentEvent[]>()
  private settlements = new Map<string, Settlement>()
  private merchants = new Map<string, Merchant>()
  private deliveries = new Map<string, WebhookDelivery>()
  private idempotency = new Map<string, { requestHash: string; response: unknown }>()
  private accounts = new Map<string, Account>()
  private apiKeys = new Map<string, ApiKeyRecord>()
  private auditEvents: AuditEvent[] = []

  async createPayment(payment: PaymentIntent) {
    this.payments.set(payment.id, payment)
    return payment
  }

  async updatePayment(id: string, patch: Partial<PaymentIntent>) {
    const existing = this.payments.get(id)
    if (!existing) throw new Error(`Payment ${id} not found`)
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    this.payments.set(id, updated)
    return updated
  }

  /**
   * Atomic by construction: there is no `await` between the read and the write, so the event
   * loop cannot interleave another claim between them. That is the entire guarantee — adding an
   * `await` inside this method silently removes it.
   */
  async claimPayment(
    id: string,
    expectedStatus: PaymentIntent["status"],
    claim: PaymentClaim,
  ): Promise<PaymentIntent | undefined> {
    const existing = this.payments.get(id)
    if (!existing || existing.status !== expectedStatus) return undefined
    if (!claimIsAvailable(existing.processingClaim, claim.claimedAt)) return undefined

    const updated = { ...existing, processingClaim: claim, updatedAt: new Date().toISOString() }
    this.payments.set(id, updated)
    return updated
  }

  async releasePayment(id: string, owner: string) {
    const existing = this.payments.get(id)
    if (!existing || existing.processingClaim?.owner !== owner) return

    const { processingClaim: _released, ...rest } = existing
    this.payments.set(id, { ...rest, updatedAt: new Date().toISOString() })
  }

  async getPayment(id: string) {
    return this.payments.get(id)
  }

  async getPaymentByReference(reference: string) {
    return [...this.payments.values()].find((p) => p.paymentReference === reference)
  }

  async listPayments(merchantId: string, limit = 50) {
    return [...this.payments.values()]
      .filter((p) => p.merchantId === merchantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async listExpirablePayments(now: Date) {
    return [...this.payments.values()].filter(
      (p) =>
        ["created", "awaiting_payment", "partially_paid"].includes(p.status) &&
        new Date(p.expiresAt) <= now,
    )
  }

  async listPaymentsByStatus(status: PaymentIntent["status"], limit = 50) {
    return [...this.payments.values()].filter((p) => p.status === status).slice(0, limit)
  }

  async appendEvent(event: Omit<PaymentEvent, "id">) {
    const full: PaymentEvent = { ...event, id: `evt_${randomUUID()}` }
    const list = this.events.get(event.paymentId) ?? []
    list.push(full)
    this.events.set(event.paymentId, list)
    return full
  }

  async listEvents(paymentId: string) {
    return [...(this.events.get(paymentId) ?? [])].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    )
  }

  async saveSettlement(settlement: Settlement) {
    this.settlements.set(settlement.id, settlement)
    return settlement
  }

  async getSettlement(id: string) {
    return this.settlements.get(id)
  }

  async listSettlements(merchantId: string, limit = 50) {
    const paymentIds = new Set(
      [...this.payments.values()].filter((p) => p.merchantId === merchantId).map((p) => p.id),
    )
    return [...this.settlements.values()]
      .filter((s) => paymentIds.has(s.paymentId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async getMerchant(id: string) {
    return this.merchants.get(id)
  }

  async saveMerchant(merchant: Merchant) {
    this.merchants.set(merchant.id, merchant)
    return merchant
  }

  async getAccount(id: string) {
    return this.accounts.get(id)
  }

  async saveAccount(account: Account) {
    this.accounts.set(account.id, account)
    return account
  }

  async getApiKey(keyId: string) {
    return this.apiKeys.get(keyId)
  }

  async saveApiKey(record: ApiKeyRecord) {
    this.apiKeys.set(record.id, record)
    return record
  }

  async listApiKeys(accountId: string) {
    return [...this.apiKeys.values()].filter((key) => key.accountId === accountId)
  }

  async listMerchants() {
    return [...this.merchants.values()]
  }

  async appendAuditEvent(event: AuditEvent) {
    this.auditEvents.push(event)
    return event
  }

  async listAuditEvents(accountId: string, limit = 100) {
    return this.auditEvents
      .filter((event) => event.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async saveWebhookDelivery(delivery: WebhookDelivery) {
    this.deliveries.set(delivery.id, delivery)
    return delivery
  }

  async listWebhookDeliveries(merchantId: string, limit = 50) {
    return [...this.deliveries.values()]
      .filter((d) => d.merchantId === merchantId)
      .sort((a, b) => (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""))
      .slice(0, limit)
  }

  async listPendingWebhookDeliveries(now: Date) {
    return [...this.deliveries.values()].filter(
      (d) => d.status === "pending" && (!d.nextAttemptAt || new Date(d.nextAttemptAt) <= now),
    )
  }

  async getIdempotentResponse(merchantId: string, key: string) {
    return this.idempotency.get(`${merchantId}:${key}`)
  }

  async saveIdempotentResponse(merchantId: string, key: string, requestHash: string, response: unknown) {
    this.idempotency.set(`${merchantId}:${key}`, { requestHash, response })
  }
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

class FirestoreStore implements Store {
  readonly kind = "firestore" as const

  constructor(private db: FirebaseFirestore.Firestore) {}

  private col(name: string) {
    return this.db.collection(name)
  }

  async createPayment(payment: PaymentIntent) {
    await this.col("payments").doc(payment.id).set(strip(payment))
    return payment
  }

  async updatePayment(id: string, patch: Partial<PaymentIntent>) {
    const ref = this.col("payments").doc(id)
    const updated = { ...patch, updatedAt: new Date().toISOString() }
    await ref.set(strip(updated), { merge: true })
    const snapshot = await ref.get()
    return snapshot.data() as PaymentIntent
  }

  /**
   * The same compare-and-set, in a Firestore transaction so it holds across replicas.
   *
   * Firestore aborts and retries the transaction if the document changed under it, so the
   * read-check-write is genuinely atomic and the full-document `set` cannot clobber a
   * concurrent writer.
   */
  async claimPayment(
    id: string,
    expectedStatus: PaymentIntent["status"],
    claim: PaymentClaim,
  ): Promise<PaymentIntent | undefined> {
    const ref = this.col("payments").doc(id)

    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      if (!snapshot.exists) return undefined

      const existing = snapshot.data() as PaymentIntent
      if (existing.status !== expectedStatus) return undefined
      if (!claimIsAvailable(existing.processingClaim, claim.claimedAt)) return undefined

      const updated = { ...existing, processingClaim: claim, updatedAt: new Date().toISOString() }
      tx.set(ref, strip(updated))
      return updated
    })
  }

  async releasePayment(id: string, owner: string) {
    const ref = this.col("payments").doc(id)

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      if (!snapshot.exists) return

      const existing = snapshot.data() as PaymentIntent
      if (existing.processingClaim?.owner !== owner) return

      // A full set rather than a field delete: `strip` drops the undefined key, which removes it
      // from the document without needing a FieldValue sentinel through the dynamic import.
      const { processingClaim: _released, ...rest } = existing
      tx.set(ref, strip({ ...rest, updatedAt: new Date().toISOString() }))
    })
  }

  async getPayment(id: string) {
    const snapshot = await this.col("payments").doc(id).get()
    return snapshot.exists ? (snapshot.data() as PaymentIntent) : undefined
  }

  async getPaymentByReference(reference: string) {
    const snapshot = await this.col("payments")
      .where("paymentReference", "==", reference)
      .limit(1)
      .get()
    return snapshot.empty ? undefined : (snapshot.docs[0].data() as PaymentIntent)
  }

  async listPayments(merchantId: string, limit = 50) {
    const snapshot = await this.col("payments")
      .where("merchantId", "==", merchantId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get()
    return snapshot.docs.map((d) => d.data() as PaymentIntent)
  }

  async listExpirablePayments(now: Date) {
    const snapshot = await this.col("payments")
      .where("status", "in", ["created", "awaiting_payment", "partially_paid"])
      .where("expiresAt", "<=", now.toISOString())
      .limit(100)
      .get()
    return snapshot.docs.map((d) => d.data() as PaymentIntent)
  }

  async listPaymentsByStatus(status: PaymentIntent["status"], limit = 50) {
    // Single-field filter plus limit — no composite index required.
    const snapshot = await this.col("payments").where("status", "==", status).limit(limit).get()
    return snapshot.docs.map((d) => d.data() as PaymentIntent)
  }

  async appendEvent(event: Omit<PaymentEvent, "id">) {
    const id = `evt_${randomUUID()}`
    const full: PaymentEvent = { ...event, id }
    await this.col("paymentEvents").doc(id).set(strip(full))
    return full
  }

  async listEvents(paymentId: string) {
    const snapshot = await this.col("paymentEvents")
      .where("paymentId", "==", paymentId)
      .orderBy("timestamp", "asc")
      .get()
    return snapshot.docs.map((d) => d.data() as PaymentEvent)
  }

  async saveSettlement(settlement: Settlement) {
    await this.col("settlements").doc(settlement.id).set(strip(settlement), { merge: true })
    return settlement
  }

  async getSettlement(id: string) {
    const snapshot = await this.col("settlements").doc(id).get()
    return snapshot.exists ? (snapshot.data() as Settlement) : undefined
  }

  async listSettlements(merchantId: string, limit = 50) {
    const payments = await this.listPayments(merchantId, 200)
    const ids = payments.map((p) => p.id)
    if (ids.length === 0) return []
    const chunks: Settlement[] = []
    for (let i = 0; i < ids.length; i += 10) {
      const snapshot = await this.col("settlements")
        .where("paymentId", "in", ids.slice(i, i + 10))
        .get()
      chunks.push(...snapshot.docs.map((d) => d.data() as Settlement))
    }
    return chunks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
  }

  async getMerchant(id: string) {
    const snapshot = await this.col("users").doc(id).get()
    return snapshot.exists ? (snapshot.data() as Merchant) : undefined
  }

  async saveMerchant(merchant: Merchant) {
    await this.col("users").doc(merchant.id).set(strip(merchant), { merge: true })
    return merchant
  }

  async getAccount(id: string) {
    const snapshot = await this.col("accounts").doc(id).get()
    return snapshot.exists ? (snapshot.data() as Account) : undefined
  }

  async saveAccount(account: Account) {
    await this.col("accounts").doc(account.id).set(strip(account), { merge: true })
    return account
  }

  async getApiKey(keyId: string) {
    const snapshot = await this.col("apiKeys").doc(keyId).get()
    return snapshot.exists ? (snapshot.data() as ApiKeyRecord) : undefined
  }

  async saveApiKey(record: ApiKeyRecord) {
    // Not a merge: rotation and revocation clear `expiresAt`/`revokedAt`, and a merge would
    // leave a stale expiry behind on a key that is meant to be unconditionally revoked.
    await this.col("apiKeys").doc(record.id).set(strip(record))
    return record
  }

  async listApiKeys(accountId: string) {
    const snapshot = await this.col("apiKeys").where("accountId", "==", accountId).get()
    return snapshot.docs.map((d) => d.data() as ApiKeyRecord)
  }

  async listMerchants() {
    const snapshot = await this.col("users").get()
    return snapshot.docs.map((d) => d.data() as Merchant)
  }

  async appendAuditEvent(event: AuditEvent) {
    // create(), not set(): a colliding id must fail loudly rather than overwrite history.
    await this.col("auditEvents").doc(event.id).create(strip(event))
    return event
  }

  async listAuditEvents(accountId: string, limit = 100) {
    const snapshot = await this.col("auditEvents")
      .where("accountId", "==", accountId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get()
    return snapshot.docs.map((d) => d.data() as AuditEvent)
  }

  async saveWebhookDelivery(delivery: WebhookDelivery) {
    await this.col("webhookDeliveries").doc(delivery.id).set(strip(delivery), { merge: true })
    return delivery
  }

  async listWebhookDeliveries(merchantId: string, limit = 50) {
    const snapshot = await this.col("webhookDeliveries")
      .where("merchantId", "==", merchantId)
      .limit(limit)
      .get()
    return snapshot.docs.map((d) => d.data() as WebhookDelivery)
  }

  async listPendingWebhookDeliveries(now: Date) {
    const snapshot = await this.col("webhookDeliveries")
      .where("status", "==", "pending")
      .where("nextAttemptAt", "<=", now.toISOString())
      .limit(50)
      .get()
    return snapshot.docs.map((d) => d.data() as WebhookDelivery)
  }

  async getIdempotentResponse(merchantId: string, key: string) {
    const snapshot = await this.col("idempotencyKeys").doc(`${merchantId}__${key}`).get()
    return snapshot.exists
      ? (snapshot.data() as { requestHash: string; response: unknown })
      : undefined
  }

  async saveIdempotentResponse(merchantId: string, key: string, requestHash: string, response: unknown) {
    await this.col("idempotencyKeys")
      .doc(`${merchantId}__${key}`)
      .set(strip({ requestHash, response, createdAt: new Date().toISOString() }))
  }
}

/** Firestore rejects `undefined`; strip it rather than writing nulls that change semantics. */
/**
 * Whether a claim can be taken: nobody holds one, or the holder's lease has lapsed.
 *
 * Both timestamps are UTC ISO-8601 from `toISOString()`, whose fixed width makes lexicographic
 * comparison identical to chronological comparison — no Date parsing needed on a hot path.
 */
function claimIsAvailable(existing: PaymentClaim | undefined, now: string): boolean {
  if (!existing) return true
  return existing.expiresAt <= now
}

function strip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? undefined : v))) as T
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let instance: Store | undefined

export async function getStore(): Promise<Store> {
  if (instance) return instance

  const hasFirebase =
    env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY

  if (hasFirebase) {
    try {
      const admin = await import("firebase-admin")
      const app = admin.default.apps.length
        ? admin.default.app()
        : admin.default.initializeApp({
            credential: admin.default.credential.cert({
              projectId: env.FIREBASE_PROJECT_ID,
              clientEmail: env.FIREBASE_CLIENT_EMAIL,
              // Normalized to a real PEM at config load — see config/env.ts.
              privateKey: env.FIREBASE_PRIVATE_KEY!,
            }),
          })
      const db = app.firestore()
      // A single `undefined` anywhere in a document throws, and inside a fire-and-forget write
      // that becomes an unhandled rejection that kills the process. Optional fields are normal
      // in this domain (a payment with no metadata, a key with no expiry), so dropping them is
      // the correct behaviour rather than a crash.
      db.settings({ ignoreUndefinedProperties: true })
      instance = new FirestoreStore(db)
      console.log("[payflux] store: firestore")
      return instance
    } catch (error) {
      console.error(
        `[payflux] Firestore init failed, falling back to in-memory store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  instance = new MemoryStore()
  console.log("[payflux] store: in-memory (no Firebase credentials configured)")
  return instance
}
