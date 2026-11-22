import { parseProject } from "./project.js";
import { candidatesForRef, proposeMatch, rankCandidates } from "./matcher.js";
import { analyzeMedia, mergeAnalysis, playWithMediaSource } from "./media.js";
const state = {
    config: null,
    project: null,
    projectPath: "",
    newRoot: "",
    oldRoot: "",
    scannedNewRoot: "",
    scannedOldRoot: "",
    files: [],
    matches: [],
    filter: "review",
    query: "",
    selectedKey: null,
    busy: false,
    demo: false,
    exportResult: null,
    lastLog: 0
};
function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element;
}
function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "—";
    const whole = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(whole / 60);
    const remainder = whole % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
function formatDurationLong(seconds) {
    return seconds == null ? "时长未知" : `${seconds.toFixed(2)} s`;
}
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function dimensions(width, height) {
    return width && height ? `${width}×${height}` : "参数未知";
}
function technicalLine(file) {
    return [
        formatDurationLong(file.duration),
        dimensions(file.width, file.height),
        file.fps ? `${Number(file.fps).toFixed(2)} fps` : null,
        file.videoCodec,
        file.audioCodec
    ].filter(Boolean).join(" · ");
}
function pct(value) {
    if (value == null) return "—";
    return `${Math.round(value * 100)}%`;
}
function mediaUrl(path) {
    return `/api/media?path=${encodeURIComponent(path)}`;
}
async function api(path, body) {
    const response = await fetch(path, body === undefined ? undefined : {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
}
function toast(message, error = false) {
    const element = byId("toast");
    element.textContent = message;
    element.classList.toggle("is-error", error);
    element.classList.add("is-visible");
    window.clearTimeout(Number(element.dataset.timer ?? 0));
    const timer = window.setTimeout(()=>element.classList.remove("is-visible"), 4200);
    element.dataset.timer = String(timer);
}
function setBusy(busy) {
    state.busy = busy;
    byId("runButton").disabled = busy;
    byId("exportButton").disabled = busy;
    byId("rerunButton").disabled = busy;
}
function setProgress(percent, label, detail, count = "") {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    byId("progressPanel").hidden = false;
    byId("progressLabel").textContent = label;
    byId("progressValue").textContent = `${safePercent}%`;
    byId("progressBar").style.width = `${safePercent}%`;
    byId("progressDetail").textContent = detail;
    byId("progressCount").textContent = count;
}
function scanLog(message) {
    const log = byId("scanLog");
    const span = document.createElement("span");
    span.textContent = message;
    log.append(span);
    while(log.children.length > 5)log.firstElementChild?.remove();
}
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
        while(cursor < items.length){
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({
        length: Math.min(limit, items.length)
    }, ()=>run()));
    return results;
}
function toCandidates(files) {
    return files.map((file)=>({
            ...file
        }));
}
function candidateFilename(file) {
    return file.name.normalize("NFC").trim().toLowerCase();
}
function buildGroups(refs, files) {
    const groups = new Map();
    for (const ref of refs){
        const key = ref.filename.normalize("NFC").trim().toLowerCase();
        const group = groups.get(key) ?? {
            candidates: [],
            refs: []
        };
        group.refs.push(ref);
        groups.set(key, group);
    }
    for (const file of files){
        const key = candidateFilename(file);
        const group = groups.get(key);
        if (group) group.candidates.push(file);
    }
    return groups;
}
function enrichRefWithAnalysis(ref, file, hash, analysis) {
    return {
        ...ref,
        duration: ref.duration ?? file.duration ?? analysis.duration,
        width: ref.width ?? file.width ?? analysis.width,
        height: ref.height ?? file.height ?? analysis.height,
        fps: ref.fps ?? file.fps,
        videoCodec: ref.videoCodec ?? file.videoCodec,
        audioCodec: ref.audioCodec ?? file.audioCodec,
        audioChannels: ref.audioChannels ?? file.audioChannels,
        sampleRate: ref.sampleRate ?? file.sampleRate,
        sha256: hash || ref.sha256,
        visualHash: analysis.visualHash || ref.visualHash,
        audioFingerprint: analysis.audioFingerprint || ref.audioFingerprint
    };
}
function isDirectReferencePath(ref, candidate) {
    const source = ref.sourcePath.replaceAll("\\", "/");
    const target = candidate.path.replaceAll("\\", "/");
    return source === target || source.endsWith(`/${candidate.relPath}`);
}
function chooseReferenceFile(ref, oldFiles) {
    const options = candidatesForRef(ref, oldFiles);
    if (options.length === 0) return null;
    if (options.length === 1) return options[0];
    const direct = options.find((candidate)=>isDirectReferencePath(ref, candidate));
    if (direct) return direct;
    const ranked = rankCandidates(ref, options);
    const [top, second] = ranked;
    if (!second) return top.candidate;
    const durationKnown = top.evidence.duration.available && (top.evidence.duration.score ?? 0) > 0.97;
    if (durationKnown && top.score - second.score >= 0.12) return top.candidate;
    return null;
}
async function enrichReferences(refs, oldFiles, oldRoot) {
    if (!oldRoot || oldFiles.length === 0) return refs;
    const result = [];
    let analyzed = 0;
    for(let index = 0; index < refs.length; index += 1){
        const ref = refs[index];
        const file = chooseReferenceFile(ref, oldFiles);
        if (!file) {
            result.push(ref);
            continue;
        }
        try {
            setProgress(50 + index / Math.max(1, refs.length) * 12, "读取旧盘参考证据", `比对 ${ref.filename}`, `${index + 1} / ${refs.length}`);
            const hash = await api("/api/hash", {
                path: file.path
            });
            const analysis = await analyzeMedia(mediaUrl(file.path), file.size, {
                needVisual: true,
                needAudio: true,
                needThumbnail: false
            });
            result.push(enrichRefWithAnalysis(ref, file, hash.sha256, analysis));
            analyzed += 1;
            if (index < 4) scanLog(`参考 ${file.relPath}`);
        } catch (error) {
            result.push(ref);
            scanLog(`参考指纹失败 · ${ref.filename}`);
            if (index === 0) console.warn("Reference analysis failed", error);
        }
    }
    if (analyzed > 0) toast(`旧盘参考指纹已读取 ${analyzed} 条`);
    return result;
}
async function analyzeCandidates(refs, files, totalFiles, startPercent, endPercent) {
    const groups = buildGroups(refs, files);
    const tasks = [];
    for (const group of groups.values()){
        group.candidates.forEach((candidate, index)=>tasks.push({
                group,
                candidate,
                index
            }));
    }
    let completed = 0;
    const updated = await mapLimit(tasks, 2, async (task)=>{
        const hasRefHash = task.group.refs.some((ref)=>Boolean(ref.sha256));
        const hasRefAudio = task.group.refs.some((ref)=>Boolean(ref.audioFingerprint));
        const hasRefVisual = task.group.refs.some((ref)=>Boolean(ref.visualHash));
        const ambiguous = task.group.candidates.length > 1;
        const needHash = hasRefHash || ambiguous || totalFiles <= 50;
        const needAudio = hasRefAudio;
        const needVisual = ambiguous || hasRefVisual;
        const needThumbnail = ambiguous || totalFiles <= 150;
        const needMediaMetadata = !task.candidate.duration || !task.candidate.width || !task.candidate.height;
        let candidate = task.candidate;
        const errors = [];
        if (needHash) {
            try {
                const hash = await api("/api/hash", {
                    path: candidate.path
                });
                candidate = {
                    ...candidate,
                    sha256: hash.sha256
                };
            } catch (error) {
                errors.push(`SHA-256: ${error instanceof Error ? error.message : "失败"}`);
            }
        }
        if (needAudio || needVisual || needThumbnail || needMediaMetadata) {
            try {
                const analysis = await analyzeMedia(mediaUrl(candidate.path), candidate.size, {
                    needAudio,
                    needVisual,
                    needThumbnail
                });
                candidate = mergeAnalysis(candidate, analysis);
                if (analysis.errors.length > 0) errors.push(...analysis.errors);
            } catch (error) {
                errors.push(`媒体分析: ${error instanceof Error ? error.message : "失败"}`);
            }
        }
        if (errors.length > 0) candidate = {
            ...candidate,
            analysisError: errors.join("；")
        };
        completed += 1;
        const percent = startPercent + completed / Math.max(1, tasks.length) * (endPercent - startPercent);
        setProgress(percent, "逐候选比对证据", candidate.relPath || candidate.name, `${completed} / ${tasks.length}`);
        if (completed <= 6) scanLog(`分析 ${candidate.name} · ${candidate.relPath}`);
        return candidate;
    });
    const byPath = new Map(updated.map((candidate)=>[
            candidate.path,
            candidate
        ]));
    return files.map((file)=>byPath.get(file.path) ?? file);
}
function statusOf(match) {
    if (match.decision === "missing") return "missing";
    if (match.confirmed) return "confirmed";
    return match.decision === "auto" ? "auto" : "review";
}
function matchPriority(match) {
    const status = statusOf(match);
    return status === "review" ? 0 : status === "missing" ? 1 : status === "auto" ? 2 : 3;
}
async function runAnalysis(options) {
    if (state.busy) return;
    setBusy(true);
    state.demo = Boolean(options.demo);
    state.projectPath = options.projectPath;
    state.newRoot = options.newRoot;
    state.oldRoot = options.oldRoot;
    state.matches = [];
    state.files = [];
    state.exportResult = null;
    state.selectedKey = null;
    byId("dashboard").hidden = true;
    byId("setupCard").hidden = true;
    byId("scanLog").replaceChildren();
    document.body.classList.remove("is-analyzed");
    state.lastLog = 0;
    setProgress(3, "读取剪辑工程", options.projectPath);
    scanLog("开始读取工程");
    try {
        const projectResponse = await api("/api/read-project", {
            path: options.projectPath
        });
        state.projectPath = projectResponse.path;
        const project = parseProject(projectResponse.text, projectResponse.path);
        project.sha256 = projectResponse.sha256;
        if (project.refs.length === 0) throw new Error("工程中没有识别到可重连的素材路径");
        state.project = project;
        scanLog(`${project.name} · ${project.refs.length} 个素材引用`);
        setProgress(9, "扫描新素材盘", options.newRoot);
        const newScan = await api("/api/scan", {
            root: options.newRoot
        });
        state.scannedNewRoot = newScan.root;
        state.files = toCandidates(newScan.files);
        scanLog(`新盘 ${newScan.files.length} 个媒体 · ${newScan.elapsedMs} ms`);
        setProgress(31, "扫描旧盘参考", options.oldRoot || "未指定，跳过");
        let oldFiles = [];
        state.scannedOldRoot = "";
        if (options.oldRoot.trim()) {
            try {
                const oldScan = await api("/api/scan", {
                    root: options.oldRoot
                });
                oldFiles = toCandidates(oldScan.files);
                state.scannedOldRoot = oldScan.root;
                scanLog(`参考盘 ${oldScan.files.length} 个媒体`);
            } catch (error) {
                scanLog("旧盘不可读，继续使用工程内元数据");
                toast(`旧盘参考不可用：${error instanceof Error ? error.message : "读取失败"}`, true);
            }
        }
        setProgress(47, "提取参考哈希与指纹", "旧盘可读时生成可比较证据");
        let refs = await enrichReferences(project.refs, oldFiles, state.scannedOldRoot);
        state.project = {
            ...project,
            refs
        };
        setProgress(64, "排序同名候选", "计算时长、参数、哈希与指纹");
        const files = await analyzeCandidates(refs, state.files, state.files.length, 64, 92);
        state.files = files;
        const matches = refs.map((ref)=>{
            const proposal = proposeMatch(ref, candidatesForRef(ref, files));
            return {
                ...proposal,
                confirmed: false,
                overridden: false,
                rejectedPaths: new Set()
            };
        });
        state.matches = matches.sort((left, right)=>{
            const priority = matchPriority(left) - matchPriority(right);
            return priority || left.ref.filename.localeCompare(right.ref.filename, "zh-CN");
        });
        const reviewCount = state.matches.filter((match)=>statusOf(match) === "review").length;
        state.filter = reviewCount > 0 ? "review" : "matched";
        state.selectedKey = null;
        setProgress(100, "匹配完成", "等待复核与保存映射");
        renderAll();
        byId("progressPanel").hidden = true;
        byId("dashboard").hidden = false;
        document.body.classList.add("is-analyzed");
        window.setTimeout(()=>byId("dashboard").scrollIntoView({
                behavior: "smooth",
                block: "start"
            }), 120);
        const missing = state.matches.filter((match)=>statusOf(match) === "missing").length;
        toast(`完成：${state.matches.length - reviewCount - missing} 条自动匹配，${reviewCount} 条待确认`);
    } catch (error) {
        byId("progressPanel").hidden = true;
        byId("setupCard").hidden = false;
        byId("setupHint").textContent = error instanceof Error ? error.message : "分析失败";
        toast(error instanceof Error ? error.message : "分析失败", true);
        console.error(error);
    } finally{
        setBusy(false);
    }
}
function selectedCandidate(match) {
    if (!match.selectedPath) return match.ranked[0]?.candidate ?? null;
    return state.files.find((file)=>file.path === match.selectedPath) ?? match.ranked.find((item)=>item.candidate.path === match.selectedPath)?.candidate ?? null;
}
function selectedRanked(match) {
    if (!match.selectedPath) return match.ranked[0] ?? null;
    return match.ranked.find((item)=>item.candidate.path === match.selectedPath) ?? match.ranked[0] ?? null;
}
function matchesQuery(match) {
    if (!state.query) return true;
    const query = state.query.toLowerCase();
    const candidate = selectedCandidate(match);
    return [
        match.ref.filename,
        match.ref.sourcePath,
        candidate?.relPath,
        candidate?.path
    ].filter(Boolean).some((value)=>String(value).toLowerCase().includes(query));
}
function visibleMatches() {
    return state.matches.filter((match)=>{
        if (!matchesQuery(match)) return false;
        if (state.filter === "all") return true;
        if (state.filter === "matched") return [
            "auto",
            "confirmed"
        ].includes(statusOf(match));
        return statusOf(match) === state.filter;
    });
}
function statusLabel(match) {
    const status = statusOf(match);
    if (status === "review") return "待确认";
    if (status === "confirmed") return "已确认";
    if (status === "auto") return "自动匹配";
    return "仍缺文件";
}
function statusClass(match) {
    const status = statusOf(match);
    if (status === "review") return "status-review";
    if (status === "confirmed") return "status-confirmed";
    if (status === "auto") return "status-auto";
    return "status-missing";
}
function scoreClass(score) {
    if (score >= 0.86) return "";
    return score >= 0.6 ? "warn" : "bad";
}
function updateCounts() {
    const statuses = state.matches.map(statusOf);
    const matched = statuses.filter((status)=>status === "auto" || status === "confirmed").length;
    const review = statuses.filter((status)=>status === "review").length;
    const missing = statuses.filter((status)=>status === "missing").length;
    byId("statTotal").textContent = String(state.matches.length);
    byId("statMatched").textContent = String(matched);
    byId("statReview").textContent = String(review);
    byId("statMissing").textContent = String(missing);
    byId("reviewTabCount").textContent = String(review);
    byId("matchedTabCount").textContent = String(matched);
    byId("missingTabCount").textContent = String(missing);
    byId("allTabCount").textContent = String(state.matches.length);
    const timelineRefs = state.matches.reduce((sum, match)=>sum + match.ref.timelineRefs.length, 0);
    byId("statTotalNote").textContent = `${timelineRefs} 个时间线引用 · ${state.project?.format?.toUpperCase() ?? "PROJECT"}`;
    document.querySelectorAll(".filter-tab").forEach((button)=>{
        button.classList.toggle("is-active", button.dataset.filter === state.filter);
    });
}
function rowHtml(match) {
    const candidate = selectedCandidate(match);
    const ranked = selectedRanked(match);
    const status = statusOf(match);
    const score = ranked?.score ?? 0;
    const isSelected = state.selectedKey === match.ref.key;
    const thumb = candidate?.thumbnail ? `<img src="${candidate.thumbnail}" alt="">` : `<span class="thumb-icon">${escapeHtml(candidate?.ext?.replace(".", "").toUpperCase() ?? "MISS")}</span>`;
    const candidateTitle = status === "missing" ? "新盘未找到同名文件" : candidate?.relPath ?? candidate?.path ?? "未选择";
    const candidateNote = status === "missing" ? "检查目录，或将文件补入新盘后重新分析" : status === "review" ? `${match.ranked.length} 个同名候选 · ${match.reason}` : status === "confirmed" ? `人工确认 · ${match.reason}` : match.reason;
    return `
    <article class="match-row${isSelected ? " is-selected" : ""}" data-key="${escapeHtml(match.ref.key)}" tabindex="0">
      <span class="status-cell"><span class="status-badge ${statusClass(match)}">${statusLabel(match)}</span></span>
      <div class="file-cell">
        <div class="thumb">${thumb}</div>
        <div class="file-main">
          <strong title="${escapeHtml(match.ref.filename)}">${escapeHtml(match.ref.filename)}</strong>
          <small title="${escapeHtml(match.ref.sourcePath)}">${escapeHtml(match.ref.sourcePath || match.ref.name)}</small>
        </div>
      </div>
      <div class="duration-cell">${formatDuration(candidate?.duration ?? match.ref.duration)}<small>${match.ref.timelineRefs.length} 处引用</small></div>
      <div class="candidate-cell${status === "missing" ? " is-missing" : ""}">
        <strong title="${escapeHtml(candidateTitle)}">${escapeHtml(candidateTitle)}</strong>
        <small title="${escapeHtml(candidateNote)}">${escapeHtml(candidateNote)}</small>
      </div>
      <div class="score-cell">
        <div class="score-track"><span class="${scoreClass(score)}" style="width:${Math.round(score * 100)}%"></span></div>
        <b>${status === "missing" ? "—" : pct(score)}</b>
      </div>
    </article>`;
}
function renderList() {
    const visible = visibleMatches();
    if (!state.selectedKey || !visible.some((match)=>match.ref.key === state.selectedKey)) {
        state.selectedKey = visible[0]?.ref.key ?? null;
    }
    byId("matchList").innerHTML = visible.map(rowHtml).join("");
    byId("emptyFilter").hidden = visible.length > 0;
}
function signalBar(label, available, score) {
    const width = available && score != null ? Math.round(score * 100) : 0;
    const kind = !available ? "" : (score ?? 0) >= 0.85 ? "good" : (score ?? 0) >= 0.55 ? "warn" : "bad";
    const title = available ? `${label}: ${pct(score)}` : `${label}: 无参考值`;
    return `<span class="${kind}" title="${escapeHtml(title)}"><i style="width:${width}%"></i></span>`;
}
function candidateCardHtml(match, ranked) {
    const candidate = ranked.candidate;
    const picked = match.selectedPath === candidate.path;
    const { evidence } = ranked;
    const bars = [
        signalBar("文件名", evidence.filename.available, evidence.filename.score),
        signalBar("时长", evidence.duration.available, evidence.duration.score),
        signalBar("参数", evidence.params.available, evidence.params.score),
        signalBar("哈希", evidence.hash.available, evidence.hash.score),
        signalBar("音频", evidence.audio.available, evidence.audio.score),
        signalBar("画面", evidence.visual.available, evidence.visual.score)
    ].join("");
    const flags = ranked.flags.length > 0 ? ranked.flags.join(" · ") : "未发现冲突";
    return `
    <article class="candidate-card${picked ? " is-picked" : ""}" data-pick="${escapeHtml(candidate.path)}" tabindex="0">
      <div class="candidate-top">
        <div class="candidate-title">
          <strong title="${escapeHtml(candidate.path)}">${escapeHtml(candidate.relPath)}</strong>
          <small>${escapeHtml(technicalLine(candidate))}</small>
        </div>
        <span class="candidate-score${ranked.score < 0.86 ? " warn" : ""}">${pct(ranked.score)}</span>
      </div>
      <div class="candidate-facts">
        <span>${formatBytes(candidate.size)}</span>
        ${candidate.sha256 ? `<span>SHA ${escapeHtml(candidate.sha256.slice(0, 8))}</span>` : ""}
        <span>${escapeHtml(flags)}</span>
      </div>
      <div class="signal-bars" title="文件名 · 时长 · 参数 · 哈希 · 音频 · 画面">${bars}</div>
      ${candidate.analysisError ? `<div class="candidate-facts"><span>${escapeHtml(candidate.analysisError)}</span></div>` : ""}
      <div class="candidate-actions">
        <small>${picked ? "当前选用" : "点击卡片选用此候选"}</small>
        <button class="mini-button" type="button" data-preview="${escapeHtml(candidate.path)}">预览</button>
      </div>
      <div class="preview-slot"></div>
    </article>`;
}
function inspectorMissingHtml(match) {
    return `
    <div class="inspector-scroll">
      <div class="inspector-head">
        <div>
          <p class="section-kicker">MISSING MEDIA</p>
          <h3>${escapeHtml(match.ref.filename)}</h3>
          <code>${escapeHtml(match.ref.sourcePath)}</code>
        </div>
        <span class="status-badge status-missing">仍缺文件</span>
      </div>
      <div class="inspector-path"><span>工程引用路径</span><code>${escapeHtml(match.ref.sourcePath)}</code></div>
      <div class="evidence-grid">
        <div class="evidence-chip"><span>工程时长</span><strong>${formatDuration(match.ref.duration)}</strong></div>
        <div class="evidence-chip"><span>尺寸</span><strong>${dimensions(match.ref.width, match.ref.height)}</strong></div>
        <div class="evidence-chip"><span>时间线引用</span><strong>${match.ref.timelineRefs.length} 处</strong></div>
      </div>
      <div class="missing-box">
        <strong>新盘没有同名候选</strong>
        <p>可能是尚未拷入、文件名被修改，或位于被跳过的系统目录。补入文件后重新分析即可，不会改动工程。</p>
      </div>
    </div>`;
}
function inspectorMatchHtml(match) {
    const candidate = selectedCandidate(match);
    const ranked = selectedRanked(match);
    const status = statusOf(match);
    const ref = match.ref;
    const hashDetail = ref.sha256 ? `SHA ${ref.sha256.slice(0, 8)}` : "无参考";
    const audioDetail = ref.audioFingerprint ? "已提取" : "无参考";
    const visualDetail = ref.visualHash ? "已提取" : "无参考";
    return `
    <div class="inspector-scroll">
      <div class="inspector-head">
        <div>
          <p class="section-kicker">MATCH INSPECTOR</p>
          <h3>${escapeHtml(ref.filename)}</h3>
          <code>${escapeHtml(ref.name)} · ${escapeHtml(ref.assetId)}</code>
        </div>
        <span class="status-badge ${statusClass(match)}">${statusLabel(match)}</span>
      </div>
      <div class="inspector-path"><span>原工程路径</span><code title="${escapeHtml(ref.sourcePath)}">${escapeHtml(ref.sourcePath)}</code></div>
      <div class="evidence-grid">
        <div class="evidence-chip ${ref.sha256 ? "good" : ""}"><span>参考哈希</span><strong>${escapeHtml(hashDetail)}</strong></div>
        <div class="evidence-chip ${ref.audioFingerprint ? "good" : ""}"><span>音频指纹</span><strong>${audioDetail}</strong></div>
        <div class="evidence-chip ${ref.visualHash ? "good" : ""}"><span>画面指纹</span><strong>${visualDetail}</strong></div>
      </div>
      <div class="inspector-section-title">
        <h4>候选排序</h4>
        <span>${match.ranked.length} 个同名文件 · 覆盖率 ${pct(ranked?.evidence.coverage)}</span>
      </div>
      <div class="candidate-list">${match.ranked.map((item)=>candidateCardHtml(match, item)).join("")}</div>
      ${status === "review" ? `<p class="inspector-note">${escapeHtml(match.reason)}。请预览并核对后确认；未确认项不会写入映射。</p>` : status === "confirmed" ? `<p class="inspector-note">已人工确认。导出只记录相对路径，不修改时间线内容。</p>` : `<p class="inspector-note">该候选达到安全阈值。仍可改选，但改选后会重新要求人工确认。</p>`}
      <div class="inspector-actions">
        ${status === "confirmed" ? `<button class="secondary-button" type="button" disabled>已确认</button>` : `<button class="primary-button" type="button" data-confirm="${escapeHtml(candidate?.path ?? "")}">确认并锁定此匹配</button>`}
      </div>
    </div>`;
}
function renderInspector() {
    const placeholder = byId("inspectorPlaceholder");
    const content = byId("inspectorContent");
    const match = state.matches.find((item)=>item.ref.key === state.selectedKey);
    if (!match) {
        placeholder.hidden = false;
        content.hidden = true;
        content.innerHTML = "";
        return;
    }
    placeholder.hidden = true;
    content.hidden = false;
    content.innerHTML = statusOf(match) === "missing" ? inspectorMissingHtml(match) : inspectorMatchHtml(match);
    wireInspectorEvents(match);
}
function wireInspectorEvents(match) {
    byId("inspectorContent").querySelectorAll("[data-pick]").forEach((card)=>{
        card.addEventListener("click", ()=>chooseCandidate(match, card.dataset.pick ?? ""));
        card.addEventListener("keydown", (event)=>{
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                chooseCandidate(match, card.dataset.pick ?? "");
            }
        });
    });
    byId("inspectorContent").querySelectorAll("[data-confirm]").forEach((button)=>{
        button.addEventListener("click", ()=>confirmMatch(match, button.dataset.confirm ?? ""));
    });
    byId("inspectorContent").querySelectorAll("[data-preview]").forEach((button)=>{
        button.addEventListener("click", async (event)=>{
            event.stopPropagation();
            const path = button.dataset.preview ?? "";
            const card = button.closest(".candidate-card");
            const slot = card?.querySelector(".preview-slot");
            if (!slot || !path) return;
            slot.innerHTML = `<div class="candidate-preview" style="display:grid;place-items:center;color:#7b8a93;font-size:9px">正在通过 MediaSource 加载预览…</div>`;
            const video = document.createElement("video");
            video.className = "candidate-preview";
            video.controls = true;
            video.autoplay = true;
            video.playsInline = true;
            slot.replaceChildren(video);
            const usedMse = await playWithMediaSource(video, mediaUrl(path));
            video.dataset.previewTransport = usedMse ? "mse" : "direct";
            if (!usedMse) {
                video.src = mediaUrl(path);
                await video.play().catch(()=>undefined);
            }
        });
    });
}
function chooseCandidate(match, path) {
    if (!path) return;
    const topPath = match.ranked[0]?.candidate.path;
    if (match.decision === "auto" && path === topPath) {
        match.selectedPath = path;
        match.overridden = false;
        match.confirmed = false;
    } else {
        match.selectedPath = path;
        match.overridden = true;
        match.confirmed = false;
        match.decision = "review";
    }
    renderAll();
    toast("已选用候选，请确认后进入映射");
}
function confirmMatch(match, path) {
    if (!path) return;
    match.selectedPath = path;
    match.confirmed = true;
    renderAll();
    toast(`${match.ref.filename} 已确认`);
}
function renderAll() {
    if (!state.project) return;
    updateCounts();
    renderList();
    renderInspector();
}
function exportBuckets() {
    const mapped = state.matches.filter((match)=>{
        if (statusOf(match) === "missing" || !match.selectedPath) return false;
        return match.decision === "auto" || match.confirmed;
    });
    const unresolved = state.matches.filter((match)=>statusOf(match) === "review");
    const missing = state.matches.filter((match)=>statusOf(match) === "missing");
    return {
        mapped,
        unresolved,
        missing
    };
}
function renderExportSummary() {
    const { mapped, unresolved, missing } = exportBuckets();
    byId("exportSummary").innerHTML = `
    <div class="export-stat good"><span>写入映射</span><strong>${mapped.length}</strong></div>
    <div class="export-stat warn"><span>待确认</span><strong>${unresolved.length}</strong></div>
    <div class="export-stat bad"><span>仍缺文件</span><strong>${missing.length}</strong></div>
    <p class="export-note">路径以工程目录为基准写成 POSIX 相对路径，同时保留“新素材根目录相对路径”。${unresolved.length > 0 ? ` ${unresolved.length} 条未确认项会写入 unresolved.csv，不会进入 mappings。` : ""}</p>`;
    byId("exportResult").hidden = true;
    byId("exportResult").innerHTML = "";
    byId("confirmExportButton").disabled = false;
    byId("confirmExportButton").textContent = "生成映射文件";
}
function openExportModal() {
    if (!state.project) {
        toast("请先分析一个工程", true);
        return;
    }
    state.exportResult = null;
    renderExportSummary();
    byId("exportModal").hidden = false;
}
function closeExportModal() {
    byId("exportModal").hidden = true;
}
async function confirmExport() {
    if (!state.project || state.busy) return;
    const { mapped, unresolved, missing } = exportBuckets();
    const button = byId("confirmExportButton");
    button.disabled = true;
    button.textContent = "正在写入…";
    try {
        const mappings = mapped.map((match)=>{
            const candidate = selectedCandidate(match);
            const ranked = selectedRanked(match);
            if (!candidate) throw new Error(`${match.ref.filename} 缺少候选路径`);
            const signals = ranked ? Object.fromEntries(Object.entries(ranked.evidence).map(([key, value])=>[
                    key,
                    value && typeof value === "object" && "score" in value ? {
                        available: value.available,
                        score: value.score,
                        detail: value.detail
                    } : value
                ])) : {};
            return {
                assetId: match.ref.assetId,
                filename: match.ref.filename,
                sourcePath: match.ref.sourcePath,
                targetPath: candidate.path,
                confidence: ranked?.score ?? 0,
                decision: match.confirmed ? "confirmed" : "auto",
                confirmedByUser: match.confirmed,
                evidence: {
                    score: ranked?.score ?? 0,
                    signals,
                    reason: match.reason
                },
                timelineRefs: match.ref.timelineRefs.map((ref)=>ref.id)
            };
        });
        const result = await api("/api/export", {
            projectPath: state.projectPath,
            projectSha256: state.project.sha256 ?? "",
            mediaRoot: state.scannedNewRoot || state.newRoot,
            mappings,
            missing: missing.map((match)=>({
                    assetId: match.ref.assetId,
                    filename: match.ref.filename,
                    sourcePath: match.ref.sourcePath,
                    duration: match.ref.duration,
                    reason: match.reason
                })),
            unresolved: unresolved.map((match)=>({
                    assetId: match.ref.assetId,
                    filename: match.ref.filename,
                    sourcePath: match.ref.sourcePath,
                    reason: match.reason,
                    candidates: match.ranked.slice(0, 6).map((ranked)=>({
                            path: ranked.candidate.path,
                            relativePath: ranked.candidate.relPath,
                            score: ranked.score,
                            flags: ranked.flags
                        }))
                }))
        });
        state.exportResult = result;
        const resultBox = byId("exportResult");
        resultBox.hidden = false;
        resultBox.innerHTML = `
      <h4>${result.projectUnchanged ? "映射已保存 · 工程哈希未变化" : "映射已保存 · 但工程哈希已变化"}</h4>
      ${result.files.map((file)=>`
        <a href="${escapeHtml(file.url)}" download="${escapeHtml(file.name)}">
          ${escapeHtml(file.label)} <span>${escapeHtml(file.name)} ↓</span>
        </a>`).join("")}
      <code>${escapeHtml(result.directory)}</code>`;
        button.textContent = "已保存";
        toast(`已写入 ${result.counts.mapped} 条映射，${result.counts.missing} 条缺失`);
        if (!result.projectUnchanged) toast("检测到工程文件在分析后被修改；映射已生成，但请核对工程版本", true);
    } catch (error) {
        button.disabled = false;
        button.textContent = "重试保存";
        toast(error instanceof Error ? error.message : "导出失败", true);
    }
}
function fillPaths(projectPath, newRoot, oldRoot) {
    byId("projectPathInput").value = projectPath;
    byId("newRootInput").value = newRoot;
    byId("oldRootInput").value = oldRoot;
}
function currentInputs() {
    return {
        projectPath: byId("projectPathInput").value.trim(),
        newRoot: byId("newRootInput").value.trim(),
        oldRoot: byId("oldRootInput").value.trim()
    };
}
function wireEvents() {
    byId("runButton").addEventListener("click", ()=>{
        const inputs = currentInputs();
        if (!inputs.projectPath || !inputs.newRoot) {
            toast("请填写工程文件和新素材根目录", true);
            return;
        }
        void runAnalysis(inputs);
    });
    byId("demoButton").addEventListener("click", ()=>{
        if (!state.config?.demo.available) return;
        const demo = state.config.demo;
        fillPaths(demo.projectPath, demo.newRoot, demo.oldRoot);
        void runAnalysis({
            ...demo,
            demo: true
        });
    });
    byId("openSetupButton").addEventListener("click", ()=>{
        byId("setupCard").hidden = false;
        byId("setupCard").scrollIntoView({
            behavior: "smooth",
            block: "center"
        });
        window.setTimeout(()=>byId("projectPathInput").focus(), 300);
    });
    byId("rerunButton").addEventListener("click", ()=>{
        if (state.busy) return;
        void runAnalysis({
            projectPath: state.projectPath || byId("projectPathInput").value,
            newRoot: state.scannedNewRoot || byId("newRootInput").value,
            oldRoot: state.scannedOldRoot || byId("oldRootInput").value,
            demo: state.demo
        });
    });
    document.querySelectorAll(".filter-tab").forEach((button)=>{
        button.addEventListener("click", ()=>{
            state.filter = button.dataset.filter ?? "all";
            renderAll();
        });
    });
    byId("searchInput").addEventListener("input", (event)=>{
        state.query = event.target.value.trim();
        renderAll();
    });
    byId("matchList").addEventListener("click", (event)=>{
        const row = event.target.closest(".match-row");
        if (!row) return;
        state.selectedKey = row.dataset.key ?? null;
        renderAll();
        if (window.innerWidth < 980) byId("inspector").scrollIntoView({
            behavior: "smooth",
            block: "start"
        });
    });
    byId("matchList").addEventListener("keydown", (event)=>{
        if (event.key !== "Enter" && event.key !== " ") return;
        const row = event.target.closest(".match-row");
        if (!row) return;
        event.preventDefault();
        state.selectedKey = row.dataset.key ?? null;
        renderAll();
    });
    byId("exportButton").addEventListener("click", openExportModal);
    byId("confirmExportButton").addEventListener("click", ()=>void confirmExport());
    byId("closeExportButton").addEventListener("click", closeExportModal);
    byId("cancelExportButton").addEventListener("click", closeExportModal);
    byId("exportModal").addEventListener("click", (event)=>{
        if (event.target === byId("exportModal")) closeExportModal();
    });
    window.addEventListener("keydown", (event)=>{
        if (event.key === "Escape" && !byId("exportModal").hidden) closeExportModal();
    });
}
async function boot() {
    wireEvents();
    try {
        const config = await api("/api/config");
        state.config = config;
        if (config.demo.available) {
            fillPaths(config.demo.projectPath, config.demo.newRoot, config.demo.oldRoot);
        }
        const manual = new URLSearchParams(window.location.search).has("manual");
        if (config.demo.available && !manual) {
            await new Promise((resolvePromise)=>window.setTimeout(resolvePromise, 250));
            await runAnalysis({
                ...config.demo,
                demo: true
            });
        }
    } catch (error) {
        toast(error instanceof Error ? error.message : "无法连接本地服务", true);
    }
}
void boot();


//# sourceURL=app.ts
