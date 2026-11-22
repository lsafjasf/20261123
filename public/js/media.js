const analysisCache = new Map();
function withTimeout(promise, milliseconds, message) {
    return new Promise((resolvePromise, reject)=>{
        const timer = setTimeout(()=>reject(new Error(message)), milliseconds);
        promise.then((value)=>{
            clearTimeout(timer);
            resolvePromise(value);
        }, (error)=>{
            clearTimeout(timer);
            reject(error);
        });
    });
}
function waitForEvent(target, event, timeout = 20_000) {
    return withTimeout(new Promise((resolvePromise)=>target.addEventListener(event, ()=>resolvePromise(), {
            once: true
        })), timeout, `等待 ${event} 超时`);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
async function loadVideo(url) {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await waitForEvent(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) && video.duration <= 0) throw new Error("无法读取媒体时长");
    return video;
}
async function seekFrame(video, time) {
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return;
    const seeked = waitForEvent(video, "seeked", 12_000);
    video.currentTime = clamp(time, 0, Math.max(0, video.duration - 0.05));
    await seeked;
    if ("requestVideoFrameCallback" in video) {
        await withTimeout(new Promise((resolvePromise)=>{
            video.requestVideoFrameCallback(()=>resolvePromise());
        }), 3_000, "等待视频帧超时").catch(()=>undefined);
    }
}
function drawVideoFrame(video, context, width, height) {
    try {
        if ("VideoFrame" in window) {
            const frame = new VideoFrame(video, {
                timestamp: Math.round(video.currentTime * 1_000_000)
            });
            context.drawImage(frame, 0, 0, width, height);
            frame.close();
            return true;
        }
    } catch  {}
    try {
        context.drawImage(video, 0, 0, width, height);
        return true;
    } catch  {
        return false;
    }
}
function dHash(context) {
    const pixels = context.getImageData(0, 0, 17, 16).data;
    let hash = 0n;
    let bit = 0n;
    for(let y = 0; y < 16; y += 1){
        for(let x = 0; x < 16; x += 1){
            const leftIndex = (y * 17 + x) * 4;
            const rightIndex = (y * 17 + x + 1) * 4;
            const left = pixels[leftIndex] * 0.299 + pixels[leftIndex + 1] * 0.587 + pixels[leftIndex + 2] * 0.114;
            const right = pixels[rightIndex] * 0.299 + pixels[rightIndex + 1] * 0.587 + pixels[rightIndex + 2] * 0.114;
            if (left > right) hash |= 1n << bit;
            bit += 1n;
        }
    }
    return hash.toString(16).padStart(64, "0");
}
async function visualEvidence(video, needThumbnail) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const times = duration > 1 ? [
        clamp(duration * 0.22, 0.1, duration - 0.1),
        clamp(duration * 0.68, 0.2, duration - 0.1)
    ] : [
        0
    ];
    const hashCanvas = document.createElement("canvas");
    hashCanvas.width = 17;
    hashCanvas.height = 16;
    const hashContext = hashCanvas.getContext("2d", {
        willReadFrequently: true
    });
    if (!hashContext) throw new Error("Canvas 2D 不可用");
    let used = false;
    const hashes = [];
    let thumbnail;
    for(let index = 0; index < times.length; index += 1){
        await seekFrame(video, times[index]);
        used = drawVideoFrame(video, hashContext, 17, 16) || used;
        hashes.push(dHash(hashContext));
        if (index === 0 && needThumbnail) {
            const thumb = document.createElement("canvas");
            thumb.width = 480;
            thumb.height = 270;
            const thumbContext = thumb.getContext("2d");
            if (thumbContext) {
                drawVideoFrame(video, thumbContext, 480, 270);
                thumbnail = thumb.toDataURL("image/jpeg", 0.72);
            }
        }
    }
    return {
        visualHash: hashes.join(""),
        thumbnail,
        webCodecsUsed: used
    };
}
function fft(real, imag) {
    const size = real.length;
    for(let index = 1, reversed = 0; index < size; index += 1){
        let bit = size >> 1;
        for(; reversed & bit; bit >>= 1)reversed ^= bit;
        reversed ^= bit;
        if (index < reversed) {
            [real[index], real[reversed]] = [
                real[reversed],
                real[index]
            ];
            [imag[index], imag[reversed]] = [
                imag[reversed],
                imag[index]
            ];
        }
    }
    for(let length = 2; length <= size; length <<= 1){
        const angle = -2 * Math.PI / length;
        const stepReal = Math.cos(angle);
        const stepImag = Math.sin(angle);
        for(let start = 0; start < size; start += length){
            let currentReal = 1;
            let currentImag = 0;
            for(let offset = 0; offset < length / 2; offset += 1){
                const left = start + offset;
                const right = left + length / 2;
                const oddReal = real[right] * currentReal - imag[right] * currentImag;
                const oddImag = real[right] * currentImag + imag[right] * currentReal;
                real[right] = real[left] - oddReal;
                imag[right] = imag[left] - oddImag;
                real[left] += oddReal;
                imag[left] += oddImag;
                const nextReal = currentReal * stepReal - currentImag * stepImag;
                currentImag = currentReal * stepImag + currentImag * stepReal;
                currentReal = nextReal;
            }
        }
    }
}
export function fingerprintAudioBuffer(buffer) {
    const frames = 16;
    const bands = 8;
    const frameSize = 1024;
    const sampleRate = Math.round(buffer.sampleRate);
    const duration = buffer.duration;
    const start = Math.min(0.25, duration * 0.02);
    const available = Math.max(0, duration - start);
    const span = Math.min(6, available);
    const channels = Math.min(2, buffer.numberOfChannels);
    const values = [];
    for(let frame = 0; frame < frames; frame += 1){
        const offsetSeconds = start + (frames === 1 ? 0 : span * frame / (frames - 1));
        const offset = Math.min(Math.max(0, Math.round(offsetSeconds * sampleRate)), Math.max(0, buffer.length - frameSize));
        const real = new Float32Array(frameSize);
        const imag = new Float32Array(frameSize);
        for(let sample = 0; sample < frameSize; sample += 1){
            let mixed = 0;
            for(let channel = 0; channel < channels; channel += 1){
                mixed += buffer.getChannelData(channel)[offset + sample] ?? 0;
            }
            const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * sample / (frameSize - 1));
            real[sample] = mixed / Math.max(1, channels) * hann;
        }
        fft(real, imag);
        const lowerHz = 80;
        const upperHz = Math.min(8000, sampleRate * 0.45);
        for(let band = 0; band < bands; band += 1){
            const low = lowerHz * Math.pow(upperHz / lowerHz, band / bands);
            const high = lowerHz * Math.pow(upperHz / lowerHz, (band + 1) / bands);
            const firstBin = Math.max(1, Math.floor(low * frameSize / sampleRate));
            const lastBin = Math.max(firstBin, Math.min(frameSize / 2 - 1, Math.ceil(high * frameSize / sampleRate)));
            let power = 0;
            for(let bin = firstBin; bin <= lastBin; bin += 1){
                power += real[bin] * real[bin] + imag[bin] * imag[bin];
            }
            values.push(Math.log10(1 + power / Math.max(1, lastBin - firstBin + 1)));
        }
    }
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum;
    const bytes = new Uint8Array(Math.ceil(values.length / 2));
    values.forEach((value, index)=>{
        const quantized = range < 1e-9 ? 0 : Math.round((value - minimum) / range * 15);
        bytes[index >> 1] |= (quantized & 0x0f) << (index % 2 === 0 ? 4 : 0);
    });
    let binary = "";
    for (const byte of bytes)binary += String.fromCharCode(byte);
    return {
        v: 1,
        sr: sampleRate,
        bands,
        frames,
        data: btoa(binary)
    };
}
async function audioEvidence(url, size) {
    if (size > 96 * 1024 * 1024) return undefined;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取音频失败 (${response.status})`);
    const data = await response.arrayBuffer();
    const context = new OfflineAudioContext(1, 48_000, 48_000);
    const audio = await context.decodeAudioData(data.slice(0));
    return fingerprintAudioBuffer(audio);
}
async function analyzeUncached(url, size, options) {
    const errors = [];
    let video = null;
    const result = {
        duration: null,
        width: null,
        height: null,
        errors,
        webCodecsUsed: false
    };
    try {
        video = await loadVideo(url);
        result.duration = Number(video.duration.toFixed(3));
        result.width = video.videoWidth || null;
        result.height = video.videoHeight || null;
        if (options.needVisual || options.needThumbnail) {
            try {
                const visual = await visualEvidence(video, options.needThumbnail);
                result.visualHash = visual.visualHash;
                result.thumbnail = visual.thumbnail;
                result.webCodecsUsed = visual.webCodecsUsed;
            } catch (error) {
                errors.push(`画面指纹: ${error instanceof Error ? error.message : "失败"}`);
            }
        }
    } catch (error) {
        errors.push(`媒体元数据: ${error instanceof Error ? error.message : "失败"}`);
    } finally{
        if (video) {
            video.removeAttribute("src");
            video.load();
        }
    }
    if (options.needAudio) {
        try {
            result.audioFingerprint = await audioEvidence(url, size);
            if (!result.audioFingerprint) errors.push("音频指纹: 文件较大，已跳过全量解码");
        } catch (error) {
            errors.push(`音频指纹: ${error instanceof Error ? error.message : "解码失败"}`);
        }
    }
    return result;
}
export function analyzeMedia(url, size, options) {
    const key = `${url}|${options.needVisual}|${options.needAudio}|${options.needThumbnail}`;
    const cached = analysisCache.get(key);
    if (cached) return cached;
    const promise = analyzeUncached(url, size, options);
    analysisCache.set(key, promise);
    return promise;
}
export function mergeAnalysis(candidate, analysis) {
    return {
        ...candidate,
        duration: candidate.duration ?? analysis.duration,
        width: candidate.width ?? analysis.width,
        height: candidate.height ?? analysis.height,
        visualHash: analysis.visualHash,
        thumbnail: analysis.thumbnail,
        audioFingerprint: analysis.audioFingerprint,
        analysisError: analysis.errors.length > 0 ? analysis.errors.join("；") : undefined
    };
}
export function mediaTechnicalFromAnalysis(analysis) {
    return {
        duration: analysis.duration,
        width: analysis.width,
        height: analysis.height
    };
}
function previewMimeCandidates(url) {
    const parsed = new URL(url, window.location.href);
    const path = (parsed.searchParams.get("path") ?? parsed.pathname).toLowerCase();
    if (path.endsWith(".webm")) {
        return [
            'video/webm; codecs="vp9,opus"',
            'video/webm; codecs="vp8,opus"',
            "video/webm"
        ];
    }
    if (path.endsWith(".m4a")) return [
        'audio/mp4; codecs="mp4a.40.2"',
        "audio/mp4"
    ];
    if (path.endsWith(".mp4") || path.endsWith(".mov") || path.endsWith(".m4v")) {
        return [
            'video/mp4; codecs="avc1.42E01F,mp4a.40.2"',
            'video/mp4; codecs="avc1.4D401F,mp4a.40.2"',
            'video/mp4; codecs="avc1.64001F,mp4a.40.2"',
            'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
            'video/mp4; codecs="avc1.42E01E"',
            'video/mp4; codecs="avc1.64001F"',
            "video/mp4"
        ];
    }
    return [];
}
function waitForBufferUpdate(buffer) {
    return new Promise((resolvePromise, reject)=>{
        const cleanup = ()=>{
            buffer.removeEventListener("updateend", onEnd);
            buffer.removeEventListener("error", onError);
        };
        const onEnd = ()=>{
            cleanup();
            resolvePromise();
        };
        const onError = ()=>{
            cleanup();
            reject(new Error("MediaSource 缓冲失败"));
        };
        buffer.addEventListener("updateend", onEnd, {
            once: true
        });
        buffer.addEventListener("error", onError, {
            once: true
        });
    });
}
async function tryMediaSource(video, url, mime) {
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    let attached = false;
    try {
        video.src = objectUrl;
        if (mediaSource.readyState !== "open") {
            await withTimeout(new Promise((resolvePromise)=>mediaSource.addEventListener("sourceopen", ()=>resolvePromise(), {
                    once: true
                })), 8_000, "MediaSource 初始化超时");
        }
        const sourceBuffer = mediaSource.addSourceBuffer(mime);
        const response = await fetch(url);
        if (!response.ok) throw new Error("无法读取预览流");
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > 64 * 1024 * 1024) throw new Error("预览文件过大");
        const payload = await response.arrayBuffer();
        sourceBuffer.appendBuffer(payload);
        await waitForBufferUpdate(sourceBuffer);
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
        attached = true;
        video.addEventListener("emptied", ()=>URL.revokeObjectURL(objectUrl), {
            once: true
        });
        try {
            await video.play();
        } catch (error) {
            if (!(error instanceof DOMException) || error.name !== "NotAllowedError") throw error;
        }
        return true;
    } catch  {
        video.removeAttribute("src");
        video.load();
        return false;
    } finally{
        if (!attached) window.setTimeout(()=>URL.revokeObjectURL(objectUrl), 1_000);
    }
}
export async function playWithMediaSource(video, url) {
    if (!("MediaSource" in window)) return false;
    const candidates = previewMimeCandidates(url).filter((candidate)=>MediaSource.isTypeSupported(candidate));
    for (const mime of candidates){
        if (await tryMediaSource(video, url, mime)) return true;
    }
    return false;
}


//# sourceURL=media.ts
