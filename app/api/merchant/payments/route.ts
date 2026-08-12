import { proxy } from "../_client"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const limit = new URL(request.url).searchParams.get("limit") ?? "50"
  return proxy(`/v1/payments?limit=${encodeURIComponent(limit)}`)
}
