import { supabase } from "../dbhelper/dbclient.js";
import { throwSupabaseError } from "../utils/supabaseError.js";

// Normalize slug
const toSlug = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Ensure unique slug on create
export async function ensureUniqueSlug(base) {
  const seed = toSlug(base || "merchant");
  let slug = seed;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase
      .from("merchants")
      .select("id")
      .eq("slug", slug)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return slug;
    slug = `${seed}-${i + 1}`;
  }
  return `${seed}-${Date.now()}`;
}

// Ensure unique slug on update (exclude current id)
export async function ensureUniqueSlugOnUpdate(id, proposed) {
  const seed = toSlug(proposed || "merchant");
  let slug = seed;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase
      .from("merchants")
      .select("id")
      .eq("slug", slug)
      .neq("id", id)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return slug;
    slug = `${seed}-${i + 1}`;
  }
  return `${seed}-${Date.now()}`;
}

// List with filters + pagination
export async function list({ name = "", page = 1, limit = 20 } = {}) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const selectCols = `
    id,
    name,
    slug,
	  web_url,
    aff_url,
    tracker_lock,
	  h1keyword,
    meta_title,
    meta_keywords,
    meta_description,
	  side_description_html,
    description_html,
	  sidebar,
    home,
    ads_block_all,
    ads_block_banners,
    is_header,
    deals_home,
    tag_home,
    amazon_store,
    active,
    show_at_search_bar,
    extension_active,
    extension_mandatory,
    is_header_2,
    coupon_icon_visibility,
    store_status_visibility,
    logo_url,
    category_names,
    subcategories,
    category_id,
    subcategory_id,
    coupon_h2_blocks,
    coupon_h3_blocks,
    faqs,
    suggestions,
    views,
    created_at,
    updated_at
  `;

  let countQuery = supabase
    .from("merchants")
    .select("id", { count: "exact", head: true });
  if (name) countQuery = countQuery.ilike("name", `%${name}%`);
  const { count, error: countErr } = await countQuery;
  if (countErr) throw countErr;

  let query = supabase
    .from("merchants")
    .select(selectCols)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (name) query = query.ilike("name", `%${name}%`);

  const { data, error } = await query;
  if (error) throw error;

  return { rows: data || [], total: count || 0 };
}

export async function getById(id) {
  const selectCols = `
    id,
    name,
    slug,
	  web_url,
    aff_url,
    tracker_lock,
	  h1keyword,
    meta_title,
    meta_keywords,
    meta_description,
	  side_description_html,
    description_html,
	  sidebar,
    home,
    ads_block_all,
    ads_block_banners,
    is_header,
    deals_home,
    tag_home,
    amazon_store,
    active,
    show_at_search_bar,
    extension_active,
    extension_mandatory,
    is_header_2,
    coupon_icon_visibility,
    store_status_visibility,
    logo_url,
    category_names,
    subcategories,
    category_id,
    subcategory_id,
    coupon_h2_blocks,
    coupon_h3_blocks,
    faqs,
    suggestions,
    views,
    created_at,
    updated_at
  `;
  const { data, error } = await supabase
    .from("merchants")
    .select(selectCols)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

// Insert
export async function insert(payload) {
  const toInsert = { ...payload };
  const { data, error } = await supabase
    .from("merchants")
    .insert(toInsert)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Update (drops undefined keys)
export async function update(id, patch) {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );

  if (Object.keys(clean).length === 0) {
    return await getById(id);
  }
  const { data, error } = await supabase
    .from("merchants")
    .update(clean)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Toggle status (active/inactive)
export async function toggleStatus(id) {
  const { data: cur, error: ge } = await supabase
    .from("merchants")
    .select("is_publish")
    .eq("id", id)
    .single();
  if (ge) throw ge;
  const next = !cur?.is_publish;
  const { data, error } = await supabase
    .from("merchants")
    .update({ is_publish: next })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Remove row
export async function remove(id) {
  const { error } = await supabase.from("merchants").delete().eq("id", id);
  if (error) throw error;
  return true;
}

export async function count() {
  const { count, error } = await supabase
    .from("merchants")
    .select("id", { count: "exact", head: true });

  if (error) throwSupabaseError(error, "MerchantRepo.count");
  return count ?? 0;
}
