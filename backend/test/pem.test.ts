import { describe, expect, it } from "vitest"
import "./setup.js"
import { __testing } from "../src/config/env.js"

const { normalizePem, looksLikePem } = __testing

/*
 * A service account key survives a round trip through a hosting dashboard's text box, and each
 * platform mangles it differently. Every corruption below produces the same unhelpful
 * `error:1E08010C:DECODER routines::unsupported` at the first Firestore call, so they are worth
 * pinning down where the message can still name the cause.
 */

const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDexample"
const VALID = `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\n`

describe("private key normalization", () => {
  it("leaves an already-correct PEM alone", () => {
    expect(normalizePem(VALID)).toBe(VALID.trim())
    expect(looksLikePem(normalizePem(VALID))).toBe(true)
  })

  it("converts escaped newlines into real ones", () => {
    const escaped = `-----BEGIN PRIVATE KEY-----\\n${BODY}\\n-----END PRIVATE KEY-----\\n`
    const out = normalizePem(escaped)
    expect(out).toContain("\n")
    expect(out).not.toContain("\\n")
    expect(looksLikePem(out)).toBe(true)
  })

  /* The failure that actually broke the deploy: the dashboard kept the quotes. */
  it("strips wrapping double quotes stored as part of the value", () => {
    const quoted = `"-----BEGIN PRIVATE KEY-----\\n${BODY}\\n-----END PRIVATE KEY-----\\n"`
    const out = normalizePem(quoted)
    expect(out.startsWith('"')).toBe(false)
    expect(looksLikePem(out)).toBe(true)
  })

  it("strips wrapping single quotes too", () => {
    const quoted = `'-----BEGIN PRIVATE KEY-----\\n${BODY}\\n-----END PRIVATE KEY-----\\n'`
    expect(looksLikePem(normalizePem(quoted))).toBe(true)
  })

  it("drops carriage returns from a Windows clipboard", () => {
    const crlf = `-----BEGIN PRIVATE KEY-----\\r\\n${BODY}\\r\\n-----END PRIVATE KEY-----\\r\\n`
    const out = normalizePem(crlf)
    expect(out).not.toContain("\r")
    expect(looksLikePem(out)).toBe(true)
  })

  it("handles a key that is quoted and escaped at once", () => {
    const both = `"-----BEGIN PRIVATE KEY-----\\r\\n${BODY}\\r\\n-----END PRIVATE KEY-----\\r\\n"`
    expect(looksLikePem(normalizePem(both))).toBe(true)
  })

  it("accepts the RSA PRIVATE KEY header variant", () => {
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\\n${BODY}\\n-----END RSA PRIVATE KEY-----`
    expect(looksLikePem(normalizePem(rsa))).toBe(true)
  })

  /*
   * A stray quote inside the value is not a wrapper. Stripping it would corrupt a key that was
   * otherwise fine, turning a working deploy into a broken one.
   */
  it("does not strip an unmatched quote", () => {
    const oddity = `"-----BEGIN PRIVATE KEY-----\\n${BODY}\\n-----END PRIVATE KEY-----`
    expect(normalizePem(oddity).startsWith('"')).toBe(true)
  })
})

describe("private key rejection", () => {
  it("rejects a truncated key", () => {
    expect(looksLikePem(normalizePem("-----BEGIN PRIVATE KEY-----"))).toBe(false)
  })

  it("rejects a key with no line structure", () => {
    // Survives quote-stripping but has no newlines, so OpenSSL cannot parse it.
    expect(looksLikePem(`-----BEGIN PRIVATE KEY-----${BODY}-----END PRIVATE KEY-----`)).toBe(false)
  })

  it("rejects an unrelated value pasted into the field", () => {
    expect(looksLikePem(normalizePem("not-a-key"))).toBe(false)
    expect(looksLikePem(normalizePem("{}"))).toBe(false)
  })
})
