// Create a helper, e.g. utils/supabaseError.js
export function throwSupabaseError(error, context = "") {
  const msg = error.message || error.details || error.hint || "Unknown Supabase error";
  const err = new Error(`[${context}] ${msg}`);
  err.code = error.code;
  err.details = error.details;
  err.hint = error.hint;
  throw err;
}