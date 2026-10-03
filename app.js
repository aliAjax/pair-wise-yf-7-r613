"use strict";

// 头版（已确认班次写入的共享状态）存 localStorage，各窗口共享；
// 班次（未提交的工作副本）存 sessionStorage，每个窗口各自一份。
const sharedKey = "zfl16-movable-type-workshop-shared-v1";
const localKey = "zfl16-movable-type-workshop-local-v1";
const legacyKey = "zfl16-movable-type-workshop";

function makeStarterInventory() {
  return [
    { id: crypto.randomUUID(), char: "山", style: "宋体旧字", size: 30, quantity: 4, wear: "微磨" },
    { id: crypto.randomUUID(), char: "月", style: "宋体旧字", size: 30, quantity: 3, wear: "旧痕" },
    { id: crypto.randomUUID(), char: "风", style: "楷体木刻", size: 28, quantity: 2, wear: "微磨" },
    { id: crypto.randomUUID(), char: "花", style: "楷体木刻", size: 28, quantity: 2, wear: "新" },
    { id: crypto.randomUUID(), char: "茶", style: "黑体铅字", size: 24, quantity: 3, wear: "旧痕" },
    { id: crypto.randomUUID(), char: "雨", style: "仿宋细字", size: 22, quantity: 4, wear: "新" }
  ];
}

function emptyShared() {
  return { revision: 0, inventory: makeStarterInventory(), placements: [], drafts: [] };
}

function emptyChanges() {
  return { placements: {}, quantities: {}, addedTypes: {}, deletedTypeIds: [] };
}

function placementKey(row, col) {
  return `${row}:${col}`;
}

function snapshotPlacements(placements) {
  const out = {};
  for (const p of placements) out[placementKey(p.row, p.col)] = p.typeId;
  return out;
}

function snapshotQuantities(inventory) {
  const out = {};
  for (const item of inventory) out[item.id] = item.quantity;
  return out;
}

function emptyShift(shared) {
  return {
    id: crypto.randomUUID(),
    baseRevision: shared.revision,
    basePlacements: snapshotPlacements(shared.placements),
    baseQuantities: snapshotQuantities(shared.inventory),
    changes: emptyChanges(),
    conflicts: [],
    quantityConflicts: [],
    returnReasons: []
  };
}

// ---------- 载入 / 保存 ----------

function loadShared() {
  try {
    const raw = localStorage.getItem(sharedKey);
    if (raw) return JSON.parse(raw);
  } catch {
    /* 存档损坏则重建 */
  }
  let shared;
  try {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      // 旧版本地存档：版面与字模按单人班次接管为修订号 0 的头版，
      // 旧草稿保留，载入时再按当前头版做差集接管。
      const parsed = JSON.parse(legacy);
      shared = {
        revision: 0,
        inventory: Array.isArray(parsed.inventory) && parsed.inventory.length ? parsed.inventory : makeStarterInventory(),
        placements: Array.isArray(parsed.placements) ? parsed.placements : [],
        drafts: Array.isArray(parsed.drafts)
          ? parsed.drafts.map((draft) => ({ ...draft, revision: 0, legacy: true }))
          : []
      };
    } else {
      shared = emptyShared();
    }
  } catch {
    shared = emptyShared();
  }
  saveShared(shared);
  return shared;
}

function saveShared(shared) {
  localStorage.setItem(sharedKey, JSON.stringify(shared));
}

function defaultSettings() {
  return { paperSize: "postcard", flowMode: "horizontal", gridGap: 8, workTitle: "晚风小笺" };
}

function loadLocal(shared) {
  try {
    const raw = sessionStorage.getItem(localKey);
    if (raw) {
      const local = JSON.parse(raw);
      if (local && local.shift && local.shift.id) {
        // 离开期间头版可能被另一窗口推进：重定基线、标出冲突、按新库存重算。
        if (local.shift.baseRevision !== shared.revision) {
          rebaseShift(local.shift, shared);
        }
        recalcShift(local.shift, shared);
        return local;
      }
    }
  } catch {
    /* 班次损坏则重领 */
  }
  let settings = defaultSettings();
  try {
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) settings = { ...settings, ...JSON.parse(legacy).settings };
  } catch {
    /* 忽略旧设置读取失败 */
  }
  const local = { shift: emptyShift(shared), settings, selectedTypeId: shared.inventory[0]?.id || null };
  saveLocal(local);
  return local;
}

function saveLocal(data) {
  sessionStorage.setItem(localKey, JSON.stringify(data || local));
}

let shared = loadShared();
let local = loadLocal(shared);
let shift = local.shift;

// ---------- 派生状态：工作字模库 / 工作面 ----------

function workingInventory(head, workShift) {
  const deleted = new Set(workShift.changes.deletedTypeIds);
  const list = head.inventory.filter((item) => !deleted.has(item.id)).map((item) => ({ ...item }));
  for (const [tempId, item] of Object.entries(workShift.changes.addedTypes)) {
    list.push({ ...item, id: tempId });
  }
  for (const [typeId, qty] of Object.entries(workShift.changes.quantities)) {
    const item = list.find((entry) => entry.id === typeId);
    if (item) item.quantity = qty;
  }
  return list;
}

function workingPlacements(head, workShift, inventory) {
  const inv = inventory || workingInventory(head, workShift);
  const valid = new Set(inv.map((item) => item.id));
  const map = new Map();
  for (const p of head.placements) {
    if (!valid.has(p.typeId)) continue; // 本班次已删除的字模，落字随删除一并退场
    map.set(placementKey(p.row, p.col), { row: p.row, col: p.col, typeId: p.typeId, pending: false });
  }
  for (const [key, change] of Object.entries(workShift.changes.placements)) {
    const [row, col] = key.split(":").map(Number);
    if (change === null) {
      map.delete(key);
    } else {
      map.set(key, { row, col, typeId: change.typeId, pending: true });
    }
  }
  return [...map.values()];
}

function computeUsage(placements) {
  return placements.reduce((acc, p) => {
    acc[p.typeId] = (acc[p.typeId] || 0) + 1;
    return acc;
  }, {});
}

function getGrid() {
  const size = local.settings.paperSize;
  if (size === "bookmark") return { cols: 7, rows: 18 };
  if (size === "square") return { cols: 12, rows: 12 };
  return { cols: 16, rows: 10 };
}

function getSelectedType() {
  const inventory = workingInventory(shared, shift);
  return inventory.find((item) => item.id === local.selectedTypeId) || null;
}

// ---------- 班次变更（全部先记在本班次，不直接写头版） ----------

function afterLocalMutation() {
  shared = loadShared();
  recalcShift(shift, shared);
  saveLocal();
  renderAll();
}

function placeType(row, col, typeId) {
  if (!typeId) return;
  const key = placementKey(row, col);
  const committed = shared.placements.find((p) => placementKey(p.row, p.col) === key);
  const pending = shift.changes.placements[key];
  if (pending === undefined) {
    shift.changes.placements[key] = committed && committed.typeId === typeId ? null : { typeId };
  } else if (pending === null) {
    shift.changes.placements[key] = committed && committed.typeId === typeId ? undefined : { typeId };
    if (shift.changes.placements[key] === undefined) delete shift.changes.placements[key];
  } else if (pending.typeId === typeId) {
    delete shift.changes.placements[key];
  } else {
    shift.changes.placements[key] = { typeId };
  }
  afterLocalMutation();
}

function changeQuantity(typeId, raw) {
  let qty = Math.floor(Number(raw));
  if (!Number.isFinite(qty)) return;
  qty = Math.min(99, Math.max(1, qty));
  if (shift.changes.addedTypes[typeId]) {
    shift.changes.addedTypes[typeId].quantity = qty;
  } else {
    const baseQty = shift.baseQuantities[typeId];
    if (qty === baseQty) delete shift.changes.quantities[typeId];
    else shift.changes.quantities[typeId] = qty;
  }
  afterLocalMutation();
}

function addType(event) {
  event.preventDefault();
  const item = {
    char: els.charInput.value.trim(),
    style: els.styleInput.value.trim(),
    size: Number(els.sizeInput.value),
    quantity: Number(els.quantityInput.value),
    wear: els.wearInput.value
  };
  if (!item.char || !item.style) return;
  const id = crypto.randomUUID();
  shift.changes.addedTypes[id] = { id, ...item };
  local.selectedTypeId = id;
  els.typeForm.reset();
  els.sizeInput.value = 24;
  els.quantityInput.value = 3;
  afterLocalMutation();
}

function deleteType(typeId) {
  if (shift.changes.addedTypes[typeId]) {
    delete shift.changes.addedTypes[typeId];
  } else {
    shift.changes.deletedTypeIds.push(typeId);
    delete shift.changes.quantities[typeId];
  }
  for (const [key, change] of Object.entries(shift.changes.placements)) {
    if (change && change.typeId === typeId) delete shift.changes.placements[key];
  }
  if (local.selectedTypeId === typeId) local.selectedTypeId = null;
  afterLocalMutation();
}

// ---------- 重定基线与冲突检测 ----------

function rebaseShift(workShift, head) {
  const conflicts = [];
  for (const [key, ours] of Object.entries(workShift.changes.placements)) {
    const [row, col] = key.split(":").map(Number);
    const base = workShift.basePlacements[key] ?? null;
    const committed = head.placements.find((p) => placementKey(p.row, p.col) === key);
    const theirs = committed ? committed.typeId : null;
    if (theirs !== base) {
      conflicts.push({ row, col, ours: ours ? ours.typeId : null, theirs });
    }
  }
  const quantityConflicts = [];
  for (const [typeId, oursQty] of Object.entries(workShift.changes.quantities)) {
    if (workShift.changes.addedTypes[typeId]) continue;
    const baseQty = workShift.baseQuantities[typeId];
    const headItem = head.inventory.find((item) => item.id === typeId);
    const theirsQty = headItem ? headItem.quantity : null;
    if (theirsQty !== baseQty) {
      quantityConflicts.push({ typeId, ours: oursQty, theirs: theirsQty });
    }
  }
  workShift.baseRevision = head.revision;
  workShift.basePlacements = snapshotPlacements(head.placements);
  workShift.baseQuantities = snapshotQuantities(head.inventory);
  workShift.conflicts = conflicts;
  workShift.quantityConflicts = quantityConflicts;
  return { conflicts, quantityConflicts };
}

// ---------- 退回重算：头版数量更新后，未确认班次立刻按新库存重算 ----------

function recalcShift(workShift, head) {
  const inventory = workingInventory(head, workShift);
  const usage = computeUsage(workingPlacements(head, workShift, inventory));
  const reasons = [];
  for (const [typeId, used] of Object.entries(usage)) {
    const item = inventory.find((entry) => entry.id === typeId);
    if (!item) {
      reasons.push(`有 ${used} 个落字用的字模已被对方删除`);
    } else if (used > item.quantity) {
      reasons.push(`「${item.char} · ${item.style}」用量 ${used} 超过库存 ${item.quantity}`);
    }
  }
  workShift.returnReasons = reasons;
}

// ---------- 提交班次：乐观并发，只有一个能写入 ----------

function commitShift() {
  if (shift.conflicts.length || shift.quantityConflicts.length || shift.returnReasons.length) return;
  let head = loadShared();
  if (head.revision !== shift.baseRevision) {
    rebaseShift(shift, head);
    if (shift.conflicts.length || shift.quantityConflicts.length) {
      saveLocal();
      renderAll();
      return; // 不写入，等窗口取舍
    }
  }
  // 应用落字变更
  for (const [key, change] of Object.entries(shift.changes.placements)) {
    head.placements = head.placements.filter((p) => placementKey(p.row, p.col) !== key);
    if (change) {
      const [row, col] = key.split(":").map(Number);
      head.placements.push({ row, col, typeId: change.typeId });
    }
  }
  // 应用库存数量变更
  for (const [typeId, qty] of Object.entries(shift.changes.quantities)) {
    const item = head.inventory.find((entry) => entry.id === typeId);
    if (item) item.quantity = qty;
  }
  // 应用新增字模
  for (const item of Object.values(shift.changes.addedTypes)) {
    head.inventory.push({ ...item });
  }
  // 应用删除字模
  for (const typeId of shift.changes.deletedTypeIds) {
    head.inventory = head.inventory.filter((item) => item.id !== typeId);
    head.placements = head.placements.filter((p) => p.typeId !== typeId);
  }
  head.revision += 1;
  saveShared(head);
  shared = head;
  // 班次确认：基线推到头版，清空已提交变更
  shift.baseRevision = head.revision;
  shift.basePlacements = snapshotPlacements(head.placements);
  shift.baseQuantities = snapshotQuantities(head.inventory);
  shift.changes = emptyChanges();
  shift.conflicts = [];
  shift.quantityConflicts = [];
  shift.returnReasons = [];
  saveLocal();
  flashStatus(`班次已提交，头版修订号 ${head.revision}`);
  renderAll();
}

// ---------- 冲突取舍 ----------

function resolvePlacementConflict(row, col, keepOurs) {
  const key = placementKey(row, col);
  if (!keepOurs) delete shift.changes.placements[key]; // 接受对方：撤回本班次对该格的改动
  shift.conflicts = shift.conflicts.filter((c) => !(c.row === row && c.col === col));
  recalcShift(shift, shared);
  saveLocal();
  renderAll();
}

function resolveQuantityConflict(typeId, keepOurs) {
  if (!keepOurs) delete shift.changes.quantities[typeId];
  shift.quantityConflicts = shift.quantityConflicts.filter((c) => c.typeId !== typeId);
  recalcShift(shift, shared);
  saveLocal();
  renderAll();
}

// ---------- 草稿与导出：只认已确认班次（头版） ----------

function saveDraft() {
  const head = loadShared();
  const title = local.settings.workTitle.trim() || "未命名作品";
  head.drafts.unshift({
    id: crypto.randomUUID(),
    title,
    settings: structuredClone(local.settings),
    placements: structuredClone(head.placements),
    revision: head.revision,
    savedAt: new Date().toISOString()
  });
  head.drafts = head.drafts.slice(0, 8);
  saveShared(head);
  shared = head;
  renderAll();
}

function takeoverDraft(draft) {
  // 旧草稿（或任意已保存草稿）按单人班次接管：以当前头版为基线，
  // 草稿与头版的差异全部作为本班次变更，提交后才写入头版。
  const head = loadShared();
  const fresh = emptyShift(head);
  const headMap = new Map(head.placements.map((p) => [placementKey(p.row, p.col), p.typeId]));
  const draftMap = new Map((draft.placements || []).map((p) => [placementKey(p.row, p.col), p.typeId]));
  for (const [key, typeId] of draftMap) {
    if (headMap.get(key) !== typeId) fresh.changes.placements[key] = { typeId };
  }
  for (const [key] of headMap) {
    if (!draftMap.has(key)) fresh.changes.placements[key] = null;
  }
  shift = fresh;
  local.shift = fresh;
  if (draft.settings) local.settings = structuredClone(draft.settings);
  recalcShift(shift, head);
  saveLocal();
  renderAll();
}

function exportPreview() {
  const head = loadShared();
  const inventory = head.inventory;
  const { cols, rows } = getGrid();
  const cell = local.settings.paperSize === "bookmark" ? 44 : 56;
  const gap = local.settings.gridGap;
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
  ctx.fillText(local.settings.workTitle || "未命名作品", margin, 50);
  ctx.font = "bold 30px serif";
  // 导出只画已确认班次（头版）落字
  head.placements.forEach((placement) => {
    const type = inventory.find((item) => item.id === placement.typeId);
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
  link.download = `${local.settings.workTitle || "movable-type"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// ---------- 渲染 ----------

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
  shiftIdLabel: document.querySelector("#shiftIdLabel"),
  baseRevLabel: document.querySelector("#baseRevLabel"),
  headRevLabel: document.querySelector("#headRevLabel"),
  shiftStatus: document.querySelector("#shiftStatus"),
  commitShiftBtn: document.querySelector("#commitShiftBtn"),
  newWindowBtn: document.querySelector("#newWindowBtn"),
  conflictBanner: document.querySelector("#conflictBanner"),
  conflictList: document.querySelector("#conflictList"),
  returnBanner: document.querySelector("#returnBanner"),
  returnReasons: document.querySelector("#returnReasons")
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function charOf(inventory, typeId) {
  if (!typeId) return "空";
  const item = inventory.find((entry) => entry.id === typeId);
  return item ? item.char : "？";
}

function renderSettings() {
  els.paperSize.value = local.settings.paperSize;
  els.flowMode.value = local.settings.flowMode;
  els.gridGap.value = local.settings.gridGap;
  els.workTitle.value = local.settings.workTitle;
}

function renderShiftBar() {
  const head = loadShared();
  els.shiftIdLabel.textContent = shift.id.slice(0, 4);
  els.baseRevLabel.textContent = shift.baseRevision;
  els.headRevLabel.textContent = head.revision;
  const blocked = shift.conflicts.length || shift.quantityConflicts.length || shift.returnReasons.length;
  let label = "编辑中";
  if (shift.conflicts.length || shift.quantityConflicts.length) label = "冲突待处理";
  else if (shift.returnReasons.length) label = "已退回";
  els.shiftStatus.textContent = label;
  els.shiftStatus.className = `badge ${blocked ? "warn" : "ok"}`;
  els.commitShiftBtn.disabled = !!blocked;
  els.commitShiftBtn.title = blocked ? "存在冲突或超量退回，处理后才能提交" : "提交本班次：只有一个窗口能写入头版";
}

function renderBanners() {
  const placementConflicts = shift.conflicts;
  const quantityConflicts = shift.quantityConflicts;
  const hasConflict = placementConflicts.length || quantityConflicts.length;
  els.conflictBanner.hidden = !hasConflict;
  els.conflictList.innerHTML = [
    ...placementConflicts.map((c) => {
      const ours = charOf(workingInventory(shared, shift), c.ours);
      const theirs = charOf(shared.inventory, c.theirs);
      return `
        <div class="conflict-row" data-conflict-cell="${c.row}:${c.col}">
          <span class="conflict-where">第${c.row + 1}行第${c.col + 1}列</span>
          <span class="conflict-pick">
            <button type="button" data-keep-ours="${c.row}:${c.col}">保留我方 ${escapeHtml(ours)}</button>
            <button type="button" data-accept-theirs="${c.row}:${c.col}">接受对方 ${escapeHtml(theirs)}</button>
          </span>
        </div>`;
    }),
    ...quantityConflicts.map((c) => {
      const item = shared.inventory.find((entry) => entry.id === c.typeId);
      const name = item ? `${item.char} · ${item.style}` : "已删除字模";
      return `
        <div class="conflict-row" data-conflict-qty="${c.typeId}">
          <span class="conflict-where">${escapeHtml(name)} 数量</span>
          <span class="conflict-pick">
            <button type="button" data-keep-qty-ours="${c.typeId}">保留我方 ${c.ours}</button>
            <button type="button" data-accept-qty-theirs="${c.typeId}">接受对方 ${c.theirs === null ? "删除" : c.theirs}</button>
          </span>
        </div>`;
    })
  ].join("");

  els.returnBanner.hidden = shift.returnReasons.length === 0;
  els.returnReasons.innerHTML = shift.returnReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
}

function renderStyleFilter() {
  const inventory = workingInventory(shared, shift);
  const current = els.styleFilter.value || "all";
  const styles = [...new Set(inventory.map((item) => item.style))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  els.styleFilter.innerHTML = `<option value="all">全部风格</option>${styles
    .map((style) => `<option value="${escapeHtml(style)}">${escapeHtml(style)}</option>`)
    .join("")}`;
  els.styleFilter.value = styles.includes(current) ? current : "all";
}

function renderInventory() {
  const inventory = workingInventory(shared, shift);
  const usage = computeUsage(workingPlacements(shared, shift, inventory));
  const keyword = els.inventorySearch.value.trim();
  const style = els.styleFilter.value;
  const items = inventory.filter((item) => {
    const matchesKeyword = !keyword || `${item.char}${item.style}${item.wear}`.includes(keyword);
    const matchesStyle = style === "all" || item.style === style;
    return matchesKeyword && matchesStyle;
  });

  els.inventoryCount.textContent = `${inventory.length}枚字模`;
  els.typeList.innerHTML = items
    .map((item) => {
      const used = usage[item.id] || 0;
      const selected = item.id === local.selectedTypeId ? "selected" : "";
      const isNew = !!shift.changes.addedTypes[item.id];
      const qtyChanged = shift.changes.quantities[item.id] !== undefined || isNew;
      return `
        <article class="type-card ${selected} ${isNew ? "pending-new" : ""}" draggable="true" data-type-id="${item.id}">
          <div class="glyph" style="font-size:${Math.min(item.size, 36)}px">${escapeHtml(item.char)}</div>
          <div class="type-meta">
            <strong>${escapeHtml(item.char)} · ${escapeHtml(item.style)} ${isNew ? '<em class="pending-tag">待提交</em>' : ""}</strong>
            <span>${item.size}px · ${escapeHtml(item.wear)} · 已用${used}/</span>
            <label class="qty-label">库存
              <input class="qty-input ${qtyChanged ? "changed" : ""}" type="number" min="1" max="99" value="${item.quantity}" data-qty-input="${item.id}" />
            </label>
          </div>
          <button class="mini-btn" title="删除字模（随班次提交）" data-delete-type="${item.id}" type="button">×</button>
        </article>
      `;
    })
    .join("");
}

function renderStage() {
  const head = loadShared();
  const inventory = workingInventory(head, shift);
  const placements = workingPlacements(head, shift, inventory);
  const { cols, rows } = getGrid();
  const conflictKeys = new Set(shift.conflicts.map((c) => placementKey(c.row, c.col)));
  const map = new Map(placements.map((p) => [placementKey(p.row, p.col), p]));
  els.stage.className = `stage ${local.settings.paperSize}`;
  els.stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  els.stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  els.stage.style.gap = `${local.settings.gridGap}px`;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const key = placementKey(row, col);
      const placement = map.get(key);
      const conflict = conflictKeys.has(key) ? shift.conflicts.find((c) => c.row === row && c.col === col) : null;
      const type = placement ? inventory.find((item) => item.id === placement.typeId) : null;
      const vertical = local.settings.flowMode === "vertical" ? "vertical" : "";
      const classes = ["cell", type ? "used" : "", placement && placement.pending ? "pending" : "", conflict ? "conflict" : "", vertical].filter(Boolean).join(" ");
      let content = "";
      if (conflict) {
        content = `<span class="conflict-chip ours" title="我方选择">${escapeHtml(charOf(inventory, conflict.ours))}</span><span class="conflict-chip theirs" title="对方选择">${escapeHtml(charOf(head.inventory, conflict.theirs))}</span>`;
      } else if (type) {
        content = escapeHtml(type.char);
      }
      cells.push(`
        <button class="${classes}" data-row="${row}" data-col="${col}" type="button" aria-label="第${row + 1}行第${col + 1}列">
          ${content}
        </button>
      `);
    }
  }
  els.stage.innerHTML = cells.join("");
}

function renderUsage() {
  const inventory = workingInventory(shared, shift);
  const usage = computeUsage(workingPlacements(shared, shift, inventory));
  const entries = inventory.filter((item) => usage[item.id]);
  const workingCount = workingPlacements(shared, shift, inventory).length;
  els.placedCount.textContent = `${workingCount}个落字（本班次工作面）`;

  const shortages = entries.filter((item) => usage[item.id] > item.quantity);
  els.shortageBadge.textContent = shortages.length ? `${shortages.length}处超量` : "数量充足";
  els.shortageBadge.className = `badge ${shortages.length ? "warn" : "ok"}`;

  const selectedType = getSelectedType();
  els.selectedTypeLabel.textContent = selectedType ? `当前：${selectedType.char} · ${selectedType.style}` : "未选择字模";

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
      .join("") || `<p class="empty">还没有落字。</p>`;
}

function renderDrafts() {
  const head = loadShared();
  els.draftList.innerHTML =
    head.drafts
      .map(
        (draft) => `
          <article class="draft-item">
            <strong>${escapeHtml(draft.title)} ${draft.legacy ? '<em class="pending-tag">旧稿</em>' : ""}</strong>
            <span>${draft.placements.length}个落字 · ${draft.revision ? `修订 ${draft.revision} · ` : ""}${new Date(draft.savedAt).toLocaleString("zh-CN")}</span>
            <div class="draft-actions">
              <button type="button" data-load-draft="${draft.id}">单人接管</button>
              <button type="button" data-delete-draft="${draft.id}">删除</button>
            </div>
          </article>
        `
      )
      .join("") || `<p class="empty">还没有保存草稿。</p>`;
}

let flashTimer = null;
function flashStatus(message) {
  els.shiftStatus.textContent = message;
  els.shiftStatus.className = "badge ok";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(renderShiftBar, 2600);
}

function renderAll() {
  shared = loadShared();
  renderSettings();
  renderShiftBar();
  renderBanners();
  renderStyleFilter();
  renderInventory();
  renderStage();
  renderUsage();
  renderDrafts();
}

// ---------- 事件 ----------

els.paperSize.addEventListener("change", () => {
  local.settings.paperSize = els.paperSize.value;
  const { cols, rows } = getGrid();
  // 超出新版面的已确认落字，在本班次记为移除
  for (const p of shared.placements) {
    if (p.row >= rows || p.col >= cols) shift.changes.placements[placementKey(p.row, p.col)] = null;
  }
  for (const [key, change] of Object.entries(shift.changes.placements)) {
    const [r, c] = key.split(":").map(Number);
    if (r >= rows || c >= cols) {
      if (change === null) continue;
      delete shift.changes.placements[key];
    }
  }
  saveLocal();
  renderAll();
});

els.flowMode.addEventListener("change", () => {
  local.settings.flowMode = els.flowMode.value;
  saveLocal();
  renderAll();
});

els.gridGap.addEventListener("input", () => {
  local.settings.gridGap = Number(els.gridGap.value);
  saveLocal();
  renderAll();
});

els.workTitle.addEventListener("input", () => {
  local.settings.workTitle = els.workTitle.value;
  saveLocal();
});

els.typeForm.addEventListener("submit", addType);
els.inventorySearch.addEventListener("input", renderInventory);
els.styleFilter.addEventListener("change", renderInventory);
els.saveDraftBtn.addEventListener("click", saveDraft);
els.exportBtn.addEventListener("click", exportPreview);
els.commitShiftBtn.addEventListener("click", commitShift);

els.newWindowBtn.addEventListener("click", () => {
  window.open("index.html", "_blank", "noopener");
});

els.clearBoardBtn.addEventListener("click", () => {
  const head = loadShared();
  for (const p of head.placements) shift.changes.placements[placementKey(p.row, p.col)] = null;
  for (const [key, change] of Object.entries(shift.changes.placements)) {
    if (change === null) continue;
    const exists = head.placements.some((p) => placementKey(p.row, p.col) === key);
    if (!exists) delete shift.changes.placements[key];
  }
  afterLocalMutation();
});

els.typeList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-type]");
  if (deleteButton) {
    deleteType(deleteButton.dataset.deleteType);
    return;
  }
  const qtyInput = event.target.closest("[data-qty-input]");
  if (qtyInput) return; // 数量输入框自行处理 change 事件
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  local.selectedTypeId = card.dataset.typeId;
  saveLocal();
  renderAll();
});

els.typeList.addEventListener("change", (event) => {
  const qtyInput = event.target.closest("[data-qty-input]");
  if (!qtyInput) return;
  changeQuantity(qtyInput.dataset.qtyInput, qtyInput.value);
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
  const keepOurs = event.target.closest("[data-keep-ours]");
  const acceptTheirs = event.target.closest("[data-accept-theirs]");
  const keepQtyOurs = event.target.closest("[data-keep-qty-ours]");
  const acceptQtyTheirs = event.target.closest("[data-accept-qty-theirs]");
  if (keepOurs) {
    const [row, col] = keepOurs.dataset.keepOurs.split(":").map(Number);
    resolvePlacementConflict(row, col, true);
  } else if (acceptTheirs) {
    const [row, col] = acceptTheirs.dataset.acceptTheirs.split(":").map(Number);
    resolvePlacementConflict(row, col, false);
  } else if (keepQtyOurs) {
    resolveQuantityConflict(keepQtyOurs.dataset.keepQtyOurs, true);
  } else if (acceptQtyTheirs) {
    resolveQuantityConflict(acceptQtyTheirs.dataset.acceptQtyTheirs, false);
  }
});

els.draftList.addEventListener("click", (event) => {
  const loadButton = event.target.closest("[data-load-draft]");
  const deleteButton = event.target.closest("[data-delete-draft]");
  if (loadButton) {
    const head = loadShared();
    const draft = head.drafts.find((item) => item.id === loadButton.dataset.loadDraft);
    if (!draft) return;
    takeoverDraft(draft);
  }
  if (deleteButton) {
    const head = loadShared();
    head.drafts = head.drafts.filter((item) => item.id !== deleteButton.dataset.deleteDraft);
    saveShared(head);
    shared = head;
    renderAll();
  }
});

// 另一窗口提交班次后，头版修订号推进：本班次立刻重定基线、标出冲突、按新库存重算退回
window.addEventListener("storage", (event) => {
  if (event.key !== sharedKey) return;
  const head = loadShared();
  shared = head;
  rebaseShift(shift, head);
  recalcShift(shift, head);
  saveLocal();
  renderAll();
});

renderAll();
