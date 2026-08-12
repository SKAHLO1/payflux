"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/payflux/shell"
import {
  DataRow,
  GhostButton,
  HashLink,
  PrimaryButton,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { RequireAuth, useAuth } from "@/components/payflux/auth-provider"
import { Loading } from "@/components/payflux/dashboard-ui"
import { payfluxApi } from "@/lib/payflux/client"
import { accountApi, type AccountSettings } from "@/lib/payflux/api-keys-client"
import { MISSING_FIREBASE_VARS } from "@/lib/firebase/client"
import type { HealthReport } from "@/lib/payflux/types"

/**
 * Settings.
 *
 * Settlement addresses are per account: a developer's customers pay *their* XRPL address and
 * their FXRP lands in *their* wallet. There is deliberately no fallback to the deployment's own
 * addresses — inheriting them would quietly route a developer's payments to the operator.
 *
 * Network and contract addresses stay read-only. Those are environment-managed, and an editable
 * form would imply the browser can change how funds are routed on-chain.
 */
export default function SettingsPage() {
  return (
    <RequireAuth fallback={<ReadOnlySettings />}>
      <EditableSettings />
    </RequireAuth>
  )
}

function EditableSettings() {
  const { getToken } = useAuth()

  const [settings, setSettings] = useState<AccountSettings | undefined>()
  const [health, setHealth] = useState<HealthReport | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState<string[] | undefined>()

  const [form, setForm] = useState({
    xrplAddress: "",
    flareAddress: "",
    settlementAsset: "FXRP",
    webhookUrl: "",
    webhookSecret: "",
  })

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      if (!token) return
      const [result, healthReport] = await Promise.all([
        accountApi.settings(token),
        payfluxApi.health().catch(() => undefined),
      ])
      setSettings(result.data)
      setHealth(healthReport)
      setForm({
        xrplAddress: result.data.xrplAddress ?? "",
        flareAddress: result.data.flareAddress ?? "",
        settlementAsset: result.data.settlementAsset,
        webhookUrl: result.data.webhookUrl ?? "",
        webhookSecret: "",
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setSaving(true)
    setError(undefined)
    setSaved(undefined)
    try {
      const token = await getToken()
      if (!token) throw new Error("Your session expired. Sign in again.")

      const patch: Record<string, string> = {
        xrplAddress: form.xrplAddress.trim(),
        flareAddress: form.flareAddress.trim(),
        settlementAsset: form.settlementAsset,
        webhookUrl: form.webhookUrl.trim(),
      }
      // Only send the secret when something was typed — an empty field means "leave it alone",
      // not "clear it".
      if (form.webhookSecret.trim()) patch.webhookSecret = form.webhookSecret.trim()

      const result = await accountApi.updateSettings(token, patch)
      setSettings(result.data)
      setSaved(result.changed)
      setForm((current) => ({ ...current, webhookSecret: "" }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Loading label="Loading your settings…" />

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchant"
        title="Settings"
        description="Where your customers pay and where you get settled. These are yours — other accounts on this deployment have their own."
        actions={<GhostButton onClick={load}>Reload</GhostButton>}
      />

      {error ? (
        <Surface className="border-[color:var(--pf-danger)]/30 bg-[color:var(--pf-danger)]/[0.07] p-5">
          <p className="text-[13px] leading-relaxed text-white/85">{error}</p>
        </Surface>
      ) : null}

      {settings && !settings.readyToAcceptPayments ? (
        <Surface className="border-[color:var(--pf-pending)]/40 bg-[color:var(--pf-pending)]/[0.08] p-5">
          <p className="font-display text-sm uppercase tracking-[0.12em] text-white">
            Finish setup to accept payments
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-white/70">
            Your account has no settlement addresses yet, so every payment route reports itself
            unavailable. Add an XRPL Testnet address to receive XRP and a Coston2 address to
            receive FXRP. Both are yours alone — nothing is inherited from this deployment.
          </p>
          <p className="mt-3 text-[12px] text-white/45">
            Need testnet addresses? XRPL:{" "}
            <span className="pf-hash">faucet.altnet.rippletest.net/accounts</span> · Coston2:{" "}
            <span className="pf-hash">faucet.flare.network/coston2</span>
          </p>
        </Surface>
      ) : null}

      {saved ? (
        <Surface className="border-[color:var(--pf-success)]/30 bg-[color:var(--pf-success)]/[0.07] p-5">
          <p className="flex items-center gap-2 text-[13px] text-white/85">
            <Check className="h-4 w-4 text-[color:var(--pf-success)]" />
            {saved.length === 0
              ? "Nothing changed."
              : `Saved: ${saved.join(", ")}. Recorded in the audit log.`}
          </p>
        </Surface>
      ) : null}

      <Surface className="p-6">
        <SectionLabel>Settlement</SectionLabel>
        <p className="mt-2 text-[12px] leading-relaxed text-white/45">
          These are yours. PayFlux never falls back to another account&apos;s addresses — until
          both are set, the payment routes report themselves unavailable rather than sending your
          customers somewhere else.
        </p>

        <div className="mt-5 space-y-5">
          <Field
            label="XRPL destination address"
            hint="Where your customers send XRP. Verified against XRPL Testnet when you save — an unfunded address cannot receive payments."
            value={form.xrplAddress}
            onChange={(value) => setForm((f) => ({ ...f, xrplAddress: value }))}
            placeholder="rExampleXRPLTestnetAddress…"
            required={settings?.unset.includes("xrplAddress")}
            mono
          />

          <Field
            label="Coston2 settlement address"
            hint="Where your FXRP or C2FLR is delivered."
            value={form.flareAddress}
            onChange={(value) => setForm((f) => ({ ...f, flareAddress: value }))}
            placeholder="0x…"
            required={settings?.unset.includes("flareAddress")}
            mono
          />

          <label className="block">
            <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
              Settlement asset
            </span>
            <select
              value={form.settlementAsset}
              onChange={(event) =>
                setForm((f) => ({ ...f, settlementAsset: event.target.value }))
              }
              className="w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white outline-none transition-colors focus:border-[color:var(--pf-coral)]/60"
            >
              <option value="FXRP">FXRP — FAssets representation of XRP</option>
              <option value="C2FLR">C2FLR — native Coston2</option>
            </select>
            <span className="mt-1.5 block text-[11px] leading-relaxed text-white/40">
              Choosing FXRP means an XRP payment settles by FAssets minting. Choosing C2FLR means
              XRP payments are verified but have no settlement path, and the route reports that.
            </span>
          </label>
        </div>
      </Surface>

      <Surface className="p-6">
        <SectionLabel>Webhooks</SectionLabel>
        <div className="mt-5 space-y-5">
          <Field
            label="Endpoint URL"
            hint="Where PayFlux posts signed payment events."
            value={form.webhookUrl}
            onChange={(value) => setForm((f) => ({ ...f, webhookUrl: value }))}
            placeholder="https://example.com/webhooks/payflux"
          />

          <label className="block">
            <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
              Signing secret
            </span>
            <input
              type="password"
              value={form.webhookSecret}
              onChange={(event) =>
                setForm((f) => ({ ...f, webhookSecret: event.target.value }))
              }
              placeholder={
                settings?.webhookSecretConfigured
                  ? "Configured — type to replace"
                  : "whsec_… (at least 16 characters)"
              }
              className="w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[color:var(--pf-coral)]/60"
            />
            <span className="mt-1.5 block text-[11px] leading-relaxed text-white/40">
              Never displayed after saving. The audit log records that it changed, never its value.
            </span>
          </label>
        </div>
      </Surface>

      <div className="flex items-center gap-4">
        <PrimaryButton onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save settings
        </PrimaryButton>
        {settings && !settings.readyToAcceptPayments ? (
          <p className="text-[12px] text-[color:var(--pf-pending)]">
            Still needed before you can accept payments: {settings.unset.join(", ")}
          </p>
        ) : null}
      </div>

      {health ? <ReadOnlyInfrastructure health={health} /> : null}
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  required,
  mono,
}: {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
          {label}
        </span>
        {required ? (
          <span className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--pf-pending)]">
            Required — not set yet
          </span>
        ) : null}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[color:var(--pf-coral)]/60 ${
          mono ? "font-mono text-[13px]" : ""
        }`}
      />
      <span className="mt-1.5 block text-[11px] leading-relaxed text-white/40">{hint}</span>
    </label>
  )
}

function ReadOnlyInfrastructure({ health }: { health: HealthReport }) {
  return (
    <>
      <Surface className="p-6">
        <SectionLabel>Networks</SectionLabel>
        <div className="mt-3 divide-y divide-white/[0.07]">
          <DataRow label="Flare network">{health.networks.flare.name}</DataRow>
          <DataRow label="Chain ID">{health.networks.flare.chainId}</DataRow>
          <DataRow label="XRPL network">{health.networks.xrpl.name}</DataRow>
        </div>
      </Surface>

      <Surface className="p-6">
        <SectionLabel>Contracts</SectionLabel>
        <div className="mt-3 divide-y divide-white/[0.07]">
          <DataRow label="PaymentRegistry">
            <HashLink
              hash={health.paymentRegistry.address}
              href={health.paymentRegistry.explorer}
            />
          </DataRow>
          <DataRow label="FdcVerification">
            <HashLink hash={health.fdc.verificationAddress} />
          </DataRow>
          <DataRow label="AssetManagerFXRP">
            <HashLink hash={health.fassets.assetManager} />
          </DataRow>
          <DataRow label="FXRP">
            <HashLink hash={health.fassets.fxrp} />
          </DataRow>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-white/40">
          Environment-managed and read-only. The Coston2 signing key lives only in the API process
          — it is never written to Firestore, never sent to the browser and never rendered here.
          This dashboard cannot sign anything.
        </p>
      </Surface>
    </>
  )
}

/** Shown when Firebase is not configured: there is no account, so nothing is editable. */
function ReadOnlySettings() {
  const [health, setHealth] = useState<HealthReport | undefined>()

  useEffect(() => {
    payfluxApi.health().then(setHealth).catch(() => undefined)
  }, [])

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Merchant"
        title="Settings"
        description="Per-account settlement needs Google sign-in. Without it this deployment uses the environment defaults for everyone."
      />

      <UnavailableNotice
        title="Google sign-in unavailable"
        detail="Settlement addresses are stored per account, which requires an account. Configure Firebase to enable it."
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

      {health ? <ReadOnlyInfrastructure health={health} /> : null}
    </div>
  )
}
