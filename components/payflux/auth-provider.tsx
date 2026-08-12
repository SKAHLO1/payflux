"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  getFirebaseAuth,
  isFirebaseConfigured,
  onAuthStateChanged,
  signInWithGoogle,
  signOut,
  type User,
} from "@/lib/firebase/client"

/**
 * Auth state for the dashboard.
 *
 * The ID token is never stored — not in localStorage, not in a cookie this app controls. It is
 * fetched from the Firebase SDK immediately before each authenticated request, so it is always
 * fresh and there is no long-lived credential sitting in the browser for a script to steal.
 */

interface AuthState {
  user: User | null
  loading: boolean
  configured: boolean
  error?: string
  signIn: () => Promise<void>
  signOutUser: () => Promise<void>
  /** Returns a current ID token, refreshing if the cached one is near expiry. */
  getToken: () => Promise<string | undefined>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const configured = isFirebaseConfigured()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(configured)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!configured) return
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (next) => {
      setUser(next)
      setLoading(false)
    })
    return unsubscribe
  }, [configured])

  const signIn = useCallback(async () => {
    setError(undefined)
    try {
      await signInWithGoogle()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Closing the popup is a normal thing to do, not an error worth shouting about.
      if (message.includes("popup-closed-by-user") || message.includes("cancelled-popup-request")) {
        return
      }
      setError(
        message.includes("unauthorized-domain")
          ? "This domain is not authorised in the Firebase console. Add it under Authentication → Settings → Authorized domains."
          : message,
      )
    }
  }, [])

  const signOutUser = useCallback(async () => {
    await signOut()
    setUser(null)
  }, [])

  const getToken = useCallback(async () => {
    if (!configured) return undefined
    const current = getFirebaseAuth().currentUser
    if (!current) return undefined
    return current.getIdToken()
  }, [configured])

  const value = useMemo<AuthState>(
    () => ({ user, loading, configured, error, signIn, signOutUser, getToken }),
    [user, loading, configured, error, signIn, signOutUser, getToken],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>")
  return context
}

/**
 * Gate for pages that genuinely need an account.
 *
 * Renders `fallback` when Firebase is not configured, so an unconfigured deployment explains
 * itself rather than redirecting into a sign-in page that cannot work.
 */
export function RequireAuth({
  children,
  fallback,
}: {
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const { user, loading, configured } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (configured && !loading && !user) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`)
    }
  }, [configured, loading, user, pathname, router])

  if (!configured) return <>{fallback ?? null}</>
  if (loading || !user) return null
  return <>{children}</>
}
