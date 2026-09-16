const readOnly = document.documentElement.dataset.mode === "public";
const state = {
  data: null, reviews: null, selectedTarget: null, selectedAttempt: null,
  selectedRegion: null, inputIndex: 0, reviewStartedAt: Date.now(), filters: { dataset: "all", model: "all", outcome: "all", review: "all" },
  catalog: null, bundleId: null, loading: false, saving: false, formDirty: false,
  lastBundle: {}, selections: {}, drafts: {},
};
let geometryViewers = null;
let geometryModulePromise = null;
let geometryLoadGeneration = 0;
let bundleLoadGeneration = 0;
let bundleAbortController = null;

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
function experimentRecord(entry) {
  if (!entry) return null;
  if (VISION_RECORDS[entry.id]) return { href: VISION_RECORDS[entry.id], label: "看图与操作记录", icon: "scan-eye" };
  if (entry.recorded_io && /astra/i.test(entry.recorded_io.summary?.model || "")) {
    return { href: `astra.html?run=${encodeURIComponent(entry.id)}`, label: "模型输入输出与执行记录", icon: "file-clock" };
  }
  return null;
}
function renderRecords(entry) {
  const record = experimentRecord(entry);
  $("experimentRecords").hidden = !record;
  $("experimentRecords").innerHTML = record ? `<a href="${escapeHtml(record.href)}" target="_blank" rel="noopener"><i data-lucide="${record.icon}" aria-hidden="true"></i>${record.label}<i data-lucide="arrow-up-right" aria-hidden="true"></i></a>` : "";
  const entries = (state.catalog?.bundles || []).filter((item) => experimentRecord(item));
  const harnesses = [...new Set(entries.map((item) => item.harness))];
  $("recordsLibrary").innerHTML = harnesses.map((harness) => `<section><h3>${escapeHtml(harness)}</h3>${entries.filter((item) => item.harness === harness).map((item) => {
    const link = experimentRecord(item);
    return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener"><i data-lucide="${link.icon}" aria-hidden="true"></i><span>${escapeHtml(item.label)}<small>${link.label}</small></span><i data-lucide="arrow-up-right" aria-hidden="true"></i></a>`;
  }).join("")}</section>`).join("") || '<div class="empty">暂无独立归档记录</div>';
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
  if (!state.catalog) return;
  $("harnessNavigation").hidden = false;
  const entry = state.catalog.bundles.find((item) => item.id === state.bundleId);
  const harness = entry?.harness || state.catalog.bundles[0].harness;
  const harnesses = [...new Set(state.catalog.bundles.map((item) => item.harness))];
  $("harnessFilter").innerHTML = harnesses.map((name) => `<option>${escapeHtml(name)}</option>`).join("");
  $("harnessFilter").value = harness;
  $("experimentFilter").innerHTML = state.catalog.bundles.filter((item) => item.harness === harness)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
  $("experimentFilter").value = entry?.id || "";
  syncSelectLabels();
  renderRecords(entry);
}

function setNavigationBusy() {
  const busy = state.loading || state.saving;
  $("harnessFilter").disabled = busy;
  $("experimentFilter").disabled = busy;
  $("submitReview").disabled = busy;
  for (const selector of [".inspection", ".review-panel", ".filter-grid", "#runList"]) {
    const element = document.querySelector(selector);
    if (element) { element.inert = busy; element.setAttribute("aria-busy", String(busy)); }
  }
}

async function loadBundle(id, { updateUrl = true } = {}) {
  if (state.saving) { renderNavigation(); return; }
  const previousRun = currentRun();
  rememberDraft();
  if (state.bundleId && previousRun) {
    state.selections[state.bundleId] = { target: state.selectedTarget, attempt: state.selectedAttempt };
  }
  const generation = ++bundleLoadGeneration;
  bundleAbortController?.abort();
  bundleAbortController = new AbortController();
  state.loading = true;
  setNavigationBusy();
  $("navigationStatus").textContent = "Loading experiment...";
  try {
    const [data, reviews] = await Promise.all([
      fetchJson(id ? `${bundleBase(id)}review-data.json` : "/data/review-data.json", { signal: bundleAbortController.signal }),
      fetchJson(reviewsUrl(id), { signal: bundleAbortController.signal }),
    ]);
    if (generation !== bundleLoadGeneration) return;
    const entry = state.catalog?.bundles.find((item) => item.id === id);
    if ((entry && data.bundle_sha256 !== entry.bundle_sha256) || reviews.integrity.bundle.bundle_sha256 !== data.bundle_sha256) {
      throw new Error("Experiment evidence and review ledger do not match");
    }
    ++geometryLoadGeneration;
    geometryViewers?.dispose(); geometryViewers = null;
    state.data = data; state.reviews = reviews; state.bundleId = id;
    state.selectedTarget = null; state.selectedAttempt = null; state.formDirty = false;
    state.filters = { dataset: "all", model: "all", outcome: "all", review: "all" };
    if (entry) state.lastBundle[entry.harness] = id;
    setOptions($("datasetFilter"), [...new Set(data.runs.map((run) => run.dataset))].sort(), "全部数据集");
    setOptions($("modelFilter"), data.models, "全部模型");
    $("outcomeFilter").value = "all"; $("reviewFilter").value = "all";
    renderNavigation(); renderHeader(); resetReviewForm();
    const saved = state.selections[id];
    const run = data.runs.find((item) => item.sample_id === previousRun?.sample_id && item.model === previousRun?.model)
      || data.runs.find((item) => item.sample_id === previousRun?.sample_id)
      || data.runs.find((item) => item.target_id === saved?.target) || data.runs[0];
    if (run) {
      selectRun(run.target_id);
      if (run.target_id === saved?.target && run.attempts.some((item) => item.attempt_id === saved.attempt)) selectAttempt(saved.attempt);
    } else {
      renderRunList();
      $("taskTitle").textContent = "No runs in this experiment";
    }
    if (id && updateUrl) {
      const url = new URL(location.href); url.searchParams.set("view", id);
      history.replaceState(null, "", url);
    }
    $("navigationStatus").textContent = "";
    document.documentElement.dataset.appState = "ready";
  } catch (error) {
    if (generation !== bundleLoadGeneration) return;
    if (!state.data) throw error;
    renderNavigation();
    $("navigationStatus").textContent = `Switch failed: ${error.message}`;
  } finally {
    if (generation === bundleLoadGeneration) { state.loading = false; setNavigationBusy(); }
  }
}

function currentRun() { return state.data?.runs.find((run) => run.target_id === state.selectedTarget); }
function currentAttempt() { return currentRun()?.attempts.find((attempt) => attempt.attempt_id === state.selectedAttempt); }
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
  return state.data.runs.filter((run) => {
    const records = targetReviews(run.target_id);
    const disputed = records.some((row) => ["partially_agree", "disagree"].includes(row.verifier_decision));
    return (state.filters.dataset === "all" || run.dataset === state.filters.dataset) &&
      (state.filters.model === "all" || run.model === state.filters.model) &&
      (state.filters.outcome === "all" || (state.filters.outcome === "unscored" ? run.passed == null : run.passed != null && (state.filters.outcome === "passed") === run.passed)) &&
      (state.filters.review === "all" || (state.filters.review === "pending" && !records.length) ||
        (state.filters.review === "reviewed" && records.length) || (state.filters.review === "disputed" && disputed));
  });
}

function renderRunList() {
  const runs = visibleRuns();
  renderFilterState();
  $("runCount").textContent = `${runs.length} / ${state.data.runs.length}`;
  $("runList").innerHTML = runs.map((run) => {
    const reviews = targetReviews(run.target_id);
    const disputed = reviews.some((row) => ["partially_agree", "disagree"].includes(row.verifier_decision));
    const reviewState = !reviews.length ? "pending" : disputed ? "disputed" : "reviewed";
    return `<button class="run-item ${run.target_id === state.selectedTarget ? "active" : ""}" data-target="${escapeHtml(run.target_id)}">
      <div><strong>${escapeHtml(run.sample_key)}</strong><span>${escapeHtml(run.model.replace("gpt-5.6-", ""))}</span></div>
      <div class="run-result"><span class="score ${run.passed == null ? "" : run.passed ? "pass" : "fail"}">${fmt(run.score, 1)}</span><i class="review-dot ${reviewState}" title="${reviewState}"></i></div>
    </button>`;
  }).join("") || `<div class="empty">没有符合筛选条件的算例。</div>`;
  document.querySelectorAll(".run-item").forEach((button) => button.addEventListener("click", () => selectRun(button.dataset.target)));
  if (runs.length && !runs.some((run) => run.target_id === state.selectedTarget)) selectRun(runs[0].target_id);
}

function metric(label, value, tone = "") { return `<div class="metric"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`; }

function selectRun(targetId) {
  const run = state.data.runs.find((item) => item.target_id === targetId);
  if (!run) return;
  rememberDraft();
  state.selectedTarget = targetId;
  state.selectedAttempt = run.selected_attempt_id || run.attempts.at(-1)?.attempt_id;
  state.selectedRegion = null;
  state.inputIndex = 0;
  state.reviewStartedAt = Date.now();
  resetReviewForm();
  restoreDraft();
  renderRun();
  renderRunList();
}

function selectAttempt(attemptId) {
  rememberDraft();
  state.selectedAttempt = attemptId;
  state.selectedRegion = null;
  state.reviewStartedAt = Date.now();
  resetReviewForm();
  restoreDraft();
  renderRun();
}

function renderRun() {
  const run = currentRun();
  const attempt = currentAttempt();
  if (!run || !attempt) return;
  $("datasetLabel").textContent = `${run.dataset}${run.category ? ` / ${run.category}` : ""}`;
  $("taskTitle").textContent = run.task;
  $("modelLabel").textContent = `${run.model} · ${run.reasoning_effort || "default"}`;
  $("targetId").textContent = run.target_id;
  $("metrics").innerHTML = [
    metric("Selected score", fmt(run.score), run.passed == null ? "" : run.passed ? "good" : "bad"),
    metric("Attempt score", fmt(attempt.score), attempt.passed == null ? "" : attempt.passed ? "good" : "bad"),
    metric("Strict label", attempt.passed == null ? "UNSCORED" : attempt.passed ? "PASS" : "FAIL", attempt.passed == null ? "" : attempt.passed ? "good" : "bad"),
    metric("Attempts", run.attempts.length),
    metric("Elapsed", `${fmt(attempt.elapsed_seconds, 1)} s`),
    metric("Ledger", run.integrity?.ok ? "VERIFIED" : "CHECK", run.integrity?.ok ? "good" : "bad"),
  ].join("");
  const annotation = run.data_quality_annotation;
  $("annotationBanner").hidden = !annotation;
  if (annotation) $("annotationBanner").innerHTML = `<strong>Data-quality annotation: ${escapeHtml(annotation.status)}</strong><span>${escapeHtml((annotation.issue_types || []).join(" · "))}</span><p>${escapeHtml(annotation.recommended_use || "")}</p>`;
  renderAttempts(run);
  renderEvidence(run, attempt);
  renderVerifier(attempt);
  renderReflection(attempt);
  renderMcp(attempt);
  renderReviewPanel(run, attempt);
}

function renderAttempts(run) {
  $("attemptButtons").innerHTML = run.attempts.map((attempt) => `<button class="attempt-button ${attempt.attempt_id === state.selectedAttempt ? "active" : ""} ${attempt.passed == null ? "" : attempt.passed ? "passed" : "failed"}" data-attempt="${escapeHtml(attempt.attempt_id)}">
    <span>${escapeHtml(attempt.attempt_id)}</span><strong>${fmt(attempt.score, 1)}</strong><small>${attempt.safety_stop_reason ? `safety: ${escapeHtml(attempt.safety_stop_reason)}` : attempt.agent_decision ? `agent: ${escapeHtml(attempt.agent_decision)}` : attempt.selected ? "selected" : attempt.timed_out ? "timeout" : attempt.passed ? "pass" : "no decision"}</small>
  </button>`).join("");
  document.querySelectorAll(".attempt-button").forEach((button) => button.addEventListener("click", () => selectAttempt(button.dataset.attempt)));
}

function setImage(id, source, emptyText) {
  const image = $(id);
  image.src = source || "";
  image.hidden = !source;
  image.parentElement.classList.toggle("missing", !source);
  image.parentElement.dataset.empty = source ? "" : emptyText;
}

async function mountGeometryViewers(attempt) {
  const generation = ++geometryLoadGeneration;
  geometryViewers?.dispose();
  geometryViewers = null;
  try {
    geometryModulePromise ||= import("./geometry-viewer.js?v=8");
    const { createSynchronizedGeometryViewers } = await geometryModulePromise;
    if (generation !== geometryLoadGeneration) return;
    geometryViewers = createSynchronizedGeometryViewers({
      containers: {
        truth: $("truthViewer"), candidate: $("candidateViewer"), overlay: $("overlayViewer"),
      },
      geometry: Object.fromEntries(Object.entries(attempt.geometry || {}).map(([key, path]) => [key, assetUrl(path)])),
    });
  } catch (error) {
    if (generation !== geometryLoadGeneration) return;
    console.error("Interactive geometry viewer unavailable", error);
    for (const id of ("truthViewer", "candidateViewer", "overlayViewer")) {
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

function renderEvidence(run, attempt) {
  const inputs = run.input_images || [];
  setImage("inputImage", assetUrl(inputs[state.inputIndex]), "Input image unavailable");
  $("inputSwitcher").innerHTML = inputs.map((_, index) => `<button class="${index === state.inputIndex ? "active" : ""}" data-input="${index}">${index + 1}</button>`).join("");
  document.querySelectorAll("[data-input]").forEach((button) => button.addEventListener("click", () => { state.inputIndex = Number(button.dataset.input); renderEvidence(run, attempt); }));
  setImage("truthImage", assetUrl(attempt.images.ground_truth), "Ground-truth render unavailable");
  setImage("candidateImage", assetUrl(attempt.images.candidate), "Candidate render unavailable");
  setImage("overlayImage", assetUrl(attempt.images.overlay), "Overlay unavailable");
  mountGeometryViewers(attempt);
  $("candidateCaption").textContent = attempt.attempt_id;
  $("truthCaption").textContent = `SHA ${shortHash(run.ground_truth_sha256)}`;
  $("candidateState").textContent = `SHA ${shortHash(attempt.evidence?.candidate?.sha256)}`;
  $("overlayState").textContent = !attempt.geometry?.ground_truth ? "GT geometry unavailable; alignment not evaluated" : attempt.render_error ? `Render error: ${attempt.render_error}` : "Axis-permutation and translation alignment; no scale";
  const localization = attempt.localization || (attempt.verdict?.mismatch || {}).localization || {};
  const regions = localization.regions || [];
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
    return `<button class="localization-region ${region.direction === "ground_truth_to_candidate" ? "missing" : "excess"} ${state.selectedRegion === region.region_id ? "selected" : ""}" data-region="${escapeHtml(region.region_id)}"><strong>${escapeHtml(region.region_id)}</strong><span>${label}</span><code>p95 ${fmt(region.p95_distance_normalized, 4)}</code><small>bbox position [${escapeHtml(position)}]</small>${faces ? `<small>Truth B-Rep ${escapeHtml(faces)}</small>` : ""}${nativeFaces ? `<small>${candidateLabel} ${escapeHtml(nativeFaces)} · ${escapeHtml(region.topology_mapping_confidence || "unknown")} confidence</small>` : ""}${features ? `<small>Feature ${escapeHtml(features)}</small>` : ""}${operations ? `<small>Operation ${escapeHtml(operations)}</small>` : ""}</button>`;
  }).join("") : `<div class="empty">${attempt.passed == null ? "GT comparison not evaluated; mismatch localization is unavailable." : attempt.localization_error ? `Localization unavailable: ${escapeHtml(attempt.localization_error)}` : "No surface regions exceed the localization threshold."}</div>`;
  document.querySelectorAll(".localization-region").forEach((button) => button.addEventListener("click", () => {
    state.selectedRegion = button.dataset.region;
    document.querySelectorAll(".localization-region").forEach((item) => item.classList.toggle("selected", item === button));
    geometryViewers?.focusRegion?.(button.dataset.region);
  }));
}

function thresholdText(check) {
  if (check.minimum != null) return `≥ ${fmt(check.minimum, 3)}`;
  if (check.maximum != null) return `≤ ${fmt(check.maximum, 3)}`;
  return String(check.expected);
}

function renderVerifier(attempt) {
  const verdict = attempt.verdict || {};
  $("benchmarkComparison").innerHTML = renderBenchmarkComparison(attempt.benchmark_comparison);
  $("checkList").innerHTML = (verdict.rubrics || []).map((check) => `<div class="check-row">
    <span class="status-mark ${check.status}"></span><strong>${escapeHtml(check.id.replaceAll("_", " "))}</strong>
    <code>${escapeHtml(String(check.actual))}</code><span>target ${escapeHtml(thresholdText(check))}</span>
  </div>`).join("") || `<div class="empty">Verifier produced no checks.</div>`;
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
  $("protocolBinding").textContent = verdict.protocol || state.data.campaign.protocol;
  $("evidenceHash").textContent = attempt.evidence_sha256;
}

function listBlock(title, items) {
  return `<section><h3>${escapeHtml(title)}</h3>${items?.length ? `<ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : `<div class="empty">Not recorded</div>`}</section>`;
}

function renderReflection(attempt) {
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
    const title = event.type === "agent_message" ? "Agent message" : event.type === "mcp_tool_call" ? `MCP · ${event.tool}` : event.type === "tool_call" ? `Tool · ${event.tool}` : "Command";
    const detail = event.text || event.command || JSON.stringify(event.arguments || {});
    return `<details ${index < 2 ? "open" : ""}><summary><span>${index + 1}</span><strong>${escapeHtml(title)}</strong><i>${escapeHtml(event.phase || "action")}</i><i class="${event.status === "completed" ? "ok" : "warn"}">${escapeHtml(event.status || "")}</i></summary><pre>${escapeHtml(detail)}</pre>${event.error ? `<p class="error-text">${escapeHtml(JSON.stringify(event.error))}</p>` : ""}</details>`;
  }).join("") || `<div class="empty">No public action events were recorded.</div>`;
}

function renderMcp(attempt) {
  const events = attempt.mcp_events || [];
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
  $("openRecords").addEventListener("click", () => $("recordsDialog").showModal());
  $("closeRecords").addEventListener("click", () => $("recordsDialog").close());
  $("recordsDialog").addEventListener("click", (event) => {
    const box = $("recordsDialog").getBoundingClientRect();
    if (event.target === $("recordsDialog") && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) $("recordsDialog").close();
  });
  $("resetFilters").addEventListener("click", resetFilters);
  $("harnessFilter").addEventListener("change", (event) => {
    const harness = event.target.value;
    loadBundle(state.lastBundle[harness] || state.catalog.bundles.find((item) => item.harness === harness).id);
  });
  $("experimentFilter").addEventListener("change", (event) => loadBundle(event.target.value));
  for (const type of ["input", "change"]) $("reviewForm").addEventListener(type, () => {
    state.formDirty = true; rememberDraft();
  });
  ["dataset", "model", "outcome", "review"].forEach((key) => $(key + "Filter").addEventListener("change", (event) => { state.filters[key] = event.target.value; renderRunList(); }));
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
    const blob = new Blob([(state.reviews.records || []).map((row) => JSON.stringify(row)).join("\n") + "\n"], { type: "application/x-ndjson" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.data.campaign.campaign_id}-human-reviews.jsonl`; link.click(); URL.revokeObjectURL(link.href);
  });
  document.querySelectorAll(".image-button").forEach((button) => button.addEventListener("click", () => {
    const image = button.querySelector("img"); if (!image.src || image.hidden) return;
    $("dialogImage").src = image.src; $("imageDialog").showModal();
  }));
  $("closeDialog").addEventListener("click", () => $("imageDialog").close());
}

async function start() {
  bindControls();
  if (readOnly) $("reviewForm").hidden = true;
  try { state.drafts = JSON.parse(sessionStorage.getItem("evocadReviewDrafts") || "{}"); } catch { state.drafts = {}; }
  const response = await fetch(readOnly ? "catalog.json" : "/api/catalog", { cache: "no-store" });
  if (response.ok) state.catalog = await response.json();
  else if (response.status !== 404) throw new Error(`Experiment catalog: HTTP ${response.status}`);
  const requested = new URL(location.href).searchParams.get("view");
  const id = state.catalog?.bundles.some((entry) => entry.id === requested) ? requested : state.catalog?.default_id || null;
  await loadBundle(id);
}

start().catch((error) => {
  document.documentElement.dataset.appState = "failed";
  $("campaignName").textContent = "Load failed";
  $("taskTitle").textContent = error.message;
  $("ledgerIntegrity").textContent = "Data unavailable";
});
