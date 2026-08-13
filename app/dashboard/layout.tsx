"use client"

import type React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Loader2, LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import { Shell, BrandMark, NetworkPill } from "@/components/payflux/shell"
import { AuthProvider, useAuth } from "@/components/payflux/auth-provider"

/**
 * Dashboard chrome.
 *
 * The 3D ambient layer is deliberately off here: it is the right first impression on the landing
 * page and the wrong background for a table of transaction hashes. The violet ground and the
 * coral accent keep the identity intact.
 *
 * Sign-in gating is soft by design. When Firebase is not configured the dashboard still works
 * against the environment bootstrap key, so a fresh clone is not a blank wall — only the
 * key-management page, which genuinely needs an account, requires signing in.
 */

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/payments", label: "Payments" },
  { href: "/dashboard/routes", label: "Routes" },
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/assets", label: "Assets" },
  { href: "/dashboard/webhooks", label: "Webhooks" },
  { href: "/dashboard/api-keys", label: "API keys" },
  { href: "/dashboard/playground", label: "Playground" },
  { href: "/dashboard/audit", label: "Audit log" },
  { href: "/dashboard/diagnostics", label: "Diagnostics" },
  { href: "/dashboard/settings", label: "Settings" },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardChrome>{children}</DashboardChrome>
    </AuthProvider>
  )
}

function DashboardChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <Shell ambient={false} deep>
      <div className="flex w-full flex-col lg:flex-row">
        <aside className="shrink-0 border-b border-white/10 px-6 py-6 lg:h-screen lg:w-60 lg:border-b-0 lg:border-r lg:py-8 lg:sticky lg:top-0">
          <BrandMark subtitle="Dashboard" />

          <nav className="mt-8">
            <ul className="flex flex-wrap gap-1 lg:flex-col">
              {NAV.map((item) => {
                const active =
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(item.href)

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "block rounded-lg px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] transition-all duration-200",
                        active
                          ? "bg-white/10 text-white shadow-[inset_2px_0_0_0_var(--pf-coral)]"
                          : "text-white/45 hover:bg-white/[0.05] hover:text-white/80",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>

          <div className="mt-8 space-y-4">
            <AccountBadge />
            <div className="hidden lg:block">
              <NetworkPill />
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-6 py-8 md:px-10 lg:px-12 lg:py-10">{children}</main>
      </div>
    </Shell>
  )
}

function AccountBadge() {
  const { user, loading, configured, signOutUser } = useAuth()

  if (!configured) {
    return (
      <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-white/40">
        Google sign-in not configured. Using the environment bootstrap key.
      </p>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-white/35">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking session…
      </div>
    )
  }

  if (!user) {
    return (
      <Link
        href="/sign-in?next=/dashboard/api-keys"
        className="block rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70 transition-colors hover:border-[color:var(--pf-coral)]/50 hover:text-white"
      >
        Sign in
      </Link>
    )
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5">
      <p className="truncate text-[12px] font-medium text-white/85" title={user.email ?? undefined}>
        {user.displayName ?? user.email}
      </p>
      {user.displayName && user.email ? (
        <p className="mt-0.5 truncate text-[10px] text-white/35">{user.email}</p>
      ) : null}
      <button
        type="button"
        onClick={signOutUser}
        className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40 transition-colors hover:text-[color:var(--pf-coral)] hover:shadow-none"
      >
        <LogOut className="h-3 w-3" />
        Sign out
      </button>
    </div>
  )
}
