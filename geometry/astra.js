"use strict";
const readOnly = document.documentElement.dataset.mode === "public";
const siteBase = readOnly ? "./" : "/";
const records = { entries: [], current: null, timeline: [], jobs: [], files: [], run: null, tab: "overview", generation: 0, nativeGeneration: 0, previewGeneration: 0 };
const $ = (id) => document.getElementById(id);
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fileUrl = (path) => records.current.recorded_io.base_url + path.split("/").map(encodeURIComponent).join("/");
async function read(url, type = "json", signal) {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return type === "json" ? response.json() : response.text();
}
function metric(label, value, tone = "") { return `<div><dt>${escapeHtml(label)}</dt><dd class="${tone}">${escapeHtml(value)}</dd></div>`; }
function scoreLabel(value) { return value == null ? "N/A" : Number(value).toFixed(2); }
function scoreTone(passed) { return passed == null ? "" : passed ? "pass" : "fail"; }
function renderExperiments() {
  $("experiments").innerHTML = records.entries.map((entry) => {
    const s = entry.recorded_io.summary;
    return `<button class="experiment" data-id="${entry.id}" aria-current="${entry.id === records.current?.id}"><strong><span>${escapeHtml(s.sample_id.replace(":", " / "))}</span><span class="score ${scoreTone(s.passed)}">${scoreLabel(s.score)}</span></strong><small>${escapeHtml(entry.harness)}${entry.harness === "Diagnostics" ? " / human mirror" : " / Astra Ultra"}</small></button>`;
  }).join("");
  $("experiments").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => loadRecord(button.dataset.id)));
}
let controller;
async function loadRecord(id) {
  const entry = records.entries.find((r) => r.id === id);
  if (!entry) return;
  const generation = ++records.generation;
  ++records.nativeGeneration; ++records.previewGeneration;
  controller?.abort(); controller = new AbortController();
  $("status").textContent = "Loading recorded evidence...";
  document.querySelectorAll("main section, .tabs").forEach((el) => { el.inert = true; });
  try {
    const base = entry.recorded_io.base_url;
    const [manifest, text, jobs, bundle] = await Promise.all([
      read(base + "manifest.json", "json", controller.signal), read(base + "timeline.jsonl", "text", controller.signal),
      read(base + "autocad/index.json", "json", controller.signal), read(`${siteBase}bundles/${entry.id}/review-data.json`, "json", controller.signal),
    ]);
    if (generation !== records.generation) return;
    records.current = entry; records.files = manifest.files; records.timeline = text.split(/\r?\n/).filter(Boolean).map(JSON.parse); records.jobs = jobs;
    const s = entry.recorded_io.summary;
    records.run = bundle.runs.find((r) => r.sample_id === s.sample_id && r.model === s.model);
    if (!records.run || bundle.bundle_sha256 !== entry.bundle_sha256) throw new Error("Review/export binding mismatch");
    $("condition").textContent = entry.harness === "Diagnostics" ? "HUMAN-ASSISTED DIAGNOSTIC / NOT AN AGENT RUN" : `${entry.harness.toUpperCase()} / GPT-6-ASTRA / ULTRA`;
    $("title").textContent = s.sample_id.replace(":", " / "); $("campaign").textContent = s.campaign;
    $("reviewLink").href = `${siteBase}?view=${entry.id}`; $("downloadLink").href = fileUrl("archive.zip");
    $("note").textContent = entry.recorded_io.note; $("note").hidden = !entry.recorded_io.note;
    const counts = s.counts;
    $("metrics").innerHTML = metric("Score", scoreLabel(s.score), scoreTone(s.passed)) + metric("Strict", s.passed == null ? "UNSCORED" : s.passed ? "PASS" : "FAIL", scoreTone(s.passed)) + metric("CLI events", counts.cli_events || 0) + metric("MCP calls", counts.mcp_audit_calls || 0) + metric("CAD jobs", counts.native_jobs || 0) + metric("Files", records.files.length + 1);
    $("eventSearch").value = ""; $("fileSearch").value = "";
    $("filePreview").textContent = ""; $("previewName").textContent = ""; $("fileImage").hidden = true; $("fileDownload").hidden = true;
    renderExperiments(); renderOverview(); renderEvents(); renderFiles();
    $("nativeJob").innerHTML = jobs.map((job, i) => `<option value="${i}">${String(i + 1).padStart(2, "0")} / ${escapeHtml(job.directory.split("/").at(-1).replace(/^\d+-/, ""))}</option>`).join("");
    await selectNativeJob();
    if (records.tab === "files") await previewFile("summary.json");
    if (generation !== records.generation) return;
    const url = new URL(location.href); url.searchParams.set("run", id); history.replaceState(null, "", url);
    $("status").textContent = "";
  } catch (error) {
    if (generation === records.generation && error.name !== "AbortError") $("status").textContent = `Unable to load record: ${error.message}`;
  } finally {
    if (generation === records.generation) document.querySelectorAll("main section, .tabs").forEach((el) => { el.inert = false; });
  }
}
function renderOverview() {
  const run = records.run, attempt = run.attempts.find((a) => a.attempt_id === run.selected_attempt_id) || run.attempts[0];
  const images = [["Original input", run.input_images[0]], ["Candidate", attempt.images.candidate], ["Aligned overlay", attempt.images.overlay]];
  $("media").innerHTML = images.filter(([, path]) => path).map(([label, path]) => `<figure><figcaption>${label}</figcaption><a href="${siteBase}bundles/${records.current.id}/${escapeHtml(path)}" target="_blank" rel="noopener"><img src="${siteBase}bundles/${records.current.id}/${escapeHtml(path)}" alt="${label}"></a></figure>`).join("");
  const m = attempt.verdict?.metrics || {};
  $("outcome").textContent = `IoU ${m.voxel_iou ?? "N/A"} | Normalized Chamfer ${m.normalized_chamfer ?? "N/A"} | Volume error ${m.volume_relative_error == null ? "N/A" : (100 * m.volume_relative_error).toFixed(4) + "%"}\n${attempt.reflection?.decision_reason || attempt.decision_reason || run.stop_reason}`;
  $("outcome").style.whiteSpace = "pre-line";
  $("benchmarkComparison").innerHTML = renderBenchmarkComparison(attempt.benchmark_comparison);
  if (attempt.benchmark_comparison) {
    $("outcome").textContent = `One valid AutoCAD solid; local AUDIT: 0 errors. Model runtime: ${(attempt.elapsed_seconds / 60).toFixed(2)} min. Official GT comparison pending.`;
    const downloads = [["DWG", "raw/outputs/candidate.dwg"], ["SAT", "raw/outputs/candidate.sat"], ["STEP", "candidate.step"], ["Submission ZIP", "submission.zip"]];
    $("media").insertAdjacentHTML("afterbegin", `<nav class="artifact-downloads">${downloads.filter(([,p]) => records.files.some(f => f.path === p)).map(([label,p]) => `<a href="${fileUrl(p)}" download>${label}</a>`).join("")}<a href="${siteBase}?view=${records.current.id}">Interactive 3D + human review</a></nav>`);
  }
  const limits = records.current.recorded_io.summary.limitations || [];
  $("limits").innerHTML = limits.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
}
function eventKind(row) {
  if (row.kind === "model_input_prompt") return "input";
  if (row.kind !== "cli_event") return "evaluation";
  const type = row.payload.item?.type;
  return type === "agent_message" ? "messages" : ["mcp_tool_call", "command_execution"].includes(type) ? "tools" : "control";
}
function renderEvents() {
  const filter = $("eventFilter").value, query = $("eventSearch").value.toLowerCase();
  const rows = records.timeline.filter((r) => (filter === "all" || eventKind(r) === filter) && (!query || JSON.stringify(r).toLowerCase().includes(query)));
  $("eventCount").textContent = `${rows.length} / ${records.timeline.length} records`;
  $("events").innerHTML = rows.map((row) => {
    const item = row.payload.item, kind = eventKind(row);
    const title = item?.tool || item?.type || (row.kind === "cli_event" ? row.payload.type : row.kind);
    const message = kind === "messages" ? item.text : kind === "input" ? row.payload.text : null;
    const content = message != null ? `<div class="message">${escapeHtml(message)}</div>` : `<pre class="code wrap">${escapeHtml(JSON.stringify(row.payload, null, 2))}</pre>`;
    return `<details class="event" ${["messages", "input"].includes(kind) ? "open" : ""}><summary><span class="kind">${row.sequence} / ${escapeHtml(title)}</span>${escapeHtml(row.phase)}<small>${escapeHtml(item?.status || row.payload.type || "")}</small></summary><div class="payload">${content}<p class="source">${escapeHtml(row.source)}${row.source_line ? ` : ${row.source_line}` : ""}</p></div></details>`;
  }).join("");
}
async function selectNativeJob() {
  const job = records.jobs[Number($("nativeJob").value)];
  if (!job) { $("nativeCode").textContent = "No recorded native job."; return; }
  const files = ["agent-input.lsp", ...job.files].filter((name, i, all) => all.indexOf(name) === i && records.files.some((f) => f.path === `${job.directory}/${name}`) && /\.(lsp|scr|log|json|txt|md)$/.test(name));
  $("nativeFile").innerHTML = files.map((name) => `<option>${escapeHtml(name)}</option>`).join("");
  $("nativeMeta").textContent = `${job.phase} | Job ${job.job_id}${job.actor === "human-supervisor" ? " | Human-requested operation" : ""}${job.postrun_snapshot_files?.length ? " | Includes postrun backend snapshots" : ""}`;
  await loadNativeFile();
}
async function loadNativeFile() {
  const job = records.jobs[Number($("nativeJob").value)];
  if (!job || !$("nativeFile").value) return;
  const generation = ++records.nativeGeneration;
  $("nativeCode").textContent = "Loading artifact...";
  try { const text = await read(fileUrl(`${job.directory}/${$("nativeFile").value}`), "text"); if (generation === records.nativeGeneration) $("nativeCode").textContent = text || "(Empty log)"; }
  catch (error) { if (generation === records.nativeGeneration) $("nativeCode").textContent = error.message; }
}
function renderFiles() {
  const query = $("fileSearch").value.toLowerCase();
  const files = records.files.filter((f) => f.path.toLowerCase().includes(query));
  $("fileCount").textContent = `${files.length} files`;
  $("files").innerHTML = files.map((file) => `<button class="file-item" data-path="${escapeHtml(file.path)}">${escapeHtml(file.path)}<br><span class="muted">${file.bytes.toLocaleString()} bytes</span></button>`).join("");
  $("files").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => previewFile(button.dataset.path)));
}
async function previewFile(path) {
  const generation = ++records.previewGeneration;
  $("files").querySelectorAll("button").forEach((button) => button.setAttribute("aria-current", String(button.dataset.path === path)));
  $("previewName").textContent = path; $("fileDownload").href = fileUrl(path); $("fileDownload").hidden = false;
  $("fileImage").hidden = true; $("filePreview").hidden = false;
  if (/\.(png|jpg|jpeg|webp)$/i.test(path)) {
    $("filePreview").hidden = true; $("fileImage").src = fileUrl(path); $("fileImage").hidden = false; return;
  }
  if (!/\.(jsonl?|md|txt|lsp|scr|log|py|toml|yaml|yml|css|js|html|csv)$/i.test(path)) { $("filePreview").textContent = "Binary artifact; available for download."; return; }
  $("filePreview").textContent = "Loading artifact...";
  try { const text = await read(fileUrl(path), "text"); if (generation === records.previewGeneration) $("filePreview").textContent = text || "(Empty file)"; }
  catch (error) { if (generation === records.previewGeneration) $("filePreview").textContent = error.message; }
}
async function start() {
  const catalog = await read(readOnly ? "catalog.json" : "/api/catalog");
  records.entries = catalog.bundles.filter((entry) => entry.recorded_io && /astra/i.test(entry.recorded_io.summary.model));
  $("inventory").textContent = `${records.entries.length} experiments / captured evidence`;
  renderExperiments();
  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => {
    records.tab = button.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    for (const tab of ["overview", "conversation", "native", "files"]) $(tab + "Panel").hidden = tab !== records.tab;
    if (records.tab === "files" && !$("previewName").textContent) previewFile("summary.json");
  }));
  $("eventFilter").addEventListener("change", renderEvents); $("eventSearch").addEventListener("input", renderEvents);
  $("fileSearch").addEventListener("input", renderFiles); $("nativeJob").addEventListener("change", selectNativeJob);
  $("nativeFile").addEventListener("change", loadNativeFile); $("wrapCode").addEventListener("change", () => $("nativeCode").classList.toggle("wrap", $("wrapCode").checked));
  const selected = new URL(location.href).searchParams.get("run");
  await loadRecord(records.entries.some((r) => r.id === selected) ? selected : records.entries[0]?.id);
}
start().catch((error) => { $("status").textContent = error.message; });
