"use client"

import { useCallback, useEffect, useState } from "react"
import { KeyRound, LogIn, RefreshCw, Settings2, ShieldAlert, Trash2, UserPlus } from "lucide-react"
import { PageHeader } from "@/components/payflux/shell"
import {
  GhostButton,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { RequireAuth, useAuth } from "@/components/payflux/auth-provider"
import { Loading } from "@/components/payflux/dashboard-ui"
import { accountApi, type AuditEvent } from "@/lib/payflux/api-keys-client"
import { MISSING_FIREBASE_VARS } from "@/lib/firebase/client"
import { timeAgo } from "@/lib/payflux/format"
import { cn } from "@/lib/utils"

/**
 * The account audit trail.
 *
 * Separate from a payment's timeline: that explains a payment, this explains the account. It is
 * append-only — nothing in the product updates or deletes an entry.
 */
export default function AuditPage() {
  return (
    <RequireAuth fallback={<NotConfigured />}>
      <AuditLog />
    </RequireAuth>
  )
}

const EVENT_META: Record<
  string,
  { label: string; icon: typeof KeyRound; tone: "neutral" | "good" | "warn" | "bad" }
> = {
  "account.created": { label: "Account created", icon: UserPlus, tone: "good" },
  "account.signed_in": { label: "Signed in", icon: LogIn, tone: "neutral" },
  "api_key.created": { label: "API key created", icon: KeyRound, tone: "good" },
  "api_key.rotated": { label: "API key rotated", icon: RefreshCw, tone: "warn" },
  "api_key.revoked": { label: "API key revoked", icon: Trash2, tone: "bad" },
  "api_key.scope_denied": { label: "Request denied — missing scope", icon: ShieldAlert, tone: "bad" },
  "settings.updated": { label: "Settings updated", icon: Settings2, tone: "warn" },
}

const TONE_CLASSES = {
  neutral: "text-white/50 bg-white/[0.06] border-white/15",
  good: "text-[color:var(--pf-success)] bg-[color:var(--pf-success)]/10 border-[color:var(--pf-success)]/35",
  warn: "text-[color:var(--pf-pending)] bg-[color:var(--pf-pending)]/10 border-[color:var(--pf-pending)]/35",
  bad: "text-[color:var(--pf-danger)] bg-[color:var(--pf-danger)]/10 border-[color:var(--pf-danger)]/35",
}

function AuditLog() {
  const { getToken } = useAuth()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const token = await getToken()
      if (!token) return
      const result = await accountApi.audit(token, 150)
      setEvents(result.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Security"
        title="Audit log"
        description="Who changed what on this account, and from where. Append-only — entries are never edited or deleted."
        actions={<GhostButton onClick={load}>Refresh</GhostButton>}
      />

      {error ? (
        <UnavailableNotice title="Audit log unavailable" detail={error} />
      ) : loading ? (
        <Loading label="Loading audit trail…" />
      ) : events.length === 0 ? (
        <Surface className="p-10 text-center">
          <p className="text-sm text-white/45">
            Nothing recorded yet. Creating a key or changing a setting will appear here.
          </p>
        </Surface>
      ) : (
        <Surface className="overflow-hidden">
          <ol className="divide-y divide-white/[0.06]">
            {events.map((event) => {
              const meta = EVENT_META[event.type] ?? {
                label: event.type,
                icon: Settings2,
                tone: "neutral" as const,
              }
              const Icon = meta.icon

              return (
                <li key={event.id} className="flex gap-4 px-6 py-5">
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                      TONE_CLASSES[meta.tone],
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="text-sm font-medium text-white/90">{meta.label}</p>
                      <time
                        className="text-[11px] tabular-nums text-white/35"
                        dateTime={event.createdAt}
                        title={new Date(event.createdAt).toISOString()}
                      >
                        {timeAgo(event.createdAt)}
                      </time>
                    </div>

                    <p className="mt-0.5 text-[11px] text-white/40">
                      {event.actor.kind === "user"
                        ? (event.actor.email ?? "signed-in user")
                        : event.actor.kind === "api_key"
                          ? `API key ${event.actor.id}`
                          : "system"}
                      {event.ip ? ` · ${event.ip}` : ""}
                    </p>

                    <EventDetail event={event} />
                  </div>
                </li>
              )
            })}
          </ol>
        </Surface>
      )}

      <Surface className="p-6">
        <SectionLabel>What is recorded</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-white/55">
          Sign-ins, key creation, rotation, revocation, denied scopes and settlement setting
          changes. Each entry carries the actor, the request id and the client IP, so an entry
          here can be traced to a line in the API logs.
        </p>
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-white/40">
          Secrets are never recorded. A webhook secret change is logged as the field having
          changed, never as a value — and the same is true of API key secrets, which the server
          does not hold in the first place.
        </p>
      </Surface>
    </div>
  )
}

function EventDetail({ event }: { event: AuditEvent }) {
  const rows: Array<[string, string]> = []
  const meta = event.metadata ?? {}

  if (event.target) rows.push([event.target.kind, event.target.id])
  if (meta.name) rows.push(["name", String(meta.name)])
  if (Array.isArray(meta.scopes)) rows.push(["scopes", meta.scopes.join(", ")])
  if (Array.isArray(meta.changed)) rows.push(["changed", meta.changed.join(", ")])
  if (meta.requiredScope) rows.push(["required", String(meta.requiredScope)])
  if (Array.isArray(meta.heldScopes)) rows.push(["held", meta.heldScopes.join(", ") || "none"])
  if (meta.path) rows.push(["endpoint", `${meta.method ?? ""} ${meta.path}`.trim()])
  if (meta.successorId) rows.push(["successor", String(meta.successorId)])
  if (meta.graceHours !== undefined) rows.push(["grace", `${meta.graceHours}h`])
  if (meta.xrplAddress) rows.push(["xrplAddress", String(meta.xrplAddress)])
  if (meta.flareAddress) rows.push(["flareAddress", String(meta.flareAddress)])
  if (meta.settlementAsset) rows.push(["settlementAsset", String(meta.settlementAsset)])

  if (rows.length === 0) return null

  return (
    <dl className="mt-2.5 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="shrink-0 uppercase tracking-[0.1em] text-white/30">{label}</dt>
          <dd className="min-w-0 break-words text-white/60">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function NotConfigured() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Security"
        title="Audit log"
        description="The audit trail is per account, which needs Google sign-in."
      />
      <UnavailableNotice
        title="Google sign-in unavailable"
        detail="Without accounts there is nobody to attribute an action to, so no audit trail is kept."
        action={
          <ul className="space-y-1">
            {MISSING_FIREBASE_VARS.map((variable) => (
              <li key={variable} className="pf-hash text-white/70">
                {variable}
              </li>
            ))}
          </ul>
        }
      />
    </div>
  )
}
