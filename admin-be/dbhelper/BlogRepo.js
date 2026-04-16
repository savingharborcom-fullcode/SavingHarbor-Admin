import { supabase } from "../dbhelper/dbclient.js";
import { throwSupabaseError } from "../utils/supabaseError.js";

// ===== List with optional title filter =====
export async function list({ title }) {
  const selectParameter =
    "id, title, slug, category_id, author_id, is_publish, is_featured, is_top, featured_thumb_url, created_at, category:category_id ( id, name, category_order, is_top )";
  // Select core blog fields + category join fields needed for the list view
  let query = supabase
    .from("blogs")
    .select(selectParameter)
    .order("created_at", { ascending: false });

  if (title) {
    query = query.ilike("title", `%${title}%`);
  }

  const { data, error } = await query;
  if (error) throw error;

  // Normalize shape to expose category info directly
  const rows = (data || []).map((r) => ({
    ...r,
    // For compatibility with your table headings:
    top_category_name: r.category?.name ?? null,
    category_name: r.category?.name ?? null,
    category_order: r.category?.category_order ?? null,
    // Also expose a structured category object
    category: r.category
      ? {
          id: r.category.id,
          name: r.category.name,
          category_order: r.category.category_order,
          is_top: r.category.is_top,
        }
      : null,
  }));

  return rows;
}

// ===== Get by ID =====
export async function getById(id) {
  const selectParameter =
    "id, title, slug, content, meta_title, meta_keywords, meta_description, is_publish, is_featured, is_top, featured_thumb_url, featured_image_url, category_id, author_id, created_at, updated_at, category:category_id ( id, name, category_order, is_top ), author:author_id ( id, name, email )";
  const { data, error } = await supabase
    .from("blogs")
    .select(selectParameter)
    .eq("id", id)
    .single();

  if (error) throw error;

  // Normalize to expose category/author as objects and also simple label fields
  const result = {
    ...data,
    category: data.category
      ? {
          id: data.category.id,
          name: data.category.name,
          category_order: data.category.category_order,
          is_top: data.category.is_top,
        }
      : null,
    author: data.author
      ? {
          id: data.author.id,
          name: data.author.name,
          email: data.author.email,
        }
      : null,
    // Convenience labels
    category_name: data.category?.name ?? null,
    author_name: data.author?.name ?? null,
  };

  return result;
}

// ===== Insert new blog =====
export async function insert(blog) {
  const { data, error } = await supabase
    .from("blogs")
    .insert([blog])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ===== Update existing blog =====
export async function update(id, patch) {
  // Remove undefined values so we don't overwrite unintentionally
  const cleanPatch = {};
  Object.keys(patch).forEach((k) => {
    if (patch[k] !== undefined) cleanPatch[k] = patch[k];
  });

  const { data, error } = await supabase
    .from("blogs")
    .update(cleanPatch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ===== Delete blog =====
export async function remove(id) {
  const { error } = await supabase.from("blogs").delete().eq("id", id);
  if (error) throw error;
  return true;
}

// ===== Ensure unique slug when creating =====
export async function ensureUniqueSlug(baseSlug) {
  if (!baseSlug) baseSlug = "post";
  let slug = baseSlug;
  let i = 1;

  while (true) {
    const { data, error } = await supabase
      .from("blogs")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return slug; // slug is unique
    slug = `${baseSlug}-${i}`;
    i++;
  }
}

// ===== Ensure unique slug when updating =====
export async function ensureUniqueSlugOnUpdate(id, proposedSlug) {
  if (!proposedSlug) return proposedSlug;

  // Allow same slug for the same record
  const { data: same, error: errSame } = await supabase
    .from("blogs")
    .select("id")
    .eq("id", id)
    .eq("slug", proposedSlug)
    .maybeSingle();

  if (errSame) throw errSame;
  if (same) return proposedSlug;

  // Otherwise, ensure uniqueness
  let slug = proposedSlug;
  let i = 1;
  while (true) {
    const { data, error } = await supabase
      .from("blogs")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return slug;
    slug = `${proposedSlug}-${i}`;
    i++;
  }
}

export async function countPublished() {
  const { count, error } = await supabase
    .from("blogs")
    .select("*", { count: "exact", head: true })
    .eq("is_publish", true);

  if (error) throwSupabaseError(error, "BlogRepo.countPublished");
  return count ?? 0;
}
