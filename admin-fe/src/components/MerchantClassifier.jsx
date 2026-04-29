import { useState, useCallback, useRef } from "react";

const API = "https://admin-api.savingharbor.com/api/classifier";

const post = (path, body) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const TABS = ["Config", "Run", "Review", "Results"];

const STATUS = {
  idle: { label: "Idle", color: "#6b7280" },
  pending: { label: "Queued", color: "#d97706" },
  scraping: { label: "Scraping", color: "#3b82f6" },
  classifying: { label: "Classifying", color: "#8b5cf6" },
  done: { label: "Done", color: "#10b981" },
  mismatch: { label: "Mismatch", color: "#ef4444" },
  error: { label: "Error", color: "#f97316" },
};

export default function App() {
  const [tab, setTab] = useState("Config");

  // Config
  const [db, setDb] = useState({
    host: "",
    port: "5432",
    database: "",
    user: "",
    password: "",
    ssl: true,
  });
  const [geminiKey, setGeminiKey] = useState("");
  const [model, setModel] = useState("gemini-3.1-flash-lite-preview");
  const [batchSize] = useState(500);
  const [filter, setFilter] = useState({
    onlyActive: false,
    onlyPublished: false,
  });
  const [dbOk, setDbOk] = useState(null);

  // Data
  const [categories, setCategories] = useState([]);
  const [merchants, setMerchants] = useState([]);
  const [totalMerchants, setTotalMerchants] = useState(0);
  const [offset, setOffset] = useState(0);

  // Run
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState({}); // id -> { status, classification, merchant, changed }
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);

  // Review
  const [approved, setApproved] = useState({}); // id -> bool
  const [newCatQueue, setNewCatQueue] = useState([]); // pending new category creates

  // Results
  const [commitResult, setCommitResult] = useState(null);

  // ── Config ──────────────────────────────────────────────────────────────────
  const testConnection = async () => {
    setDbOk(null);
    const r = await post("/test-connection", db);
    setDbOk(r.ok);
    if (r.ok) {
      const catRes = await post("/categories", { db });
      setCategories(catRes.categories || []);
    }
  };

  const loadBatch = async (off = 0) => {
    const res = await post("/merchants/batch", {
      db,
      offset: off,
      limit: batchSize,
      filter,
    });
    setMerchants(res.merchants || []);
    setTotalMerchants(res.total || 0);
    setOffset(off);
    setJobs({});
    setProgress({ done: 0, total: res.merchants?.length || 0 });
    setApproved({});
    setCommitResult(null);
  };

  // ── Run ──────────────────────────────────────────────────────────────────────
  const runClassification = useCallback(async () => {
    if (!merchants.length) return;
    abortRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: merchants.length });

    const CONCURRENCY = 3;
    let idx = 0;

    const worker = async () => {
      while (idx < merchants.length) {
        if (abortRef.current) break;
        const merchant = merchants[idx++];
        setJobs((j) => ({
          ...j,
          [merchant.id]: { status: "scraping", merchant },
        }));

        try {
          const res = await post("/classify", {
            db,
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
            setApproved((a) => ({ ...a, [merchant.id]: true })); // default approve

            // Queue new category creation prompts
            if (
              res.classification.needs_new_category &&
              res.classification.new_category
            ) {
              setNewCatQueue((q) => [
                ...q,
                {
                  merchant,
                  suggestion: res.classification.new_category,
                  type: "category",
                },
              ]);
            }
            if (
              res.classification.needs_new_subcategory &&
              res.classification.new_subcategory
            ) {
              setNewCatQueue((q) => [
                ...q,
                {
                  merchant,
                  suggestion: res.classification.new_subcategory,
                  type: "subcategory",
                },
              ]);
            }
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

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);
  }, [merchants, db, geminiKey, model, categories]);

  const stopRun = () => {
    abortRef.current = true;
  };

  // ── Review ───────────────────────────────────────────────────────────────────
  const mismatches = Object.values(jobs).filter((j) => j.changed);

  const commitApproved = async () => {
    const corrections = mismatches
      .filter((j) => approved[j.merchant.id])
      .map((j) => ({
        id: j.merchant.id,
        category_id: j.classification.category_id,
        subcategory_id: j.classification.subcategory_id,
      }));
    if (!corrections.length) return;
    const res = await post("/merchants/update", { db, corrections });
    setCommitResult(res);
    setTab("Results");
  };

  const createCategory = async (item) => {
    const res = await post("/categories/create", {
      db,
      category: item.suggestion,
    });
    if (res.category) {
      setCategories((c) => [...c, res.category]);
      setNewCatQueue((q) => q.filter((x) => x !== item));
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const catName = (id) => categories.find((c) => c.id === id)?.name || `#${id}`;

  const pct = progress.total
    ? Math.round((progress.done / progress.total) * 100)
    : 0;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={S.root}>
      <header style={S.header}>
        <span style={S.logo}>⬡</span>
        <span style={S.title}>Merchant Category Classifier</span>
        <span style={S.sub}>Powered by Gemini</span>
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
        {/* ── CONFIG TAB ── */}
        {tab === "Config" && (
          <div style={S.card}>
            <h2 style={S.cardTitle}>Database Connection</h2>
            <div style={S.grid2}>
              {[
                ["Host", "host", "db-host.example.com"],
                ["Port", "port", "5432"],
                ["Database", "database", "mydb"],
                ["User", "user", "postgres"],
              ].map(([label, key, ph]) => (
                <label key={key} style={S.label}>
                  {label}
                  <input
                    style={S.input}
                    placeholder={ph}
                    value={db[key]}
                    onChange={(e) =>
                      setDb((d) => ({ ...d, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
              <label style={S.label}>
                Password
                <input
                  style={S.input}
                  type="password"
                  value={db.password}
                  onChange={(e) =>
                    setDb((d) => ({ ...d, password: e.target.value }))
                  }
                />
              </label>
              <label
                style={{
                  ...S.label,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <input
                  type="checkbox"
                  checked={db.ssl}
                  onChange={(e) =>
                    setDb((d) => ({ ...d, ssl: e.target.checked }))
                  }
                />
                SSL
              </label>
            </div>
            <button style={S.btn} onClick={testConnection}>
              Test Connection
            </button>
            {dbOk === true && (
              <p style={{ color: "#10b981", marginTop: 8 }}>
                ✓ Connected — {categories.length} categories loaded
              </p>
            )}
            {dbOk === false && (
              <p style={{ color: "#ef4444", marginTop: 8 }}>
                ✗ Connection failed
              </p>
            )}

            <h2 style={{ ...S.cardTitle, marginTop: 32 }}>Gemini API</h2>
            <label style={S.label}>
              API Key
              <input
                style={S.input}
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIza..."
              />
            </label>
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
                <option value="gemini-3-flash">gemini-3-flash (20 RPD)</option>
              </select>
            </label>

            <h2 style={{ ...S.cardTitle, marginTop: 32 }}>Batch Filters</h2>
            <div style={{ display: "flex", gap: 24 }}>
              {[
                ["onlyActive", "Active merchants only"],
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
            </div>
          </div>
        )}

        {/* ── RUN TAB ── */}
        {tab === "Run" && (
          <div>
            <div style={S.card}>
              <h2 style={S.cardTitle}>Batch Control</h2>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  style={S.btn}
                  onClick={() => loadBatch(0)}
                  disabled={!dbOk}
                >
                  Load First {batchSize}
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
                <span style={{ color: "#9ca3af", fontSize: 13 }}>
                  {merchants.length > 0 &&
                    `Showing ${offset + 1}–${offset + merchants.length} of ${totalMerchants}`}
                </span>
              </div>

              {merchants.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={S.progressBar}>
                    <div style={{ ...S.progressFill, width: `${pct}%` }} />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      color: "#9ca3af",
                      marginTop: 4,
                    }}
                  >
                    <span>
                      {progress.done} / {progress.total} processed
                    </span>
                    <span>{pct}%</span>
                  </div>

                  <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
                    <button
                      style={S.btn}
                      onClick={runClassification}
                      disabled={running}
                    >
                      {running ? "Running…" : "▶ Run Classification"}
                    </button>
                    {running && (
                      <button style={S.btnDanger} onClick={stopRun}>
                        ■ Stop
                      </button>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 16,
                      marginTop: 16,
                      fontSize: 13,
                    }}
                  >
                    {Object.entries(
                      Object.values(jobs).reduce((acc, j) => {
                        acc[j.status] = (acc[j.status] || 0) + 1;
                        return acc;
                      }, {}),
                    ).map(([status, count]) => (
                      <span
                        key={status}
                        style={{ color: STATUS[status]?.color || "#fff" }}
                      >
                        {STATUS[status]?.label || status}: {count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Job list */}
            {Object.values(jobs).length > 0 && (
              <div
                style={{
                  ...S.card,
                  marginTop: 16,
                  maxHeight: 420,
                  overflowY: "auto",
                }}
              >
                <table style={S.table}>
                  <thead>
                    <tr>
                      {[
                        "ID",
                        "Store",
                        "Status",
                        "Old Cat",
                        "New Cat",
                        "Confidence",
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
                        style={{ borderBottom: "1px solid #1f2937" }}
                      >
                        <td style={S.td}>{j.merchant.id}</td>
                        <td style={S.td}>{j.merchant.name}</td>
                        <td style={{ ...S.td, color: STATUS[j.status]?.color }}>
                          {STATUS[j.status]?.label}
                        </td>
                        <td style={S.td}>{catName(j.merchant.category_id)}</td>
                        <td style={S.td}>
                          {j.classification
                            ? catName(j.classification.category_id)
                            : "—"}
                        </td>
                        <td style={S.td}>
                          {j.classification
                            ? `${Math.round(j.classification.confidence * 100)}%`
                            : "—"}
                        </td>
                        <td style={{ ...S.td, fontSize: 11, color: "#9ca3af" }}>
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
            )}
          </div>
        )}

        {/* ── REVIEW TAB ── */}
        {tab === "Review" && (
          <div>
            {newCatQueue.length > 0 && (
              <div
                style={{ ...S.card, borderColor: "#d97706", marginBottom: 16 }}
              >
                <h2 style={{ ...S.cardTitle, color: "#d97706" }}>
                  ⚠ New Category Suggestions ({newCatQueue.length})
                </h2>
                {newCatQueue.map((item, i) => (
                  <div key={i} style={S.newCatRow}>
                    <div>
                      <strong style={{ color: "#f3f4f6" }}>
                        {item.type === "category"
                          ? "New Category"
                          : "New Subcategory"}
                      </strong>
                      <span
                        style={{
                          color: "#9ca3af",
                          marginLeft: 8,
                          fontSize: 12,
                        }}
                      >
                        for: {item.merchant.name}
                      </span>
                      <div
                        style={{ fontSize: 13, color: "#d1d5db", marginTop: 4 }}
                      >
                        Name: {item.suggestion.name} · Slug:{" "}
                        {item.suggestion.slug}
                        {item.suggestion.parent_id &&
                          ` · Parent: ${catName(item.suggestion.parent_id)}`}
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
                  marginBottom: 16,
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
                    style={{ ...S.btn, marginLeft: 8 }}
                    onClick={commitApproved}
                    disabled={!Object.values(approved).some(Boolean)}
                  >
                    Commit {Object.values(approved).filter(Boolean).length}{" "}
                    Updates
                  </button>
                </div>
              </div>

              {mismatches.length === 0 ? (
                <p style={{ color: "#6b7280" }}>
                  No mismatches found. Run classification first.
                </p>
              ) : (
                <div style={{ maxHeight: 520, overflowY: "auto" }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {[
                          "Approve",
                          "ID",
                          "Store",
                          "Old Category",
                          "Old Sub",
                          "→ New Category",
                          "→ New Sub",
                          "Conf",
                          "Reasoning",
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
                          style={{ borderBottom: "1px solid #1f2937" }}
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
                          <td style={{ ...S.td, color: "#9ca3af" }}>
                            {catName(j.merchant.category_id)}
                          </td>
                          <td style={{ ...S.td, color: "#9ca3af" }}>
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
                              color: "#9ca3af",
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
              <p style={{ color: "#6b7280" }}>
                No commit yet. Approve and commit from the Review tab.
              </p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 32, marginBottom: 24 }}>
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
                    <h3 style={{ color: "#10b981", marginBottom: 8 }}>
                      Updated Store IDs
                    </h3>
                    <div style={S.idBox}>{commitResult.updated.join(", ")}</div>
                    <button
                      style={{ ...S.btnGhost, marginTop: 8 }}
                      onClick={() => {
                        navigator.clipboard.writeText(
                          commitResult.updated.join(", "),
                        );
                      }}
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
                        marginTop: 16,
                        marginBottom: 8,
                      }}
                    >
                      Failed
                    </h3>
                    {commitResult.failed.map((f) => (
                      <div
                        key={f.id}
                        style={{ fontSize: 12, color: "#f97316" }}
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

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  root: {
    minHeight: "100vh",
    background: "#030712",
    color: "#f3f4f6",
    fontFamily: "'DM Mono', 'Fira Code', monospace",
    fontSize: 14,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "18px 28px",
    borderBottom: "1px solid #111827",
    background: "#050c1a",
  },
  logo: { fontSize: 24, color: "#3b82f6" },
  title: {
    fontWeight: 700,
    fontSize: 16,
    letterSpacing: "0.05em",
    color: "#f9fafb",
  },
  sub: { fontSize: 11, color: "#4b5563", marginLeft: "auto" },
  nav: {
    display: "flex",
    gap: 2,
    padding: "0 24px",
    background: "#050c1a",
    borderBottom: "1px solid #111827",
  },
  navBtn: {
    padding: "10px 18px",
    background: "none",
    border: "none",
    color: "#6b7280",
    cursor: "pointer",
    fontSize: 13,
    letterSpacing: "0.04em",
    position: "relative",
    borderBottom: "2px solid transparent",
  },
  navActive: { color: "#3b82f6", borderBottom: "2px solid #3b82f6" },
  badge: {
    background: "#ef4444",
    color: "#fff",
    borderRadius: 9,
    fontSize: 10,
    padding: "1px 6px",
    marginLeft: 6,
  },
  main: { padding: 24, maxWidth: 1200, margin: "0 auto" },
  card: {
    background: "#0d1117",
    border: "1px solid #1f2937",
    borderRadius: 8,
    padding: 24,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e5e7eb",
    marginBottom: 16,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginBottom: 16,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 12,
    color: "#9ca3af",
  },
  input: {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 6,
    padding: "8px 12px",
    color: "#f3f4f6",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
  },
  btn: {
    background: "#1d4ed8",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "9px 18px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "0.03em",
  },
  btnGhost: {
    background: "none",
    color: "#6b7280",
    border: "1px solid #374151",
    borderRadius: 6,
    padding: "9px 18px",
    cursor: "pointer",
    fontSize: 13,
  },
  btnDanger: {
    background: "#7f1d1d",
    color: "#fca5a5",
    border: "none",
    borderRadius: 6,
    padding: "9px 18px",
    cursor: "pointer",
    fontSize: 13,
  },
  btnSmall: {
    background: "#065f46",
    color: "#6ee7b7",
    border: "none",
    borderRadius: 5,
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  btnGhostSm: {
    background: "none",
    color: "#6b7280",
    border: "1px solid #374151",
    borderRadius: 5,
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: 12,
  },
  progressBar: {
    height: 6,
    background: "#1f2937",
    borderRadius: 9,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #1d4ed8, #3b82f6)",
    transition: "width 0.3s ease",
    borderRadius: 9,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    padding: "8px 12px",
    textAlign: "left",
    fontSize: 11,
    color: "#4b5563",
    borderBottom: "1px solid #1f2937",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  td: {
    padding: "8px 12px",
    fontSize: 12,
    color: "#d1d5db",
    verticalAlign: "top",
  },
  newCatRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "12px 0",
    borderBottom: "1px solid #1f2937",
  },
  stat: { display: "flex", flexDirection: "column", alignItems: "center" },
  statNum: { fontSize: 36, fontWeight: 700 },
  statLabel: { fontSize: 12, color: "#6b7280" },
  idBox: {
    background: "#111827",
    border: "1px solid #1f2937",
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
