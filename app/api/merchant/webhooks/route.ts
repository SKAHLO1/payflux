import { proxy } from "../_client"

export const dynamic = "force-dynamic"

export async function GET() {
  return proxy("/v1/webhooks")
}
