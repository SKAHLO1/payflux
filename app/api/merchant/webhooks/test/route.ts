import { proxy } from "../../_client"

export const dynamic = "force-dynamic"

export async function POST() {
  return proxy("/v1/webhooks/test", { method: "POST" })
}
