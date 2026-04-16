// src/dbhelper/CouponsRepo.js
import { supabase } from "./dbclient.js";
import { deleteFilesByUrls } from "../services/deleteFilesByUrl.js";

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function list({
  search = "",
  store_id,
  type = "",
  status = "",
  from_date = "",
  to_date = "",
  page = 1,
  limit = 20,
} = {}) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  // Base select with merchant join fields useful for UI
  const selectCols =
    "id, merchant_id, coupon_type, coupon_code, title, description, is_editor, is_publish, created_at";

  let query = supabase
    .from("coupons")
    .select(selectCols)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (store_id) query = query.eq("merchant_id", store_id);
  if (type) query = query.eq("coupon_type", type);
  if (status) query = query.eq("is_publish", status === "published");
  if (from_date) query = query.gte("created_at", from_date);
  if (to_date) query = query.lte("created_at", to_date);
  // Optional filter hooks (category_id, filter) require schema support; omit if not in table

  if (search) {
    // Simple title search
    query = query.ilike("title", `%${search}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  // Count
  let countQuery = supabase
    .from("coupons")
    .select("id", { count: "exact", head: true });
  if (store_id) countQuery = countQuery.eq("merchant_id", store_id);
  if (type) countQuery = countQuery.eq("coupon_type", type);
  if (status) countQuery = countQuery.eq("is_publish", status === "published");
  if (from_date) countQuery = countQuery.gte("created_at", from_date);
  if (to_date) countQuery = countQuery.lte("created_at", to_date);
  if (search) countQuery = countQuery.ilike("title", `%${search}%`);

  const { count, error: cErr } = await countQuery;
  if (cErr) throw cErr;

  // Optionally fetch merchant names (separate query to keep select lean)
  let rows = data || [];
  if (rows.length) {
    const merchantIds = [
      ...new Set(rows.map((r) => r.merchant_id).filter(Boolean)),
    ];
    if (merchantIds.length) {
      const { data: stores, error: mErr } = await supabase
        .from("merchants")
        .select("id, name, slug")
        .in("id", merchantIds);
      if (mErr) throw mErr;
      const mMap = Object.fromEntries((stores || []).map((s) => [s.id, s]));
      rows = rows.map((r) => ({
        ...r,
        store_name: mMap[r.merchant_id]?.name,
        store_slug: mMap[r.merchant_id]?.slug,
      }));
    }
  }

  return { rows, total: count || 0 };
}

export async function getById(id) {
  const { data, error } = await supabase
    .from("coupons")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function insert(payload) {
  const { data, error } = await supabase
    .from("coupons")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function update(id, patch) {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  );
  if (!Object.keys(clean).length) {
    return await getById(id);
  }
  const { data, error } = await supabase
    .from("coupons")
    .update(clean)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function togglePublish(id) {
  const { data: cur, error: ge } = await supabase
    .from("coupons")
    .select("is_publish")
    .eq("id", id)
    .single();
  if (ge) throw ge;
  const next = !cur?.is_publish;
  const { data, error } = await supabase
    .from("coupons")
    .update({ is_publish: next })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function toggleEditorPick(id) {
  const { data: cur, error: ge } = await supabase
    .from("coupons")
    .select("is_editor")
    .eq("id", id)
    .single();
  if (ge) throw ge;
  const next = !cur?.is_editor;
  const { data, error } = await supabase
    .from("coupons")
    .update({ is_editor: next })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function remove(id) {
  const { error } = await supabase.from("coupons").delete().eq("id", id);
  if (error) throw error;
  return true;
}

export async function countTopCoupons() {
  const { count, error } = await supabase
    .from("coupons")
    .select("*", { count: "exact", head: true })
    .eq("is_publish", true);

  if (error) throwSupabaseError(error, "CouponsRepo.countTopCoupons");
  return count ?? 0;
}

// === Merchant Proofs ===

// Fetch Proofs for a merchant with pagination
export async function fetchMerchantProofs(merchantId, page = 1, limit = 10) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data: rows, error } = await supabase
    .from("merchant_proofs")
    .select("*", { count: "exact" })
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const { count, error: cErr } = await supabase
    .from("merchant_proofs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId);

  if (cErr) throw cErr;

  return { rows: rows || [], total: count || 0 };
}

// Delete a proof by ID
export async function deleteProof(proofId, BUCKET) {
  const { data: proof, error: fetchError } = await supabase
    .from("merchant_proofs")
    .select("id, image_url")
    .eq("id", proofId)
    .single();
  if (fetchError) throw fetchError;

  // 2. Delete from storage
  let urls = [];
  urls.push(proof.image_url);

  try {
    if (urls.length) await deleteFilesByUrls(BUCKET, urls);
  } catch (fileErr) {
    console.error(
      "Merchant Proof deletion failed:",
      fileErr?.message || fileErr
    );
  }
  const { error } = await supabase
    .from("merchant_proofs")
    .delete()
    .eq("id", proofId);

  if (error) throw error;
  return true;
}

// Upload new proofs for a merchant
export async function uploadProofs(merchantId, files) {
  // files: array of { url, filename } or { buffer, originalname, mimetype }
  const inserts = files.map((f) => ({
    merchant_id: merchantId,
    image_url: f.url,
    filename: f.filename || f.originalname,
  }));

  const { data, error } = await supabase
    .from("merchant_proofs")
    .insert(inserts)
    .select();

  if (error) throw error;
  return data;
}
