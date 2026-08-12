import type React from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono, Audiowide } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

// Audiowide carries the brand in headings and figures — the original design's display face.
const aurora = Audiowide({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-aurora",
})

export const metadata: Metadata = {
  title: "PayFlux — Payment infrastructure for interoperable assets",
  description:
    "One payment API for assets across chains. Customers pay with XRP on XRPL; Flare's Data Connector verifies it; merchants settle into FXRP on Coston2.",
  applicationName: "PayFlux",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        {/* The ambient scene is a cross-origin iframe. Warming DNS and TLS during parse shaves a
            round trip off when it starts fetching. */}
        <link rel="preconnect" href="https://my.spline.design" />
        <link rel="dns-prefetch" href="https://my.spline.design" />
      </head>
      <body
        className={`${geist.variable} ${geistMono.variable} ${aurora.variable} font-sans antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  )
}
