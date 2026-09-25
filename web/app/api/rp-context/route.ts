import { rpContext } from "@/lib/world";

// POST, not GET: each RP signature is a single-use challenge with its own nonce. A GET handler
// that reads nothing from the request can be cached, which would hand every user the same nonce.
export function POST() {
  try {
    return Response.json(rpContext(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("rp-context:", err);
    return Response.json({ code: "server_error", message: "Could not sign the request" }, { status: 500 });
  }
}
