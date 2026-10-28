import crypto from "crypto";
import type { Request, Response } from "express";

// Verify each Relay event before trusting it. During key rotation, both keys are valid.
export function relayWebhook(keys: string[]) {
  return (req: Request, res: Response) => {
    const sig = String(req.headers["x-signature-sha256"] || "");
    const ts = String(req.headers["x-signature-timestamp"] || "");
    const ok = keys.some(k => crypto.createHmac("sha256", k).update(`${ts}.${(req as any).rawBody}`).digest("hex") === sig);
    if (!ok) return res.status(401).end();
    if (req.body.event === "request.status.updated") updateOrder(req.body.data);
    res.status(200).end();
  };
}
declare function updateOrder(data: unknown): void;
// app.post("/webhooks/relay", relayWebhook([process.env.RELAY_API_KEY!]))
export const WEBHOOK_PATH = "/webhooks/relay";
