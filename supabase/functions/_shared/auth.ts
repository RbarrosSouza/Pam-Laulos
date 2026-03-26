export function validateApiKey(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;

  const token = authHeader.replace("Bearer ", "");
  const expectedKey = Deno.env.get("WEBHOOK_API_KEY");

  if (!expectedKey) {
    console.error("WEBHOOK_API_KEY not configured in Supabase secrets");
    return false;
  }

  return token === expectedKey;
}
