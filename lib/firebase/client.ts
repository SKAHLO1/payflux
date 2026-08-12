"use client"

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app"
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth"

/**
 * Firebase client, used for Google sign-in only.
 *
 * The `NEXT_PUBLIC_FIREBASE_*` values are public by design — they identify the project, they are
 * not secrets, and Firebase expects them in client bundles. What actually protects the account is
 * that the API verifies the resulting ID token server-side against Google's signing keys.
 *
 * When these are absent the app does not crash: `isFirebaseConfigured()` is false and the
 * sign-in page renders UNAVAILABLE with the variables to set.
 */

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

export function isFirebaseConfigured(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)
}

export const MISSING_FIREBASE_VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
]

let app: FirebaseApp | undefined

function getFirebaseApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error(
      `Firebase is not configured. Set ${MISSING_FIREBASE_VARS.join(", ")} in .env.local.`,
    )
  }
  if (!app) {
    app = getApps().length ? getApp() : initializeApp(config)
  }
  return app
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp())
}

export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider()
  // Always show the chooser: developers commonly have several Google accounts and silently
  // reusing the last one is how you end up with keys on the wrong account.
  provider.setCustomParameters({ prompt: "select_account" })

  const result = await signInWithPopup(getFirebaseAuth(), provider)
  return result.user
}

export async function signOut(): Promise<void> {
  if (!isFirebaseConfigured()) return
  await firebaseSignOut(getFirebaseAuth())
}

export { onAuthStateChanged }
export type { User }
