"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/payflux/shell"
import {
  CheckItem,
  CopyButton,
  DataRow,
  GhostButton,
  PrimaryButton,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { RequireAuth, useAuth } from "@/components/payflux/auth-provider"
import { Loading } from "@/components/payflux/dashboard-ui"
import {
  apiKeysApi,
  type ApiKey,
  type ApiKeyStatus,
  type ApiScope,
} from "@/lib/payflux/api-keys-client"
import { MISSING_FIREBASE_VARS } from "@/lib/firebase/client"
import { timeAgo } from "@/lib/payflux/format"
import { cn } from "@/lib/utils"

export default function ApiKeysPage() {
  return (
    <RequireAuth fallback={<NotConfigured />}>
      <ApiKeys />
    </RequireAuth>
  )
}

const STATUS_STYLES: Record<ApiKeyStatus, string> = {
  active:
    "text-[color:var(--pf-success)] border-[color:var(--pf-success)]/40 bg-[color:var(--pf-success)]/10",
  rotating:
    "text-[color:var(--pf-pending)] border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10",
  expired: "text-white/45 border-white/20 bg-white/5",
  revoked:
    "text-[color:var(--pf-danger)] border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10",
}

function ApiKeys() {
  const { getToken } = useAuth()

  const [keys, setKeys] = useState<ApiKey[]>([])
  const [limit, setLimit] = useState(5)
  const [defaultGrace, setDefaultGrace] = useState(24)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [name, setName] = useState("")
  const [availableScopes, setAvailableScopes] = useState<
    Array<{ scope: ApiScope; description: string }>
  >([])
  const [selectedScopes, setSelectedScopes] = useState<ApiScope[]>([])

  // The one and only time a secret exists in the browser. Cleared on dismiss, never persisted.
  const [revealed, setRevealed] = useState<{ key: ApiKey; note: string } | undefined>()

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const token = await getToken()
      if (!token) return
      const result = await apiKeysApi.list(token)
      setKeys(result.data)
      setLimit(result.limit)
      setDefaultGrace(result.defaultGraceHours)
      setAvailableScopes(result.availableScopes)
      // Preselect the documented default the first time, then leave the user's choice alone.
      setSelectedScopes((current) => (current.length ? current : result.defaultScopes))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    void load()
  }, [load])

  const withToken = async <T,>(action: string, fn: (token: string) => Promise<T>) => {
    setBusy(action)
    setError(undefined)
    try {
      const token = await getToken()
      if (!token) throw new Error("Your session expired. Sign in again.")
      return await fn(token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      setBusy(undefined)
      void load()
    }
  }

  const create = async () => {
    const result = await withToken("create", (token) =>
      apiKeysApi.create(token, name.trim() || "Default key", selectedScopes),
    )
    if (result) {
      setRevealed({ key: result.data, note: result.warning })
      setName("")
    }
  }

  const rotate = async (key: ApiKey, graceHours: number) => {
    const result = await withToken(`rotate:${key.id}`, (token) =>
      apiKeysApi.rotate(token, key.id, graceHours),
    )
    if (result) setRevealed({ key: result.data, note: result.warning })
  }

  const revoke = async (key: ApiKey) => {
    await withToken(`revoke:${key.id}`, (token) => apiKeysApi.revoke(token, key.id))
  }

  const live = keys.filter((k) => k.status === "active" || k.status === "rotating")

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integration"
        title="API keys"
        description="Keys are scoped to your account. PayFlux stores only a hash, so a secret is shown exactly once — at the moment it is created."
      />

      {error ? (
        <Surface className="border-[color:var(--pf-danger)]/30 bg-[color:var(--pf-danger)]/[0.07] p-5">
          <p className="text-[13px] leading-relaxed text-white/85">{error}</p>
        </Surface>
      ) : null}

      {revealed ? (
        <RevealedKey
          apiKey={revealed.key}
          note={revealed.note}
          onDismiss={() => setRevealed(undefined)}
        />
      ) : null}

      <Surface className="p-6">
        <SectionLabel>Create a key</SectionLabel>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="min-w-[14rem] flex-1">
            <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
              Name
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production checkout"
              maxLength={64}
              className="w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[color:var(--pf-coral)]/60"
            />
          </label>
          <PrimaryButton
            onClick={create}
            disabled={busy === "create" || live.length >= limit || selectedScopes.length === 0}
          >
            {busy === "create" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            Create key
          </PrimaryButton>
        </div>

        <div className="mt-6 border-t border-white/10 pt-5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
            Scopes
          </p>
          <p className="mb-4 text-[12px] leading-relaxed text-white/40">
            Grant only what this key needs. A reporting job that cannot move money is a much
            smaller problem when it leaks.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            {availableScopes.map(({ scope, description }) => {
              const checked = selectedScopes.includes(scope)
              return (
                <label
                  key={scope}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                    checked
                      ? "border-[color:var(--pf-coral)]/50 bg-[color:var(--pf-coral)]/[0.08]"
                      : "border-white/12 bg-white/[0.02] hover:border-white/25",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelectedScopes((current) =>
                        current.includes(scope)
                          ? current.filter((s) => s !== scope)
                          : [...current, scope],
                      )
                    }
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[color:var(--pf-coral)]"
                  />
                  <span className="min-w-0">
                    <span className="pf-hash block text-white/85">{scope}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-white/45">
                      {description}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>

          {selectedScopes.length === 0 ? (
            <p className="mt-3 text-[12px] text-[color:var(--pf-pending)]">
              Select at least one scope.
            </p>
          ) : null}
        </div>

        <p className="mt-5 text-[12px] text-white/40">
          {live.length} of {limit} live keys used.
          {live.length >= limit
            ? " Revoke one before creating another."
            : " Name keys after where they run — it is the only way to know which to rotate."}
        </p>
      </Surface>

      {loading ? (
        <Loading label="Loading your keys…" />
      ) : keys.length === 0 ? (
        <Surface className="p-10 text-center">
          <p className="text-sm text-white/45">
            No keys yet. Create one above to start calling the API.
          </p>
        </Surface>
      ) : (
        <div className="space-y-4">
          {keys.map((key) => (
            <KeyRow
              key={key.id}
              apiKey={key}
              defaultGrace={defaultGrace}
              busy={busy}
              onRotate={rotate}
              onRevoke={revoke}
            />
          ))}
        </div>
      )}

      <Surface className="p-6">
        <SectionLabel>How rotation works</SectionLabel>
        <ul className="mt-4 space-y-2.5">
          <CheckItem>
            Rotating issues a successor and puts the old key on a countdown — both work during the
            grace window, so you can deploy and verify before anything breaks.
          </CheckItem>
          <CheckItem>
            Rotate with <span className="text-white/85">no grace period</span> if a key has leaked.
            The old key is rejected on the next request.
          </CheckItem>
          <CheckItem>
            Keys carry their id in the clear (<code className="pf-hash">sk_ctn2_&lt;id&gt;_…</code>),
            so verification is one indexed lookup and the id is safe to quote in a support thread.
          </CheckItem>
          <CheckItem>
            The secret is 256 bits from a CSPRNG, stored as SHA-256 and compared in constant time.
          </CheckItem>
          <CheckItem>
            A successor inherits the predecessor&apos;s scopes. Keys marked{" "}
            <span className="text-white/85">legacy</span> predate scopes and run with full access —
            rotating one applies the default scopes instead.
          </CheckItem>
        </ul>
      </Surface>

      <Surface className="p-6">
        <SectionLabel>Using a key</SectionLabel>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/25 p-5 text-[12.5px] leading-relaxed">
          <code className="font-mono text-white/75">
            {`curl -X POST ${process.env.NEXT_PUBLIC_PAYFLUX_API_URL ?? "http://localhost:4000"}/v1/payments \\
  -H "X-API-Key: $PAYFLUX_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order_1001" \\
  -d '{
    "amount": "50.00",
    "currency": "USD",
    "acceptedAssets": ["XRP", "FXRP", "C2FLR"],
    "settlementAsset": "FXRP",
    "orderId": "order_1001"
  }'`}
          </code>
        </pre>
        <p className="mt-4 text-[12px] leading-relaxed text-white/40">
          The <code className="pf-hash">Idempotency-Key</code> is what stops a retried request from
          creating a second payment. Reusing a key with a different body returns 409 rather than
          silently returning the first payment.
        </p>
      </Surface>
    </div>
  )
}

function KeyRow({
  apiKey,
  defaultGrace,
  busy,
  onRotate,
  onRevoke,
}: {
  apiKey: ApiKey
  defaultGrace: number
  busy?: string
  onRotate: (key: ApiKey, graceHours: number) => void
  onRevoke: (key: ApiKey) => void
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const terminal = apiKey.status === "revoked" || apiKey.status === "expired"
  const rotating = busy === `rotate:${apiKey.id}`
  const revoking = busy === `revoke:${apiKey.id}`

  return (
    <Surface className={cn("p-6", terminal && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-display text-base tracking-[0.05em] text-white">{apiKey.name}</p>
          <p className="pf-hash mt-1.5 text-white/55">{apiKey.prefix}…</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {apiKey.legacyFullAccess ? (
            <span
              className="rounded-full border border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--pf-pending)]"
              title="Issued before scopes existed, so it has full access. Rotate to apply scopes."
            >
              Legacy · full access
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
              STATUS_STYLES[apiKey.status],
            )}
          >
            {apiKey.status}
          </span>
        </div>
      </div>

      {apiKey.scopes.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {apiKey.scopes.map((scope) => (
            <li
              key={scope}
              className="rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 pf-hash text-white/60"
            >
              {scope}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 divide-y divide-white/[0.07] border-t border-white/[0.07]">
        <DataRow label="Key ID">
          <span className="pf-hash">{apiKey.id}</span>
        </DataRow>
        <DataRow label="Created">{timeAgo(apiKey.createdAt)}</DataRow>
        <DataRow label="Last used">
          {apiKey.lastUsedAt ? timeAgo(apiKey.lastUsedAt) : "Never used"}
        </DataRow>
        {apiKey.expiresAt ? (
          <DataRow label="Stops working">
            <span className="text-[color:var(--pf-pending)]">
              {new Date(apiKey.expiresAt).toLocaleString()}
            </span>
          </DataRow>
        ) : null}
        {apiKey.rotatedToId ? (
          <DataRow label="Rotated into">
            <span className="pf-hash">{apiKey.rotatedToId}</span>
          </DataRow>
        ) : null}
        {apiKey.rotatedFromId ? (
          <DataRow label="Replaced">
            <span className="pf-hash">{apiKey.rotatedFromId}</span>
          </DataRow>
        ) : null}
      </div>

      {!terminal ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
          {!apiKey.rotatedToId ? (
            <>
              <GhostButton
                className="px-5 py-2"
                disabled={Boolean(busy)}
                onClick={() => onRotate(apiKey, defaultGrace)}
              >
                {rotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Rotate ({defaultGrace}h grace)
              </GhostButton>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onRotate(apiKey, 0)}
                className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40 underline underline-offset-4 transition-colors hover:text-[color:var(--pf-coral)] hover:shadow-none disabled:opacity-40"
              >
                Rotate now (no grace)
              </button>
            </>
          ) : null}

          {confirmRevoke ? (
            <span className="ml-auto flex items-center gap-3">
              <span className="text-[12px] text-white/60">Revoke immediately?</span>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onRevoke(apiKey)}
                className="rounded-full border border-[color:var(--pf-danger)]/50 bg-[color:var(--pf-danger)]/15 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--pf-danger)] transition-colors hover:bg-[color:var(--pf-danger)]/25 hover:shadow-none"
              >
                {revoking ? "Revoking…" : "Yes, revoke"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevoke(false)}
                className="text-[11px] uppercase tracking-[0.12em] text-white/40 hover:text-white hover:shadow-none"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRevoke(true)}
              className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40 transition-colors hover:text-[color:var(--pf-danger)] hover:shadow-none"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Revoke
            </button>
          )}
        </div>
      ) : null}
    </Surface>
  )
}

/**
 * The single reveal.
 *
 * Deliberately loud and deliberately dismissible only by the user — losing this means creating a
 * new key, because the server kept only a hash.
 */
function RevealedKey({
  apiKey,
  note,
  onDismiss,
}: {
  apiKey: ApiKey
  note: string
  onDismiss: () => void
}) {
  if (!apiKey.secret) return null

  return (
    <Surface
      strong
      className="border-[color:var(--pf-coral)]/50 bg-[color:var(--pf-coral)]/[0.08] p-6 shadow-[var(--pf-glow-sm)]"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--pf-coral)]" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm uppercase tracking-[0.12em] text-white">
            Copy your key now
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/70">{note}</p>

          <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/15 bg-black/30 px-4 py-3">
            <code className="pf-hash min-w-0 flex-1 break-all text-white/90">{apiKey.secret}</code>
            <CopyButton value={apiKey.secret} className="mt-0.5 h-5 w-5 text-white/60" />
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50 underline underline-offset-4 transition-colors hover:text-white hover:shadow-none"
          >
            I&apos;ve stored it — dismiss
          </button>
        </div>
      </div>
    </Surface>
  )
}

function NotConfigured() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integration"
        title="API keys"
        description="Per-account API keys need Google sign-in, which needs Firebase."
      />

      <UnavailableNotice
        title="Google sign-in unavailable"
        detail="Without Firebase, this deployment falls back to the PAYFLUX_API_KEYS environment variable — a single shared bootstrap key that cannot be rotated from the dashboard."
        action={
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/40">
              Set in .env.local (Next app)
            </p>
            <ul className="space-y-1">
              {MISSING_FIREBASE_VARS.map((variable) => (
                <li key={variable} className="pf-hash text-white/70">
                  {variable}
                </li>
              ))}
            </ul>
            <p className="mb-2 mt-4 text-[11px] uppercase tracking-[0.14em] text-white/40">
              Set in .env (API)
            </p>
            <ul className="space-y-1">
              {["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"].map((v) => (
                <li key={v} className="pf-hash text-white/70">
                  {v}
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </div>
  )
}
