const readOnly = document.documentElement.dataset.mode === "public";
const state = {
  data: null, reviews: null, runs: [], model: null, selectedTarget: null, selectedAttempt: null,
  selectedRegion: null, inputIndex: 0, registeredPose: false, reviewStartedAt: Date.now(), filters: { dataset: "all", outcome: "all", review: "all" },
  catalog: null, bundleId: null, loading: false, saving: false, formDirty: false,
  lastModel: {}, lastBundle: {}, selections: {}, drafts: {},
};
let geometryViewers = null;
let geometryModulePromise = null;
let geometryLoadGeneration = 0;
let bundleLoadGeneration = 0;
let bundleAbortController = null;
let attemptFilesController = new AbortController();

const ISSUE_LABELS = {
  agent_geometry: "Agent geometry", agent_reasoning: "Agent reasoning", input_ambiguity: "Input ambiguity",
  ground_truth_error: "Ground-truth error", verifier_metric: "Verifier metric", verifier_threshold: "Verifier threshold",
  alignment_error: "Alignment", export_error: "Geometry export", mcp_error: "MCP interface",
  harness_error: "Harness", attempt_selection: "Attempt selection", none: "No issue",
};
const FINDING_CATEGORIES = Object.keys(ISSUE_LABELS).filter((key) => key !== "none");
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const fmt = (value, digits = 2) => value == null ? "N/A" : Number(value).toFixed(digits);
const shortHash = (value) => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "unavailable";

// These exports are frozen supplemental pages, bound to one catalog experiment each.
const VISION_RECORDS = {
  "direct-kimi-2": "kimi-vision-direct-2.html",
  "direct-kimi-4": "kimi-vision-direct-4.html",
  "direct-kimi-10": "kimi-vision-direct-10.html",
  "evocad-kimi-2": "kimi-vision-evocad-2.html",
};
function renderIcons() { globalThis.lucide?.createIcons(); }
function syncSelectLabels() {
  document.querySelectorAll("[data-select-value]").forEach((label) => {
    const select = $(label.dataset.selectValue);
    label.textContent = select.selectedOptions[0]?.textContent || "";
    select.title = label.textContent;
  });
}
function bundleEntry(id) {
  return state.catalog?.bundles.find((entry) => entry.id === id);
}
function entryModels(entry) {
  return entry?.models || [];
}
function externalExperiments() { return state.catalog.external_experiments || []; }
function harnessModels(harness) {
  const models = state.catalog.bundles.filter((entry) => entry.harness === harness).flatMap(entryModels);
  const summaryModels = externalExperiments().filter((entry) => entry.harness === harness).map((entry) => entry.model);
  return [...new Set([...models, ...summaryModels])];
}
function modelExperiments(harness, model) {
  return state.catalog.bundles.filter((entry) => entry.harness === harness && entryModels(entry).includes(model));
}
function navigationKey(...parts) { return JSON.stringify(parts); }
function preferredExperiment(harness, model) {
  const entries = modelExperiments(harness, model);
  const remembered = state.lastBundle[navigationKey(harness, model)];
  return entries.find((entry) => entry.id === remembered) || entries[0];
}
function selectModelExperiment(harness, model) {
  const entry = preferredExperiment(harness, model);
  if (entry) return loadBundle(entry.id, model);
  const summary = externalExperiments().find((item) => item.harness === harness && item.model === model);
  if (!summary) return;
  const url = new URL(summary.url, location.href);
  if (url.origin !== location.origin) return;
  rememberDraft();
  // The back button returns to the geometry selection that is still loaded.
  $("harnessFilter").value = bundleEntry(state.bundleId).harness;
  $("modelFilter").value = state.model;
  location.assign(url.href);
}
function persistNavigation() {
  const { lastModel, lastBundle, selections } = state;
  try { sessionStorage.setItem("evocadGeometryNavigation", JSON.stringify({ lastModel, lastBundle, selections })); }
  catch { /* Selection memory remains available in this page. */ }
}
function rememberSelection() {
  if (!state.bundleId || !state.selectedTarget) return;
  const harness = bundleEntry(state.bundleId)?.harness;
  state.selections[navigationKey(harness, state.model, state.bundleId)] = {
    target: state.selectedTarget, attempt: state.selectedAttempt,
  };
  persistNavigation();
}
function experimentRecord(entry, model) {
  if (!entry) return null;
  if (VISION_RECORDS[entry.id] && model === "kimi-k3") {
    return { href: VISION_RECORDS[entry.id], label: "看图与操作记录", icon: "scan-eye" };
  }
  const recordedModel = entry.recorded_io?.summary?.model;
  if (model === recordedModel && /astra/i.test(recordedModel || "")) {
    return { href: `astra.html?run=${encodeURIComponent(entry.id)}`, label: "模型输入输出与执行记录", icon: "file-clock" };
  }
  return null;
}
function renderRecords(entry) {
  const record = experimentRecord(entry, state.model);
  $("experimentRecords").hidden = !record;
  $("experimentRecords").innerHTML = record ? `<a href="${escapeHtml(record.href)}" target="_blank" rel="noopener"><i data-lucide="${record.icon}" aria-hidden="true"></i>${record.label}<i data-lucide="arrow-up-right" aria-hidden="true"></i></a>` : "";
  const harnesses = [...new Set(state.catalog.bundles.map((item) => item.harness))];
  const sections = harnesses.map((harness) => {
    const groups = harnessModels(harness).map((model) => {
      const links = modelExperiments(harness, model).map((item) => {
        const link = experimentRecord(item, model);
        if (!link) return "";
        return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener"><i data-lucide="${link.icon}" aria-hidden="true"></i><span>${escapeHtml(item.label)}<small>${link.label}</small></span><i data-lucide="arrow-up-right" aria-hidden="true"></i></a>`;
      }).join("");
      return links ? `<div class="records-model"><h4>${escapeHtml(model)}</h4>${links}</div>` : "";
    }).join("");
    return groups ? `<section><h3>${escapeHtml(harness)}</h3>${groups}</section>` : "";
  }).join("");
  $("recordsLibrary").innerHTML = sections || '<div class="empty">暂无独立归档记录</div>';
  $("openRecords").disabled = !sections;
  renderIcons();
}
function renderFilterState() {
  const count = Object.values(state.filters).filter((value) => value !== "all").length;
  $("filterCount").hidden = !count;
  $("filterCount").textContent = `${count} 项`;
  $("resetFilters").disabled = !count;
  syncSelectLabels();
}
function resetFilters() {
  Object.keys(state.filters).forEach((key) => { state.filters[key] = "all"; $(key + "Filter").value = "all"; });
  renderRunList();
}

function bundleBase(id = state.bundleId) { return id ? `${readOnly ? "./" : "/"}bundles/${encodeURIComponent(id)}/` : "/"; }
function reviewsUrl(id = state.bundleId) { return readOnly ? `${bundleBase(id)}reviews.json` : id ? `/api/bundles/${encodeURIComponent(id)}/reviews` : "/api/reviews"; }
function assetUrl(path) { return path ? bundleBase() + path.replace(/^\/+/, "") : ""; }
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function draftKey() {
  return state.data && state.selectedTarget && state.selectedAttempt
    ? `${state.data.bundle_sha256}:${state.selectedTarget}:${state.selectedAttempt}` : null;
}
function reviewFields() {
  return [...$("reviewForm").querySelectorAll("input, select, textarea")].filter((field) => !field.hasAttribute("data-field"));
}
function persistDrafts() {
  try { sessionStorage.setItem("evocadReviewDrafts", JSON.stringify(state.drafts)); }
  catch { $("formStatus").textContent = "Draft kept in this page only; browser storage unavailable."; }
}
function rememberDraft() {
  if (readOnly) return;
  const key = draftKey();
  if (!key || !state.formDirty) return;
  state.drafts[key] = {
    fields: reviewFields().map((field) => ({ value: field.value, checked: field.checked })),
    findings: collectFindings(), startedAt: state.reviewStartedAt,
  };
  persistDrafts();
}
function restoreDraft() {
  if (readOnly) return;
  const draft = state.drafts[draftKey()];
  if (!draft) return;
  reviewFields().forEach((field, index) => {
    if (!draft.fields[index]) return;
    field.value = draft.fields[index].value;
    if ("checked" in field) field.checked = draft.fields[index].checked;
  });
  draft.findings.forEach((finding) => addFinding(finding));
  state.reviewStartedAt = draft.startedAt;
  state.formDirty = true;
  $("formStatus").textContent = "Unsaved draft restored.";
}

function renderNavigation() {
  const entry = bundleEntry(state.bundleId);
  if (!entry) return;
  $("harnessNavigation").hidden = false;
  const harnesses = [...new Set([...state.catalog.bundles, ...externalExperiments()].map((item) => item.harness))];
  $("harnessFilter").innerHTML = harnesses.map((name) => `<option>${escapeHtml(name)}</option>`).join("");
  $("harnessFilter").value = entry.harness;
  $("modelFilter").innerHTML = harnessModels(entry.harness).map((model) => `<option>${escapeHtml(model)}</option>`).join("");
  $("modelFilter").value = state.model;
  $("experimentFilter").innerHTML = modelExperiments(entry.harness, state.model)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
  $("experimentFilter").value = entry.id;
  syncSelectLabels();
  renderRecords(entry);
}

function setNavigationBusy() {
  const busy = state.loading || state.saving;
  for (const id of ["harnessFilter", "modelFilter", "experimentFilter"]) {
    const select = $(id);
    select.disabled = busy || select.options.length < 2;
  }
  $("submitReview").disabled = busy || !currentAttempt();
  $("exportReviews").disabled = busy || !modelReviewRecords().length;
  for (const selector of [".inspection", ".review-panel", ".filter-grid", "#runList"]) {
    const element = document.querySelector(selector);
    if (element) { element.inert = busy; element.setAttribute("aria-busy", String(busy)); }
  }
}

async function loadBundle(id, model, sample = null, requestedPose = false) {
  if (state.saving) { renderNavigation(); return; }
  rememberDraft();
  const generation = ++bundleLoadGeneration;
  bundleAbortController?.abort();
  bundleAbortController = new AbortController();
  state.loading = true;
  setNavigationBusy();
  $("navigationStatus").textContent = "正在加载实验…";
  try {
    const sameBundle = state.data && state.bundleId === id;
    const [data, reviews] = sameBundle ? [state.data, state.reviews] : await Promise.all([
      fetchJson(id ? `${bundleBase(id)}review-data.json` : "/data/review-data.json", { signal: bundleAbortController.signal }),
      fetchJson(reviewsUrl(id), { signal: bundleAbortController.signal }),
    ]);
    if (generation !== bundleLoadGeneration) return;
    const entry = bundleEntry(id);
    if ((entry && data.bundle_sha256 !== entry.bundle_sha256) || reviews.integrity.bundle.bundle_sha256 !== data.bundle_sha256) {
      throw new Error("Experiment evidence and review ledger do not match");
    }
    const selectedModel = model || entryModels(entry)[0] || data.runs[0]?.model || null;
    if (entry && !entryModels(entry).includes(selectedModel)) {
      throw new Error("The selected model is unavailable in this experiment");
    }
    const runs = data.runs.filter((run) => run.model === selectedModel);
    ++geometryLoadGeneration;
    geometryViewers?.dispose(); geometryViewers = null;
    state.data = data; state.reviews = reviews; state.bundleId = id; state.model = selectedModel; state.runs = runs;
    state.selectedTarget = null; state.selectedAttempt = null; state.formDirty = false; state.registeredPose = false;
    state.filters = { dataset: "all", outcome: "all", review: "all" };
    if (entry) {
      state.lastModel[navigationKey(entry.harness)] = selectedModel;
      state.lastBundle[navigationKey(entry.harness, selectedModel)] = id;
      persistNavigation();
    }
    setOptions($("datasetFilter"), [...new Set(runs.map((run) => run.dataset))].sort(), "全部数据集");
    const scoped = runs.some((run) => run.attempts.some((attempt) => attempt.evaluation_scope));
    const outcomeLabels = scoped ? { passed: "整题严格通过", failed: "整题未通过", unscored: "整题未确认" }
      : { passed: "严格通过", failed: "未通过", unscored: "未评分" };
    for (const option of $("outcomeFilter").options) {
      if (outcomeLabels[option.value]) option.textContent = outcomeLabels[option.value];
    }
    $("outcomeFilter").value = "all"; $("reviewFilter").value = "all";
    renderNavigation(); renderHeader(); resetReviewForm();
    const saved = state.selections[navigationKey(entry?.harness, selectedModel, id)];
    const requested = sample && (runs.find((item) => item.sample_key === sample) || runs.find((item) => item.sample_id === sample));
    const run = requested || runs.find((item) => item.target_id === saved?.target) || runs[0];
    if (run) selectRun(run.target_id, run.target_id === saved?.target ? saved.attempt : null, Boolean(requested && requestedPose));
    else renderRunList();
    syncSelectionUrl();
    $("navigationStatus").textContent = "";
    document.documentElement.dataset.appState = "ready";
  } catch (error) {
    if (generation !== bundleLoadGeneration) return;
    if (!state.data) throw error;
    renderNavigation();
    $("navigationStatus").textContent = `切换失败：${error.message}`;
  } finally {
    if (generation === bundleLoadGeneration) { state.loading = false; setNavigationBusy(); }
  }
}

function currentRun() { return state.runs.find((run) => run.target_id === state.selectedTarget); }
function currentAttempt() { return currentRun()?.attempts.find((attempt) => attempt.attempt_id === state.selectedAttempt); }
function syncSelectionUrl() {
  if (!state.bundleId || !state.model) return;
  const url = new URL(location.href);
  url.searchParams.set("view", state.bundleId);
  url.searchParams.set("model", state.model);
  const sample = currentRun()?.sample_key;
  if (sample) url.searchParams.set("sample", sample);
  else url.searchParams.delete("sample");
  if (state.registeredPose) url.searchParams.set("pose", "task");
  else url.searchParams.delete("pose");
  if (url.href !== location.href) history.replaceState(null, "", url);
}
function modelReviewRecords() {
  const targetIds = new Set(state.runs.map((run) => run.target_id));
  return (state.reviews?.records || []).filter((record) => targetIds.has(record.binding.target_id));
}
function activeReviews() {
  const records = state.reviews?.records || [];
  const superseded = new Set(records.map((row) => row.supersedes_review_id).filter(Boolean));
  return records.filter((row) => !superseded.has(row.review_id));
}
function targetReviews(targetId, attemptId = null) {
  return activeReviews().filter((row) => row.binding.target_id === targetId && (!attemptId || row.binding.attempt_id === attemptId));
}

function setOptions(select, values, allLabel) {
  select.innerHTML = `<option value="all">${escapeHtml(allLabel)}</option>` + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function visibleRuns() {
  return state.runs.filter((run) => {
    const records = targetReviews(run.target_id);
    const disputed = records.some((row) => ["partially_agree", "disagree"].includes(row.verifier_decision));
    return (state.filters.dataset === "all" || run.dataset === state.filters.dataset) &&
      (state.filters.outcome === "all" || (state.filters.outcome === "unscored" ? run.passed == null : run.passed != null && (state.filters.outcome === "passed") === run.passed)) &&
      (state.filters.review === "all" || (state.filters.review === "pending" && !records.length) ||
        (state.filters.review === "reviewed" && records.length) || (state.filters.review === "disputed" && disputed));
  });
}

function renderRunList() {
  const runs = visibleRuns();
  renderFilterState();
  $("runCount").textContent = `${runs.length} / ${state.runs.length}`;
  $("runList").innerHTML = runs.map((run) => {
    const reviews = targetReviews(run.target_id);
    const disputed = reviews.some((row) => ["partially_agree", "disagree"].includes(row.verifier_decision));
    const reviewState = !reviews.length ? "pending" : disputed ? "disputed" : "reviewed";
    return `<button class="run-item ${run.target_id === state.selectedTarget ? "active" : ""}" data-target="${escapeHtml(run.target_id)}">
      <div><strong>${escapeHtml(run.sample_key)}</strong><span>${escapeHtml(run.dataset)}</span></div>
      <div class="run-result"><span class="score ${run.passed == null ? "" : run.passed ? "pass" : "fail"}">${fmt(run.score, 1)}</span><i class="review-dot ${reviewState}" title="${reviewState}"></i></div>
    </button>`;
  }).join("") || `<div class="empty">没有符合筛选条件的算例。</div>`;
  document.querySelectorAll(".run-item").forEach((button) => button.addEventListener("click", () => selectRun(button.dataset.target)));
  if (!runs.length) showNoRun(state.runs.length ? "没有符合筛选条件的算例" : "此模型在当前实验中没有算例");
  else if (!runs.some((run) => run.target_id === state.selectedTarget)) selectRun(runs[0].target_id);
  else if ($("runDetails").hidden && currentAttempt()) renderRun();
}

function metric(label, value, tone = "") { return `<div class="metric"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`; }
function scopeResult(value) { return value === true ? "通过" : value === false ? "未通过" : "未确认"; }
function scopeTone(value) { return value === true ? "good" : value === false ? "bad" : ""; }

function showNoRun(message) {
  ++geometryLoadGeneration;
  attemptFilesController.abort();
  geometryViewers?.dispose(); geometryViewers = null;
  $("datasetLabel").textContent = "";
  $("taskTitle").textContent = message;
  $("modelLabel").textContent = state.model || "";
  $("targetId").textContent = "";
  $("runDetails").hidden = true;
  $("reviewPanel").hidden = true;
}

function selectRun(targetId, attemptId = null, requestedPose = false) {
  const run = state.runs.find((item) => item.target_id === targetId);
  if (!run) return;
  rememberDraft();
  state.selectedTarget = targetId;
  const selected = run.attempts.find((attempt) => attempt.attempt_id === attemptId)
    || run.attempts.find((attempt) => attempt.attempt_id === run.selected_attempt_id) || run.attempts.at(-1);
  state.selectedAttempt = selected?.attempt_id || null;
  state.selectedRegion = null;
  state.inputIndex = 0;
  state.registeredPose = Boolean(requestedPose && selected && poseAssets(selected, poseEvidence(selected)));
  state.reviewStartedAt = Date.now();
  resetReviewForm();
  restoreDraft();
  rememberSelection();
  syncSelectionUrl();
  renderRun();
  renderRunList();
}

function selectAttempt(attemptId) {
  if (!currentRun()?.attempts.some((attempt) => attempt.attempt_id === attemptId)) return;
  rememberDraft();
  state.selectedAttempt = attemptId;
  state.selectedRegion = null;
  state.registeredPose = false;
  state.reviewStartedAt = Date.now();
  resetReviewForm();
  restoreDraft();
  rememberSelection();
  syncSelectionUrl();
  renderRun();
}

function renderRun() {
  const run = currentRun();
  const attempt = currentAttempt();
  if (!run || !attempt) { showNoRun("此算例没有可用的尝试记录"); return; }
  $("runDetails").hidden = false;
  $("reviewPanel").hidden = false;
  const scope = attempt.evaluation_scope;
  $("datasetLabel").textContent = `${run.dataset}${run.category ? ` / ${run.category}` : ""}`;
  $("taskTitle").textContent = run.task;
  $("modelLabel").textContent = scope && run.reasoning_effort
    ? `${run.model} · ${run.reasoning_effort} requested`
    : `${run.model} · ${run.reasoning_effort || "default"}`;
  $("targetId").textContent = run.target_id;
  $("metrics").innerHTML = (scope ? [
    metric(measurementLabel(attempt), scope.display ?? fmt(run.score)),
    metric("评测状态", scope.measurement_status || "未确认"),
    metric("组件检查", scopeResult(scope.component_passed), scopeTone(scope.component_passed)),
    metric("整题验收", scopeResult(scope.whole_task_passed), scopeTone(scope.whole_task_passed)),
    metric("执行状态", scope.execution_status || run.status || "未确认"),
    metric("尝试记录", run.attempts.length),
  ] : [
    metric("Selected score", fmt(run.score), run.passed == null ? "" : run.passed ? "good" : "bad"),
    metric("Attempt score", fmt(attempt.score), attempt.passed == null ? "" : attempt.passed ? "good" : "bad"),
    metric("Strict label", attempt.passed == null ? "UNSCORED" : attempt.passed ? "PASS" : "FAIL", attempt.passed == null ? "" : attempt.passed ? "good" : "bad"),
    metric("Attempts", run.attempts.length),
    metric("Elapsed", `${fmt(attempt.elapsed_seconds, 1)} s`),
    metric("Ledger", run.integrity?.ok ? "VERIFIED" : "CHECK", run.integrity?.ok ? "good" : "bad"),
  ]).join("");
  const annotation = run.data_quality_annotation;
  $("annotationBanner").hidden = !annotation;
  if (annotation) $("annotationBanner").innerHTML = `<strong>Data-quality annotation: ${escapeHtml(annotation.status)}</strong><span>${escapeHtml((annotation.issue_types || []).join(" · "))}</span><p>${escapeHtml(annotation.recommended_use || "")}</p>`;
  renderAttempts(run);
  renderEvidence(run, attempt);
  renderAttemptExtras(run, attempt);
  renderVerifier(attempt);
  renderReflection(attempt);
  renderMcp(attempt);
  renderReviewPanel(run, attempt);
}

function renderAttempts(run) {
  $("attemptButtons").innerHTML = run.attempts.map((attempt) => `<button class="attempt-button ${attempt.attempt_id === state.selectedAttempt ? "active" : ""} ${attempt.passed == null ? "" : attempt.passed ? "passed" : "failed"}" data-attempt="${escapeHtml(attempt.attempt_id)}">
    <span title="${escapeHtml(attempt.attempt_id)}">${escapeHtml(attempt.attempt_id)}</span><strong>${fmt(attempt.score, 1)}</strong><small>${attempt.safety_stop_reason ? `safety: ${escapeHtml(attempt.safety_stop_reason)}` : attempt.agent_decision ? `agent: ${escapeHtml(attempt.agent_decision)}` : attempt.selected ? "selected" : attempt.timed_out ? "timeout" : attempt.passed ? "pass" : "no decision"}</small>
  </button>`).join("");
  document.querySelectorAll(".attempt-button").forEach((button) => button.addEventListener("click", () => selectAttempt(button.dataset.attempt)));
}

function setImage(id, source, emptyText) {
  const image = $(id);
  const container = image.parentElement;
  if (container.matches("button")) {
    container.disabled = true;
    image.onload = () => { container.disabled = false; };
    image.onerror = () => {
      container.disabled = true;
      image.hidden = true;
      container.classList.add("missing");
    };
  }
  image.hidden = !source;
  container.classList.toggle("missing", !source);
  container.dataset.empty = emptyText;
  if (source) image.src = source;
  else image.removeAttribute("src");
}

function comparisonAlignment(attempt) {
  if (!attempt.comparison_view && !attempt.evaluation_scope) return undefined;
  const alignment = attempt.comparison_view?.alignment;
  const geometry = attempt.geometry || {};
  if (alignment === "fixed_frame" && geometry.ground_truth && geometry.candidate) return alignment;
  if (alignment === "historical_alignment" && geometry.ground_truth && geometry.overlay_candidate) return alignment;
  return "unavailable";
}

function poseEvidence(attempt) {
  const pose = attempt.pose_comparison;
  return pose?.kind === "allowed_axial_pose" ? pose : null;
}

function measurementLabel(attempt) {
  const label = attempt.evaluation_scope?.label || "测量";
  return poseEvidence(attempt) ? `历史原坐标诊断 · ${label}` : label;
}

function poseAssets(attempt, pose) {
  if (!pose || !attempt.geometry?.ground_truth || !attempt.geometry?.candidate) return null;
  if (!Number.isFinite(pose.transform?.rotation_z_deg) || !Number.isFinite(pose.transform?.translation_z_mm)) return null;
  const literal = pose.target_semantics === "literal_analytic_working_flanks";
  if (!literal && pose.target_semantics !== "historical_reference") return null;
  const [candidate] = evidenceFiles([pose.candidate_path]);
  const [target] = literal ? evidenceFiles([pose.target_path]) : [];
  if (!candidate || !/\.stl$/i.test(candidate.url.pathname) || pose.candidate_path === attempt.geometry.candidate
      || (literal && (!target || !/\.stl$/i.test(target.url.pathname)))) return null;
  return { literal, candidate: candidate.url.href, target: target?.url.href,
    candidateImage: evidenceFiles([pose.candidate_image])[0]?.url.href,
    targetImage: evidenceFiles([pose.target_image])[0]?.url.href,
    image: evidenceFiles([pose.overlay_image])[0]?.url.href };
}

function renderPoseControls(pose, assets, active) {
  $("poseComparisonControls").hidden = !assets;
  $("poseOriginal").setAttribute("aria-pressed", String(!active));
  $("poseRegistered").setAttribute("aria-pressed", String(active));
  $("poseRegistered").textContent = assets?.literal ? "题面齿侧检查" : "题面允许位姿配准";
  const panel = $("poseDiagnostics");
  const data = pose?.diagnostics;
  panel.hidden = !data;
  panel.replaceChildren();
  if (!data) return;
  panel.append(evidenceNode("h2", "工作齿面诊断"));
  if (data.summary) panel.append(evidenceNode("p", data.summary));
  if (data.reference_note) panel.append(evidenceNode("p", data.reference_note));
  if (data.method) panel.append(evidenceNode("p", data.method));
  const metrics = (Array.isArray(data.metrics) ? data.metrics : []).filter((item) => item?.label && item.value != null);
  if (metrics.length) {
    const list = evidenceNode("dl");
    for (const item of metrics) {
      const entry = evidenceNode("div");
      entry.append(evidenceNode("dt", item.label), evidenceNode("dd", [item.value, item.unit].filter((value) => value != null && value !== "").join(" ")));
      list.append(entry);
    }
    panel.append(list);
  }
  const notes = (Array.isArray(data.notes) ? data.notes : []).filter((note) => typeof note === "string" && note.trim());
  if (notes.length) {
    const list = evidenceNode("ul");
    list.append(...notes.map((note) => evidenceNode("li", note)));
    panel.append(list);
  }
  panel.append(evidenceNode("p", "此为事后有限采样诊断；整题验收仍未确认。"));
}

async function mountGeometryViewers(attempt, registered) {
  const generation = ++geometryLoadGeneration;
  geometryViewers?.dispose();
  geometryViewers = null;
  for (const id of ["truthViewer", "candidateViewer", "overlayViewer"]) {
    const container = $(id);
    container.dataset.viewerState = "loading";
    container.querySelector("canvas").hidden = true;
    container.querySelector(".viewer-status").textContent = "Loading geometry";
  }
  try {
    geometryModulePromise ||= import("./geometry-viewer.js?v=10");
    const { createSynchronizedGeometryViewers } = await geometryModulePromise;
    if (generation !== geometryLoadGeneration) return;
    const geometry = Object.fromEntries(Object.entries(attempt.geometry || {}).map(([key, path]) => [key, assetUrl(path)]));
    if (registered) {
      geometry.candidate = registered.candidate;
      if (registered.target) geometry.ground_truth = registered.target;
      delete geometry.localization;
    }
    geometryViewers = createSynchronizedGeometryViewers({
      containers: {
        truth: $("truthViewer"), candidate: $("candidateViewer"), overlay: $("overlayViewer"),
      },
      geometry,
      alignment: registered ? "allowed_pose" : comparisonAlignment(attempt),
    });
    updateRegionControls();
    if (state.selectedRegion) geometryViewers?.focusRegion?.(state.selectedRegion);
  } catch (error) {
    if (generation !== geometryLoadGeneration) return;
    console.error("Interactive geometry viewer unavailable", error);
    updateRegionControls();
    for (const id of ["truthViewer", "candidateViewer", "overlayViewer"]) {
      const container = $(id);
      if (!container) continue;
      container.dataset.viewerState = "fallback";
      const hasFallback = Boolean(container.querySelector(".geometry-fallback")?.getAttribute("src"));
      const status = container.querySelector(".viewer-status");
      if (status) status.textContent = hasFallback
        ? `PNG fallback: 3D module unavailable: ${error.message}`
        : `3D viewer unavailable: ${error.message}`;
    }
  }
}

function updateRegionControls() {
  const viewerReady = Boolean(document.querySelector('.geometry-viewer[data-viewer-state="ready"]'));
  document.querySelectorAll("button.localization-region").forEach((button) => {
    button.disabled = !viewerReady || !geometryViewers?.regions?.has(button.dataset.region);
  });
}

function renderEvidence(run, attempt) {
  const scope = attempt.evaluation_scope;
  const alignment = comparisonAlignment(attempt);
  const pose = poseEvidence(attempt);
  const assets = poseAssets(attempt, pose);
  const registered = state.registeredPose ? assets : null;
  renderPoseControls(pose, assets, Boolean(registered));
  const referenceAvailable = Boolean(attempt.images?.ground_truth || attempt.geometry?.ground_truth);
  const referenceMissing = "本页未提供参考几何；历史测量见 Verifier";
  const overlayMissing = "本页未提供历史评分对齐证据";
  const inputs = (run.input_images || []).filter(Boolean);
  const hideInput = !inputs.length && Boolean(scope || run.task_prompt?.trim());
  $("inputEvidence").hidden = hideInput;
  setImage("inputImage", assetUrl(inputs[state.inputIndex]), hideInput ? "" : "Input image unavailable");
  $("inputSwitcher").hidden = inputs.length < 2;
  $("inputSwitcher").innerHTML = inputs.map((_, index) => `<button class="${index === state.inputIndex ? "active" : ""}" data-input="${index}">${index + 1}</button>`).join("");
  document.querySelectorAll("[data-input]").forEach((button) => button.addEventListener("click", () => { state.inputIndex = Number(button.dataset.input); renderEvidence(run, attempt); }));
  const truthImage = registered?.literal ? registered.targetImage : assetUrl(attempt.images?.ground_truth);
  setImage("truthImage", truthImage, alignment ? referenceMissing : "Ground-truth render unavailable");
  const candidatePreview = evidenceFiles(attempt.candidate_images)[0]?.url.href;
  const candidateImage = registered ? registered.candidateImage : assetUrl(attempt.images?.candidate) || candidatePreview;
  setImage("candidateImage", candidateImage, "Candidate render unavailable");
  const overlayImage = registered ? registered.image : alignment === "unavailable" ? "" : assetUrl(attempt.images?.overlay);
  setImage("overlayImage", overlayImage, alignment ? overlayMissing : "Overlay unavailable");
  mountGeometryViewers(attempt, registered);
  $("candidateCaption").textContent = registered ? "按题面允许位姿摆放"
    : assets ? `原始坐标 · ${attempt.attempt_id}` : attempt.attempt_id;
  $("truthTitle").textContent = registered?.literal ? "解析工作齿侧" : alignment ? "参考几何" : "Evaluator ground truth";
  $("truthSubtitle").textContent = registered?.literal ? "非完整实体"
    : alignment ? attempt.reference_geometry?.label || "公开参考" : "hidden from agent";
  $("overlayTitle").textContent = registered?.literal ? "题面齿侧与候选"
    : registered ? "允许位姿配准对比" : alignment ? "参考与候选叠合" : "Aligned overlay";
  $("overlaySubtitle").textContent = registered?.literal ? "蓝色题面齿侧 / 橙色候选"
    : alignment ? "蓝色参考 / 橙色候选" : "blue truth / orange candidate";
  $("truthCaption").textContent = registered?.literal ? "按冻结题面公式构造；未参与历史评分。"
    : alignment && !referenceAvailable ? referenceMissing
    : alignment && run.ground_truth_sha256 ? `来源 SHA ${shortHash(run.ground_truth_sha256)}`
    : alignment ? "" : `SHA ${shortHash(run.ground_truth_sha256)}`;
  $("candidateState").textContent = registered ? "事后诊断视图；提交文件保持原坐标。"
    : `SHA ${shortHash(attempt.evidence?.candidate?.sha256)}`;
  if (registered) {
    const { rotation_z_deg: angle, translation_z_mm: shift } = pose.transform;
    $("overlayState").textContent = `事后诊断 · 绕 Z 旋转 ${fmt(angle, 3)}°，沿 Z 平移 ${fmt(shift, 3)} mm。历史分数仍按原坐标。`;
  } else if (alignment) {
    const relation = attempt.reference_geometry?.scoring_relation;
    const fixedBasis = relation === "observation_source_geometry_not_direct_3d_grade" ? "按历史观察坐标叠合"
      : relation?.startsWith("actual_historical_photo_") ? "按历史图像评测的固定坐标叠合" : "按历史评分使用的固定坐标叠合";
    const basis = alignment === "fixed_frame" ? fixedBasis
      : alignment === "historical_alignment" ? "按历史评分记录的对齐叠合" : overlayMissing;
    $("overlayState").textContent = [basis, attempt.comparison_view?.note].filter(Boolean).join("。 ");
  } else {
    $("overlayState").textContent = !attempt.geometry?.ground_truth ? "GT geometry unavailable; alignment not evaluated"
      : attempt.render_error ? `Render error: ${attempt.render_error}` : "Axis-permutation and translation alignment; no scale";
  }
  const localization = attempt.localization || (attempt.verdict?.mismatch || {}).localization || {};
  const regions = registered ? [] : localization.regions || [];
  const focusAvailable = !registered && Boolean(attempt.geometry?.localization && (attempt.geometry?.ground_truth || attempt.geometry?.candidate));
  const regionTag = focusAvailable ? "button" : "div";
  $("localizationHint").textContent = focusAvailable ? "Click a region to focus the available views." : "Recorded surface evidence";
  $("localizationRegions").innerHTML = regions.length ? regions.map((region) => {
    const position = (region.centroid_bbox_position || []).map((value) => fmt(value, 2)).join(", ");
    const label = region.direction === "ground_truth_to_candidate" ? "Missing" : "Excess";
    const faces = (region.source_brep_faces || []).slice(0, 2).map((face) => `${face.surface_type}${face.radius == null ? "" : ` R${fmt(face.radius, 2)}`}`).join(" + ");
    const nativeFaces = (region.candidate_topology_faces || []).slice(0, 2).map((face) => {
      const hits = face.exact_query_fraction == null ? "" : ` · ${(100 * face.exact_query_fraction).toFixed(0)}% hits`;
      const distance = face.minimum_trimmed_face_distance_normalized == null ? "" : ` · d=${fmt(face.minimum_trimmed_face_distance_normalized, 4)}`;
      return `${face.entity_handle}:${face.face_id} ${face.surface_type}${hits}${distance}`;
    }).join(" + ");
    const features = (region.engineering_feature_candidates || []).slice(0, 2).map((feature) => feature.kind).join(" + ");
    const operations = (region.responsible_operation_candidates || []).slice(0, 2).map((operation) => operation.operation_id).join(" + ");
    const candidateLabel = region.direction === "ground_truth_to_candidate" ? "Candidate nearest boundary" : "Candidate face";
    return `<${regionTag}${focusAvailable ? ' type="button" disabled' : ''} class="localization-region ${region.direction === "ground_truth_to_candidate" ? "missing" : "excess"} ${state.selectedRegion === region.region_id ? "selected" : ""}" data-region="${escapeHtml(region.region_id)}"><strong>${escapeHtml(region.region_id)}</strong><span>${label}</span><code>p95 ${fmt(region.p95_distance_normalized, 4)}</code><small>bbox position [${escapeHtml(position)}]</small>${faces ? `<small>Truth B-Rep ${escapeHtml(faces)}</small>` : ""}${nativeFaces ? `<small>${candidateLabel} ${escapeHtml(nativeFaces)} · ${escapeHtml(region.topology_mapping_confidence || "unknown")} confidence</small>` : ""}${features ? `<small>Feature ${escapeHtml(features)}</small>` : ""}${operations ? `<small>Operation ${escapeHtml(operations)}</small>` : ""}</${regionTag}>`;
  }).join("") : `<div class="empty">${scope ? "本页未提供局部误差定位证据。" : attempt.passed == null ? "GT comparison not evaluated; mismatch localization is unavailable." : attempt.localization_error ? `Localization unavailable: ${escapeHtml(attempt.localization_error)}` : "No surface regions exceed the localization threshold."}</div>`;
  document.querySelectorAll("button.localization-region").forEach((button) => button.addEventListener("click", () => {
    state.selectedRegion = button.dataset.region;
    document.querySelectorAll(".localization-region").forEach((item) => item.classList.toggle("selected", item === button));
    geometryViewers?.focusRegion?.(button.dataset.region);
  }));
}

function evidenceNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function evidenceFiles(entries) {
  if (!Array.isArray(entries)) return [];
  const base = new URL(bundleBase(), document.baseURI);
  return entries.flatMap((entry) => {
    const file = typeof entry === "string" ? { path: entry } : entry;
    if (typeof file?.path !== "string" || !file.path.trim()) return [];
    try {
      const url = new URL(file.path, base);
      return url.origin === base.origin && url.pathname.startsWith(base.pathname) && ["https:", "http:"].includes(url.protocol)
        ? [{ ...file, url }] : [];
    } catch { return []; }
  });
}

function openEvidenceImage(button) {
  const image = button.querySelector("img");
  if (button.disabled || !image?.getAttribute("src") || image.hidden) return;
  $("dialogImage").src = image.src;
  $("dialogImage").alt = image.alt;
  $("imageDialog").showModal();
}

function renderCandidateGallery(entries) {
  const parent = $("candidateGallery");
  const files = evidenceFiles(entries);
  parent.hidden = !files.length;
  parent.replaceChildren();
  if (!files.length) return;
  const gallery = evidenceNode("div", null, "evidence-gallery");
  for (const [index, file] of files.entries()) {
    const label = file.label || `候选视图 ${index + 1}`;
    const figure = evidenceNode("figure");
    const button = evidenceNode("button", null, "image-button");
    button.type = "button";
    button.disabled = true;
    button.setAttribute("aria-label", `放大：${label}`);
    const image = evidenceNode("img");
    image.alt = label;
    image.loading = "lazy";
    image.addEventListener("load", () => { button.disabled = false; });
    image.addEventListener("error", () => { button.replaceWith(evidenceNode("p", "图像文件暂不可读取。", "empty")); });
    button.addEventListener("click", () => openEvidenceImage(button));
    image.src = file.url.href;
    button.append(image);
    figure.append(button, evidenceNode("figcaption", label));
    gallery.append(figure);
  }
  parent.append(evidenceNode("h2", "候选产物视图"), gallery);
}

async function previewEvidenceFile(file, output, signal) {
  const limit = 512 * 1024;
  try {
    const response = await fetch(file.url, { signal, mode: "same-origin" });
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw new Error("File unavailable");
    if (Number(response.headers.get("content-length")) > limit) {
      output.textContent = "文件较大，请下载查看。";
      return;
    }
    const data = await response.text();
    if (signal.aborted) return;
    if (data.length > limit) { output.textContent = "文件较大，请下载查看。"; return; }
    const pre = evidenceNode("pre", data || "文件为空。");
    pre.tabIndex = 0;
    output.replaceWith(pre);
  } catch (error) {
    if (error.name !== "AbortError" && !signal.aborted) output.textContent = "文件暂不可读取。";
  }
}

function previewDisclosure(file, label) {
  const detail = evidenceNode("details");
  const output = evidenceNode("p", "正在读取文件…", "empty");
  const signal = attemptFilesController.signal;
  detail.append(evidenceNode("summary", label), output);
  detail.addEventListener("toggle", function loadOnOpen() {
    if (!detail.open) return;
    detail.removeEventListener("toggle", loadOnOpen);
    previewEvidenceFile(file, output, signal);
  });
  return detail;
}

function renderEvidenceFiles(id, title, entries, sourceFiles = false) {
  const parent = $(id);
  const files = evidenceFiles(entries);
  parent.hidden = !files.length;
  parent.replaceChildren();
  if (!files.length) return;
  const list = evidenceNode("ul", null, "evidence-files");
  for (const file of files) {
    const label = file.label || file.name || "下载文件";
    const item = evidenceNode("li", null, "evidence-file");
    const link = evidenceNode("a", sourceFiles ? `下载 ${label}` : label);
    link.href = file.url.href;
    link.download = "";
    if (sourceFiles || (file.kind === "assembly" && /\.json$/i.test(file.url.pathname))) {
      item.append(previewDisclosure(file, sourceFiles ? label : "查看装配位姿 JSON"));
    }
    item.append(link);
    if (/^[\da-f]{64}$/i.test(file.sha256 || "")) {
      const digest = evidenceNode("code", `SHA-256 ${shortHash(file.sha256)}`);
      digest.title = file.sha256;
      item.append(digest);
    }
    list.append(item);
  }
  parent.append(evidenceNode("h2", title), list);
}

function renderAttemptExtras(run, attempt) {
  attemptFilesController.abort();
  attemptFilesController = new AbortController();
  const prompt = run.task_prompt?.trim();
  $("taskPrompt").hidden = !prompt;
  $("taskPrompt").open = false;
  $("taskPromptLabel").textContent = run.prompt_label || "任务说明";
  $("taskPromptText").textContent = prompt ? run.task_prompt : "";
  renderCandidateGallery(attempt.candidate_images);
  renderEvidenceFiles("attemptArtifacts", "候选产物文件", attempt.artifacts);
  renderEvidenceFiles("attemptCode", "建模源文件", attempt.code_files, true);
  const finalResponse = attempt.final_response?.trim();
  $("modelFinalResponse").hidden = !finalResponse;
  $("modelFinalResponseText").textContent = finalResponse ? attempt.final_response : "";
}

function thresholdText(check) {
  if (check.minimum != null) return `≥ ${fmt(check.minimum, 3)}`;
  if (check.maximum != null) return `≤ ${fmt(check.maximum, 3)}`;
  return String(check.expected);
}

function renderVerifier(attempt) {
  const verdict = attempt.verdict || {};
  const scope = attempt.evaluation_scope;
  const scopePanel = $("evaluationScope");
  scopePanel.hidden = !scope;
  const notes = Array.isArray(scope?.notes) ? scope.notes.filter((note) => typeof note === "string" && note.trim()) : [];
  scopePanel.innerHTML = scope ? `<h2>评测口径</h2><div class="metrics">${[
    metric(measurementLabel(attempt), scope.display ?? fmt(attempt.score)),
    metric("评测状态", scope.measurement_status || "未确认"),
    metric("组件检查", scopeResult(scope.component_passed), scopeTone(scope.component_passed)),
    metric("整题验收", scopeResult(scope.whole_task_passed), scopeTone(scope.whole_task_passed)),
  ].join("")}</div>${notes.length ? `<details class="scope-notes"><summary>记录说明</summary><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></details>` : ""}` : "";
  $("benchmarkComparison").innerHTML = renderBenchmarkComparison(attempt.benchmark_comparison);
  $("checkList").innerHTML = (verdict.rubrics || []).map((check) => `<div class="check-row">
    <span class="status-mark ${check.status}"></span><strong>${escapeHtml(check.id.replaceAll("_", " "))}</strong>
    <code>${escapeHtml(String(check.actual))}</code><span>target ${escapeHtml(thresholdText(check))}</span>
  </div>`).join("") || `<div class="empty">${scope ? "本页未提供逐项评分器记录。" : "Verifier produced no checks."}</div>`;
  const candidate = verdict.candidate_geometry || {};
  const truth = verdict.ground_truth_geometry || {};
  const rows = [
    ["Extents", candidate.extents ? JSON.stringify(candidate.extents) : "N/A", truth.extents ? JSON.stringify(truth.extents) : "N/A"],
    ["Volume", fmt(candidate.volume, 3), fmt(truth.volume, 3)],
    ["Surface area", fmt(candidate.surface_area, 3), fmt(truth.surface_area, 3)],
    ["Watertight", candidate.watertight == null ? "N/A" : String(candidate.watertight), truth.watertight == null ? "N/A" : String(truth.watertight)],
    ["Triangles", candidate.triangles ?? "N/A", truth.triangles ?? "N/A"],
  ];
  $("geometryTable").innerHTML = `<div class="geometry-head"><span>Measure</span><span>Candidate</span><span>Truth</span></div>` + rows.map((row) => `<div><span>${escapeHtml(row[0])}</span><code>${escapeHtml(row[1])}</code><code>${escapeHtml(row[2])}</code></div>`).join("");
  $("protocolBinding").textContent = verdict.protocol || scope?.metric_id || state.data.campaign.protocol;
  $("evidenceHash").textContent = attempt.evidence_sha256;
}

function listBlock(title, items) {
  return `<section><h3>${escapeHtml(title)}</h3>${items?.length ? `<ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : `<div class="empty">Not recorded</div>`}</section>`;
}

function renderReflection(attempt) {
  const archived = (attempt.public_events || []).some((event) => event.type === "archive_evidence");
  $("reflectionNote").textContent = archived
    ? "归档摘要反映已公开的执行、产物和评测记录。模型自述、工具调用和归档摘要分别标注。"
    : "Only recorded agent messages and submitted reflection are shown. Hidden chain-of-thought is not part of the review evidence.";
  $("publicEventsHeading").textContent = archived ? "公开执行证据与归档摘要" : "Public action and feedback trace";
  const reflection = attempt.reflection || {};
  const decision = attempt.agent_decision || reflection.decision;
  const safety = attempt.safety_stop_reason;
  const decisionTurns = attempt.decision_attempts?.length || (attempt.decision_timed_out || attempt.decision_return_code != null ? 1 : 0);
  const decisionTransport = attempt.decision_recovered ? `${decisionTurns} turns / recovered` : attempt.decision_timed_out ? `${decisionTurns} turn(s) / timeout` : decisionTurns ? `${decisionTurns} turn(s) / complete` : "not recorded";
  $("iterationDecision").className = `iteration-decision ${decision || "unavailable"} ${safety ? "safety" : ""}`;
  $("iterationDecision").innerHTML = `<div><span>Agent decision</span><strong>${escapeHtml(decision || "unavailable")}</strong></div><p>${escapeHtml(attempt.decision_reason || reflection.decision_reason || "No decision reason was recorded.")}</p><div class="decision-facts"><span>Can improve <strong>${reflection.can_improve ?? attempt.can_improve ?? "N/A"}</strong></span><span>Expected gain <strong>${reflection.expected_score_gain == null ? "N/A" : fmt(reflection.expected_score_gain, 1)}</strong></span><span>Safety stop <strong>${escapeHtml(safety || "none")}</strong></span><span>Decision transport <strong>${escapeHtml(decisionTransport)}</strong></span></div><div class="structure-assessment"><span>Structure assessment</span><p>${escapeHtml(reflection.structure_assessment || "Not recorded")}</p><span>System change proposal</span><p>${escapeHtml(reflection.system_change_proposal || "None")}</p></div>`;
  $("feedbackPacket").textContent = attempt.feedback_packet ? JSON.stringify(attempt.feedback_packet, null, 2) : "Feedback packet was not recorded for this legacy attempt.";
  $("reflectionContent").innerHTML = `<section class="owner"><h3>Failure owner</h3><strong>${escapeHtml(reflection.failure_owner || "not recorded")}</strong><span>Confidence ${reflection.confidence == null ? "N/A" : fmt(reflection.confidence, 2)}</span></section>` +
    listBlock("Observed failures", reflection.observed_failures) + listBlock("Root causes", reflection.root_causes) + listBlock("Planned changes", reflection.planned_geometry_changes);
  $("publicEvents").innerHTML = (attempt.public_events || []).map((event, index) => {
    if (event.type === "archive_evidence") {
      const details = event.details ?? event.text;
      const text = typeof details === "string" ? details : details == null ? "" : JSON.stringify(details, null, 2);
      return `<details ${index < 2 ? "open" : ""}><summary><span>${index + 1}</span><strong>${escapeHtml(event.label || "归档证据")}</strong><i>归档证据</i></summary><pre>${escapeHtml(text)}</pre></details>`;
    }
    const title = event.type === "agent_message" ? "Agent message" : event.type === "mcp_tool_call" ? `MCP · ${event.tool}` : event.type === "tool_call" ? `Tool · ${event.tool}` : "Command";
    const detail = event.text || event.command || JSON.stringify(event.arguments || {});
    return `<details ${index < 2 ? "open" : ""}><summary><span>${index + 1}</span><strong>${escapeHtml(title)}</strong><i>${escapeHtml(event.phase || "action")}</i><i class="${event.status === "completed" ? "ok" : "warn"}">${escapeHtml(event.status || "")}</i></summary><pre>${escapeHtml(detail)}</pre>${event.error ? `<p class="error-text">${escapeHtml(JSON.stringify(event.error))}</p>` : ""}</details>`;
  }).join("") || `<div class="empty">No public action events were recorded.</div>`;
}

function renderMcp(attempt) {
  const events = attempt.mcp_events || [];
  if (attempt.evaluation_scope && !events.length) {
    $("auditSummary").innerHTML = '<span><strong>N/A</strong> calls</span><span><strong>N/A</strong> failed</span><span><strong>N/A</strong> ms observed</span>';
    $("mcpEvents").innerHTML = '<div class="empty">No MCP audit evidence available.</div>';
    return;
  }
  const failed = events.filter((event) => event.status !== "pass").length;
  const totalMs = events.reduce((sum, event) => sum + Number(event.duration_ms || 0), 0);
  $("auditSummary").innerHTML = `<span><strong>${events.length}</strong> calls</span><span><strong>${failed}</strong> failed</span><span><strong>${fmt(totalMs, 0)}</strong> ms observed</span>`;
  $("mcpEvents").innerHTML = events.map((event, index) => `<details class="${event.status === "pass" ? "" : "failed"}"><summary><span>${index + 1}</span><strong>${escapeHtml(event.tool)}</strong><i class="${event.status === "pass" ? "ok" : "warn"}">${escapeHtml(event.status)}</i><code>${fmt(event.duration_ms, 1)} ms</code></summary><pre>${escapeHtml(JSON.stringify(event.arguments || {}, null, 2))}</pre>${event.error ? `<p class="error-text">${escapeHtml(JSON.stringify(event.error))}</p>` : ""}</details>`).join("") || `<div class="empty">No MCP calls were recorded for this attempt.</div>`;
}

function renderReviewPanel(run, attempt) {
  $("reviewTarget").textContent = `${run.sample_key} · ${attempt.attempt_id}`;
  const derived = attempt.derived_feature_backfill?.applied
    ? `<strong class="warning">Post-hoc native topology evidence</strong>` : "";
  $("reviewBinding").innerHTML = `<span>Review binds to this exact evidence</span><code>${shortHash(attempt.evidence_sha256)}</code>${attempt.selected ? `<strong>Campaign-selected attempt</strong>` : `<strong class="warning">Not the campaign-selected attempt</strong>`}${derived}`;
  const history = targetReviews(run.target_id, attempt.attempt_id);
  $("historyCount").textContent = `${history.length} active`;
  $("reviewHistory").innerHTML = history.map((record) => `<article><div><strong>${escapeHtml(record.reviewer.id)}</strong><span>${escapeHtml(record.created_at)}</span></div><div><span class="decision ${escapeHtml(record.verifier_decision)}">${escapeHtml(record.verifier_decision.replaceAll("_", " "))}</span><span>${escapeHtml(record.recommended_action.replaceAll("_", " "))}</span></div><p>${escapeHtml(record.notes || "No notes")}</p><button type="button" class="secondary revise" data-review="${record.review_id}">Revise</button></article>`).join("") || `<div class="empty">No active human review for this attempt.</div>`;
  document.querySelectorAll(".revise").forEach((button) => button.addEventListener("click", () => populateRevision(button.dataset.review)));
  if (readOnly) document.querySelectorAll(".revise").forEach((button) => button.remove());
}

function resetReviewForm() {
  $("reviewForm").reset();
  $("reviewerId").value = localStorage.getItem("evocadReviewerId") || "";
  $("reviewerExpertise").value = localStorage.getItem("evocadReviewerExpertise") || "";
  $("strictAssessment").value = "correct";
  $("selectionAssessment").value = "correct";
  $("recommendedAction").value = "keep";
  $("supersedesId").value = "";
  $("findings").innerHTML = "";
  $("formStatus").textContent = "";
  const none = document.querySelector('input[name="issueType"][value="none"]');
  if (none) none.checked = true;
  state.formDirty = false;
}

function populateRevision(reviewId) {
  const record = state.reviews.records.find((row) => row.review_id === reviewId);
  if (!record) return;
  $("reviewerId").value = record.reviewer.id;
  $("reviewerExpertise").value = record.reviewer.expertise;
  document.querySelector(`input[name="verifierDecision"][value="${record.verifier_decision}"]`).checked = true;
  $("strictAssessment").value = record.strict_pass_assessment;
  $("selectionAssessment").value = record.selected_attempt_assessment;
  document.querySelectorAll("[data-rating]").forEach((select) => { select.value = record.ratings[select.dataset.rating] ?? ""; });
  document.querySelectorAll('input[name="issueType"]').forEach((input) => { input.checked = record.issue_types.includes(input.value); });
  $("recommendedAction").value = record.recommended_action;
  $("reviewNotes").value = record.notes;
  $("supersedesId").value = record.review_id;
  $("findings").innerHTML = "";
  record.findings.forEach((finding) => addFinding(finding));
  $("formStatus").textContent = `Revision of ${record.review_id.slice(0, 10)}. The original remains in history.`;
  $("reviewForm").scrollIntoView({ behavior: "smooth", block: "start" });
  state.formDirty = true;
  rememberDraft();
}

function addFinding(value = {}) {
  const index = document.querySelectorAll(".finding").length + 1;
  const wrapper = document.createElement("div");
  wrapper.className = "finding";
  wrapper.innerHTML = `<div class="finding-header"><strong>Finding ${index}</strong><button type="button" class="remove-finding">Remove</button></div><div class="two-col"><label>Category<select data-field="category">${FINDING_CATEGORIES.map((key) => `<option value="${key}">${escapeHtml(ISSUE_LABELS[key])}</option>`).join("")}</select></label><label>Severity<select data-field="severity"><option value="note">Note</option><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></select></label></div><label>Location<input data-field="location" maxlength="500" placeholder="feature, view, metric, or event"></label><label>Observation<textarea data-field="observation" rows="2" maxlength="4000" required></textarea></label><label>Recommendation<textarea data-field="recommendation" rows="2" maxlength="4000"></textarea></label>`;
  wrapper.querySelector('[data-field="category"]').value = value.category || "agent_geometry";
  wrapper.querySelector('[data-field="severity"]').value = value.severity || "major";
  ["location", "observation", "recommendation"].forEach((key) => {
    wrapper.querySelector(`[data-field="${key}"]`).value = value[key] || (key === "location" ? state.selectedRegion || "" : "");
  });
  wrapper.querySelector(".remove-finding").addEventListener("click", () => {
    wrapper.remove(); state.formDirty = true; rememberDraft();
  });
  $("findings").appendChild(wrapper);
}

function collectFindings() {
  return [...document.querySelectorAll(".finding")].map((finding) => Object.fromEntries([...finding.querySelectorAll("[data-field]")].map((field) => [field.dataset.field, field.value])));
}

async function submitReview(event) {
  event.preventDefault();
  if (readOnly) return;
  if (state.loading || state.saving) return;
  const run = currentRun(); const attempt = currentAttempt();
  const issues = [...document.querySelectorAll('input[name="issueType"]:checked')].map((input) => input.value);
  const decision = document.querySelector('input[name="verifierDecision"]:checked')?.value;
  const payload = {
    bundle_sha256: state.data.bundle_sha256,
    presentation_sha256: state.catalog?.presentation_sha256,
    target_id: run.target_id, attempt_id: attempt.attempt_id,
    reviewer: { id: $("reviewerId").value, expertise: $("reviewerExpertise").value },
    verifier_decision: decision, strict_pass_assessment: $("strictAssessment").value,
    selected_attempt_assessment: $("selectionAssessment").value,
    ratings: Object.fromEntries([...document.querySelectorAll("[data-rating]")].map((select) => [select.dataset.rating, select.value ? Number(select.value) : null])),
    issue_types: issues, recommended_action: $("recommendedAction").value,
    findings: collectFindings(), notes: $("reviewNotes").value,
    duration_seconds: Math.min(86400, (Date.now() - state.reviewStartedAt) / 1000),
    supersedes_review_id: $("supersedesId").value || null,
  };
  state.saving = true;
  setNavigationBusy();
  $("formStatus").textContent = "Saving…";
  try {
    const response = await fetch(reviewsUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    localStorage.setItem("evocadReviewerId", payload.reviewer.id);
    localStorage.setItem("evocadReviewerExpertise", payload.reviewer.expertise);
    state.reviews.records.push(body);
    delete state.drafts[draftKey()]; persistDrafts();
    resetReviewForm();
    $("formStatus").textContent = `Saved ${body.review_id.slice(0, 10)} · ledger hash ${shortHash(body.record_sha256)}`;
    try { state.reviews = await fetchJson(reviewsUrl()); renderHeader(); }
    catch { $("formStatus").textContent += " · Saved successfully; summary refresh unavailable."; }
    renderRunList(); renderReviewPanel(run, attempt);
  } catch (error) {
    $("formStatus").textContent = `Save failed: ${error.message}`;
  } finally { state.saving = false; setNavigationBusy(); }
}

function renderHeader() {
  $("campaignName").textContent = state.data.campaign.campaign_id;
  $("protocolLabel").textContent = state.data.campaign.protocol;
  const summary = state.reviews.summary;
  $("reviewProgress").textContent = `${summary.reviewed_targets} / ${summary.total_targets} reviewed`;
  $("ledgerIntegrity").textContent = state.reviews.integrity.ok ? `${state.reviews.integrity.records} records · verified` : "Ledger integrity error";
  $("ledgerIntegrity").classList.toggle("bad", !state.reviews.integrity.ok);
  if (readOnly) $("ledgerIntegrity").textContent = "Public read-only snapshot / source verified before redaction";
  const decisions = summary.decisions;
  const labels = summary.strict_pass_assessments;
  const issues = summary.issue_counts;
  const decided = decisions.agree + decisions.partially_agree + decisions.disagree;
  const agreement = decided ? (100 * decisions.agree / decided).toFixed(0) + "%" : "N/A";
  $("reviewAuditMetrics").innerHTML = [
    ["评分认同率", agreement],
    ["有争议的评审", decisions.partially_agree + decisions.disagree],
    ["误判通过 / 失败", labels.false_positive + labels.false_negative],
    ["数据问题", issues.input_ambiguity + issues.ground_truth_error],
    ["评测问题", issues.verifier_metric + issues.verifier_threshold + issues.alignment_error],
    ["评审意见冲突", summary.conflicted_evidence],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function bindControls() {
  renderIcons();
  for (const [id, registered] of [["poseOriginal", false], ["poseRegistered", true]]) {
    $(id).addEventListener("click", () => {
      const run = currentRun(), attempt = currentAttempt();
      if (!attempt || state.registeredPose === registered || !poseAssets(attempt, poseEvidence(attempt))) return;
      state.registeredPose = registered;
      syncSelectionUrl();
      renderEvidence(run, attempt);
    });
  }
  new MutationObserver(updateRegionControls).observe($("evidencePanel"), {
    subtree: true, attributes: true, attributeFilter: ["data-viewer-state"],
  });
  $("openRecords").addEventListener("click", () => $("recordsDialog").showModal());
  $("closeRecords").addEventListener("click", () => $("recordsDialog").close());
  $("recordsDialog").addEventListener("click", (event) => {
    const box = $("recordsDialog").getBoundingClientRect();
    if (event.target === $("recordsDialog") && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) $("recordsDialog").close();
  });
  $("resetFilters").addEventListener("click", resetFilters);
  $("harnessFilter").addEventListener("change", (event) => {
    const harness = event.target.value;
    const models = harnessModels(harness);
    const remembered = state.lastModel[navigationKey(harness)];
    const model = models.includes(remembered) ? remembered : models[0];
    return selectModelExperiment(harness, model);
  });
  $("modelFilter").addEventListener("change", (event) =>
    selectModelExperiment(bundleEntry(state.bundleId).harness, event.target.value));

  $("experimentFilter").addEventListener("change", (event) => loadBundle(event.target.value, state.model));
  for (const type of ["input", "change"]) $("reviewForm").addEventListener(type, () => {
    state.formDirty = true; rememberDraft();
  });
  Object.keys(state.filters).forEach((key) => $(key + "Filter").addEventListener("change", (event) => { state.filters[key] = event.target.value; renderRunList(); }));
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, .tab-panel").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active"); $(tab.dataset.tab + "Panel").classList.add("active");
  }));
  document.querySelectorAll("[data-rating]").forEach((select) => { select.innerHTML = `<option value="">N/A</option>` + [1, 2, 3, 4, 5].map((value) => `<option>${value}</option>`).join(""); });
  $("issueInputs").innerHTML = Object.entries(ISSUE_LABELS).map(([key, label]) => `<label><input type="checkbox" name="issueType" value="${key}"><span>${escapeHtml(label)}</span></label>`).join("");
  $("issueInputs").addEventListener("change", (event) => {
    if (!event.target.matches('input[name="issueType"]')) return;
    const none = document.querySelector('input[name="issueType"][value="none"]');
    if (event.target === none && none.checked) document.querySelectorAll('input[name="issueType"]:not([value="none"])').forEach((input) => { input.checked = false; });
    else if (event.target.checked) none.checked = false;
    if (![...document.querySelectorAll('input[name="issueType"]:checked')].length) none.checked = true;
  });
  $("addFinding").addEventListener("click", () => { addFinding(); state.formDirty = true; rememberDraft(); });
  $("reviewForm").addEventListener("submit", submitReview);
  $("exportReviews").addEventListener("click", () => {
    const records = modelReviewRecords();
    if (!records.length) return;
    const blob = new Blob([records.map((row) => JSON.stringify(row)).join("\n") + "\n"], { type: "application/x-ndjson" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.data.campaign.campaign_id}-${state.model}-human-reviews.jsonl`; link.click(); URL.revokeObjectURL(link.href);
  });
  document.querySelectorAll(".image-button").forEach((button) => button.addEventListener("click", () => openEvidenceImage(button)));
  $("closeDialog").addEventListener("click", () => $("imageDialog").close());
}

async function start() {
  bindControls();
  if (readOnly) $("reviewForm").hidden = true;
  try { state.drafts = JSON.parse(sessionStorage.getItem("evocadReviewDrafts") || "{}"); } catch { state.drafts = {}; }
  const response = await fetch(readOnly ? "catalog.json" : "/api/catalog", { cache: "no-store" });
  if (response.ok) state.catalog = await response.json();
  else if (response.status !== 404) throw new Error(`Experiment catalog: HTTP ${response.status}`);
  try {
    const navigation = JSON.parse(sessionStorage.getItem("evocadGeometryNavigation") || "{}");
    for (const key of ["lastModel", "lastBundle", "selections"]) Object.assign(state[key], navigation?.[key]);
  } catch { /* Browser storage is optional. */ }
  const params = new URL(location.href).searchParams;
  const entry = bundleEntry(params.get("view")) || bundleEntry(state.catalog?.default_id) || state.catalog?.bundles[0];
  const requestedModel = params.get("model");
  const rememberedModel = state.lastModel[navigationKey(entry?.harness)];
  const models = entryModels(entry);
  const model = [requestedModel, rememberedModel, models[0]].find((value) => models.includes(value));
  await loadBundle(entry?.id || null, model, params.get("sample"), params.get("pose") === "task");
}

start().catch((error) => {
  document.documentElement.dataset.appState = "failed";
  $("campaignName").textContent = "Load failed";
  $("taskTitle").textContent = error.message;
  $("ledgerIntegrity").textContent = "Data unavailable";
});
