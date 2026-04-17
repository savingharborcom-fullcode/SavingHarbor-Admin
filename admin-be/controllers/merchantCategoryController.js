// src/controllers/merchantCategoryController.js
import * as mcRepo from "../dbhelper/MerchantCategoryRepo.js";
import { uploadImageBuffer } from "../services/storageService.js";
import { deleteFilesByUrls } from "../services/deleteFilesByUrl.js";
import { supabase } from "../dbhelper/dbclient.js";

const BUCKET = process.env.UPLOAD_BUCKET || "merchant-categories-images";
const FOLDER = "merchant-categories";

const toBool = (v) => v === true || v === "true" || v === "1";
const toInt = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

//to validate if parentId is existing or not
export async function assertValidParentId(parentId, selfId = null) {
  if (parentId == null) return null; // allow null
  const pid = Number(parentId);
  if (!Number.isFinite(pid)) throw new Error("Invalid parent_id");
  if (selfId != null && Number(selfId) === pid) {
    throw new Error("A category cannot be its own parent");
  }
  // Ensure parent exists
  const parent = await mcRepo.getById(pid);
  if (!parent?.id) throw new Error("Parent category not found");
  return pid;
}

export async function listCategories(req, res) {
  try {
    const name = req.query?.name || "";
    const page = Math.max(1, toInt(req.query?.page || 1, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query?.limit || 20, 20)));
    const includeStoreCount = req.query?.include_store_count === "true";

    // parent_id: "null" → root only; numeric string → subcategories; absent → all
    let parent_id = undefined;
    if (req.query.parent_id !== undefined) {
      parent_id = req.query.parent_id === "null" ? null : req.query.parent_id;
    }

    const filter = {
      name,
      parent_id,
      show_home:
        req.query?.show_home !== undefined
          ? toBool(req.query.show_home)
          : undefined,
      show_deals_page:
        req.query?.show_deals_page !== undefined
          ? toBool(req.query.show_deals_page)
          : undefined,
      is_publish:
        req.query?.is_publish !== undefined
          ? toBool(req.query.is_publish)
          : undefined,
      is_header:
        req.query?.is_header !== undefined
          ? toBool(req.query.is_header)
          : undefined,
    };

    const { rows, total } = await mcRepo.list({ ...filter, page, limit });

    let enriched = rows;
    if (includeStoreCount && Array.isArray(rows) && rows.length) {
      enriched = await Promise.all(
        rows.map(async (r) => {
          if (!r?.name) return { ...r, store_count: 0 };
          const { count, error } = await supabase
            .from("merchants")
            .select("id", { count: "exact", head: true })
            .contains("category_names", [r.name]);
          if (error) return { ...r, store_count: 0 };
          return { ...r, store_count: count || 0 };
        }),
      );
    }

    return res.json({ data: { rows: enriched, total }, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error listing categories",
        details: err?.message || err,
      },
    });
  }
}

export async function getCategory(req, res) {
  try {
    const { id } = req.params;
    const data = await mcRepo.getById(id);
    return res.json({ data, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error fetching category",
        details: err?.message || err,
      },
    });
  }
}

export async function createCategory(req, res) {
  try {
    const b = req.body || {};
    const f = req.files || {};

    // Validate parent first (if provided)
    let parentId = null;
    if (b.parent_id) {
      try {
        parentId = await assertValidParentId(b.parent_id);
      } catch (e) {
        return res
          .status(400)
          .json({ data: null, error: { message: e.message } });
      }
    }

    const toInsert = {
      name: b.name,
      slug: await mcRepo.ensureUniqueSlug(b.slug || b.name || ""),
      description: b.description || "",
      meta_title: b.meta_title || "",
      meta_keywords: b.meta_keywords || "",
      meta_description: b.meta_description || "",
      parent_id: b.parent_id ? Number(b.parent_id) : null,
      top_banner_link_url: b.top_banner_link_url || "",
      side_banner_link_url: b.side_banner_link_url || "",
      show_home: toBool(b.show_home),
      show_deals_page: toBool(b.show_deals_page),
      is_publish: toBool(b.is_publish),
      is_header: toBool(b.is_header),
    };

    const thumbFile = f.thumb?.[0];
    if (thumbFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        thumbFile.buffer,
        thumbFile.originalname,
        thumbFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Thumb upload failed", details: error },
        });
      toInsert.thumb_url = url;
    }

    const topFile = f.tp_banner?.[0];
    if (topFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        topFile.buffer,
        topFile.originalname,
        topFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Top banner upload failed", details: error },
        });
      toInsert.top_banner_url = url;
    }

    const sideFile = f.side_banner?.[0];
    if (sideFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        sideFile.buffer,
        sideFile.originalname,
        sideFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Side banner upload failed", details: error },
        });
      toInsert.side_banner_url = url;
    }

    const created = await mcRepo.insert(toInsert);
    return res.status(201).json({ data: created, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error creating category",
        details: err?.message || err,
      },
    });
  }
}

export async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const f = req.files || {};

    // Load current to know which files to clean up if replaced/removed
    const cur = await mcRepo.getById(id);

    // Validate parent (only if provided in payload)
    let parentIdPatch = undefined;
    if (b.parent_id !== undefined) {
      if (b.parent_id) {
        try {
          parentIdPatch = await assertValidParentId(b.parent_id, id);
        } catch (e) {
          return res
            .status(400)
            .json({ data: null, error: { message: e.message } });
        }
      } else {
        parentIdPatch = null; // explicit clear
      }
    }

    const patch = {
      name: b.name ?? undefined,
      description: b.description ?? undefined,
      meta_title: b.meta_title ?? undefined,
      meta_keywords: b.meta_keywords ?? undefined,
      meta_description: b.meta_description ?? undefined,
      parent_id:
        b.parent_id !== undefined
          ? b.parent_id
            ? Number(b.parent_id)
            : null
          : undefined,
      top_banner_link_url: b.top_banner_link_url ?? undefined,
      side_banner_link_url: b.side_banner_link_url ?? undefined,
      show_home: b.show_home !== undefined ? toBool(b.show_home) : undefined,
      show_deals_page:
        b.show_deals_page !== undefined ? toBool(b.show_deals_page) : undefined,
      is_publish: b.is_publish !== undefined ? toBool(b.is_publish) : undefined,
      is_header: b.is_header !== undefined ? toBool(b.is_header) : undefined,
      updated_at: new Date().toISOString(),
    };

    if (b.slug !== undefined) {
      patch.slug = await mcRepo.ensureUniqueSlugOnUpdate(id, b.slug);
    } else if (b.name !== undefined && b.name) {
      patch.slug = await mcRepo.ensureUniqueSlugOnUpdate(id, b.name);
    }

    const toDelete = [];

    // Explicit removals
    if (toBool(b.remove_thumb) && cur?.thumb_url) {
      patch.thumb_url = null;
      toDelete.push(cur.thumb_url);
    }
    if (toBool(b.remove_top_banner) && cur?.top_banner_url) {
      patch.top_banner_url = null;
      toDelete.push(cur.top_banner_url);
    }
    if (toBool(b.remove_side_banner) && cur?.side_banner_url) {
      patch.side_banner_url = null;
      toDelete.push(cur.side_banner_url);
    }

    // Upload replacements (NOTE: multer .fields() provides arrays -> use [0])
    const thumbFile = f.thumb?.[0];
    if (thumbFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        thumbFile.buffer,
        thumbFile.originalname,
        thumbFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Thumb upload failed", details: error },
        });
      if (cur?.thumb_url) toDelete.push(cur.thumb_url);
      patch.thumb_url = url;
    }

    const topFile = f.top_banner?.[0];
    if (topFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        topFile.buffer,
        topFile.originalname,
        topFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Top banner upload failed", details: error },
        });
      if (cur?.top_banner_url) toDelete.push(cur.top_banner_url);
      patch.top_banner_url = url;
    }

    const sideFile = f.side_banner?.[0];
    if (sideFile) {
      const { url, error } = await uploadImageBuffer(
        BUCKET,
        FOLDER,
        sideFile.buffer,
        sideFile.originalname,
        sideFile.mimetype,
      );
      if (error)
        return res.status(500).json({
          data: null,
          error: { message: "Side banner upload failed", details: error },
        });
      if (cur?.side_banner_url) toDelete.push(cur.side_banner_url);
      patch.side_banner_url = url;
    }

    const updated = await mcRepo.update(id, patch);

    // Best-effort cleanup AFTER successful update
    if (toDelete.length) {
      try {
        await deleteFilesByUrls(BUCKET, toDelete);
      } catch (fileErr) {
        console.error(
          "Category file cleanup (update) failed:",
          fileErr?.message || fileErr,
        );
      }
    }

    return res.json({ data: updated, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error updating category",
        details: err?.message || err,
      },
    });
  }
}

export async function updateCategoryStatus(req, res) {
  try {
    const { id } = req.params;
    const updated = await mcRepo.toggleStatus(id);
    return res.json({ data: updated, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error updating category status",
        details: err?.message || err,
      },
    });
  }
}

export async function deleteCategory(req, res) {
  try {
    const { id } = req.params;

    const c = await mcRepo.getById(id);
    if (!c)
      return res
        .status(404)
        .json({ data: null, error: { message: "Category not found" } });

    const urls = [c.thumb_url, c.top_banner_url, c.side_banner_url].filter(
      Boolean,
    );
    try {
      if (urls.length) await deleteFilesByUrls(BUCKET, urls);
    } catch (fileErr) {
      console.error(
        "Category file deletion failed:",
        fileErr?.message || fileErr,
      );
      // choose to proceed; change policy if strict consistency required
    }

    const ok = await mcRepo.remove(id);
    if (!ok)
      return res
        .status(500)
        .json({ data: null, error: { message: "Failed to delete category" } });

    return res.json({ data: { id, deleted_files: urls.length }, error: null });
  } catch (err) {
    return res.status(500).json({
      data: null,
      error: {
        message: "Error deleting category",
        details: err?.message || err,
      },
    });
  }
}
