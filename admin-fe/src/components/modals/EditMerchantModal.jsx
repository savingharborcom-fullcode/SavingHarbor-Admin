// src/components/merchants/EditMerchantModal.jsx
import React, { useEffect, useState, useRef } from "react";
import {
  getMerchant,
  updateMerchant,
  uploadMerchantImage,
} from "../../services/merchantService";
import {
  getAllCategories,
  getSubcategoriesByCategoryId,
} from "../../services/merchantCategoryService.js";
import useEscClose from "../hooks/useEscClose";
import SafeQuill from "../common/SafeQuill.jsx";

export default function EditMerchantModal({ merchantId, onClose, onSave }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState(null);

  const [logo, setLogo] = useState(null);
  const [logoPreview, setLogoPreview] = useState("");

  const [categories, setCategories] = useState([]);
  const [brandCategories, setBrandCategories] = useState([]);

  const [couponH2Blocks, setCouponH2Blocks] = useState([]);
  const [couponH3Blocks, setCouponH3Blocks] = useState([]);
  const [faqs, setFaqs] = useState([]);
  const [suggestions, setSuggestions] = useState([]);

  const [allCategories, setAllCategories] = useState([]);
  const [loadingCats, setLoadingCats] = useState(true);

  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [allSubcategories, setAllSubcategories] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);

  const isFirstCategoryLoad = useRef(true);

  // Temp inputs for list sections
  const [categoryInput, setCategoryInput] = useState("");
  const [brandCategoryInput, setBrandCategoryInput] = useState("");
  const [tempHeading, setTempHeading] = useState("");
  const [tempDesc, setTempDesc] = useState("");
  const [tempHeading3, setTempHeading3] = useState("");
  const [tempDesc3, setTempDesc3] = useState("");
  const [tempQ, setTempQ] = useState("");
  const [tempA, setTempA] = useState("");
  const [tempSuggestion, setTempSuggestion] = useState("");
  const quillRef = useRef(null);

  // Load merchant data
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      try {
        const m = await getMerchant(merchantId);
        if (!mounted) return;

        setForm({
          name: m?.name || "",
          slug: m?.slug || "",
          web_url: m?.web_url || m?.website || "",
          aff_url: m?.aff_url || "",
          tracker_lock: !!m?.tracker_lock,
          h1keyword: m?.h1keyword || "",
          seo_title: m?.meta_title || "",
          seo_keywords: m?.meta_keywords || "",
          seo_description: m?.meta_description || "",
          side_description_html: m?.side_description_html || "",
          description_html: m?.description_html || m?.description || "",
          sidebar: !!m?.sidebar,
          home: !!m?.home,
          ads_block_all: !!m?.ads_block_all,
          ads_block_banners: !!m?.ads_block_banners,
          is_header: !!m?.is_header,
          deals_home: !!m?.deals_home,
          tag_home: !!m?.tag_home,
          amazon_store: !!m?.amazon_store,
          active: !!m?.active,
          show_at_search_bar: !!m?.show_at_search_bar,
          extension_active: !!m?.extension_active,
          extension_mandatory: !!m?.extension_mandatory,
          is_header_2: !!m?.is_header_2,
          coupon_icon_visibility: m?.coupon_icon_visibility || "visible",
          store_status_visibility: m?.store_status_visibility || "visible",
          logo_url: m?.logo_url || m?.logo || "",
        });

        setCategories(Array.isArray(m?.category_names) ? m.category_names : []);
        setBrandCategories(
          Array.isArray(m?.subcategories) ? m.subcategories : [],
        );
        setCouponH2Blocks(
          Array.isArray(m?.coupon_h2_blocks) ? m.coupon_h2_blocks : [],
        );
        setCouponH3Blocks(
          Array.isArray(m?.coupon_h3_blocks) ? m.coupon_h3_blocks : [],
        );
        setFaqs(Array.isArray(m?.faqs) ? m.faqs : []);
        setSuggestions(Array.isArray(m?.suggestions) ? m.suggestions : []);
        setLogoPreview(m?.logo_url || m?.logo || "");
        setCategoryId(m?.category_id || "");
        setSubcategoryId(m?.subcategory_id || "");
      } catch (e) {
        console.error("Failed to load merchant:", e?.message || e);
        setForm({
          name: "",
          slug: "",
          web_url: "",
          aff_url: "",
          tracker_lock: false,
          h1keyword: "",
          seo_title: "",
          seo_keywords: "",
          seo_description: "",
          side_description_html: "",
          description_html: "",
          sidebar: false,
          home: false,
          ads_block_all: false,
          ads_block_banners: false,
          is_header: false,
          deals_home: false,
          tag_home: false,
          amazon_store: false,
          active: false,
          show_at_search_bar: false,
          extension_active: false,
          extension_mandatory: false,
          is_header_2: false,
          coupon_icon_visibility: "visible",
          store_status_visibility: "visible",
          logo_url: "",
        });
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [merchantId]); // eslint-disable-line

  // Fetch all categories
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadingCats(true);
        const res = await getAllCategories();
        if (!mounted) return;
        setAllCategories(Array.isArray(res) ? res : []);
      } catch (err) {
        console.error("Could not fetch categories:", err);
        setAllCategories([]);
      } finally {
        if (mounted) setLoadingCats(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Fetch subcategories when categoryId changes
  useEffect(() => {
    if (!categoryId) {
      setAllSubcategories([]);
      if (!isFirstCategoryLoad.current) setSubcategoryId("");
      return;
    }
    let mounted = true;
    (async () => {
      setLoadingSubs(true);
      if (!isFirstCategoryLoad.current) setSubcategoryId("");
      isFirstCategoryLoad.current = false;
      try {
        const res = await getSubcategoriesByCategoryId(categoryId);
        if (mounted) setAllSubcategories(Array.isArray(res) ? res : []);
      } catch {
        if (mounted) setAllSubcategories([]);
      } finally {
        if (mounted) setLoadingSubs(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [categoryId]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === "checkbox" ? checked : value }));
  };

  const pickLogo = (file) => {
    setLogo(file || null);
    if (logoPreview && logoPreview.startsWith("blob:"))
      URL.revokeObjectURL(logoPreview);
    if (file) setLogoPreview(URL.createObjectURL(file));
    else setLogoPreview(form?.logo_url || "");
  };

  const addCategory = () => {
    const v = (categoryInput || "").trim();
    if (!v) return;
    setCategories((arr) => (arr.includes(v) ? arr : [...arr, v]));
    setCategoryInput("");
  };
  const removeCategory = (v) =>
    setCategories((arr) => arr.filter((x) => x !== v));

  const addBrandCategory = () => {
    const v = brandCategoryInput.trim();
    if (!v) return;
    setBrandCategories((arr) => [...arr, v]);
    setBrandCategoryInput("");
  };
  const removeBrandCategory = (v) =>
    setBrandCategories((arr) => arr.filter((x) => x !== v));

  const addCouponH2 = () => {
    if (!tempHeading.trim()) return;
    setCouponH2Blocks((arr) => [
      ...arr,
      { heading: tempHeading.trim(), description: tempDesc.trim() },
    ]);
    setTempHeading("");
    setTempDesc("");
  };
  const removeCouponH2 = (i) =>
    setCouponH2Blocks((arr) => arr.filter((_, idx) => idx !== i));

  const addCouponH3 = () => {
    if (!tempHeading3.trim()) return;
    setCouponH3Blocks((arr) => [
      ...arr,
      { heading: tempHeading3.trim(), description: tempDesc3.trim() },
    ]);
    setTempHeading3("");
    setTempDesc3("");
  };
  const removeCouponH3 = (i) =>
    setCouponH3Blocks((arr) => arr.filter((_, idx) => idx !== i));

  const addFaq = () => {
    if (!tempQ.trim()) return;
    setFaqs((arr) => [
      ...arr,
      { question: tempQ.trim(), answer: tempA.trim() },
    ]);
    setTempQ("");
    setTempA("");
  };
  const removeFaq = (i) => setFaqs((arr) => arr.filter((_, idx) => idx !== i));

  const addSuggestion = () => {
    if (!tempSuggestion.trim()) return;
    setSuggestions((arr) => [...arr, tempSuggestion.trim()]);
    setTempSuggestion("");
  };
  const removeSuggestion = (i) =>
    setSuggestions((arr) => arr.filter((_, idx) => idx !== i));

  const Radio = ({ name, value, label }) => (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name={name}
        value={value}
        checked={form[name] === value}
        onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
      />
      {label}
    </label>
  );

  const Bool = ({ name, label }) => (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        name={name}
        checked={!!form[name]}
        onChange={handleChange}
      />
      {label}
    </label>
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    setSaving(true);
    const fd = new FormData();
    fd.append("name", form.name || "");
    fd.append("slug", form.slug || "");
    fd.append("web_url", form.web_url || "");
    fd.append("aff_url", form.aff_url || "");
    fd.append("tracker_lock", String(!!form.tracker_lock));
    fd.append("h1keyword", form.h1keyword || "");
    fd.append("seo_title", form.seo_title || "");
    fd.append("seo_keywords", form.seo_keywords || "");
    fd.append("seo_description", form.seo_description || "");
    fd.append("side_description_html", form.side_description_html || "");
    fd.append("description_html", form.description_html || "");
    fd.append("sidebar", String(!!form.sidebar));
    fd.append("home", String(!!form.home));
    fd.append("ads_block_all", String(!!form.ads_block_all));
    fd.append("ads_block_banners", String(!!form.ads_block_banners));
    fd.append("is_header", String(!!form.is_header));
    fd.append("deals_home", String(!!form.deals_home));
    fd.append("tag_home", String(!!form.tag_home));
    fd.append("amazon_store", String(!!form.amazon_store));
    fd.append("active", String(!!form.active));
    fd.append("show_at_search_bar", String(!!form.show_at_search_bar));
    fd.append("extension_active", String(!!form.extension_active));
    fd.append("extension_mandatory", String(!!form.extension_mandatory));
    fd.append("is_header_2", String(!!form.is_header_2));
    fd.append(
      "coupon_icon_visibility",
      form.coupon_icon_visibility || "visible",
    );
    fd.append(
      "store_status_visibility",
      form.store_status_visibility || "visible",
    );
    fd.append("category_id", categoryId || "");
    fd.append("subcategory_id", subcategoryId || "");

    if (logo) fd.append("logo", logo);

    fd.append("category_names", JSON.stringify(categories));
    fd.append("subcategories", JSON.stringify(brandCategories));
    fd.append("coupon_h2_blocks", JSON.stringify(couponH2Blocks));
    fd.append("coupon_h3_blocks", JSON.stringify(couponH3Blocks));
    fd.append("faqs", JSON.stringify(faqs));
    fd.append("suggestions", JSON.stringify(suggestions));

    try {
      const { error } = await updateMerchant(merchantId, fd);
      if (error) throw new Error(error.message || "Update failed");
      onSave?.();
      onClose?.();
    } catch (err) {
      console.error("Update merchant failed:", err?.message || err);
    } finally {
      setSaving(false);
    }
  };

  const imageHandler = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.click();

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const url = await uploadMerchantImage(file);
        if (url) {
          const editor = quillRef.current?.getEditor();
          if (editor) {
            const range = editor.getSelection(true);
            editor.insertEmbed(range.index, "image", url);
            editor.setSelection(range.index + 1);
          }
        }
      } catch (err) {
        console.error("Image upload failed:", err);
        alert("Image upload failed. Please try again.");
      }
    };
  };

  const formats = [
    "header",
    "bold",
    "italic",
    "underline",
    "strike",
    "list",
    "link",
    "image",
  ];

  const modules = {
    toolbar: {
      container: [
        [{ header: [1, 2, 3, false] }],
        ["bold", "italic", "underline", "strike"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["link", "image"],
        ["clean"],
      ],
      handlers: { image: imageHandler },
    },
    history: { delay: 500, maxStack: 200, userOnly: true },
    keyboard: {
      bindings: {
        undo: {
          key: "z",
          shortKey: true,
          handler() {
            this.quill.history.undo();
          },
        },
        redo: {
          key: "y",
          shortKey: true,
          handler() {
            this.quill.history.redo();
          },
        },
        redoMac: {
          key: "z",
          shortKey: true,
          shiftKey: true,
          handler() {
            this.quill.history.redo();
          },
        },
      },
    },
  };

  useEffect(() => {
    const editor = quillRef.current?.getEditor?.();
    if (!editor) return;
    const root = editor.root;
    const history = editor.getModule("history");
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const onKeyDown = (e) => {
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;
      if (!ctrlOrCmd) return;
      const key = e.key?.toLowerCase?.();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        history.redo();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [quillRef]);

  useEscClose(onClose);

  if (loading || !form) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 text-white">
        Loading…
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white w-full max-w-6xl rounded shadow-lg p-6 max-h-[95vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Edit Store</h2>
          <button className="border px-3 py-1 rounded" onClick={onClose}>
            Back
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name / Slug */}
          <div>
            <label className="block mb-1">Name</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
              required
            />
          </div>
          <div>
            <label className="block mb-1">Slug</label>
            <input
              name="slug"
              value={form.slug}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
              required
            />
          </div>

          {/* Category / Subcategory */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block mb-1">Category</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full border px-3 py-2 rounded"
                disabled={loadingCats}
              >
                <option value="">
                  {loadingCats ? "Loading…" : "Select category"}
                </option>
                {allCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1">Subcategory</label>
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                className="w-full border px-3 py-2 rounded"
                disabled={!categoryId || loadingSubs}
              >
                <option value="">
                  {!categoryId
                    ? "Select category first"
                    : loadingSubs
                      ? "Loading…"
                      : "Select subcategory"}
                </option>
                {allSubcategories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Category Names (tags) */}
          <div>
            <label className="block mb-1">Category Names (tags)</label>
            <div className="flex gap-2">
              <select
                value={categoryInput}
                onChange={(e) => setCategoryInput(e.target.value)}
                className="flex-1 border px-3 py-2 rounded"
                disabled={loadingCats}
              >
                <option value="">
                  {loadingCats ? "Loading categories…" : "Select a category"}
                </option>
                {allCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="bg-blue-600 text-white px-3 py-2 rounded"
                onClick={addCategory}
              >
                + Add
              </button>
            </div>
            {categories.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {categories.map((c) => (
                  <span
                    key={c}
                    className="px-2 py-1 bg-gray-100 rounded border flex items-center gap-2"
                  >
                    <span className="text-sm">{c}</span>
                    <button
                      type="button"
                      className="ml-1 text-red-600 hover:text-red-800"
                      onClick={() => removeCategory(c)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* URLs, tracker, H1 */}
          <div>
            <label className="block mb-1">Web URL</label>
            <input
              name="web_url"
              value={form.web_url}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>
          <div>
            <label className="block mb-1">Affiliate URL</label>
            <input
              name="aff_url"
              value={form.aff_url}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="tracker_lock"
              checked={!!form.tracker_lock}
              onChange={handleChange}
            />
            Tracker Lock
          </label>
          <div>
            <label className="block mb-1">H1 Keyword</label>
            <input
              name="h1keyword"
              value={form.h1keyword}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>

          {/* Logo */}
          <div>
            <div className="mb-1">Store Logo</div>
            <div className="flex items-start gap-4">
              <div className="w-32 h-32 border rounded flex items-center justify-center overflow-hidden">
                {logoPreview ? (
                  <img
                    src={logoPreview}
                    alt="logo"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-gray-500">No image</span>
                )}
              </div>
              <div className="flex-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => pickLogo(e.target.files?.[0] || null)}
                />
                <div className="text-xs text-gray-500 mt-1">
                  Upload Store Logo
                </div>
              </div>
            </div>
          </div>

          {/* SEO */}
          <div>
            <label className="block mb-1">SEO Title</label>
            <input
              name="seo_title"
              value={form.seo_title}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>
          <div>
            <label className="block mb-1">SEO Keywords</label>
            <input
              name="seo_keywords"
              value={form.seo_keywords}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>
          <div>
            <label className="block mb-1">SEO Description</label>
            <textarea
              name="seo_description"
              value={form.seo_description}
              onChange={handleChange}
              rows={3}
              className="w-full border px-3 py-2 rounded"
            />
          </div>

          {/* Rich text */}
          <div>
            <label className="block mb-1">Side Description</label>
            <textarea
              name="side_description_html"
              value={form.side_description_html}
              onChange={handleChange}
              rows={4}
              className="w-full border px-3 py-2 rounded"
            />
          </div>
          <div>
            <label className="block mb-1">Description</label>
            <div className="border rounded bg-white">
              <SafeQuill
                ref={quillRef}
                theme="snow"
                value={form.description_html}
                onChange={(val) =>
                  setForm((f) => ({ ...f, description_html: val }))
                }
                modules={modules}
                formats={formats}
                className="h-full"
              />
            </div>
          </div>

          {/* Brand Category */}
          <div>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block mb-1">Add Brand Category</label>
                <input
                  value={brandCategoryInput}
                  onChange={(e) => setBrandCategoryInput(e.target.value)}
                  className="w-full border px-3 py-2 rounded"
                />
              </div>
              <button
                type="button"
                className="bg-blue-600 text-white px-3 py-2 rounded"
                onClick={addBrandCategory}
              >
                + Add
              </button>
            </div>
            {brandCategories.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {brandCategories.map((c) => (
                  <span
                    key={c}
                    className="px-2 py-1 bg-gray-100 rounded border"
                  >
                    {c}
                    <button
                      type="button"
                      className="ml-2 text-red-600"
                      onClick={() => removeBrandCategory(c)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Toggles */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <Bool name="sidebar" label="Sidebar" />
            <Bool name="home" label="Home" />
            <Bool name="ads_block_all" label="Ads Block All" />
            <Bool name="ads_block_banners" label="Ads Block Banners" />
            <Bool name="is_header" label="Is Header" />
            <Bool name="deals_home" label="Deals Home" />
            <Bool name="tag_home" label="Tag Home" />
            <Bool name="amazon_store" label="Amazon Store" />
            <Bool name="active" label="Active" />
            <Bool name="show_at_search_bar" label="Show at Search Bar" />
            <Bool name="extension_active" label="Extension Active" />
            <Bool name="extension_mandatory" label="Extension Mandatory" />
            <Bool name="is_header_2" label="Is Header 2" />
          </div>

          {/* Radios */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <div className="mb-1 font-medium">Coupon Icon</div>
              <div className="flex gap-6">
                <Radio
                  name="coupon_icon_visibility"
                  value="visible"
                  label="Visible"
                />
                <Radio
                  name="coupon_icon_visibility"
                  value="invisible"
                  label="Invisible"
                />
              </div>
            </div>
            <div>
              <div className="mb-1 font-medium">Store Status</div>
              <div className="flex gap-6">
                <Radio
                  name="store_status_visibility"
                  value="visible"
                  label="Visible"
                />
                <Radio
                  name="store_status_visibility"
                  value="invisible"
                  label="Invisible"
                />
              </div>
            </div>
          </div>

          {/* H2 blocks */}
          <div className="border rounded p-3">
            <div className="font-medium mb-2">Coupon H2 & Descriptions</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input
                placeholder="Heading (H2)"
                className="border px-3 py-2 rounded"
                value={tempHeading}
                onChange={(e) => setTempHeading(e.target.value)}
              />
              <input
                placeholder="Description"
                className="border px-3 py-2 rounded"
                value={tempDesc}
                onChange={(e) => setTempDesc(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="bg-blue-600 text-white px-3 py-2 rounded"
              onClick={addCouponH2}
            >
              + Add
            </button>
            {couponH2Blocks.length > 0 && (
              <ul className="mt-3 list-disc pl-6">
                {couponH2Blocks.map((b, i) => (
                  <li key={i} className="flex justify-between items-center">
                    <span>
                      {b.heading} — {b.description}
                    </span>
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={() => removeCouponH2(i)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* H3 blocks */}
          <div className="border rounded p-3">
            <div className="font-medium mb-2">Coupon H3 & Descriptions</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input
                placeholder="Heading (H3)"
                className="border px-3 py-2 rounded"
                value={tempHeading3}
                onChange={(e) => setTempHeading3(e.target.value)}
              />
              <input
                placeholder="Description"
                className="border px-3 py-2 rounded"
                value={tempDesc3}
                onChange={(e) => setTempDesc3(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="bg-blue-600 text-white px-3 py-2 rounded"
              onClick={addCouponH3}
            >
              + Add
            </button>
            {couponH3Blocks.length > 0 && (
              <ul className="mt-3 list-disc pl-6">
                {couponH3Blocks.map((b, i) => (
                  <li key={i} className="flex justify-between items-center">
                    <span>
                      {b.heading} — {b.description}
                    </span>
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={() => removeCouponH3(i)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Q&A */}
          <div className="border rounded p-3">
            <div className="font-medium mb-2">Store Question and Answers</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input
                placeholder="Question"
                className="border px-3 py-2 rounded"
                value={tempQ}
                onChange={(e) => setTempQ(e.target.value)}
              />
              <input
                placeholder="Answer"
                className="border px-3 py-2 rounded"
                value={tempA}
                onChange={(e) => setTempA(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="bg-blue-600 text-white px-3 py-2 rounded"
              onClick={addFaq}
            >
              + Add
            </button>
            {faqs.length > 0 && (
              <ul className="mt-3 list-disc pl-6">
                {faqs.map((qa, i) => (
                  <li key={i} className="flex justify-between items-center">
                    <span>
                      {qa.question} — {qa.answer}
                    </span>
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={() => removeFaq(i)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Suggestions */}
          <div className="border rounded p-3">
            <div className="font-medium mb-2">Store Suggestions</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input
                placeholder="Suggestion"
                className="border px-3 py-2 rounded"
                value={tempSuggestion}
                onChange={(e) => setTempSuggestion(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="bg-blue-600 text-white px-3 py-2 rounded"
              onClick={addSuggestion}
            >
              + Add
            </button>
            {suggestions.length > 0 && (
              <ul className="mt-3 list-disc pl-6">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex justify-between items-center">
                    <span>{s}</span>
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={() => removeSuggestion(i)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              className="border px-4 py-2 rounded"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              aria-busy={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
