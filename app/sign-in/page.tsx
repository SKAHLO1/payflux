"use client"

import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Shell, BrandMark, NetworkPill } from "@/components/payflux/shell"
import {
  CheckItem,
  Figure,
  SectionLabel,
  Surface,
  UnavailableNotice,
} from "@/components/payflux/primitives"
import { AuthProvider, useAuth } from "@/components/payflux/auth-provider"
import { MISSING_FIREBASE_VARS } from "@/lib/firebase/client"

export default function SignInPage() {
  return (
    <AuthProvider>
      {/* `useSearchParams` reads the `next=` redirect target, which forces a client bail-out. */}
      <Suspense fallback={null}>
        <SignIn />
      </Suspense>
    </AuthProvider>
  )
}

function SignIn() {
  const { user, loading, configured, error, signIn } = useAuth()
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get("next") ?? "/dashboard"

  useEffect(() => {
    if (user) router.replace(next)
  }, [user, next, router])

  return (
    <Shell ambient={false} deep>
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <BrandMark subtitle="Developers" />
        <NetworkPill />
      </header>

      <main className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 md:px-10 lg:grid-cols-[1fr_0.9fr] lg:py-20">
        <div>
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.28em] text-[color:var(--pf-coral)] pf-text-glow">
            Developer access
          </p>
          <h1 className="font-display text-3xl leading-tight tracking-[0.03em] text-white md:text-4xl">
            SIGN IN TO GET
            <br />
            YOUR API KEYS
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-white/65">
            One Google account gives you a PayFlux account, your own API keys, and a dashboard
            scoped to your payments. Signing in for the first time creates the account — there is
            no separate sign-up, and no password for anyone to leak.
          </p>

          <ul className="mt-8 space-y-2.5">
            <CheckItem>Create up to five keys and name them per environment</CheckItem>
            <CheckItem>Rotate with a grace window, so deploys never break</CheckItem>
            <CheckItem>Revoke instantly if a key leaks</CheckItem>
            <CheckItem>Keys are stored hashed — PayFlux cannot show you an existing secret</CheckItem>
          </ul>
        </div>

        <Surface strong className="self-start p-7 md:p-8">
          {!configured ? (
            <UnavailableNotice
              title="Google sign-in unavailable"
              detail="This deployment has no Firebase web configuration, so sign-in cannot run."
              action={
                <div>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/40">
                    Set in .env.local
                  </p>
                  <ul className="space-y-1">
                    {MISSING_FIREBASE_VARS.map((name) => (
                      <li key={name} className="pf-hash text-white/70">
                        {name}
                      </li>
                    ))}
                  </ul>
                </div>
              }
            />
          ) : loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Checking your session…</span>
            </div>
          ) : user ? (
            <div className="py-16 text-center">
              <Figure className="text-lg text-white">Signed in</Figure>
              <p className="mt-2 text-sm text-white/50">Redirecting to your dashboard…</p>
            </div>
          ) : (
            <>
              <SectionLabel>Continue with</SectionLabel>

              <button
                type="button"
                onClick={signIn}
                className="mt-5 flex w-full items-center justify-center gap-3 rounded-full bg-white px-7 py-3.5 text-sm font-bold uppercase tracking-[0.12em] text-[color:var(--pf-violet-700)] transition-all duration-300 hover:bg-white/90 hover:shadow-[var(--pf-glow)]"
              >
                <GoogleMark />
                Sign in with Google
              </button>

              {error ? (
                <p className="mt-5 rounded-xl border border-[color:var(--pf-danger)]/40 bg-[color:var(--pf-danger)]/10 px-4 py-3 text-[13px] leading-relaxed text-white/85">
                  {error}
                </p>
              ) : null}

              <p className="mt-6 text-[12px] leading-relaxed text-white/40">
                PayFlux receives your Google email, name and avatar. It never sees your password,
                and it stores no other profile data. This is a testnet deployment — do not use it
                for anything that matters.
              </p>
            </>
          )}
        </Surface>
      </main>
    </Shell>
  )
}

/** Google's mark, inlined — a strict CSP blocks remote images and this must render offline. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}
