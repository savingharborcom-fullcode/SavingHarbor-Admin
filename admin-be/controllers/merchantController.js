import * as merchantRepo from "../dbhelper/MerchantRepo.js";
import { uploadImageBuffer } from "../services/storageService.js";
import { deleteFilesByUrls } from "../services/deleteFilesByUrl.js";

const BUCKET = process.env.UPLOAD_BUCKET || "merchant-images";
const FOLDER = "merchants";

// Helpers
const toBool = (v) => v === true || v === "true" || v === "1";
const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const parseJSON = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

export async function listMerchants(req, res) {
  try {
    const name = req.query?.name || "";
    const page = Math.max(1, toInt(req.query?.page || 1, 1));
    const limit = Math.min(150, Math.max(1, toInt(req.query?.limit || 20, 20)));

    const { rows, total } = await merchantRepo.list({ name, page, limit });
    return res.json({ data: { rows, total }, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error listing merchants",
        details: err?.message || err,
      },
    });
  }
}

export async function getMerchant(req, res) {
  try {
    const { id } = req.params;
    const data = await merchantRepo.getById(id);
    return res.json({ data, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error fetching merchant",
        details: err?.message || err,
      },
    });
  }
}

export async function createMerchant(req, res) {
  try {
    const b = req.body || {};
    const f = req.files || {};

    const toInsert = {
      // identifiers
      name: b.name,
      slug: await merchantRepo.ensureUniqueSlug(b.slug || b.name || ""),

      // site + tracking
      web_url: b.web_url || b.website || "",
      aff_url: b.aff_url || "",
      tracker_lock: toBool(b.tracker_lock),

      // headings / SEO
      h1keyword: b.h1keyword || "",
      meta_title: b.seo_title || b.meta_title || "",
      meta_keywords: b.seo_keywords || b.meta_keywords || "",
      meta_description: b.seo_description || b.meta_description || "",

      // content blocks
      side_description_html: b.side_description_html || "",
      description_html: b.description_html || b.description || "",
      // table_content_html: b.table_content_html || "",
      // ads_description_html: b.ads_description_html || "",
      // ads_description_label: b.ads_description_label || "",

      // flags
      sidebar: toBool(b.sidebar),
      home: toBool(b.home),
      ads_block_all: toBool(b.ads_block_all),
      ads_block_banners: toBool(b.ads_block_banners),
      is_header: toBool(b.is_header),
      deals_home: toBool(b.deals_home),
      tag_home: toBool(b.tag_home),
      amazon_store: toBool(b.amazon_store),
      active: toBool(b.active),
      show_at_search_bar: toBool(b.show_at_search_bar),
      extension_active: toBool(b.extension_active),
      extension_mandatory: toBool(b.extension_mandatory),
      is_header_2: toBool(b.is_header_2),

      // radios
      coupon_icon_visibility: b.coupon_icon_visibility || "visible",
      store_status_visibility: b.store_status_visibility || "visible",

      // arrays (JSON)
      category_names: parseJSON(b.category_names, []),
      subcategories: parseJSON(b.subcategories, []),
      category_id: toInt(b.category_id, null),
      subcategory_id: toInt(b.subcategory_id, null),
      coupon_h2_blocks: parseJSON(b.coupon_h2_blocks, []),
      coupon_h3_blocks: parseJSON(b.coupon_h3_blocks, []),
      faqs: parseJSON(b.faqs, []),
      suggestions: parseJSON(b.suggestions, []),
    };

    // Images (optional)
    if (f.logo?.[0]) {
      const file = f.logo[0];
      console.log(
        "uploading",
        file.originalname,
        "size",
        file.size,
        "buffer?",
        !!file.buffer
      );
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        file.buffer,
        file.originalname,
        file.mimetype
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Logo upload failed", details: error },
        });
      toInsert.logo_url = url;
    }

    const created = await merchantRepo.insert(toInsert);
    return res.status(201).json({ data: created, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error creating merchant",
        details: err?.message || err,
      },
    });
  }
}

export async function updateMerchant(req, res) {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const f = req.files || {};

    const patch = {
      // identifiers
      name: b.name ?? undefined,

      // site + tracking
      web_url:
        b.web_url !== undefined
          ? b.web_url
          : b.website !== undefined
          ? b.website
          : undefined,
      aff_url: b.aff_url !== undefined ? b.aff_url : undefined,
      tracker_lock:
        b.tracker_lock !== undefined ? toBool(b.tracker_lock) : undefined,

      // headings / SEO
      h1keyword: b.h1keyword !== undefined ? b.h1keyword : undefined,
      meta_title:
        b.seo_title !== undefined
          ? b.seo_title
          : b.meta_title !== undefined
          ? b.meta_title
          : undefined,
      meta_keywords:
        b.seo_keywords !== undefined
          ? b.seo_keywords
          : b.meta_keywords !== undefined
          ? b.meta_keywords
          : undefined,
      meta_description:
        b.seo_description !== undefined
          ? b.seo_description
          : b.meta_description !== undefined
          ? b.meta_description
          : undefined,

      // content blocks
      side_description_html:
        b.side_description_html !== undefined
          ? b.side_description_html
          : undefined,
      description_html:
        b.description_html !== undefined
          ? b.description_html
          : b.description !== undefined
          ? b.description
          : undefined,
      // table_content_html:
      //   b.table_content_html !== undefined ? b.table_content_html : undefined,
      // ads_description_html:
      //   b.ads_description_html !== undefined
      //     ? b.ads_description_html
      //     : undefined,
      // ads_description_label:
      //   b.ads_description_label !== undefined
      //     ? b.ads_description_label
      //     : undefined,

      // flags
      sidebar: b.sidebar !== undefined ? toBool(b.sidebar) : undefined,
      home: b.home !== undefined ? toBool(b.home) : undefined,
      ads_block_all:
        b.ads_block_all !== undefined ? toBool(b.ads_block_all) : undefined,
      ads_block_banners:
        b.ads_block_banners !== undefined
          ? toBool(b.ads_block_banners)
          : undefined,
      is_header: b.is_header !== undefined ? toBool(b.is_header) : undefined,
      deals_home: b.deals_home !== undefined ? toBool(b.deals_home) : undefined,
      tag_home: b.tag_home !== undefined ? toBool(b.tag_home) : undefined,
      amazon_store:
        b.amazon_store !== undefined ? toBool(b.amazon_store) : undefined,
      active: b.active !== undefined ? toBool(b.active) : undefined,
      show_at_search_bar:
        b.show_at_search_bar !== undefined
          ? toBool(b.show_at_search_bar)
          : undefined,
      extension_active:
        b.extension_active !== undefined
          ? toBool(b.extension_active)
          : undefined,
      extension_mandatory:
        b.extension_mandatory !== undefined
          ? toBool(b.extension_mandatory)
          : undefined,
      is_header_2:
        b.is_header_2 !== undefined ? toBool(b.is_header_2) : undefined,

      // radios
      coupon_icon_visibility:
        b.coupon_icon_visibility !== undefined
          ? b.coupon_icon_visibility
          : undefined,
      store_status_visibility:
        b.store_status_visibility !== undefined
          ? b.store_status_visibility
          : undefined,

      // arrays (JSON strings)
      category_names:
        b.category_names !== undefined
          ? parseJSON(b.category_names, [])
          : undefined,
      subcategories:
        b.subcategories !== undefined
          ? parseJSON(b.subcategories, [])
          : undefined,
      category_id: b.category_id !== undefined ? toInt(b.category_id, null) : undefined,
      subcategory_id: b.subcategory_id !== undefined ? toInt(b.subcategory_id, null) : undefined,
      coupon_h2_blocks:
        b.coupon_h2_blocks !== undefined
          ? parseJSON(b.coupon_h2_blocks, [])
          : undefined,
      coupon_h3_blocks:
        b.coupon_h3_blocks !== undefined
          ? parseJSON(b.coupon_h3_blocks, [])
          : undefined,
      faqs: b.faqs !== undefined ? parseJSON(b.faqs, []) : undefined,
      suggestions:
        b.suggestions !== undefined ? parseJSON(b.suggestions, []) : undefined,
    };

    // Slug handling
    if (b.slug !== undefined) {
      patch.slug = await merchantRepo.ensureUniqueSlugOnUpdate(id, b.slug);
    } else if (b.name !== undefined && b.name) {
      patch.slug = await merchantRepo.ensureUniqueSlugOnUpdate(id, b.name);
    }

    // Explicit removals
    if (toBool(b.remove_logo)) patch.logo_url = null;
    // if (toBool(b.remove_top_banner)) patch.top_banner_url = null;
    // if (toBool(b.remove_side_banner)) patch.side_banner_url = null;

    // New files overwrite
    if (f.logo?.[0]) {
      const file = f.logo[0];
      console.log(
        "uploading",
        file.originalname,
        "size",
        file.size,
        "buffer?",
        !!file.buffer
      );
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        file.buffer,
        file.originalname,
        file.mimetype
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Logo upload failed", details: error },
        });
      patch.logo_url = url;
    }

    const updated = await merchantRepo.update(id, patch);
    return res.json({ data: updated, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error updating merchant",
        details: err?.message || err,
      },
    });
  }
}

export async function updateMerchantStatus(req, res) {
  try {
    const { id } = req.params;
    const updated = await merchantRepo.toggleStatus(id);
    return res.json({ data: updated, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error updating merchant status",
        details: err?.message || err,
      },
    });
  }
}

export async function deleteMerchant(req, res) {
  try {
    const { id } = req.params;

    const m = await merchantRepo.getById(id);
    if (!m)
      return res
        .status(404)
        .json({ data: null, error: { message: "Merchant not found" } });

    const urls = [m.logo_url].filter(
      Boolean
    );
    try {
      if (urls.length) await deleteFilesByUrls(BUCKET, urls);
    } catch (fileErr) {
      console.error(
        "Merchant file deletion failed:",
        fileErr?.message || fileErr
      );
    }

    const ok = await merchantRepo.remove(id);
    if (!ok)
      return res
        .status(500)
        .json({ data: null, error: { message: "Failed to delete merchant" } });

    return res.json({ data: { id, deleted_files: urls.length }, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error deleting merchant",
        details: err?.message || err,
      },
    });
  }
}

export async function uploadBlogImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: "No file uploaded" } });
    }

    const file = req.file;
    const { url, error } = await uploadImageBuffer(
      BUCKET,
      FOLDER,
      file.buffer,
      file.originalname,
      file.mimetype
    );

    if (error) {
      return res
        .status(500)
        .json({ error: { message: "Upload failed", details: error } });
    }

    return res.json({ url });
  } catch (err) {
    console.error("Upload Merchant Image Error:", err);
    return res
      .status(500)
      .json({ error: { message: "Error uploading image" } });
  }
}
