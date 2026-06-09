/* Minimal API client. Every method returns a Promise of parsed JSON, throwing on
   non-2xx with the server's error message. */
(function () {
  async function request(method, path, body, isForm) {
    const opts = { method, headers: {} };
    if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    else if (isForm) { opts.body = body; }
    const res = await fetch('/api' + path, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }
  const API = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    upload: (p, formData) => request('POST', p, formData, true),
    uploadProgress: (p, formData, onProgress) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api' + p);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data; try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseText; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || ('Upload failed: ' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(formData);
    }),
  };
  window.API = API;
})();
