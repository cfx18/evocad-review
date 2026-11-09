"use strict";

const $ = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll("[data-tab]")];
const dataFile = "deepseek-content.json";
let content;
let selected;
let tab = "input";
let codeRequest = new AbortController();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function list(value) { return Array.isArray(value) ? value : []; }

function assetURL(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.origin === location.origin && ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function fileEntries(values) {
  return list(values).flatMap((item) => {
    const url = assetURL(item?.url);
    return url ? [{ ...item, url }] : [];
  });
}

function readSelection(data, search) {
  const params = new URLSearchParams(search);
  const experiment = data.experiments.find((item) => item.id === params.get("experiment")) || data.experiments[0];
  const row = experiment.rows.find((item) => item.sample === params.get("sample")) || experiment.rows[0];
  const requestedTab = params.get("tab");
  return { experiment, row, activeTab: Object.hasOwn(panels, requestedTab) ? requestedTab : "input" };
}

function setTabParam(url) {
  if (tab === "input") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  return url;
}

function selectionURL(experiment, row) {
  const url = new URL(location.href);
  url.searchParams.set("experiment", experiment.id);
  url.searchParams.set("sample", row.sample);
  return setTabParam(url);
}

function selectSample(experiment, row, push = true) {
  const url = selectionURL(experiment, row);
  if (url.href !== location.href) {
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  selected = { experiment, row };
  const dialog = $("imageDialog");
  if (dialog.open) dialog.close();
  renderSelection();
}

function metricSummary(metric) {
  if (metric == null) return { display: "本页未提供数值", context: "" };
  if (typeof metric !== "object") return { display: String(metric), context: "" };
  const display = metric.display ?? metric.value ?? metric.score;
  return {
    display: display == null || display === "" ? "无数值" : String(display),
    context: [metric.label || metric.name, metric.scale].filter(Boolean).join(" · "),
  };
}

function addFact(parent, label, value, context = "") {
  const group = element("div");
  const entry = element("dd", value == null || value === "" ? "本页未提供" : value);
  if (context) entry.append(element("small", context));
  group.append(element("dt", label), entry);
  parent.append(group);
}

function renderSelection() {
  const { experiment, row } = selected;
  $("summaryLink").href = `deepseek.html#${encodeURIComponent(experiment.id)}`;
  $("experimentSelect").value = experiment.id;
  $("sampleCount").textContent = `${experiment.rows.length} 项`;
  const sampleList = $("sampleList");
  sampleList.replaceChildren(...experiment.rows.map((item) => {
    const entry = element("li");
    const link = element("a", null, "sample-link");
    link.href = selectionURL(experiment, item).href;
    if (item.sample === row.sample) link.setAttribute("aria-current", "page");
    link.append(element("strong", item.sample), element("span", item.title || ""));
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (item === selected.row) return;
      selectSample(experiment, item);
      sampleList.querySelector('[aria-current="page"]')?.focus();
    });
    entry.append(link);
    return entry;
  }));

  $("sampleId").textContent = `${row.sample} · ${experiment.label}`;
  $("sampleTitle").textContent = row.title || row.sample;
  const facts = $("sampleFacts");
  const metric = metricSummary(row.metric);
  facts.replaceChildren();
  addFact(facts, "执行状态", row.execution_status);
  addFact(facts, "评测状态", row.measurement_status);
  addFact(facts, "测量", metric.display, metric.context);
  if ("component_status" in row) addFact(facts, "组件检查", row.component_status ?? "未确认");
  if ("whole_task_status" in row) addFact(facts, "整题验收", row.whole_task_status ?? "未确认");
  const notes = list(row.notes).filter((note) => typeof note === "string" && note.trim());
  const disclosure = $("sampleNotesDisclosure");
  disclosure.open = false;
  disclosure.hidden = !notes.length;
  $("sampleNotes").replaceChildren(...notes.map((note) => element("li", note)));
  renderTab();
}

function section(parent, title) {
  const node = element("section");
  node.append(element("h3", title));
  parent.append(node);
  return node;
}

function empty(parent, message) { parent.append(element("p", message, "empty")); }

function showImage(url, caption) {
  const dialog = $("imageDialog");
  $("expandedImage").src = url.href;
  $("expandedImage").alt = caption;
  $("imageCaption").textContent = caption;
  dialog.showModal();
}

function gallery(parent, values, emptyMessage) {
  const items = fileEntries(values);
  if (!items.length) { empty(parent, emptyMessage); return; }
  const grid = element("div", null, "gallery");
  for (const [index, item] of items.entries()) {
    const caption = item.caption || `图 ${index + 1}`;
    const figure = element("figure", null, "evidence-image");
    const button = element("button");
    button.type = "button";
    button.disabled = true;
    button.setAttribute("aria-label", `放大：${caption}`);
    const image = element("img");
    image.alt = caption;
    image.loading = "lazy";
    image.addEventListener("load", () => { button.disabled = false; });
    image.addEventListener("error", () => { button.replaceWith(element("p", "图像文件暂不可读取。", "empty")); });
    button.addEventListener("click", () => showImage(item.url, caption));
    image.src = item.url.href;
    button.append(image);
    figure.append(button, element("figcaption", caption));
    grid.append(figure);
  }
  parent.append(grid);
}

function downloadLink(item, label) {
  const link = element("a", label);
  link.href = item.url.href;
  link.download = "";
  return link;
}

function downloads(parent, values, emptyMessage, { previewAssembly = false } = {}) {
  const entries = fileEntries(values);
  if (!entries.length) { empty(parent, emptyMessage); return; }
  const links = element("ul", null, "file-list");
  for (const item of entries) {
    const canPreview = previewAssembly && item.url.pathname.toLowerCase().endsWith(".json");
    const li = element("li", null, canPreview ? "file-preview" : "");
    const downloadLabel = item.label || item.name || "下载产物";
    li.append(canPreview ? previewableFile(item, "查看装配位姿 JSON", downloadLabel) : downloadLink(item, downloadLabel));
    links.append(li);
  }
  parent.append(links);
}

function renderInput(parent, row) {
  const prompt = section(parent, row.prompt_label || "任务说明");
  if (typeof row.prompt === "string" && row.prompt.trim()) prompt.append(element("p", row.prompt, "record-text"));
  else empty(prompt, "本页未提供任务说明。");
  gallery(section(parent, "输入图片"), row.input_images, "本页未提供输入图片。");
}

function renderArtifact(parent, row) {
  gallery(section(parent, "产物预览"), row.candidate_images, "本页未提供产物图像。");
  downloads(section(parent, "几何产物"), row.candidate_meshes, "本页未提供可下载的几何产物。", { previewAssembly: true });
  downloads(section(parent, "其他产物"), row.artifacts, "本页未提供其他产物。");
}

async function previewCode(item, output, signal) {
  const previewLimit = 512 * 1024;
  try {
    const response = await fetch(item.url, { signal, mode: "same-origin" });
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw new Error("File unavailable");
    if (Number(response.headers.get("content-length")) > previewLimit) {
      output.textContent = "文件较大，请下载查看。";
      return;
    }
    const data = await response.text();
    if (data.length > previewLimit) { output.textContent = "文件较大，请下载查看。"; return; }
    if (!signal.aborted) {
      const preview = element("pre", data || "文件为空。", "record-text");
      preview.tabIndex = 0;
      output.replaceWith(preview);
    }
  } catch (error) {
    if (error.name !== "AbortError") output.textContent = "文件暂不可读取。";
  }
}

function previewableFile(item, label, downloadLabel) {
  const signal = codeRequest.signal;
  const wrapper = element("div", null, "code-item");
  const detail = element("details");
  const output = element("p", "正在读取文件…", "empty");
  detail.append(element("summary", label), output);
  detail.addEventListener("toggle", function loadOnOpen() {
    if (!detail.open) return;
    detail.removeEventListener("toggle", loadOnOpen);
    previewCode(item, output, signal);
  });
  wrapper.append(detail, downloadLink(item, downloadLabel));
  return wrapper;
}

function renderCode(parent, row) {
  const files = section(parent, "建模源文件");
  const entries = fileEntries(row.code_files);
  if (!entries.length) { empty(files, "本页未提供建模源文件。"); return; }
  for (const item of entries) {
    const name = item.name || item.label || "源文件";
    files.append(previewableFile(item, name, "下载"));
  }
}

function renderProcess(parent, row) {
  const finalResponse = section(parent, "模型保存的最终回复");
  if (typeof row.final_response === "string" && row.final_response.trim()) {
    finalResponse.append(element("p", row.final_response, "record-text"));
  } else empty(finalResponse, "本页未提供最终回复。");

  const eventSection = section(parent, "执行记录");
  const events = list(row.events).filter((item) => typeof item?.text === "string" && item.text.trim());
  if (!events.length) { empty(eventSection, "本页未提供执行记录。"); return; }
  const timeline = element("ol", null, "event-list");
  for (const event of events) {
    const node = element("li");
    if (event.type) node.append(element("strong", event.type));
    node.append(element("p", event.text));
    timeline.append(node);
  }
  eventSection.append(timeline);
}

const panels = { input: renderInput, artifact: renderArtifact, code: renderCode, process: renderProcess };

function renderTab() {
  codeRequest.abort();
  codeRequest = new AbortController();
  for (const button of tabs) {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  const panel = $("evidencePanel");
  panel.setAttribute("aria-labelledby", `tab-${tab}`);
  panel.replaceChildren();
  panels[tab](panel, selected.row);
}

function bindControls() {
  $("experimentSelect").addEventListener("change", (event) => {
    const experiment = content.experiments.find((item) => item.id === event.target.value);
    if (experiment) selectSample(experiment, experiment.rows[0]);
  });
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => {
      if (tab === button.dataset.tab) return;
      tab = button.dataset.tab;
      history.replaceState(null, "", selectionURL(selected.experiment, selected.row));
      for (const link of $("sampleList").querySelectorAll("a")) link.href = setTabParam(new URL(link.href)).href;
      renderTab();
    });
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  });
  window.addEventListener("popstate", () => {
    const { experiment, row, activeTab } = readSelection(content, location.search);
    tab = activeTab;
    selectSample(experiment, row, false);
  });
}

async function start() {
  const response = await fetch(dataFile);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  content = await response.json();
  if (!list(content.experiments).length || content.experiments.some((experiment) =>
    !experiment.id || !experiment.label || !list(experiment.rows).length || experiment.rows.some((row) => !row.sample)
  )) throw new Error("Invalid experiment manifest");
  $("harnessLabel").textContent = content.harness || "未记录";
  $("modelLabel").textContent = content.model || "未记录";
  const picker = $("experimentSelect");
  picker.replaceChildren(...content.experiments.map((experiment) => {
    const option = element("option", experiment.label);
    option.value = experiment.id;
    return option;
  }));
  picker.disabled = content.experiments.length === 1;
  const { experiment, row, activeTab } = readSelection(content, location.search);
  tab = activeTab;
  selectSample(experiment, row, false);
  bindControls();
  $("loadStatus").hidden = true;
  $("workspace").hidden = false;
}

start().catch((error) => {
  console.error("DeepSeek evidence manifest could not be loaded", error);
  $("loadStatus").textContent = "暂时无法读取证据清单。请重新载入页面，或返回结果汇总。";
});
