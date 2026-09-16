"use strict";
function renderBenchmarkComparison(comparison) {
  if (!comparison) return "";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const sources = [comparison.candidate, ...comparison.references];
  const number = (value) => value == null ? "Pending / 待评测" : Number(value).toFixed(3);
  const rows = [
    ["CADScore", "cad_score"], ["Volume IoU", "volume_iou"], ["Surface F1", "surface_f1"],
    ["Shape similarity", "shape_similarity"], ["Interface match", "interface_match"], ["Topology match", "topology_match"],
  ];
  const table = `<div class="comparison-scroll"><table class="benchmark-table"><thead><tr><th scope="col">Metric (0 to 1)</th>${sources.map(s => `<th scope="col">${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(([label, key]) => `<tr><th scope="row">${label}</th>${sources.map(s => `<td class="${s.metrics[key] == null ? "pending" : ""}">${number(s.metrics[key])}</td>`).join("")}</tr>`).join("")}<tr><th scope="row">Chamfer / volume error</th>${sources.map(s => `<td>${s === comparison.candidate ? "Not evaluated" : "Not published"}</td>`).join("")}</tr><tr><th scope="row">Betti numbers</th>${sources.map(s => `<td>${esc(s.metrics.betti || "GT comparison pending")}</td>`).join("")}</tr></tbody></table></div>`;
  const links = comparison.references.map(s => {
    let url;
    try { url = new URL(s.source_url); } catch { return esc(s.label); }
    return url.protocol === "https:" ? `<a href="${esc(url.href)}" target="_blank" rel="noopener">${esc(s.label)}: official report</a>` : esc(s.label);
  }).join(" · ");
  const c = comparison.conversion;
  const conversion = c ? `<h3>Local conversion check / 本地转换检查</h3><dl class="conversion-facts"><div><dt>STEP validity / solids</dt><dd>${c.step_valid ? "VALID" : "INVALID"} / ${c.step_solids}</dd></div><div><dt>SAT → STEP volume difference</dt><dd>${(c.volume_relative_difference * 100).toFixed(6)}%</dd></div><div><dt>Analytic faces</dt><dd>${c.native_faces} → ${c.step_faces}</dd></div></dl><p class="muted">${esc(c.caveat)}</p>` : "";
  return `<h3>CADGenBench / ${esc(comparison.sample_id)} · Generation metrics</h3><p class="comparison-notice">本次结果尚未获得官方评分。GT 未公开；AutoCAD 自检通过不等于 IoU 满分。已获准公开提交，当前等待认证提交。</p>${table}<p class="muted">${esc(comparison.formula)}</p><p class="muted">${esc(comparison.notes)}</p><p class="comparison-sources">${links}</p>${conversion}`;
}
