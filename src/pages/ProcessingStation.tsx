import { useEffect, useState, useMemo } from "react";
import {
  collection, getDocs, addDoc, doc, orderBy, query,
  onSnapshot, updateDoc, runTransaction, getDoc,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuthStore } from "../store/authStore";
import { useModalKeyboard } from "../hooks/useModalKeyboard";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface RecipeInput {
  productId: string;
  productName: string;
  unit: string;
  qtyPerBatch: number;
}
export interface RecipeOutput {
  productId: string;
  productName: string;
  unit: string;
  qtyPerBatch: number;
}
export interface ProcessingRecipe {
  id?: string;
  name: string;
  description?: string;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SessionInput {
  productId: string;
  productName: string;
  unit: string;
  expectedQty: number;
  actualQty: number;  // confirmed at stage 1
}
export interface SessionOutput {
  productId: string;
  productName: string;
  unit: string;
  expectedQty: number;
  actualQty: number;  // filled at stage 2
}
export interface ProcessingSession {
  id?: string;
  recipeId: string;
  recipeName: string;
  batchCount: number;
  inputs: SessionInput[];
  outputs: SessionOutput[];
  status: "in_progress" | "completed" | "cancelled";
  wasteNotes: string;
  yieldPct: number;
  startedBy: string;
  startedByName: string;
  startedAt: string;
  completedBy?: string;
  completedByName?: string;
  completedAt?: string;
  cancelledBy?: string;
  cancelledByName?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

const inp = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";
function fmtNum(n: number) { return parseFloat(n.toFixed(4)).toString(); }
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ProcessingStation() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const [recipes, setRecipes]     = useState<ProcessingRecipe[]>([]);
  const [products, setProducts]   = useState<{ id: string; name: string; unit: string; stock: number }[]>([]);
  const [inProgress, setInProgress] = useState<ProcessingSession[]>([]);
  const [completed, setCompleted]   = useState<ProcessingSession[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<"pipeline" | "start" | "recipes" | "history">("pipeline");

  // ── Start Processing state ────────────────────────────────────────────────
  const [selectedRecipe, setSelectedRecipe] = useState<ProcessingRecipe | null>(null);
  const [batchCount, setBatchCount]         = useState("1");
  const [actualInputs, setActualInputs]     = useState<Record<string, string>>({});
  const [starting, setStarting]             = useState(false);
  const [startSuccess, setStartSuccess]     = useState(false);

  // ── Complete Processing state ─────────────────────────────────────────────
  const [completeModal, setCompleteModal]   = useState<ProcessingSession | null>(null);
  const [actualOutputs, setActualOutputs]   = useState<Record<string, string>>({});
  const [wasteNotes, setWasteNotes]         = useState("");
  const [completing, setCompleting]         = useState(false);

  // ── Cancel state ──────────────────────────────────────────────────────────
  const [cancelModal, setCancelModal]       = useState<ProcessingSession | null>(null);
  const [cancelReason, setCancelReason]     = useState("");
  const [cancelling, setCancelling]         = useState(false);

  // ── Recipe editor state ───────────────────────────────────────────────────
  const [showRecipeForm, setShowRecipeForm] = useState(false);
  const [editRecipe, setEditRecipe]         = useState<ProcessingRecipe | null>(null);
  const [recipeForm, setRecipeForm]         = useState<Partial<ProcessingRecipe>>({
    name: "", description: "", inputs: [], outputs: [], isActive: true,
  });
  const [recipeSaving, setRecipeSaving]     = useState(false);

  useModalKeyboard({ onClose: () => { setShowRecipeForm(false); setCompleteModal(null); setCancelModal(null); }, confirmOnEnter: false });

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, "processingRecipes"), orderBy("name")), snap => {
      setRecipes(snap.docs.map(d => ({ id: d.id, ...d.data() } as ProcessingRecipe)));
    });
    const u2 = onSnapshot(query(collection(db, "products"), orderBy("name")), snap => {
      setProducts(snap.docs.map(d => ({ id: d.id, name: d.data().name, unit: d.data().unit, stock: d.data().stock || 0 })));
      setLoading(false);
    });
    const u3 = onSnapshot(
      query(collection(db, "processingSessions"), orderBy("startedAt", "desc")),
      snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as ProcessingSession));
        setInProgress(all.filter(s => s.status === "in_progress"));
        setCompleted(all.filter(s => s.status !== "in_progress"));
      }
    );
    return () => { u1(); u2(); u3(); };
  }, []);

  // ── Pre-fill inputs when recipe/batch changes ─────────────────────────────
  useEffect(() => {
    if (!selectedRecipe) { setActualInputs({}); return; }
    const bc = parseFloat(batchCount) || 1;
    const map: Record<string, string> = {};
    selectedRecipe.inputs.forEach(i => { map[i.productId] = fmtNum(i.qtyPerBatch * bc); });
    setActualInputs(map);
  }, [selectedRecipe, batchCount]);

  // ── Pre-fill outputs when complete modal opens ────────────────────────────
  useEffect(() => {
    if (!completeModal) { setActualOutputs({}); setWasteNotes(""); return; }
    const map: Record<string, string> = {};
    completeModal.outputs.forEach(o => { map[o.productId] = fmtNum(o.expectedQty); });
    setActualOutputs(map);
  }, [completeModal]);

  // ── Yield preview for complete modal ─────────────────────────────────────
  const yieldPreview = useMemo(() => {
    if (!completeModal) return null;
    let totalExpected = 0, totalActual = 0, totalInput = 0;
    completeModal.outputs.forEach(o => {
      totalExpected += o.expectedQty;
      totalActual   += parseFloat(actualOutputs[o.productId] || "0") || 0;
    });
    completeModal.inputs.forEach(i => { totalInput += i.actualQty; });
    const yieldPct = totalExpected > 0 ? (totalActual / totalExpected) * 100 : 0;
    const waste    = Math.max(0, totalInput - totalActual);
    return { totalExpected, totalActual, yieldPct, waste };
  }, [completeModal, actualOutputs]);

  // ── STAGE 1: Start Processing ─────────────────────────────────────────────
  const handleStart = async () => {
    if (!selectedRecipe || !user) return;
    setStarting(true);
    try {
      const bc = parseFloat(batchCount) || 1;
      const sessionInputs: SessionInput[] = selectedRecipe.inputs.map(i => ({
        productId: i.productId, productName: i.productName, unit: i.unit,
        expectedQty: i.qtyPerBatch * bc,
        actualQty: parseFloat(actualInputs[i.productId] || "0") || 0,
      }));
      const sessionOutputs: SessionOutput[] = selectedRecipe.outputs.map(o => ({
        productId: o.productId, productName: o.productName, unit: o.unit,
        expectedQty: o.qtyPerBatch * bc, actualQty: 0,
      }));
      const now = new Date().toISOString();

      // Transaction: reduce raw material stocks
      await runTransaction(db, async t => {
        const refs  = sessionInputs.map(i => doc(db, "products", i.productId));
        const snaps = await Promise.all(refs.map(r => t.get(r)));
        sessionInputs.forEach((inp, idx) => {
          const cur = snaps[idx].data()?.stock || 0;
          t.update(refs[idx], {
            stock: parseFloat(Math.max(0, cur - inp.actualQty).toFixed(4)),
            updatedAt: now,
          });
        });
      });

      // Write stock movements for inputs
      await Promise.all(sessionInputs.map(i =>
        addDoc(collection(db, "products", i.productId, "stockMovements"), {
          type: "processing_out", direction: "out", qty: i.actualQty,
          stockBefore: 0, stockAfter: 0,
          reason: `Processing started: ${selectedRecipe.name} (${bc} batch${bc > 1 ? "es" : ""})`,
          createdBy: user.uid, createdByName: user.name, createdAt: now,
        })
      ));

      // Create session record
      const session: Omit<ProcessingSession, "id"> = {
        recipeId: selectedRecipe.id!, recipeName: selectedRecipe.name,
        batchCount: bc, inputs: sessionInputs, outputs: sessionOutputs,
        status: "in_progress", wasteNotes: "", yieldPct: 0,
        startedBy: user.uid, startedByName: user.name, startedAt: now,
      };
      await addDoc(collection(db, "processingSessions"), session);

      setStartSuccess(true);
      setSelectedRecipe(null);
      setBatchCount("1");
      setTab("pipeline");
      setTimeout(() => setStartSuccess(false), 5000);
    } catch (err: any) {
      alert(`Failed to start processing: ${err.message}`);
    }
    setStarting(false);
  };

  // ── STAGE 2: Complete Processing ──────────────────────────────────────────
  const handleComplete = async () => {
    if (!completeModal || !user) return;
    setCompleting(true);
    try {
      const now = new Date().toISOString();
      const finalOutputs: SessionOutput[] = completeModal.outputs.map(o => ({
        ...o,
        actualQty: parseFloat(actualOutputs[o.productId] || "0") || 0,
      }));
      const yieldPct = yieldPreview?.yieldPct ?? 0;

      // Transaction: increase finished product stocks
      await runTransaction(db, async t => {
        const refs  = finalOutputs.map(o => doc(db, "products", o.productId));
        const snaps = await Promise.all(refs.map(r => t.get(r)));
        finalOutputs.forEach((out, idx) => {
          const cur = snaps[idx].data()?.stock || 0;
          t.update(refs[idx], {
            stock: parseFloat((cur + out.actualQty).toFixed(4)),
            updatedAt: now,
          });
        });
      });

      // Write stock movements for outputs
      await Promise.all(finalOutputs.map(o =>
        addDoc(collection(db, "products", o.productId, "stockMovements"), {
          type: "processing_in", direction: "in", qty: o.actualQty,
          stockBefore: 0, stockAfter: 0,
          reason: `Processing completed: ${completeModal.recipeName} (${completeModal.batchCount} batch${completeModal.batchCount > 1 ? "es" : ""})`,
          createdBy: user.uid, createdByName: user.name, createdAt: now,
        })
      ));

      // Update session
      await updateDoc(doc(db, "processingSessions", completeModal.id!), {
        status: "completed", outputs: finalOutputs,
        wasteNotes: wasteNotes.trim(), yieldPct,
        completedBy: user.uid, completedByName: user.name, completedAt: now,
      });

      setCompleteModal(null);
    } catch (err: any) {
      alert(`Failed to complete processing: ${err.message}`);
    }
    setCompleting(false);
  };

  // ── Cancel Processing (with stock reversal) ───────────────────────────────
  const handleCancel = async () => {
    if (!cancelModal || !user || !cancelReason.trim()) return;
    setCancelling(true);
    try {
      const now = new Date().toISOString();

      // Reverse: return raw materials to stock
      await runTransaction(db, async t => {
        const refs  = cancelModal.inputs.map(i => doc(db, "products", i.productId));
        const snaps = await Promise.all(refs.map(r => t.get(r)));
        cancelModal.inputs.forEach((inp, idx) => {
          const cur = snaps[idx].data()?.stock || 0;
          t.update(refs[idx], {
            stock: parseFloat((cur + inp.actualQty).toFixed(4)),
            updatedAt: now,
          });
        });
      });

      // Write reversal stock movements
      await Promise.all(cancelModal.inputs.map(i =>
        addDoc(collection(db, "products", i.productId, "stockMovements"), {
          type: "processing_cancelled", direction: "in", qty: i.actualQty,
          stockBefore: 0, stockAfter: 0,
          reason: `Processing cancelled: ${cancelModal.recipeName} — ${cancelReason.trim()}`,
          createdBy: user.uid, createdByName: user.name, createdAt: now,
        })
      ));

      // Update session
      await updateDoc(doc(db, "processingSessions", cancelModal.id!), {
        status: "cancelled", cancelReason: cancelReason.trim(),
        cancelledBy: user.uid, cancelledByName: user.name, cancelledAt: now,
      });

      setCancelModal(null); setCancelReason("");
    } catch (err: any) {
      alert(`Failed to cancel: ${err.message}`);
    }
    setCancelling(false);
  };

  // ── Recipe CRUD ───────────────────────────────────────────────────────────
  const openNewRecipe = () => {
    setEditRecipe(null);
    setRecipeForm({ name: "", description: "", inputs: [], outputs: [], isActive: true });
    setShowRecipeForm(true);
  };
  const updateRecipeInput = (idx: number, field: keyof RecipeInput, value: string | number) => {
    setRecipeForm(f => {
      const inputs = [...(f.inputs || [])];
      inputs[idx] = { ...inputs[idx], [field]: value };
      if (field === "productId") {
        const prod = products.find(p => p.id === value);
        if (prod) { inputs[idx].productName = prod.name; inputs[idx].unit = prod.unit; }
      }
      return { ...f, inputs };
    });
  };
  const updateRecipeOutput = (idx: number, field: keyof RecipeOutput, value: string | number) => {
    setRecipeForm(f => {
      const outputs = [...(f.outputs || [])];
      outputs[idx] = { ...outputs[idx], [field]: value };
      if (field === "productId") {
        const prod = products.find(p => p.id === value);
        if (prod) { outputs[idx].productName = prod.name; outputs[idx].unit = prod.unit; }
      }
      return { ...f, outputs };
    });
  };
  const handleSaveRecipe = async () => {
    if (!recipeForm.name?.trim()) { alert("Recipe name is required."); return; }
    if (!recipeForm.inputs?.length) { alert("Add at least one input."); return; }
    if (!recipeForm.outputs?.length) { alert("Add at least one output."); return; }
    setRecipeSaving(true);
    const now = new Date().toISOString();
    try {
      if (editRecipe?.id) {
        await updateDoc(doc(db, "processingRecipes", editRecipe.id), { ...recipeForm, updatedAt: now });
      } else {
        await addDoc(collection(db, "processingRecipes"), { ...recipeForm, createdAt: now, updatedAt: now });
      }
      setShowRecipeForm(false); setEditRecipe(null);
    } catch (err: any) { alert(err.message); }
    setRecipeSaving(false);
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading…</div>;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Stock Processing</h1>
          <p className="text-sm text-gray-500 mt-0.5">Convert raw materials into finished products</p>
        </div>
        <div className="flex gap-2">
          {inProgress.length > 0 && (
            <span className="bg-orange-100 text-orange-700 text-xs font-semibold px-3 py-1.5 rounded-full border border-orange-200">
              🔄 {inProgress.length} in progress
            </span>
          )}
          {isAdmin && tab === "recipes" && (
            <button onClick={openNewRecipe}
              className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              + New Recipe
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
        {[
          { key: "pipeline", label: "🔄 Pipeline" },
          { key: "start",    label: "▶️ Start Processing" },
          { key: "recipes",  label: "📋 Recipes" },
          { key: "history",  label: "🕐 History" },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.key ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}>
            {t.label}
            {t.key === "pipeline" && inProgress.length > 0 && (
              <span className="ml-1.5 bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{inProgress.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── PIPELINE TAB ─────────────────────────────────────────────────── */}
      {tab === "pipeline" && (
        <div className="space-y-4">
          {startSuccess && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-4 text-green-700 text-sm font-medium">
              ✅ Processing started! Raw materials have been deducted. Complete when packing is done.
            </div>
          )}
          {inProgress.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm p-10 text-center text-gray-400">
              <p className="text-4xl mb-3">✅</p>
              <p className="font-medium text-gray-500">No sessions in progress</p>
              <p className="text-xs mt-1">Click "▶️ Start Processing" to begin a new batch</p>
            </div>
          ) : inProgress.map(sess => (
            <div key={sess.id} className="bg-white rounded-xl shadow-sm border-l-4 border-orange-400 p-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-800 text-base">{sess.recipeName}</span>
                    <span className="bg-orange-100 text-orange-700 text-xs px-2 py-0.5 rounded-full font-medium">🔄 In Progress</span>
                    <span className="text-xs text-gray-400">{sess.batchCount} batch{sess.batchCount > 1 ? "es" : ""}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Started by {sess.startedByName} · {fmtDateTime(sess.startedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setCompleteModal(sess); }}
                    className="bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-green-600">
                    ✅ Complete
                  </button>
                  {isAdmin && (
                    <button onClick={() => { setCancelModal(sess); setCancelReason(""); }}
                      className="bg-red-100 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-200">
                      ✕ Cancel
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-red-50 rounded-lg p-3">
                  <p className="text-xs font-semibold text-red-600 uppercase mb-1">📥 Raw Materials Consumed</p>
                  {sess.inputs.map((i, idx) => (
                    <p key={idx} className="text-sm text-gray-700">
                      {i.productName}: <span className="font-semibold">{fmtNum(i.actualQty)} {i.unit}</span>
                    </p>
                  ))}
                </div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <p className="text-xs font-semibold text-blue-600 uppercase mb-1">📤 Awaiting Output</p>
                  {sess.outputs.map((o, idx) => (
                    <p key={idx} className="text-sm text-gray-700">
                      {o.productName}: <span className="text-gray-400">expected {fmtNum(o.expectedQty)} {o.unit}</span>
                    </p>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── START PROCESSING TAB ─────────────────────────────────────────── */}
      {tab === "start" && (
        <div className="space-y-4">
          {/* Recipe selector */}
          <div className="bg-white rounded-xl shadow-sm p-5">
            <label className="block text-sm font-semibold text-gray-700 mb-3">Select Recipe</label>
            {recipes.filter(r => r.isActive).length === 0 && (
              <p className="text-sm text-gray-400">{isAdmin ? "No active recipes. Create one in the Recipes tab." : "No recipes available. Ask admin to create recipes."}</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {recipes.filter(r => r.isActive).map(r => (
                <button key={r.id} onClick={() => setSelectedRecipe(selectedRecipe?.id === r.id ? null : r)}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${selectedRecipe?.id === r.id ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-orange-300"}`}>
                  <p className="font-semibold text-sm text-gray-800">{r.name}</p>
                  {r.description && <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{r.description}</p>}
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                    <p>📥 {r.inputs.map(i => i.productName).join(", ")}</p>
                    <p>📤 {r.outputs.map(o => o.productName).join(", ")}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selectedRecipe && (
            <>
              {/* Batch count */}
              <div className="bg-white rounded-xl shadow-sm p-5">
                <label className="block text-sm font-semibold text-gray-700 mb-2">Number of Batches</label>
                <div className="flex items-center gap-3">
                  <input type="number" min="0.001" step="0.001" value={batchCount}
                    onChange={e => setBatchCount(e.target.value)}
                    className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                  <p className="text-xs text-gray-400">1 batch = standard recipe quantities. Enter 0.5 for half, 2 for double, etc.</p>
                </div>
              </div>

              {/* Inputs — confirm actual qty to consume */}
              <div className="bg-white rounded-xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-1">📥 Raw Materials to Consume Now</h3>
                <p className="text-xs text-gray-400 mb-4">These will be immediately deducted from stock when you start processing.</p>
                <div className="space-y-3">
                  {selectedRecipe.inputs.map(i => {
                    const expected = fmtNum(i.qtyPerBatch * (parseFloat(batchCount) || 1));
                    const actual   = actualInputs[i.productId] || "";
                    const prod     = products.find(p => p.id === i.productId);
                    const sufficient = prod && prod.stock >= (parseFloat(actual) || 0);
                    return (
                      <div key={i.productId} className="flex items-center gap-3 flex-wrap bg-gray-50 rounded-xl p-3">
                        <div className="flex-1 min-w-[160px]">
                          <p className="text-sm font-medium text-gray-800">{i.productName}</p>
                          <p className="text-xs text-gray-400">Stock available: <span className={sufficient ? "text-green-600 font-medium" : "text-red-500 font-medium"}>{fmtNum(prod?.stock || 0)} {i.unit}</span></p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-center">
                            <p className="text-xs text-gray-400 mb-1">Expected</p>
                            <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500 w-28 text-right">{expected} {i.unit}</div>
                          </div>
                          <div className="text-center">
                            <p className="text-xs text-orange-500 font-medium mb-1">Actual to use</p>
                            <input type="number" min="0" step="0.001" value={actual}
                              onChange={e => setActualInputs(prev => ({ ...prev, [i.productId]: e.target.value }))}
                              className={`w-28 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 text-right font-medium ${!sufficient ? "border-red-300 bg-red-50" : "border-orange-300 bg-orange-50"}`} />
                          </div>
                          {!sufficient && parseFloat(actual) > 0 && (
                            <span className="text-xs text-red-500 font-medium">⚠️ Insufficient stock</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Expected output preview */}
              <div className="bg-white rounded-xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-1">📤 Expected Output (after processing)</h3>
                <p className="text-xs text-gray-400 mb-3">Actual quantities will be entered when processing is complete.</p>
                <div className="space-y-2">
                  {selectedRecipe.outputs.map(o => (
                    <div key={o.productId} className="flex items-center justify-between bg-blue-50 rounded-xl px-4 py-3">
                      <p className="text-sm font-medium text-gray-800">{o.productName}</p>
                      <p className="text-sm text-blue-700 font-semibold">
                        ~{fmtNum(o.qtyPerBatch * (parseFloat(batchCount) || 1))} {o.unit}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <button onClick={handleStart} disabled={starting}
                  className="bg-orange-500 text-white px-8 py-3 rounded-xl text-sm font-bold hover:bg-orange-600 disabled:opacity-50 shadow-sm">
                  {starting ? "Starting…" : "▶️ Start Processing & Deduct Raw Materials"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── RECIPES TAB ─────────────────────────────────────────────────── */}
      {tab === "recipes" && (
        <div className="space-y-3">
          {recipes.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm p-10 text-center text-gray-400">
              <p className="text-4xl mb-2">📋</p>
              <p className="text-sm">No recipes yet.{isAdmin ? " Click '+ New Recipe' to create one." : ""}</p>
            </div>
          )}
          {recipes.map(r => (
            <div key={r.id} className={`bg-white rounded-xl shadow-sm p-5 ${!r.isActive ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-800">{r.name}</h3>
                    {!r.isActive && <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inactive</span>}
                  </div>
                  {r.description && <p className="text-xs text-gray-400 mt-0.5">{r.description}</p>}
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-semibold text-red-500 uppercase mb-1">📥 Inputs (per batch)</p>
                      {r.inputs.map((i, idx) => (
                        <p key={idx} className="text-sm text-gray-700">• {i.productName} — <strong>{fmtNum(i.qtyPerBatch)} {i.unit}</strong></p>
                      ))}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-green-600 uppercase mb-1">📤 Outputs (per batch)</p>
                      {r.outputs.map((o, idx) => (
                        <p key={idx} className="text-sm text-gray-700">• {o.productName} — <strong>{fmtNum(o.qtyPerBatch)} {o.unit}</strong></p>
                      ))}
                    </div>
                  </div>
                </div>
                {isAdmin && (
                  <button onClick={() => { setEditRecipe(r); setRecipeForm({ ...r }); setShowRecipeForm(true); }}
                    className="text-xs bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg hover:bg-blue-100 flex-shrink-0">✏️ Edit</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── HISTORY TAB ─────────────────────────────────────────────────── */}
      {tab === "history" && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {completed.length === 0 ? (
            <div className="p-10 text-center text-gray-400">
              <p className="text-4xl mb-2">🕐</p>
              <p className="text-sm">No completed sessions yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {completed.map(sess => (
                <div key={sess.id} className="p-5 hover:bg-gray-50">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-800">{sess.recipeName}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          sess.status === "completed"  ? "bg-green-100 text-green-700" :
                          sess.status === "cancelled"  ? "bg-red-100 text-red-600" : "bg-gray-100 text-gray-500"
                        }`}>
                          {sess.status === "completed" ? "✅ Completed" : "✕ Cancelled"}
                        </span>
                        {sess.status === "completed" && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sess.yieldPct >= 95 ? "bg-green-100 text-green-700" : sess.yieldPct >= 85 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-600"}`}>
                            {sess.yieldPct.toFixed(1)}% yield
                          </span>
                        )}
                        <span className="text-xs text-gray-400">{sess.batchCount} batch{sess.batchCount > 1 ? "es" : ""}</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">
                        Started: {fmtDateTime(sess.startedAt)} by {sess.startedByName}
                        {sess.completedAt && ` · Completed: ${fmtDateTime(sess.completedAt)} by ${sess.completedByName}`}
                        {sess.cancelledAt && ` · Cancelled: ${fmtDateTime(sess.cancelledAt)} by ${sess.cancelledByName}`}
                      </p>
                      {sess.wasteNotes  && <p className="text-xs text-amber-600 mt-1">⚠️ {sess.wasteNotes}</p>}
                      {sess.cancelReason && <p className="text-xs text-red-500 mt-1">Reason: {sess.cancelReason}</p>}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="bg-red-50 rounded-lg p-3">
                      <p className="text-xs font-semibold text-red-600 uppercase mb-1">Consumed</p>
                      {sess.inputs.map((i, idx) => (
                        <p key={idx} className="text-xs text-gray-700">
                          {i.productName}: <strong>{fmtNum(i.actualQty)} {i.unit}</strong>
                          {Math.abs(i.actualQty - i.expectedQty) > 0.001 && <span className="text-gray-400 ml-1">(exp: {fmtNum(i.expectedQty)})</span>}
                        </p>
                      ))}
                    </div>
                    {sess.status === "completed" && (
                      <div className="bg-green-50 rounded-lg p-3">
                        <p className="text-xs font-semibold text-green-600 uppercase mb-1">Produced</p>
                        {sess.outputs.map((o, idx) => (
                          <p key={idx} className="text-xs text-gray-700">
                            {o.productName}: <strong>{fmtNum(o.actualQty)} {o.unit}</strong>
                            {Math.abs(o.actualQty - o.expectedQty) > 0.001 && <span className="text-gray-400 ml-1">(exp: {fmtNum(o.expectedQty)})</span>}
                          </p>
                        ))}
                      </div>
                    )}
                    {sess.status === "cancelled" && (
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Raw Materials Returned</p>
                        {sess.inputs.map((i, idx) => (
                          <p key={idx} className="text-xs text-gray-700">{i.productName}: <strong>+{fmtNum(i.actualQty)} {i.unit}</strong> returned</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── COMPLETE MODAL ──────────────────────────────────────────────── */}
      {completeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Complete Processing</h3>
                <p className="text-xs text-gray-400 mt-0.5">{completeModal.recipeName} · {completeModal.batchCount} batch{completeModal.batchCount > 1 ? "es" : ""}</p>
              </div>
              <button onClick={() => setCompleteModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-3">📤 Enter actual quantities produced</p>
                <div className="space-y-3">
                  {completeModal.outputs.map(o => (
                    <div key={o.productId} className="flex items-center gap-3 bg-green-50 rounded-xl p-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-800">{o.productName}</p>
                        <p className="text-xs text-gray-400">Expected: {fmtNum(o.expectedQty)} {o.unit}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-green-600 font-medium mb-1">Actual produced</p>
                        <div className="flex items-center gap-1">
                          <input type="number" min="0" step="0.001" value={actualOutputs[o.productId] || ""}
                            onChange={e => setActualOutputs(prev => ({ ...prev, [o.productId]: e.target.value }))}
                            className="w-28 border border-green-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300 text-right font-medium bg-white" />
                          <span className="text-xs text-gray-500">{o.unit}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Yield preview */}
              {yieldPreview && (
                <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Expected output</span>
                    <span className="font-medium">{fmtNum(yieldPreview.totalExpected)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Actual output</span>
                    <span className="font-medium text-green-700">{fmtNum(yieldPreview.totalActual)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Yield</span>
                    <span className={`font-bold text-base ${yieldPreview.yieldPct >= 95 ? "text-green-600" : yieldPreview.yieldPct >= 85 ? "text-yellow-600" : "text-red-600"}`}>
                      {yieldPreview.yieldPct.toFixed(1)}%
                    </span>
                  </div>
                  {yieldPreview.waste > 0.001 && (
                    <div className="flex justify-between text-sm border-t border-gray-200 pt-2">
                      <span className="text-amber-600">Processing loss</span>
                      <span className="font-medium text-amber-700">{fmtNum(yieldPreview.waste)} units</span>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Waste / Loss Notes (optional)</label>
                <input value={wasteNotes} onChange={e => setWasteNotes(e.target.value)}
                  placeholder="e.g. Moisture loss 1.2 KG, 15 damaged packets…" className={inp} />
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setCompleteModal(null)}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleComplete} disabled={completing}
                className="flex-1 bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-600 disabled:opacity-50">
                {completing ? "Completing…" : "✅ Complete & Add to Stock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CANCEL MODAL ────────────────────────────────────────────────── */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">Cancel Processing?</h3>
              <p className="text-xs text-gray-400 mt-0.5">{cancelModal.recipeName}</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
                ⚠️ Raw materials will be <strong>returned to stock</strong>:
                {cancelModal.inputs.map((i, idx) => (
                  <p key={idx} className="mt-1">+{fmtNum(i.actualQty)} {i.unit} of {i.productName}</p>
                ))}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Reason for cancellation *</label>
                <input value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                  placeholder="e.g. Machine breakdown, power failure…" className={inp} />
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => { setCancelModal(null); setCancelReason(""); }}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">Back</button>
              <button onClick={handleCancel} disabled={cancelling || !cancelReason.trim()}
                className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50">
                {cancelling ? "Cancelling…" : "Cancel & Return Stock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RECIPE FORM MODAL ───────────────────────────────────────────── */}
      {showRecipeForm && isAdmin && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editRecipe ? "Edit Recipe" : "New Recipe"}</h3>
              <button onClick={() => { setShowRecipeForm(false); setEditRecipe(null); }} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipe Name *</label>
                <input value={recipeForm.name || ""} onChange={e => setRecipeForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Dal 100G Packet" className={inp} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input value={recipeForm.description || ""} onChange={e => setRecipeForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional notes" className={inp} />
              </div>
              {/* Inputs */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700">📥 Input Materials (per batch)</label>
                  <button onClick={() => setRecipeForm(f => ({ ...f, inputs: [...(f.inputs||[]), { productId:"", productName:"", unit:"", qtyPerBatch:0 }] }))}
                    className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-lg hover:bg-red-100">+ Add Input</button>
                </div>
                <div className="space-y-2">
                  {(recipeForm.inputs||[]).map((item, idx) => (
                    <div key={idx} className="flex gap-2 items-center bg-red-50 p-3 rounded-xl">
                      <select value={item.productId} onChange={e => updateRecipeInput(idx, "productId", e.target.value)}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white">
                        <option value="">-- Select raw material --</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                      </select>
                      <input type="number" min="0" step="0.001" value={item.qtyPerBatch || ""}
                        onChange={e => updateRecipeInput(idx, "qtyPerBatch", parseFloat(e.target.value)||0)}
                        placeholder="Qty" className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                      <span className="text-xs text-gray-500 w-8">{item.unit}</span>
                      <button onClick={() => setRecipeForm(f => ({ ...f, inputs: (f.inputs||[]).filter((_,i)=>i!==idx) }))}
                        className="text-red-400 hover:text-red-600 text-lg font-bold">×</button>
                    </div>
                  ))}
                  {!(recipeForm.inputs||[]).length && <p className="text-xs text-gray-400 italic">No inputs yet.</p>}
                </div>
              </div>
              {/* Outputs */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700">📤 Output Products (per batch)</label>
                  <button onClick={() => setRecipeForm(f => ({ ...f, outputs: [...(f.outputs||[]), { productId:"", productName:"", unit:"", qtyPerBatch:0 }] }))}
                    className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-lg hover:bg-green-100">+ Add Output</button>
                </div>
                <div className="space-y-2">
                  {(recipeForm.outputs||[]).map((item, idx) => (
                    <div key={idx} className="flex gap-2 items-center bg-green-50 p-3 rounded-xl">
                      <select value={item.productId} onChange={e => updateRecipeOutput(idx, "productId", e.target.value)}
                        className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white">
                        <option value="">-- Select finished product --</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                      </select>
                      <input type="number" min="0" step="0.001" value={item.qtyPerBatch || ""}
                        onChange={e => updateRecipeOutput(idx, "qtyPerBatch", parseFloat(e.target.value)||0)}
                        placeholder="Qty" className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                      <span className="text-xs text-gray-500 w-8">{item.unit}</span>
                      <button onClick={() => setRecipeForm(f => ({ ...f, outputs: (f.outputs||[]).filter((_,i)=>i!==idx) }))}
                        className="text-red-400 hover:text-red-600 text-lg font-bold">×</button>
                    </div>
                  ))}
                  {!(recipeForm.outputs||[]).length && <p className="text-xs text-gray-400 italic">No outputs yet.</p>}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input type="checkbox" id="isActive" checked={recipeForm.isActive ?? true}
                  onChange={e => setRecipeForm(f => ({ ...f, isActive: e.target.checked }))} />
                <label htmlFor="isActive" className="text-sm text-gray-700">Active (visible when starting processing)</label>
              </div>
            </div>
            <div className="px-6 pb-6 flex gap-3 justify-end">
              <button onClick={() => { setShowRecipeForm(false); setEditRecipe(null); }}
                className="border border-gray-300 text-gray-600 px-4 py-2.5 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleSaveRecipe} disabled={recipeSaving}
                className="bg-orange-500 text-white px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50">
                {recipeSaving ? "Saving…" : editRecipe ? "Update Recipe" : "Create Recipe"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
