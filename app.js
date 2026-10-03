const docStorageKey = "zfl16-movable-type-workshop-doc";
const legacyStorageKey = "zfl16-movable-type-workshop";
const signalKey = "zfl16-movable-type-workshop-signal";
const shiftSessionKey = "zfl16-movable-type-workshop-shift";
const viewSessionKey = "zfl16-movable-type-workshop-view";
const channel = "BroadcastChannel" in window ? new BroadcastChannel("zfl16-movable-type-workshop") : null;

const starterInventory = [
  { id: crypto.randomUUID(), char: "山", style: "宋体旧字", size: 30, quantity: 4, wear: "微磨" },
  { id: crypto.randomUUID(), char: "月", style: "宋体旧字", size: 30, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "风", style: "楷体木刻", size: 28, quantity: 2, wear: "微磨" },
  { id: crypto.randomUUID(), char: "花", style: "楷体木刻", size: 28, quantity: 2, wear: "新" },
  { id: crypto.randomUUID(), char: "茶", style: "黑体铅字", size: 24, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "雨", style: "仿宋细字", size: 22, quantity: 4, wear: "新" }
];

const defaultSettings = {
  paperSize: "postcard",
  flowMode: "horizontal",
  gridGap: 8,
  workTitle: "晚风小笺"
};

const defaultDoc = () => ({
  revision: 1,
  inventory: structuredClone(starterInventory),
  placements: [],
  drafts: [],
  updatedAt: new Date().toISOString()
});

// ---------- 共享文档（已确认班次，跨窗口） ----------

function readLegacyState() {
  const saved = localStorage.getItem(legacyStorageKey);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    return {
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : structuredClone(starterInventory),
      placements: Array.isArray(parsed.placements) ? parsed.placements : [],
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : []
    };
  } catch {
    return null;
  }
}

function normalizeDoc(raw) {
  return {
    revision: Number(raw.revision) > 0 ? Number(raw.revision) : 1,
    inventory: Array.isArray(raw.inventory) ? raw.inventory : [],
    placements: Array.isArray(raw.placements) ? raw.placements : [],
    drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

function readDocRaw() {
  const saved = localStorage.getItem(docStorageKey);
  if (saved) {
    try {
      return normalizeDoc(JSON.parse(saved));
    } catch {
      /* fall through and rebuild */
    }
  }
  // 旧版单人数据：整体接管为修订号 #1 的已确认文档
  const legacy = readLegacyState();
  if (legacy) {
    const doc = {
      revision: 1,
      inventory: legacy.inventory,
      placements: legacy.placements,
      drafts: legacy.drafts.map((draft) => ({ ...draft, legacy: draft.revision == null })),
      updatedAt: new Date().toISOString()
    };
    writeDocRaw(doc);
    return doc;
  }
  const doc = defaultDoc();
  writeDocRaw(doc);
  return doc;
}

function writeDocRaw(doc) {
  localStorage.setItem(docStorageKey, JSON.stringify(doc));
}

function writeDoc(doc, kind) {
  writeDocRaw(doc);
  signal(kind);
}

const seenSignals = new Set();

function signal(kind) {
  const payload = { nonce: crypto.randomUUID(), kind, at: Date.now() };
  try {
    channel?.postMessage(payload);
  } catch {
    /* BroadcastChannel 不可用时靠 storage 事件兜底 */
  }
  localStorage.setItem(signalKey, JSON.stringify(payload));
}

// ---------- 本班次（每个窗口一份） ----------

let doc = readDocRaw();

let view = loadView();

let shift = restoreShift() || checkoutShift(doc);

function shortId(length = 4) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, length).toUpperCase();
}

function loadView() {
  try {
    return { ...defaultSettings, ...(JSON.parse(sessionStorage.getItem(viewSessionKey)) || {}) };
  } catch {
    return { ...defaultSettings };
  }
}

function persistView() {
  sessionStorage.setItem(viewSessionKey, JSON.stringify(view));
}

function checkoutShift(sourceDoc, workerName) {
  return {
    id: shortId(),
    worker: workerName || `工匠${shortId(2)}`,
    solo: false,
    baseRevision: sourceDoc.revision,
    basePlacements: structuredClone(sourceDoc.placements),
    baseInventory: structuredClone(sourceDoc.inventory),
    placements: structuredClone(sourceDoc.placements),
    inventory: structuredClone(sourceDoc.inventory),
    status: "editing", // editing | returned | confirmed
    notice: `已领到修订号 #${sourceDoc.revision} 的班次，落字与字模数量改动随本班一起提交。`,
    conflicts: []
  };
}

function restoreShift() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(shiftSessionKey));
    if (!saved || typeof saved.baseRevision !== "number") return null;
    return {
      id: saved.id || shortId(),
      worker: saved.worker || `工匠${shortId(2)}`,
      solo: Boolean(saved.solo),
      baseRevision: saved.baseRevision,
      basePlacements: Array.isArray(saved.basePlacements) ? saved.basePlacements : [],
      baseInventory: Array.isArray(saved.baseInventory) ? saved.baseInventory : [],
      placements: Array.isArray(saved.placements) ? saved.placements : [],
      inventory: Array.isArray(saved.inventory) ? saved.inventory : [],
      status: ["editing", "returned", "confirmed"].includes(saved.status) ? saved.status : "editing",
      notice: saved.notice || "",
      conflicts: Array.isArray(saved.conflicts) ? saved.conflicts : []
    };
  } catch {
    return null;
  }
}

function persistShift() {
  sessionStorage.setItem(shiftSessionKey, JSON.stringify(shift));
}

function placementKey(row, col) {
  return `${row}:${col}`;
}

// 字模库是否相对基快照有改动（新增/删除/数量等任意变化）
function inventoryChanged(baseInventory, nextInventory) {
  const base = new Map(baseInventory.map((item) => [item.id, item]));
  const next = new Map(nextInventory.map((item) => [item.id, item]));
  if (base.size !== next.size) return true;
  for (const [id, item] of next) {
    const old = base.get(id);
    if (!old) return true;
    if (
      old.char !== item.char ||
      old.style !== item.style ||
      old.size !== item.size ||
      old.wear !== item.wear ||
      Number(old.quantity) !== Number(item.quantity)
    ) {
      return true;
    }
  }
  return false;
}

// 三路合并：基快照 / 本班 / 已确认新版；只合并落字，冲突格保留本班选择待裁决
function mergePlacements(base, mine, theirs) {
  const toMap = (list) => new Map(list.map((p) => [placementKey(p.row, p.col), p.typeId]));
  const b = toMap(base);
  const m = toMap(mine);
  const t = toMap(theirs);
  const keys = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  const merged = [];
  const conflicts = [];
  for (const key of keys) {
    const bv = b.get(key) ?? null;
    const mv = m.get(key) ?? null;
    const tv = t.get(key) ?? null;
    let pick = mv;
    let isConflict = false;
    if (mv === tv) {
      pick = mv;
    } else if (mv === bv) {
      pick = tv; // 本班没动，采用已确认版
    } else if (tv === bv) {
      pick = mv; // 对方没动，保留本班
    } else {
      isConflict = true; // 同格两边都换了不同字模
    }
    const [row, col] = key.split(":").map(Number);
    if (pick) merged.push({ row, col, typeId: pick });
    if (isConflict) conflicts.push({ row, col, mine: mv, theirs: tv });
  }
  return { merged, conflicts };
}

// 未确认班次接到新修订号：自动并入、重算用量、冲突格挂起
function rebaseShift(latest, { forced = false, reason = "" } = {}) {
  const invChanged = inventoryChanged(shift.baseInventory, latest.inventory);
  const { merged, conflicts } = mergePlacements(shift.basePlacements, shift.placements, latest.placements);

  if (invChanged) {
    // 字模数量以已确认版为准；本班新增、尚未落班的字模保留
    const committedIds = new Set(latest.inventory.map((item) => item.id));
    const localAdds = shift.inventory.filter(
      (item) => !committedIds.has(item.id) && !shift.baseInventory.some((base) => base.id === item.id)
    );
    shift.inventory = [...structuredClone(latest.inventory), ...structuredClone(localAdds)];
  }
  shift.baseInventory = structuredClone(latest.inventory);

  const available = new Set(shift.inventory.map((item) => item.id));
  const validConflicts = [];
  for (const conflict of conflicts) {
    const mineOk = conflict.mine && available.has(conflict.mine);
    const theirsOk = conflict.theirs && available.has(conflict.theirs);
    if (mineOk && theirsOk) validConflicts.push(conflict);
    // 某一边的字模已被删除：另一边直接生效，不再算冲突
  }
  shift.placements = merged.filter((p) => available.has(p.typeId));
  shift.conflicts = validConflicts;
  shift.basePlacements = structuredClone(latest.placements);
  shift.baseRevision = latest.revision;
  if (state_selectedTypeId && !available.has(state_selectedTypeId)) {
    state_selectedTypeId = shift.inventory[0]?.id || null;
  }

  shift.solo = false;
  if (reason) {
    shift.status = "returned";
    shift.notice = reason;
  } else if (forced || validConflicts.length || invChanged) {
    shift.status = "returned";
    const parts = [];
    if (invChanged) parts.push("字模数量已更新，本班用量已重算");
    if (validConflicts.length) parts.push(`${validConflicts.length} 个冲突格待选用字模`);
    parts.push(`请核对后重新提交（修订号 #${latest.revision}）`);
    shift.notice = `班次被退回：${parts.join("，")}。`;
  } else {
    shift.status = "editing";
    shift.notice = `已接上修订号 #${latest.revision}，对方的落字已自动并入本班。`;
  }
}

function markEditing() {
  if (shift.status === "confirmed") {
    shift.status = "editing";
    shift.notice = `本班在修订号 #${shift.baseRevision} 之后又有新改动，提交后才会落班。`;
  }
}

// ---------- DOM ----------

const els = {
  paperSize: document.querySelector("#paperSize"),
  flowMode: document.querySelector("#flowMode"),
  gridGap: document.querySelector("#gridGap"),
  workTitle: document.querySelector("#workTitle"),
  stage: document.querySelector("#stage"),
  typeList: document.querySelector("#typeList"),
  typeForm: document.querySelector("#typeForm"),
  charInput: document.querySelector("#charInput"),
  styleInput: document.querySelector("#styleInput"),
  sizeInput: document.querySelector("#sizeInput"),
  quantityInput: document.querySelector("#quantityInput"),
  wearInput: document.querySelector("#wearInput"),
  inventorySearch: document.querySelector("#inventorySearch"),
  styleFilter: document.querySelector("#styleFilter"),
  selectedTypeLabel: document.querySelector("#selectedTypeLabel"),
  shortageBadge: document.querySelector("#shortageBadge"),
  usageList: document.querySelector("#usageList"),
  draftList: document.querySelector("#draftList"),
  placedCount: document.querySelector("#placedCount"),
  inventoryCount: document.querySelector("#inventoryCount"),
  saveDraftBtn: document.querySelector("#saveDraftBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  clearBoardBtn: document.querySelector("#clearBoardBtn"),
  workerInput: document.querySelector("#workerInput"),
  shiftRevision: document.querySelector("#shiftRevision"),
  shiftStatus: document.querySelector("#shiftStatus"),
  shiftNotice: document.querySelector("#shiftNotice"),
  commitShiftBtn: document.querySelector("#commitShiftBtn"),
  releaseShiftBtn: document.querySelector("#releaseShiftBtn"),
  conflictList: document.querySelector("#conflictList")
};

// 选中字模属于易变状态：字模被对方删掉时需要兜底，单独持有
let state_selectedTypeId = shift.inventory[0]?.id || null;
{
  const stored = sessionStorage.getItem("zfl16-movable-type-workshop-selected");
  if (stored && shift.inventory.some((item) => item.id === stored)) state_selectedTypeId = stored;
}

function getGrid() {
  const size = view.paperSize;
  if (size === "bookmark") return { cols: 7, rows: 18 };
  if (size === "square") return { cols: 12, rows: 12 };
  return { cols: 16, rows: 10 };
}

function getSelectedType() {
  return shift.inventory.find((item) => item.id === state_selectedTypeId) || null;
}

function getUsage(placements = shift.placements) {
  return placements.reduce((acc, placement) => {
    acc[placement.typeId] = (acc[placement.typeId] || 0) + 1;
    return acc;
  }, {});
}

function formatType(typeId) {
  if (!typeId) return "空格（撤字）";
  const item = shift.inventory.find((type) => type.id === typeId);
  return item ? `${item.char} · ${item.style}` : "字模已删除";
}

function renderSettings() {
  els.paperSize.value = view.paperSize;
  els.flowMode.value = view.flowMode;
  els.gridGap.value = view.gridGap;
  if (document.activeElement !== els.workTitle) els.workTitle.value = view.workTitle;
}

function renderStyleFilter() {
  const current = els.styleFilter.value || "all";
  const styles = [...new Set(shift.inventory.map((item) => item.style))].sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );
  els.styleFilter.innerHTML = `<option value="all">全部风格</option>${styles
    .map((style) => `<option value="${escapeHtml(style)}">${escapeHtml(style)}</option>`)
    .join("")}`;
  els.styleFilter.value = styles.includes(current) ? current : "all";
}

function renderInventory() {
  const keyword = els.inventorySearch.value.trim();
  const style = els.styleFilter.value;
  const usage = getUsage();
  const baseQuantities = new Map(shift.baseInventory.map((item) => [item.id, item.quantity]));
  const items = shift.inventory.filter((item) => {
    const matchesKeyword = !keyword || `${item.char}${item.style}${item.wear}`.includes(keyword);
    const matchesStyle = style === "all" || item.style === style;
    return matchesKeyword && matchesStyle;
  });

  els.inventoryCount.textContent = `${shift.inventory.length}枚字模`;
  els.typeList.innerHTML = items
    .map((item) => {
      const used = usage[item.id] || 0;
      const selected = item.id === state_selectedTypeId ? "selected" : "";
      const qtyDirty = baseQuantities.has(item.id) && baseQuantities.get(item.id) !== item.quantity;
      const newlyAdded = !baseQuantities.has(item.id);
      return `
        <article class="type-card ${selected}" draggable="true" data-type-id="${item.id}">
          <div class="glyph" style="font-size:${Math.min(item.size, 36)}px">${escapeHtml(item.char)}</div>
          <div class="type-meta">
            <strong>${escapeHtml(item.char)} · ${escapeHtml(item.style)}${newlyAdded ? ` <em class="new-tag">新</em>` : ""}</strong>
            <span>${item.size}px · ${escapeHtml(item.wear)} · 已用${used}/<input
              class="qty-input ${qtyDirty ? "dirty" : ""}"
              type="number" min="1" max="99" value="${item.quantity}"
              title="字模数量（随班次提交）" data-qty-id="${item.id}" /></span>
          </div>
          <button class="mini-btn" title="删除字模（随班次提交）" data-delete-type="${item.id}" type="button">×</button>
        </article>
      `;
    })
    .join("");
}

function renderStage() {
  const { cols, rows } = getGrid();
  const map = new Map(shift.placements.map((item) => [placementKey(item.row, item.col), item]));
  const conflictKeys = new Set(shift.conflicts.map((c) => placementKey(c.row, c.col)));
  els.stage.className = `stage ${view.paperSize}`;
  els.stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  els.stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  els.stage.style.gap = `${view.gridGap}px`;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const key = placementKey(row, col);
      const placement = map.get(key);
      const type = placement ? shift.inventory.find((item) => item.id === placement.typeId) : null;
      const vertical = view.flowMode === "vertical" ? "vertical" : "";
      const inConflict = conflictKeys.has(key) ? "conflict" : "";
      cells.push(`
        <button class="cell ${type ? "used" : ""} ${vertical} ${inConflict}" data-row="${row}" data-col="${col}" type="button" aria-label="第${row + 1}行第${col + 1}列">
          ${type ? escapeHtml(type.char) : ""}
        </button>
      `);
    }
  }
  els.stage.innerHTML = cells.join("");
}

function renderUsage() {
  const usage = getUsage();
  const entries = shift.inventory.filter((item) => usage[item.id]);
  els.placedCount.textContent = `本班${shift.placements.length}字 · 已确认${doc.placements.length}字`;

  const shortages = entries.filter((item) => usage[item.id] > item.quantity);
  els.shortageBadge.textContent = shortages.length ? `${shortages.length}处超量` : "数量充足";
  els.shortageBadge.className = `badge ${shortages.length ? "warn" : "ok"}`;

  const selectedType = getSelectedType();
  els.selectedTypeLabel.textContent = selectedType
    ? `当前：${selectedType.char} · ${selectedType.style}`
    : "未选择字模";

  els.usageList.innerHTML =
    entries
      .map((item) => {
        const used = usage[item.id];
        const warn = used > item.quantity ? "warn" : "";
        return `
          <div class="usage-item ${warn}">
            <strong>${escapeHtml(item.char)} ${escapeHtml(item.style)}</strong>
            <span>${used}/${item.quantity}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">本班还没有落字。</p>`;
}

function renderShift() {
  if (document.activeElement !== els.workerInput) els.workerInput.value = shift.worker;
  els.shiftRevision.textContent = `班次 ${shift.id} · 修订号 #${shift.baseRevision}${shift.solo ? " · 单人接管" : ""}`;
  const statusMap = {
    editing: ["edit", "编辑中 · 未确认"],
    returned: ["warn", "已退回 · 待确认"],
    confirmed: ["ok", `已确认 · 修订号 #${shift.baseRevision}`]
  };
  const [badgeClass, badgeText] = statusMap[shift.status] || statusMap.editing;
  els.shiftStatus.textContent = badgeText;
  els.shiftStatus.className = `badge ${badgeClass}`;
  els.shiftNotice.textContent = shift.notice || "";
  els.shiftNotice.classList.toggle("warn", shift.status === "returned");
  els.commitShiftBtn.textContent = shift.status === "returned" ? "重新提交班次" : "提交班次";

  if (!shift.conflicts.length) {
    els.conflictList.innerHTML = "";
    return;
  }
  const rows = shift.conflicts
    .map(
      (conflict, index) => `
        <div class="conflict-item">
          <div class="conflict-head">
            <strong>第${conflict.row + 1}行 · 第${conflict.col + 1}格</strong>
            <span class="cf-tag">冲突 ${index + 1}</span>
          </div>
          <div class="cf-choices">
            <button type="button" data-cf-side="mine" data-cf-row="${conflict.row}" data-cf-col="${conflict.col}">
              本班：${escapeHtml(formatType(conflict.mine))}
            </button>
            <button type="button" data-cf-side="theirs" data-cf-row="${conflict.row}" data-cf-col="${conflict.col}">
              已确认：${escapeHtml(formatType(conflict.theirs))}
            </button>
          </div>
        </div>
      `
    )
    .join("");
  els.conflictList.innerHTML = `
    <div class="cf-actions">
      <button type="button" data-cf-all="mine">全部用本班</button>
      <button type="button" data-cf-all="theirs">全部用已确认</button>
    </div>
    ${rows}
  `;
}

function renderDrafts() {
  els.draftList.innerHTML =
    doc.drafts
      .map((draft) => {
        const stamp = draft.revision ? `修订号 #${draft.revision}` : "旧稿";
        return `
          <article class="draft-item ${draft.revision ? "" : "legacy"}">
            <strong>${escapeHtml(draft.title)}</strong>
            <span>${draft.placements.length}个落字 · ${stamp} · ${new Date(draft.savedAt).toLocaleString("zh-CN")}</span>
            <div class="draft-actions">
              <button type="button" data-load-draft="${draft.id}">${draft.revision ? "载入" : "单人接管"}</button>
              <button type="button" data-delete-draft="${draft.id}">删除</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">还没有已确认班次的草稿。</p>`;
}

function renderAll() {
  persistShift();
  persistView();
  sessionStorage.setItem("zfl16-movable-type-workshop-selected", state_selectedTypeId || "");
  renderSettings();
  renderStyleFilter();
  renderInventory();
  renderStage();
  renderUsage();
  renderShift();
  renderDrafts();
}

// ---------- 本班操作 ----------

function placeType(row, col, typeId = state_selectedTypeId) {
  if (!typeId) return;
  markEditing();
  const existingIndex = shift.placements.findIndex((item) => item.row === row && item.col === col);
  if (existingIndex >= 0) {
    if (shift.placements[existingIndex].typeId === typeId) {
      shift.placements.splice(existingIndex, 1);
    } else {
      shift.placements[existingIndex].typeId = typeId;
    }
  } else {
    shift.placements.push({ row, col, typeId });
  }
  renderAll();
}

function addType(event) {
  event.preventDefault();
  markEditing();
  const item = {
    id: crypto.randomUUID(),
    char: els.charInput.value.trim(),
    style: els.styleInput.value.trim(),
    size: Number(els.sizeInput.value),
    quantity: Number(els.quantityInput.value),
    wear: els.wearInput.value
  };
  if (!item.char || !item.style) return;
  shift.inventory.unshift(item);
  state_selectedTypeId = item.id;
  els.typeForm.reset();
  els.sizeInput.value = 24;
  els.quantityInput.value = 3;
  renderAll();
}

// 提交班次：比较并交换（CAS），修订号一致才允许写入
function commitShift() {
  const latest = readDocRaw();
  if (shift.status === "confirmed" && latest.revision === shift.baseRevision) {
    shift.notice = `本班已确认在修订号 #${latest.revision}，没有新的改动需要提交。`;
    renderShift();
    return;
  }
  if (latest.revision !== shift.baseRevision) {
    // 撞班落败：本班被退回，rebase 后挂出冲突格与两边选的字模
    rebaseShift(latest, {
      forced: true,
      reason:
        shift.conflicts.length > 0
          ? `提交撞班：修订号已推进到 #${latest.revision}，请在冲突格中选用本班或已确认的字模后重新提交。`
          : `提交撞班：修订号已推进到 #${latest.revision}，本班落字已并入，请确认后重新提交。`
    });
    doc = latest;
    renderAll();
    return;
  }
  if (shift.conflicts.length) {
    shift.status = "returned";
    shift.notice = "还有冲突格没有裁决，请先逐格选字模，再提交班次。";
    renderShift();
    return;
  }
  const validIds = new Set(shift.inventory.map((item) => item.id));
  latest.inventory = structuredClone(shift.inventory);
  latest.placements = structuredClone(shift.placements.filter((p) => validIds.has(p.typeId)));
  latest.revision += 1;
  latest.updatedAt = new Date().toISOString();
  writeDoc(latest, "commit");

  doc = latest;
  shift.baseRevision = latest.revision;
  shift.basePlacements = structuredClone(latest.placements);
  shift.baseInventory = structuredClone(latest.inventory);
  shift.conflicts = [];
  shift.solo = false;
  shift.status = "confirmed";
  shift.notice = `班次已确认并写入，当前修订号 #${latest.revision}。`;
  renderAll();
}

function resolveConflict(row, col, side) {
  const conflict = shift.conflicts.find((item) => item.row === row && item.col === col);
  if (!conflict) return;
  const chosen = conflict[side];
  const index = shift.placements.findIndex((item) => item.row === row && item.col === col);
  if (chosen) {
    const placement = { row, col, typeId: chosen };
    if (index >= 0) shift.placements[index] = placement;
    else shift.placements.push(placement);
  } else if (index >= 0) {
    shift.placements.splice(index, 1);
  }
  shift.conflicts = shift.conflicts.filter((item) => item !== conflict);
  if (!shift.conflicts.length) {
    shift.status = "returned";
    shift.notice = "冲突格已全部裁决，请重新提交班次。";
  }
  renderAll();
}

function resolveAllConflicts(side) {
  if (!shift.conflicts.length) return;
  for (const conflict of [...shift.conflicts]) {
    const chosen = conflict[side];
    const index = shift.placements.findIndex(
      (item) => item.row === conflict.row && item.col === conflict.col
    );
    if (chosen) {
      const placement = { row: conflict.row, col: conflict.col, typeId: chosen };
      if (index >= 0) shift.placements[index] = placement;
      else shift.placements.push(placement);
    } else if (index >= 0) {
      shift.placements.splice(index, 1);
    }
  }
  shift.conflicts = [];
  shift.status = "returned";
  shift.notice = "冲突格已全部裁决，请重新提交班次。";
  renderAll();
}

// 旧草稿（无修订号）按单人班次接管；新草稿载入为待提交的工作副本
function takeOverDraft(draft) {
  doc = readDocRaw();
  const legacy = draft.revision == null;
  const worker = shift.worker;
  const next = checkoutShift(doc, worker);
  const available = new Set(next.inventory.map((item) => item.id));
  next.placements = structuredClone(draft.placements).filter((p) => available.has(p.typeId));
  next.solo = legacy;
  next.notice = legacy
    ? `旧草稿《${draft.title}》已按单人班次接管，基于修订号 #${doc.revision}，提交即可并入。`
    : `草稿《${draft.title}》（修订号 #${draft.revision}）已载入本班，提交后成为新版面。`;
  shift = next;
  view = { ...view, ...structuredClone(draft.settings || {}) };
  state_selectedTypeId = shift.inventory[0]?.id || null;
  renderAll();
}

function saveDraft() {
  doc = readDocRaw(); // 草稿只认已确认班次
  const title = view.workTitle.trim() || "未命名作品";
  doc.drafts.unshift({
    id: crypto.randomUUID(),
    title,
    revision: doc.revision,
    settings: structuredClone(view),
    placements: structuredClone(doc.placements),
    savedAt: new Date().toISOString()
  });
  doc.drafts = doc.drafts.slice(0, 8);
  writeDoc(doc, "drafts");
  renderDrafts();
}

function exportPreview() {
  doc = readDocRaw(); // 导出只认已确认班次
  const { cols, rows } = getGrid();
  const cell = view.paperSize === "bookmark" ? 44 : 56;
  const gap = view.gridGap;
  const margin = 48;
  const width = cols * cell + (cols - 1) * gap + margin * 2;
  const height = rows * cell + (rows - 1) * gap + margin * 2 + 70;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffaf1";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#2f2921";
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, width - 36, height - 36);
  ctx.fillStyle = "#22201c";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(view.workTitle || "未命名作品", margin, 50);
  ctx.font = "bold 30px serif";
  doc.placements.forEach((placement) => {
    const type = doc.inventory.find((item) => item.id === placement.typeId);
    if (!type) return;
    const x = margin + placement.col * (cell + gap);
    const y = margin + 45 + placement.row * (cell + gap);
    ctx.fillStyle = "#2f2921";
    ctx.fillRect(x, y, cell, cell);
    ctx.fillStyle = "#fff5df";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.min(type.size + 8, 42)}px serif`;
    ctx.fillText(type.char, x + cell / 2, y + cell / 2);
  });
  const link = document.createElement("a");
  link.download = `${view.workTitle || "movable-type"}-r${doc.revision}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
  shift.notice = `已按修订号 #${doc.revision} 的已确认班次导出，本班未落班改动不含在内。`;
  renderShift();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- 跨窗口交接班 ----------

function handleRemoteSignal(payload) {
  if (!payload || !payload.nonce || seenSignals.has(payload.nonce)) return;
  seenSignals.add(payload.nonce);
  if (seenSignals.size > 100) seenSignals.delete(seenSignals.values().next().value);
  const latest = readDocRaw();
  if (latest.revision > shift.baseRevision) {
    rebaseShift(latest, { forced: false });
    doc = latest;
    renderAll();
  } else if (latest.revision === shift.baseRevision) {
    doc = latest; // 草稿等非版面改动
    renderDrafts();
  }
}

channel?.addEventListener("message", (event) => handleRemoteSignal(event.data));

window.addEventListener("storage", (event) => {
  if (event.key === signalKey && event.newValue) {
    try {
      handleRemoteSignal(JSON.parse(event.newValue));
    } catch {
      /* ignore malformed signal */
    }
    return;
  }
  if (event.key === docStorageKey && event.newValue) {
    // 兜底：只收到文档变更、没收到信号时，按修订号判断是否需要 rebase
    try {
      handleRemoteSignal({ nonce: `storage-${crypto.randomUUID()}`, kind: "commit" });
    } catch {
      /* ignore */
    }
  }
});

// 启动时若其他窗口已推进修订号，本班立刻重算并退回
if (doc.revision > shift.baseRevision) {
  rebaseShift(doc, { forced: false });
}

// ---------- 事件绑定 ----------

els.paperSize.addEventListener("change", () => {
  view.paperSize = els.paperSize.value;
  const { cols, rows } = getGrid();
  markEditing();
  shift.placements = shift.placements.filter((item) => item.row < rows && item.col < cols);
  renderAll();
});

els.flowMode.addEventListener("change", () => {
  view.flowMode = els.flowMode.value;
  renderAll();
});

els.gridGap.addEventListener("input", () => {
  view.gridGap = Number(els.gridGap.value);
  persistView();
  renderStage();
});

els.workTitle.addEventListener("input", () => {
  view.workTitle = els.workTitle.value;
  persistView();
});

els.workerInput.addEventListener("input", () => {
  shift.worker = els.workerInput.value.trim() || "无名工匠";
  persistShift();
});

els.typeForm.addEventListener("submit", addType);
els.inventorySearch.addEventListener("input", renderInventory);
els.styleFilter.addEventListener("change", renderInventory);
els.saveDraftBtn.addEventListener("click", saveDraft);
els.exportBtn.addEventListener("click", exportPreview);
els.commitShiftBtn.addEventListener("click", commitShift);
els.releaseShiftBtn.addEventListener("click", () => {
  const latest = readDocRaw();
  if (!window.confirm("交还当前班次？本班未落班的落字和字模数量改动将全部放弃。")) return;
  doc = latest;
  shift = checkoutShift(latest, shift.worker);
  state_selectedTypeId = shift.inventory[0]?.id || null;
  renderAll();
});
els.clearBoardBtn.addEventListener("click", () => {
  markEditing();
  shift.placements = [];
  renderAll();
});

els.typeList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-type]");
  if (deleteButton) {
    const typeId = deleteButton.dataset.deleteType;
    markEditing();
    shift.inventory = shift.inventory.filter((item) => item.id !== typeId);
    shift.placements = shift.placements.filter((item) => item.typeId !== typeId);
    if (state_selectedTypeId === typeId) state_selectedTypeId = shift.inventory[0]?.id || null;
    renderAll();
    return;
  }
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  state_selectedTypeId = card.dataset.typeId;
  renderAll();
});

els.typeList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-qty-id]");
  if (!input) return;
  const item = shift.inventory.find((type) => type.id === input.dataset.qtyId);
  if (!item) return;
  const quantity = Math.max(1, Math.min(99, Number(input.value) || 1));
  if (quantity === item.quantity) return;
  markEditing();
  item.quantity = quantity;
  input.value = String(quantity);
  const base = shift.baseInventory.find((type) => type.id === item.id);
  input.classList.toggle("dirty", Boolean(base && base.quantity !== quantity));
  persistShift();
  renderUsage();
});

els.typeList.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  event.dataTransfer.setData("text/plain", card.dataset.typeId);
});

els.stage.addEventListener("dragover", (event) => {
  if (event.target.closest(".cell")) event.preventDefault();
});

els.stage.addEventListener("drop", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  event.preventDefault();
  placeType(Number(cell.dataset.row), Number(cell.dataset.col), event.dataTransfer.getData("text/plain"));
});

els.stage.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  placeType(Number(cell.dataset.row), Number(cell.dataset.col));
});

els.conflictList.addEventListener("click", (event) => {
  const bulk = event.target.closest("[data-cf-all]");
  if (bulk) {
    resolveAllConflicts(bulk.dataset.cfAll);
    return;
  }
  const button = event.target.closest("[data-cf-side]");
  if (!button) return;
  resolveConflict(Number(button.dataset.cfRow), Number(button.dataset.cfCol), button.dataset.cfSide);
});

els.draftList.addEventListener("click", (event) => {
  const loadButton = event.target.closest("[data-load-draft]");
  const deleteButton = event.target.closest("[data-delete-draft]");
  if (loadButton) {
    const draft = doc.drafts.find((item) => item.id === loadButton.dataset.loadDraft);
    if (draft) takeOverDraft(draft);
  }
  if (deleteButton) {
    doc.drafts = doc.drafts.filter((item) => item.id !== deleteButton.dataset.deleteDraft);
    writeDoc(doc, "drafts");
    renderDrafts();
  }
});

renderAll();
