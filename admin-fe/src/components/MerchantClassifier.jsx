import { useState, useCallback, useRef } from "react";

const API = "https://admin-api.savingharbor.com/api/classifier";

const get = (path) => fetch(`${API}${path}`).then((r) => r.json());
const post = (path, body) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const TABS = ["Classifier", "Review", "Results"];

const STATUS = {
  scraping: { label: "Scraping", color: "#3b82f6" },
  classifying: { label: "Classifying", color: "#8b5cf6" },
  done: { label: "Matched", color: "#10b981" },
  mismatch: { label: "Mismatch", color: "#ef4444" },
  error: { label: "Error", color: "#f97316" },
};

const STATUS_FILTERS = [
  { value: "unprocessed", label: "Unprocessed" },
  { value: "failed", label: "Failed only" },
  { value: "all", label: "All" },
];

export default function App() {
  const [tab, setTab] = useState("Classifier");

  // Keys & model
  const [keys, setKeys] = useState([""]);
  const [model, setModel] = useState("gemini-3.1-flash-lite-preview");

  // Filters & batch
  const [filter, setFilter] = useState({
    onlyActive: false,
    onlyPublished: false,
    statusFilter: "unprocessed",
  });
  const [batchSize] = useState(500);
  const [offset, setOffset] = useState(0);
  const [totalMerchants, setTotalMerchants] = useState(0);

  // Data
  const [categories, setCategories] = useState([]);
  const [merchants, setMerchants] = useState([]);

  // Run state
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);
  const bucketRef = useRef({ tokens: 1, last: Date.now() });

  // Review
  const [approved, setApproved] = useState({});
  const [newCatQueue, setNewCatQueue] = useState([]);

  // Results
  const [commitResult, setCommitResult] = useState(null);

  // ── Key management ───────────────────────────────────────────────────────────
  const addKey = () => setKeys((k) => [...k, ""]);
  const removeKey = (i) => setKeys((k) => k.filter((_, idx) => idx !== i));
  const updateKey = (i, val) =>
    setKeys((k) => k.map((v, idx) => (idx === i ? val : v)));
  const validKeys = keys.filter((k) => k.trim());

  // ── Load batch ───────────────────────────────────────────────────────────────
  const loadBatch = async (off = 0) => {
    const params = new URLSearchParams({
      offset: off,
      limit: batchSize,
      onlyActive: filter.onlyActive,
      onlyPublished: filter.onlyPublished,
      statusFilter: filter.statusFilter,
    });

    const [catRes, merRes] = await Promise.all([
      get("/categories"),
      get(`/merchants/batch?${params}`),
    ]);

    setCategories(catRes.categories || []);
    setMerchants(merRes.merchants || []);
    setTotalMerchants(merRes.total || 0);
    setOffset(off);
    setJobs({});
    setProgress({ done: 0, total: merRes.merchants?.length || 0 });
    setApproved({});
    setCommitResult(null);
  };

  const acquireToken = useCallback(() => {
    const RATE = 2.5; // tokens/sec — 10 keys × 15 RPM / 60
    const MAX = 5; // burst buffer
    return new Promise((resolve) => {
      const tryAcquire = () => {
        const bucket = bucketRef.current;
        const now = Date.now();
        const elapsed = (now - bucket.last) / 1000;
        bucket.tokens = Math.min(MAX, bucket.tokens + elapsed * RATE);
        bucket.last = now;

        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          resolve();
        } else {
          // Wait until next token is available, then retry
          const wait = Math.ceil(((1 - bucket.tokens) / RATE) * 1000);
          setTimeout(tryAcquire, wait);
        }
      };
      tryAcquire();
    });
  }, []);

  // ── Run classification ───────────────────────────────────────────────────────
  const runClassification = useCallback(async () => {
    if (!merchants.length || !validKeys.length) return;
    abortRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: merchants.length });

    let idx = 0;

    const worker = async (geminiKey) => {
      await new Promise((r) => setTimeout(r, Math.random() * 400));
      while (idx < merchants.length) {
        if (abortRef.current) break;
        const merchant = merchants[idx++];
        await acquireToken();

        setJobs((j) => ({
          ...j,
          [merchant.id]: { status: "scraping", merchant },
        }));
        try {
          const res = await post("/classify", {
            geminiKey,
            model,
            merchant,
            categories,
          });
          if (res.error) throw new Error(res.error);

          setJobs((j) => ({
            ...j,
            [merchant.id]: {
              status: res.changed ? "mismatch" : "done",
              merchant,
              classification: res.classification,
              scrapeError: res.scraped?.error,
              changed: res.changed,
            },
          }));

          if (res.changed) {
            setApproved((a) => ({ ...a, [merchant.id]: true }));
            if (
              res.classification.needs_new_category &&
              res.classification.new_category
            )
              setNewCatQueue((q) => [
                ...q,
                {
                  merchant,
                  suggestion: res.classification.new_category,
                  type: "category",
                },
              ]);
            if (
              res.classification.needs_new_subcategory &&
              res.classification.new_subcategory
            )
              setNewCatQueue((q) => [
                ...q,
                {
                  merchant,
                  suggestion: res.classification.new_subcategory,
                  type: "subcategory",
                },
              ]);
          }
        } catch (e) {
          setJobs((j) => ({
            ...j,
            [merchant.id]: { status: "error", merchant, error: e.message },
          }));
        }

        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    };

    await Promise.all(validKeys.map((key) => worker(key)));
    setRunning(false);
  }, [merchants, validKeys, model, categories]);

  // ── Commit ───────────────────────────────────────────────────────────────────
  const commitApproved = async () => {
    const corrections = mismatches
      .filter((j) => approved[j.merchant.id])
      .map((j) => ({
        id: j.merchant.id,
        category_id: j.classification.category_id,
        subcategory_id: j.classification.subcategory_id,
      }));

    // Rejected = mismatches the user unchecked — still mark completed (reviewed, kept as-is)
    const rejected = mismatches
      .filter((j) => !approved[j.merchant.id])
      .map((j) => j.merchant.id);

    if (!corrections.length && !rejected.length) return;
    const res = await post("/merchants/update", { corrections, rejected });
    setCommitResult(res);
    setTab("Results");
  };

  const createCategory = async (item) => {
    const res = await post("/categories/create", { category: item.suggestion });
    if (res.category) {
      setCategories((c) => [...c, res.category]);
      setNewCatQueue((q) => q.filter((x) => x !== item));
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const catName = (id) =>
    categories.find((c) => c.id === id)?.name || (id ? `#${id}` : "—");
  const pct = progress.total
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  const mismatches = Object.values(jobs).filter((j) => j.changed);
  const approvedCount = Object.values(approved).filter(Boolean).length;
  const statusCounts = Object.values(jobs).reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <header style={S.header}>
        <span style={S.logo}>⬡</span>
        <span style={S.title}>Merchant Category Classifier</span>
      </header>

      <nav style={S.nav}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...S.navBtn, ...(tab === t ? S.navActive : {}) }}
          >
            {t}
            {t === "Review" && mismatches.length > 0 && (
              <span style={S.badge}>{mismatches.length}</span>
            )}
          </button>
        ))}
      </nav>

      <main style={S.main}>
        {/* ── CLASSIFIER TAB ── */}
        {tab === "Classifier" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Keys + Model */}
            <div style={S.card}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 14,
                }}
              >
                <h2 style={S.cardTitle}>Gemini API Keys</h2>
                <button style={S.btnSmall} onClick={addKey}>
                  + Add Key
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                {keys.map((k, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <span style={S.keyTag}>Key {i + 1}</span>
                    <input
                      style={{ ...S.input, flex: 1, fontFamily: "monospace" }}
                      type="password"
                      placeholder="AIza..."
                      value={k}
                      onChange={(e) => updateKey(i, e.target.value)}
                    />
                    {keys.length > 1 && (
                      <button style={S.btnGhostSm} onClick={() => removeKey(i)}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <label style={S.label}>
                Model
                <select
                  style={S.input}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="gemini-3.1-flash-lite-preview">
                    gemini-3.1-flash-lite-preview (500 RPD)
                  </option>
                  <option value="gemini-2.5-flash-lite">
                    gemini-2.5-flash-lite (20 RPD)
                  </option>
                  <option value="gemini-3.0-flash">
                    gemini-3.0-flash (20 RPD)
                  </option>
                  <option value="gemini-3-flash">
                    gemini-3-flash (20 RPD)
                  </option>
                </select>
              </label>
            </div>

            {/* Filters + Load */}
            <div style={S.card}>
              <h2 style={{ ...S.cardTitle, marginBottom: 14 }}>Batch</h2>
              <div
                style={{
                  display: "flex",
                  gap: 24,
                  marginBottom: 16,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                {[
                  ["onlyActive", "Active only"],
                  ["onlyPublished", "Published only"],
                ].map(([k, label]) => (
                  <label
                    key={k}
                    style={{
                      ...S.label,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={filter[k]}
                      onChange={(e) =>
                        setFilter((f) => ({ ...f, [k]: e.target.checked }))
                      }
                    />
                    {label}
                  </label>
                ))}
                <div style={{ display: "flex", gap: 4 }}>
                  {STATUS_FILTERS.map((sf) => (
                    <button
                      key={sf.value}
                      onClick={() =>
                        setFilter((f) => ({ ...f, statusFilter: sf.value }))
                      }
                      style={{
                        ...S.btnGhostSm,
                        ...(filter.statusFilter === sf.value
                          ? {
                              background: "#1d4ed8",
                              color: "#fff",
                              borderColor: "#1d4ed8",
                            }
                          : {}),
                      }}
                    >
                      {sf.label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button style={S.btn} onClick={() => loadBatch(0)}>
                  Load {batchSize}
                </button>
                {offset > 0 && (
                  <button
                    style={S.btnGhost}
                    onClick={() => loadBatch(Math.max(0, offset - batchSize))}
                  >
                    ← Prev
                  </button>
                )}
                {offset + batchSize < totalMerchants && (
                  <button
                    style={S.btnGhost}
                    onClick={() => loadBatch(offset + batchSize)}
                  >
                    Next →
                  </button>
                )}
                {merchants.length > 0 && (
                  <span style={{ color: "#6b7280", fontSize: 12 }}>
                    {offset + 1}–{offset + merchants.length} of {totalMerchants}
                    <span style={{ marginLeft: 8, color: "#374151" }}>
                      [
                      {filter.statusFilter === "unprocessed"
                        ? "Unprocessed"
                        : filter.statusFilter === "failed"
                          ? "Failed"
                          : "All"}
                      ]
                    </span>
                  </span>
                )}
              </div>
            </div>

            {/* Progress + Run */}
            {merchants.length > 0 && (
              <div style={S.card}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 14,
                  }}
                >
                  <h2 style={S.cardTitle}>
                    Run — {validKeys.length} key
                    {validKeys.length !== 1 ? "s" : ""} · {validKeys.length}{" "}
                    parallel worker{validKeys.length !== 1 ? "s" : ""}
                  </h2>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      style={S.btn}
                      onClick={runClassification}
                      disabled={running || !validKeys.length}
                    >
                      {running ? "Running…" : "▶ Start"}
                    </button>
                    {running && (
                      <button
                        style={S.btnDanger}
                        onClick={() => {
                          abortRef.current = true;
                        }}
                      >
                        ■ Stop
                      </button>
                    )}
                  </div>
                </div>

                <div style={S.progressBar}>
                  <div style={{ ...S.progressFill, width: `${pct}%` }} />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: "#6b7280",
                    marginTop: 4,
                    marginBottom: 12,
                  }}
                >
                  <span>
                    {progress.done} / {progress.total}
                  </span>
                  <span>{pct}%</span>
                </div>

                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {Object.entries(statusCounts).map(([status, count]) => (
                    <span
                      key={status}
                      style={{
                        fontSize: 12,
                        color: STATUS[status]?.color || "#9ca3af",
                      }}
                    >
                      {STATUS[status]?.label || status}:{" "}
                      <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Job table */}
            {Object.values(jobs).length > 0 && (
              <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
                <div style={{ maxHeight: 480, overflowY: "auto" }}>
                  <table style={S.table}>
                    <thead
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#0b1220",
                        zIndex: 1,
                      }}
                    >
                      <tr>
                        {[
                          "ID",
                          "Store",
                          "Status",
                          "Current Cat",
                          "→ New Cat",
                          "Conf",
                          "Note",
                        ].map((h) => (
                          <th key={h} style={S.th}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.values(jobs).map((j) => (
                        <tr
                          key={j.merchant.id}
                          style={{ borderBottom: "1px solid #1a2235" }}
                        >
                          <td style={S.td}>{j.merchant.id}</td>
                          <td style={S.td}>{j.merchant.name}</td>
                          <td
                            style={{ ...S.td, color: STATUS[j.status]?.color }}
                          >
                            {STATUS[j.status]?.label}
                          </td>
                          <td style={{ ...S.td, color: "#6b7280" }}>
                            {catName(j.merchant.category_id)}
                          </td>
                          <td
                            style={{
                              ...S.td,
                              color: j.changed ? "#10b981" : "#6b7280",
                            }}
                          >
                            {j.classification
                              ? catName(j.classification.category_id)
                              : "—"}
                          </td>
                          <td style={S.td}>
                            {j.classification
                              ? `${Math.round(j.classification.confidence * 100)}%`
                              : "—"}
                          </td>
                          <td
                            style={{
                              ...S.td,
                              fontSize: 11,
                              color: "#6b7280",
                              maxWidth: 220,
                            }}
                          >
                            {j.classification?.reasoning ||
                              j.error ||
                              j.scrapeError ||
                              ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── REVIEW TAB ── */}
        {tab === "Review" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {newCatQueue.length > 0 && (
              <div style={{ ...S.card, borderColor: "#92400e" }}>
                <h2
                  style={{ ...S.cardTitle, color: "#d97706", marginBottom: 12 }}
                >
                  ⚠ New Category Suggestions ({newCatQueue.length})
                </h2>
                {newCatQueue.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 0",
                      borderBottom: "1px solid #1a2235",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <strong style={{ color: "#f3f4f6", fontSize: 13 }}>
                        {item.type === "category"
                          ? "New Category"
                          : "New Subcategory"}
                      </strong>
                      <span
                        style={{
                          color: "#6b7280",
                          fontSize: 11,
                          marginLeft: 8,
                        }}
                      >
                        for: {item.merchant.name}
                      </span>
                      <div
                        style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}
                      >
                        {item.suggestion.name} · {item.suggestion.slug}
                        {item.suggestion.parent_id &&
                          ` · parent: ${catName(item.suggestion.parent_id)}`}
                      </div>
                    </div>
                    <button
                      style={S.btnSmall}
                      onClick={() => createCategory(item)}
                    >
                      Create
                    </button>
                    <button
                      style={S.btnGhostSm}
                      onClick={() =>
                        setNewCatQueue((q) => q.filter((x) => x !== item))
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={S.card}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 14,
                }}
              >
                <h2 style={S.cardTitle}>
                  Mismatches — {mismatches.length} stores
                </h2>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    style={S.btnSmall}
                    onClick={() => {
                      const all = {};
                      mismatches.forEach((j) => {
                        all[j.merchant.id] = true;
                      });
                      setApproved(all);
                    }}
                  >
                    Approve All
                  </button>
                  <button style={S.btnGhostSm} onClick={() => setApproved({})}>
                    Reject All
                  </button>
                  <button
                    style={{ ...S.btn, marginLeft: 4 }}
                    onClick={commitApproved}
                    disabled={!mismatches.length}
                  >
                    Commit ({approvedCount} approved ·{" "}
                    {mismatches.length - approvedCount} rejected)
                  </button>
                </div>
              </div>

              {mismatches.length === 0 ? (
                <p style={{ color: "#4b5563" }}>
                  No mismatches. Run classification first.
                </p>
              ) : (
                <div style={{ maxHeight: 560, overflowY: "auto" }}>
                  <table style={S.table}>
                    <thead
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#0b1220",
                        zIndex: 1,
                      }}
                    >
                      <tr>
                        {[
                          "✓",
                          "ID",
                          "Store",
                          "Old Cat",
                          "Old Sub",
                          "→ Cat",
                          "→ Sub",
                          "Conf",
                          "Reason",
                        ].map((h) => (
                          <th key={h} style={S.th}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {mismatches.map((j) => (
                        <tr
                          key={j.merchant.id}
                          style={{ borderBottom: "1px solid #1a2235" }}
                        >
                          <td style={S.td}>
                            <input
                              type="checkbox"
                              checked={!!approved[j.merchant.id]}
                              onChange={(e) =>
                                setApproved((a) => ({
                                  ...a,
                                  [j.merchant.id]: e.target.checked,
                                }))
                              }
                            />
                          </td>
                          <td style={S.td}>{j.merchant.id}</td>
                          <td style={S.td}>{j.merchant.name}</td>
                          <td style={{ ...S.td, color: "#6b7280" }}>
                            {catName(j.merchant.category_id)}
                          </td>
                          <td style={{ ...S.td, color: "#6b7280" }}>
                            {catName(j.merchant.subcategory_id)}
                          </td>
                          <td style={{ ...S.td, color: "#10b981" }}>
                            {catName(j.classification.category_id)}
                          </td>
                          <td style={{ ...S.td, color: "#10b981" }}>
                            {catName(j.classification.subcategory_id)}
                          </td>
                          <td style={S.td}>
                            {Math.round(j.classification.confidence * 100)}%
                          </td>
                          <td
                            style={{
                              ...S.td,
                              fontSize: 11,
                              color: "#6b7280",
                              maxWidth: 200,
                            }}
                          >
                            {j.classification.reasoning}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── RESULTS TAB ── */}
        {tab === "Results" && (
          <div style={S.card}>
            <h2 style={S.cardTitle}>Commit Results</h2>
            {!commitResult ? (
              <p style={{ color: "#4b5563" }}>
                No commit yet. Approve and commit from Review.
              </p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 40, marginBottom: 24 }}>
                  <div style={S.stat}>
                    <span style={{ ...S.statNum, color: "#10b981" }}>
                      {commitResult.updated?.length || 0}
                    </span>
                    <span style={S.statLabel}>Updated</span>
                  </div>
                  <div style={S.stat}>
                    <span style={{ ...S.statNum, color: "#ef4444" }}>
                      {commitResult.failed?.length || 0}
                    </span>
                    <span style={S.statLabel}>Failed</span>
                  </div>
                </div>

                {commitResult.updated?.length > 0 && (
                  <>
                    <h3
                      style={{
                        color: "#10b981",
                        fontSize: 11,
                        marginBottom: 8,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      Updated Store IDs
                    </h3>
                    <div style={S.idBox}>{commitResult.updated.join(", ")}</div>
                    <button
                      style={{ ...S.btnGhost, marginTop: 8 }}
                      onClick={() =>
                        navigator.clipboard.writeText(
                          commitResult.updated.join(", "),
                        )
                      }
                    >
                      Copy IDs
                    </button>
                  </>
                )}

                {commitResult.failed?.length > 0 && (
                  <>
                    <h3
                      style={{
                        color: "#ef4444",
                        fontSize: 11,
                        marginTop: 20,
                        marginBottom: 8,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      Failed
                    </h3>
                    {commitResult.failed.map((f) => (
                      <div
                        key={f.id}
                        style={{
                          fontSize: 12,
                          color: "#f97316",
                          marginBottom: 4,
                        }}
                      >
                        ID {f.id}: {f.error}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const S = {
  root: {
    minHeight: "100vh",
    background: "#060d1a",
    color: "#e5e7eb",
    fontFamily: "'DM Mono', 'Fira Code', monospace",
    fontSize: 14,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "16px 24px",
    borderBottom: "1px solid #111827",
    background: "#040b16",
  },
  logo: { fontSize: 20, color: "#3b82f6" },
  title: { fontWeight: 700, fontSize: 15, letterSpacing: "0.06em" },
  nav: {
    display: "flex",
    padding: "0 20px",
    background: "#040b16",
    borderBottom: "1px solid #111827",
  },
  navBtn: {
    padding: "10px 16px",
    background: "none",
    border: "none",
    color: "#6b7280",
    cursor: "pointer",
    fontSize: 13,
    borderBottom: "2px solid transparent",
    position: "relative",
  },
  navActive: { color: "#3b82f6", borderBottom: "2px solid #3b82f6" },
  badge: {
    background: "#ef4444",
    color: "#fff",
    borderRadius: 9,
    fontSize: 10,
    padding: "1px 5px",
    marginLeft: 5,
  },
  main: { padding: 20, maxWidth: 1280, margin: "0 auto" },
  card: {
    background: "#0b1220",
    border: "1px solid #1a2235",
    borderRadius: 8,
    padding: 20,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#6b7280",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    margin: 0,
  },
  keyTag: { fontSize: 11, color: "#4b5563", minWidth: 40 },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 12,
    color: "#6b7280",
  },
  input: {
    background: "#0d1526",
    border: "1px solid #1a2235",
    borderRadius: 6,
    padding: "8px 10px",
    color: "#e5e7eb",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
  },
  btn: {
    background: "#1d4ed8",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  btnGhost: {
    background: "none",
    color: "#6b7280",
    border: "1px solid #1f2937",
    borderRadius: 6,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 13,
  },
  btnDanger: {
    background: "#7f1d1d",
    color: "#fca5a5",
    border: "none",
    borderRadius: 6,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 13,
  },
  btnSmall: {
    background: "#064e3b",
    color: "#6ee7b7",
    border: "none",
    borderRadius: 5,
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  btnGhostSm: {
    background: "none",
    color: "#6b7280",
    border: "1px solid #1f2937",
    borderRadius: 5,
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: 12,
  },
  progressBar: {
    height: 5,
    background: "#1a2235",
    borderRadius: 9,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg,#1d4ed8,#60a5fa)",
    transition: "width 0.25s ease",
    borderRadius: 9,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "8px 12px",
    textAlign: "left",
    fontSize: 10,
    color: "#374151",
    borderBottom: "1px solid #1a2235",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "7px 12px",
    fontSize: 12,
    color: "#9ca3af",
    verticalAlign: "top",
  },
  stat: { display: "flex", flexDirection: "column", alignItems: "center" },
  statNum: { fontSize: 40, fontWeight: 700, lineHeight: 1 },
  statLabel: { fontSize: 11, color: "#4b5563", marginTop: 4 },
  idBox: {
    background: "#0d1526",
    border: "1px solid #1a2235",
    borderRadius: 6,
    padding: 12,
    fontSize: 12,
    color: "#6ee7b7",
    lineHeight: 1.8,
    maxHeight: 200,
    overflowY: "auto",
    wordBreak: "break-all",
  },
};
