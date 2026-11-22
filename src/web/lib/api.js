// 后端 JSON API 薄封装。
async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export const api = {
  health: () => request('/api/health'),
  config: () => request('/api/config'),
  listScans: () => request('/api/scans'),
  getScan: (sha) => request(`/api/scans/${sha}`),
  uploadBatch: (batch) =>
    request('/api/batches', { method: 'POST', body: JSON.stringify(batch) }),
  complete: (sha, totalFrames) =>
    request(`/api/scans/${sha}/complete`, {
      method: 'POST',
      body: JSON.stringify({ totalFrames }),
    }),
  analyze: (sha) => request(`/api/scans/${sha}/analyze`, { method: 'POST' }),
  result: (sha) => request(`/api/results/${sha}`),
  results: () => request('/api/results'),
};
