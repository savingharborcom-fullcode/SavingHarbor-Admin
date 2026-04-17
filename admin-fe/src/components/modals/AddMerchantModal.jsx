// src/components/merchants/AddMerchantModal.jsx
import React, { useEffect, useState, useRef } from "react";
import {
  addMerchant,
  uploadMerchantImage,
} from "../../services/merchantService";
import {
  getAllCategories,
  getSubcategoriesByCategoryId,
} from "../../services/merchantCategoryService.js";
import useEscClose from "../hooks/useEscClose";
import SafeQuill from "../common/SafeQuill.jsx";

export default function AddMerchantModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    category_input: "",
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
    active: true,
    show_at_search_bar: false,
    extension_active: false,
    extension_mandatory: false,
    is_header_2: false, // second Is Header seen in grid
    coupon_icon_visibility: "visible", // visible | invisible
    store_status_visibility: "visible", // visible | invisible
    is_publish: true,
  });

  const [logo, setLogo] = useState(null);
  const [logoPreview, setLogoPreview] = useState("");

  // --- categories state (selected) and all available categories (from DB) ---
  const [categories, setCategories] = useState([]); // selected category names (was inline-added)
  const [allCategories, setAllCategories] = useState([]); // fetched from backend
  const [loadingCats, setLoadingCats] = useState(true);

  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [allSubcategories, setAllSubcategories] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);

  const [brandCategories, setBrandCategories] = useState([]); // inline-added

  const [couponH2Blocks, setCouponH2Blocks] = useState([]); // [{heading, description}]
  const [couponH3Blocks, setCouponH3Blocks] = useState([]); // [{heading, description}]
  const [faqs, setFaqs] = useState([]); // [{question, answer}]
  const [suggestions, setSuggestions] = useState([]); // [text]

  const [saving, setSaving] = useState(false);
  const quillRef = useRef(null);

  // Load root categories
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoadingCats(true);
        const res = await getAllCategories();
        if (mounted) setAllCategories(Array.isArray(res) ? res : []);
      } catch {
        if (mounted) setAllCategories([]);
      } finally {
        if (mounted) setLoadingCats(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!categoryId) {
      setAllSubcategories([]);
      setSubcategoryId("");
      return;
    }
    let mounted = true;
    (async () => {
      setLoadingSubs(true);
      setSubcategoryId("");
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

  const handleSlugAuto = () => {
    if (!form.slug && form.name) {
      const slug = String(form.name)
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      setForm((f) => ({ ...f, slug }));
    }
  };

  // Add typed category to selected categories (and clear input)
  const addCategory = async () => {
    const v = String(form.category_input || "").trim();
    if (!v) return;
    if (!categories.includes(v)) {
      setCategories((arr) => [...arr, v]);
    }
    setForm((f) => ({ ...f, category_input: "" }));
  };

  const removeCategory = (v) => {
    setCategories((arr) => arr.filter((x) => x !== v));
  };

  // Handler for native <select multiple>
  const onSelectChange = (e) => {
    const opts = Array.from(e.target.selectedOptions || []).map((o) => o.value);
    setCategories(opts);
  };

  const [brandCategoryInput, setBrandCategoryInput] = useState("");
  const addBrandCategory = () => {
    const v = brandCategoryInput.trim();
    if (!v) return;
    setBrandCategories((arr) => [...arr, v]);
    setBrandCategoryInput("");
  };
  const removeBrandCategory = (v) => {
    setBrandCategories((arr) => arr.filter((x) => x !== v));
  };

  const [tempHeading, setTempHeading] = useState("");
  const [tempDesc, setTempDesc] = useState("");
  const addCouponH2 = () => {
    if (!tempHeading.trim()) return;
    setCouponH2Blocks((arr) => [
      ...arr,
      { heading: tempHeading.trim(), description: tempDesc.trim() },
    ]);
    setTempHeading("");
    setTempDesc("");
  };
  const removeCouponH2 = (i) => {
    setCouponH2Blocks((arr) => arr.filter((_, idx) => idx !== i));
  };

  const [tempHeading3, setTempHeading3] = useState("");
  const [tempDesc3, setTempDesc3] = useState("");
  const addCouponH3 = () => {
    if (!tempHeading3.trim()) return;
    setCouponH3Blocks((arr) => [
      ...arr,
      { heading: tempHeading3.trim(), description: tempDesc3.trim() },
    ]);
    setTempHeading3("");
    setTempDesc3("");
  };
  const removeCouponH3 = (i) => {
    setCouponH3Blocks((arr) => arr.filter((_, idx) => idx !== i));
  };

  const [tempQ, setTempQ] = useState("");
  const [tempA, setTempA] = useState("");
  const addFaq = () => {
    if (!tempQ.trim()) return;
    setFaqs((arr) => [
      ...arr,
      { question: tempQ.trim(), answer: tempA.trim() },
    ]);
    setTempQ("");
    setTempA("");
  };
  const removeFaq = (i) => {
    setFaqs((arr) => arr.filter((_, idx) => idx !== i));
  };

  const [tempSuggestion, setTempSuggestion] = useState("");
  const addSuggestion = () => {
    if (!tempSuggestion.trim()) return;
    setSuggestions((arr) => [...arr, tempSuggestion.trim()]);
    setTempSuggestion("");
  };
  const removeSuggestion = (i) => {
    setSuggestions((arr) => arr.filter((_, idx) => idx !== i));
  };

  const pickLogo = (file) => {
    setLogo(file || null);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    if (file) setLogoPreview(URL.createObjectURL(file));
    else setLogoPreview("");
  };

  const resetAll = () => {
    setForm({
      name: "",
      slug: "",
      category_input: "",
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
    });
    setCategories([]);
    setBrandCategories([]);
    setCouponH2Blocks([]);
    setCouponH3Blocks([]);
    setFaqs([]);
    setSuggestions([]);
    pickLogo(null);
    setCategoryId("");
    setSubcategoryId("");
    setAllSubcategories([]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!form.name || !form.slug) return;

    setSaving(true);
    const fd = new FormData();
    fd.append("name", form.name);
    fd.append("slug", form.slug);
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
    fd.append("coupon_icon_visibility", form.coupon_icon_visibility);
    fd.append("store_status_visibility", form.store_status_visibility);
    fd.append("category_id", categoryId || "");
    fd.append("subcategory_id", subcategoryId || "");
    if (logo) fd.append("logo", logo);

    // arrays as JSON
    fd.append("category_names", JSON.stringify(categories));
    fd.append("subcategories", JSON.stringify(brandCategories));
    fd.append("coupon_h2_blocks", JSON.stringify(couponH2Blocks));
    fd.append("coupon_h3_blocks", JSON.stringify(couponH3Blocks));
    fd.append("faqs", JSON.stringify(faqs));
    fd.append("suggestions", JSON.stringify(suggestions));

    try {
      const { error } = await addMerchant(fd);
      if (error) throw new Error(error.message || "Create failed");
      onSave?.();
      onClose?.();
    } catch (err) {
      console.error("Add merchant failed:", err?.message || err);
    } finally {
      setSaving(false);
    }
  };

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

  // ✅ Custom image handler with ref forwarding
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
    "list", // ← only "list" here; toolbar still shows ordered/bullet
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
    history: {
      delay: 500,
      maxStack: 200,
      userOnly: true,
    },
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

  // ✅ Harden undo/redo with a direct keydown fallback on the editor root
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

  // close on ESC
  useEscClose(onClose);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white w-full max-w-6xl rounded shadow-lg p-6 max-h-[95vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add Stores</h2>
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
              onBlur={handleSlugAuto}
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

          {/* Category + Add category (REPLACED: native multi-select + chips + typed add) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

          {/* Web / Affiliate / Tracker / H1 */}
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
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              name="tracker_lock"
              checked={!!form.tracker_lock}
              onChange={handleChange}
            />
            <span>Tracker Lock</span>
          </div>
          <div>
            <label className="block mb-1">H1 Keyword</label>
            <input
              name="h1keyword"
              value={form.h1keyword}
              onChange={handleChange}
              className="w-full border px-3 py-2 rounded"
            />
          </div>

          {/* Store Logo */}
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
                <label className="block">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => pickLogo(e.target.files?.[0] || null)}
                  />
                </label>
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

          {/* Rich text blocks */}
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

          {/* Toggles grid */}
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
            <Bool name="is_header_2" label="Is Header" />
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

          {/* Sectioned content with [+] Add */}
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

          {/* Footer actions */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              className="bg-gray-200 px-4 py-2 rounded"
              onClick={resetAll}
            >
              Reset
            </button>
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
              {saving ? "Adding..." : "Add Stores"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
