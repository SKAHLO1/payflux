import { describe, expect, it } from "vitest"
import {
  assertTransition,
  canTransition,
  InvalidStateTransitionError,
  webhookForStatus,
  TERMINAL_STATUSES,
} from "../src/domain/state-machine.js"

describe("payment state machine", () => {
  it("allows the happy path end to end", () => {
    const path = [
      "created",
      "awaiting_payment",
      "payment_detected",
      "verifying",
      "verified",
      "settling",
      "settled",
    ] as const

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(true)
    }
  })

  it("refuses to skip verification", () => {
    expect(canTransition("awaiting_payment", "verified")).toBe(false)
    expect(canTransition("payment_detected", "settled")).toBe(false)
    expect(canTransition("created", "settled")).toBe(false)
  })

  it("refuses to move backwards", () => {
    expect(canTransition("verified", "awaiting_payment")).toBe(false)
    expect(canTransition("settled", "verifying")).toBe(false)
  })

  it("locks terminal states", () => {
    for (const status of TERMINAL_STATUSES) {
      if (status === "settled") continue // settled may still be refunded
      expect(canTransition(status, "verified")).toBe(false)
    }
    expect(canTransition("failed", "verified")).toBe(false)
    expect(canTransition("expired", "awaiting_payment")).toBe(false)
  })

  it("lets an underpaid intent be topped up but not silently succeed", () => {
    expect(canTransition("verifying", "partially_paid")).toBe(true)
    expect(canTransition("partially_paid", "verified")).toBe(true)
    expect(canTransition("partially_paid", "settled")).toBe(false)
  })

  it("lets an overpaid intent settle", () => {
    expect(canTransition("verifying", "overpaid")).toBe(true)
    expect(canTransition("overpaid", "settled")).toBe(true)
  })

  it("throws a typed error on an illegal transition", () => {
    expect(() => assertTransition("created", "settled")).toThrow(InvalidStateTransitionError)
    try {
      assertTransition("created", "settled")
    } catch (error) {
      expect((error as InvalidStateTransitionError).code).toBe("INVALID_STATE_TRANSITION")
    }
  })

  it("maps statuses to webhook events", () => {
    expect(webhookForStatus("verified")).toBe("payment.verified")
    expect(webhookForStatus("settled")).toBe("payment.settled")
    expect(webhookForStatus("partially_paid")).toBe("payment.partially_paid")
    expect(webhookForStatus("refunded")).toBeUndefined()
  })
})
