// Pure configuration selector. The caller supplies the environment reader.
// Selecting a key does not authenticate it, create/revoke it, or change JWT keys.
export type ExamSupabaseEnvReader = (name: string) => string | undefined;
export type ExamSupabaseKeyErrorCode =
  | "EXAM_SUPABASE_ENV_READER_INVALID"
  | "EXAM_SUPABASE_ENV_READ_FAILED"
  | "EXAM_SUPABASE_SECRET_KEY_NAME_INVALID"
  | "EXAM_SUPABASE_SECRET_KEYS_INVALID"
  | "EXAM_SUPABASE_SECRET_KEY_NOT_FOUND"
  | "EXAM_SUPABASE_SECRET_KEY_INVALID"
  | "EXAM_SUPABASE_LEGACY_KEY_MISSING";

export class ExamSupabaseKeySelectionError extends Error {
  readonly status = 503;
  constructor(readonly code: ExamSupabaseKeyErrorCode) {
    super(code);
    this.name = "ExamSupabaseKeySelectionError";
  }
}
function fail(code: ExamSupabaseKeyErrorCode): never {
  throw new ExamSupabaseKeySelectionError(code);
}

export function selectExamSupabasePrivilegedKey(getEnv: ExamSupabaseEnvReader): string {
  if (typeof getEnv !== "function") fail("EXAM_SUPABASE_ENV_READER_INVALID");
  const read = (name: string): string | undefined => {
    try { return getEnv(name); }
    catch { fail("EXAM_SUPABASE_ENV_READ_FAILED"); }
  };
  const requestedName = read("EXAM_SUPABASE_SECRET_KEY_NAME");
  // Undefined alone means no opt-in. Empty/malformed explicit values are errors,
  // never reasons to fall back to the shared legacy key.
  if (requestedName === undefined) {
    const legacy = read("SUPABASE_SERVICE_ROLE_KEY");
    if (typeof legacy !== "string" || legacy.length === 0) fail("EXAM_SUPABASE_LEGACY_KEY_MISSING");
    return legacy; // Preserve the legacy format; do not infer/decode its privileges.
  }
  if (typeof requestedName !== "string" || requestedName.length === 0 || requestedName.length > 256
    || requestedName.trim() !== requestedName || /[\x00-\x1f\x7f]/.test(requestedName)) {
    fail("EXAM_SUPABASE_SECRET_KEY_NAME_INVALID");
  }
  const serialized = read("SUPABASE_SECRET_KEYS");
  if (typeof serialized !== "string" || serialized.length === 0) fail("EXAM_SUPABASE_SECRET_KEYS_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { fail("EXAM_SUPABASE_SECRET_KEYS_INVALID"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("EXAM_SUPABASE_SECRET_KEYS_INVALID");
  if (!Object.hasOwn(parsed, requestedName)) fail("EXAM_SUPABASE_SECRET_KEY_NOT_FOUND");
  const selected = (parsed as Record<string, unknown>)[requestedName];
  if (typeof selected !== "string" || !/^sb_secret_[A-Za-z0-9_-]+$/.test(selected)) {
    fail("EXAM_SUPABASE_SECRET_KEY_INVALID");
  }
  return selected;
}
