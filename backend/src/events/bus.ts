import { EventEmitter } from "node:events"
import type { PaymentEvent, PaymentIntent } from "../domain/types.js"

/**
 * In-process pub/sub backing the SSE stream (master prompt §45).
 *
 * Single-instance only, which is the right trade for a hackathon deployment. Scaling out would
 * mean swapping this for Redis pub/sub or Firestore listeners; nothing outside this file would
 * need to change.
 */

export interface PaymentUpdate {
  payment: PaymentIntent
  event?: PaymentEvent
}

class PaymentBus extends EventEmitter {
  publish(paymentId: string, update: PaymentUpdate) {
    this.emit(paymentId, update)
    this.emit("*", update)
  }

  subscribe(paymentId: string, listener: (update: PaymentUpdate) => void): () => void {
    this.on(paymentId, listener)
    return () => this.off(paymentId, listener)
  }

  subscribeAll(listener: (update: PaymentUpdate) => void): () => void {
    this.on("*", listener)
    return () => this.off("*", listener)
  }
}

export const paymentBus = new PaymentBus()
// One listener per open SSE connection; the default cap of 10 is far too low.
paymentBus.setMaxListeners(1000)
