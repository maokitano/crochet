/* GitHub のリポジトリ（crochet-data）を保存先にする小さなデータストア。
   - data/projects.json, data/yarns.json, data/settings.json … ドキュメントをまとめた1ファイル
   - notes/<作品ID>/<ページID>.json … 手書きノート1ページ = 1ファイル
   - images/<ID>.jpg … 毛糸の写真
   書き込みは端末に一度ためてから少し待ってまとめて送る。送れなかった分は端末に残し、あとで送り直す。 */
(function () {
  "use strict";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const bytesToB64 = (bytes) => { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
  const strToB64 = (s) => bytesToB64(enc.encode(s));
  const b64ToStr = (b64) => { const bin = atob(String(b64).replace(/\s/g, "")); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return dec.decode(u); };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function httpError(r, text) {
    const e = new Error("GitHub " + r.status + " " + (text || ""));
    e.status = r.status;
    e.code = r.status === 401 ? "bad_token" : r.status === 403 ? (/rate limit/i.test(text || "") ? "rate_limited" : "forbidden") : r.status === 404 ? "not_found" : (r.status === 409 ? "conflict" : "http");
    if (r.status === 422 && /sha/i.test(text || "")) e.code = "conflict";
    return e;
  }

  function GitHub(cfg) {
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
    const url = (path) => repoUrl + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    let useEtag = true;
    async function req(method, path, { body, accept, etag } = {}) {
      const headers = { Authorization: "Bearer " + cfg.token, Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (body) headers["Content-Type"] = "application/json";
      if (etag && useEtag) headers["If-None-Match"] = etag;
      const u = path === null ? repoUrl : url(path) + (method === "GET" ? "?ref=" + encodeURIComponent(cfg.branch) : "");
      try {
        return await fetch(u, { method, headers, cache: "no-store", body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (etag && useEtag) { useEtag = false; return req(method, path, { body, accept }); }
        const ne = new Error("network"); ne.code = "network"; throw ne;
      }
    }
    return {
      async checkRepo() {
        const r = await req("GET", null);
        if (!r.ok) throw httpError(r, await r.text());
        const j = await r.json();
        if (j.permissions && !j.permissions.push) { const e = new Error("read only"); e.code = "read_only"; throw e; }
        return j;
      },
      async getJSON(path, etag) {
        const r = await req("GET", path, { etag });
        if (r.status === 304) return { notModified: true };
        if (r.status === 404) return { data: null, sha: null, etag: null };
        if (!r.ok) throw httpError(r, await r.text());
        const j = await r.json();
        let text;
        if (j.encoding === "base64" && j.content) text = b64ToStr(j.content);
        else { const r2 = await req("GET", path, { accept: "application/vnd.github.raw+json" }); if (!r2.ok) throw httpError(r2, await r2.text()); text = await r2.text(); }
        return { data: text ? JSON.parse(text) : null, sha: j.sha, etag: r.headers.get("ETag") };
      },
      async list(dir) {
        const r = await req("GET", dir);
        if (r.status === 404) return [];
        if (!r.ok) throw httpError(r, await r.text());
        const j = await r.json();
        return Array.isArray(j) ? j : [];
      },
      async put(path, b64, sha, message) {
        const body = { message, content: b64, branch: cfg.branch };
        if (sha) body.sha = sha;
        const r = await req("PUT", path, { body });
        if (!r.ok) throw httpError(r, await r.text());
        const j = await r.json();
        return j.content.sha;
      },
      async sha(path) {
        const r = await req("GET", path);
        if (r.status === 404) return null;
        if (!r.ok) throw httpError(r, await r.text());
        return (await r.json()).sha;
      },
      async del(path, sha, message) {
        const r = await req("DELETE", path, { body: { message, sha, branch: cfg.branch } });
        if (r.status === 404) return;
        if (!r.ok) throw httpError(r, await r.text());
      },
      async raw(path) {
        const r = await req("GET", path, { accept: "application/vnd.github.raw+json" });
        if (!r.ok) throw httpError(r, await r.text());
        return r.blob();
      },
    };
  }

  /* 1ファイルにドキュメントをまとめて持つコレクション */
  class FileStore {
    constructor(gh, path, ns, status) {
      this.gh = gh; this.path = path; this.status = status;
      this.key = ns + ":" + path;
      const c = lsGet(this.key) || {};
      this.remote = c.remote || {}; this.sha = c.sha || null; this.etag = null;
      this.ops = (c.ops || []).map((o) => ({ op: o }));
      this.loaded = false; this.subs = new Set(); this.errSubs = new Set();
      this.timer = null; this.flushing = false; this.again = false;
    }
    save() { lsSet(this.key, { remote: this.remote, sha: this.sha, ops: this.ops.map((o) => o.op) }); }
    view() {
      const d = clone(this.remote);
      for (const { op } of this.ops) {
        if (op.t === "s") d[op.id] = clone(op.data);
        else if (op.t === "u") d[op.id] = Object.assign({}, d[op.id] || {}, clone(op.data));
        else if (op.t === "d") delete d[op.id];
      }
      return d;
    }
    emit() { const v = this.view(), meta = { fromCache: !this.loaded, hasPendingWrites: this.ops.length > 0 }; this.subs.forEach((f) => f(v, meta)); }
    fail(e) { this.errSubs.forEach((f) => f(e)); }
    async refresh() {
      if (this.flushing) return;
      try {
        const r = await this.gh.getJSON(this.path, this.loaded ? this.etag : null);
        if (r.notModified) return;
        this.remote = r.data || {}; this.sha = r.sha; this.etag = r.etag; this.loaded = true; this.save(); this.emit();
        if (this.ops.length) this.schedule(0);
      } catch (e) { this.fail(e); }
    }
    subscribe(next, err) { this.subs.add(next); if (err) this.errSubs.add(err); if (this.sha || this.ops.length || Object.keys(this.remote).length) next(this.view(), { fromCache: true, hasPendingWrites: this.ops.length > 0 }); return () => { this.subs.delete(next); if (err) this.errSubs.delete(err); }; }
    queue(op) {
      if (op.t === "u" && !(op.id in this.view())) return Promise.reject(Object.assign(new Error("missing"), { code: "invalid_argument" }));
      return new Promise((resolve, reject) => {
        this.ops.push({ op, resolve, reject }); this.save(); this.emit(); this.schedule(900);
      });
    }
    schedule(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), ms); }
    async flush() {
      if (this.flushing) { this.again = true; return; }
      if (!this.ops.length) return;
      this.flushing = true; this.status("saving");
      let ok = false, lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const n = this.ops.length, next = this.view();
        try {
          this.sha = await this.gh.put(this.path, strToB64(JSON.stringify(next, null, 1) + "\n"), this.sha, "更新: " + this.path);
          this.remote = next; this.etag = null;
          const done = this.ops.splice(0, n); this.save();
          done.forEach((o) => o.resolve && o.resolve());
          ok = true; break;
        } catch (e) {
          lastErr = e;
          if (e.code === "conflict") {
            try { const r = await this.gh.getJSON(this.path); this.remote = r.data || {}; this.sha = r.sha; this.etag = r.etag; continue; } catch (e2) { lastErr = e2; }
          }
          break;
        }
      }
      this.flushing = false;
      if (!ok) {
        this.ops.forEach((o) => { if (o.reject) { o.reject(lastErr); o.reject = o.resolve = null; } });
        this.status("error", lastErr); this.fail(lastErr);
        this.schedule(20000);
      } else this.status("saved");
      this.emit();
      if (this.again || this.ops.length) { this.again = false; if (this.ops.length) this.schedule(300); }
    }
  }

  /* 1ドキュメント = 1ファイルのコレクション（手書きノート用） */
  class DirStore {
    constructor(gh, dir, ns, status) { this.gh = gh; this.dir = dir; this.status = status; this.shas = {}; this.docs = {}; this.subs = new Set(); this.loaded = false; this.key = ns + ":" + dir; }
    emit() { const meta = { fromCache: !this.loaded, hasPendingWrites: false }; this.subs.forEach((f) => f(clone(this.docs), meta)); }
    async refresh(errCb) {
      try {
        const entries = (await this.gh.list(this.dir)).filter((e) => e.type === "file" && /\.json$/.test(e.name));
        const changed = entries.filter((e) => this.shas[e.name.slice(0, -5)] !== e.sha);
        await Promise.all(changed.map(async (e) => { const id = e.name.slice(0, -5); const r = await this.gh.getJSON(this.dir + "/" + e.name); this.docs[id] = r.data || {}; this.shas[id] = r.sha; }));
        const ids = new Set(entries.map((e) => e.name.slice(0, -5)));
        Object.keys(this.docs).forEach((id) => { if (!ids.has(id)) { delete this.docs[id]; delete this.shas[id]; } });
        this.loaded = true; this.emit();
      } catch (e) { errCb && errCb(e); }
    }
    subscribe(next, err) { this.subs.add(next); this.refresh(err); return () => this.subs.delete(next); }
    async set(id, data) {
      const path = this.dir + "/" + id + ".json", b64 = strToB64(JSON.stringify(data) + "\n");
      this.status("saving");
      try {
        try { this.shas[id] = await this.gh.put(path, b64, this.shas[id], "手書きノート: " + path); }
        catch (e) { if (e.code !== "conflict") throw e; this.shas[id] = await this.gh.put(path, b64, await this.gh.sha(path), "手書きノート: " + path); }
        this.docs[id] = clone(data); this.status("saved");
      } catch (e) { this.status("error", e); throw e; }
    }
  }

  function createDB(cfg, onStatus) {
    const gh = GitHub(cfg), ns = "crochet-gh:" + cfg.owner + "/" + cfg.repo;
    const status = onStatus || (() => {});
    const files = {
      projects: new FileStore(gh, "data/projects.json", ns, status),
      yarns: new FileStore(gh, "data/yarns.json", ns, status),
      settings: new FileStore(gh, "data/settings.json", ns, status),
    };
    const dirs = {};
    const snapDocs = (v, meta) => Object.keys(v).sort().map((id) => ({ id, exists: true, data: () => v[id], metadata: meta }));
    function collection(path) {
      const m = /^projects\/([^/]+)\/pages$/.exec(path);
      if (m) {
        const ds = dirs[path] || (dirs[path] = new DirStore(gh, "notes/" + m[1], ns, status));
        return {
          path,
          doc: (id) => ({ id, path: path + "/" + id, set: (data) => ds.set(id, data) }),
          onSnapshot(next, err) {
            return ds.subscribe((v, meta) => { const docs = snapDocs(v, meta); next({ docs, size: docs.length, empty: !docs.length, metadata: meta }); }, err);
          },
        };
      }
      const fs = files[path];
      if (!fs) throw new TypeError("unknown collection " + path);
      return {
        path,
        doc: (id) => ({
          id, path: path + "/" + id,
          set: (data) => fs.queue({ t: "s", id, data }),
          update: (data) => fs.queue({ t: "u", id, data }),
          delete: () => fs.queue({ t: "d", id }),
          onSnapshot(next, err) {
            const un = fs.subscribe((v, meta) => next({ id, exists: id in v, data: () => v[id], metadata: meta }), err);
            if (!fs.loaded) fs.refresh();
            return un;
          },
        }),
        onSnapshot(next, err) {
          const un = fs.subscribe((v, meta) => { const docs = snapDocs(v, meta); next({ docs, size: docs.length, empty: !docs.length, metadata: meta }); }, err);
          if (!fs.loaded) fs.refresh();
          return un;
        },
      };
    }
    const doc = (p) => { const i = p.lastIndexOf("/"); return collection(p.slice(0, i)).doc(p.slice(i + 1)); };

    const urls = new Map();
    const images = {
      async upload(blob) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
        status("saving");
        await gh.put("images/" + id + ".jpg", b64, null, "写真を追加: " + id);
        status("saved");
        urls.set(id, URL.createObjectURL(blob));
        return { id };
      },
      async url(id) {
        if (urls.has(id)) return urls.get(id);
        const b = await gh.raw("images/" + id + ".jpg");
        const u = URL.createObjectURL(b); urls.set(id, u); return u;
      },
      async delete(id) { const p = "images/" + id + ".jpg"; const sha = await gh.sha(p); if (sha) await gh.del(p, sha, "写真を削除: " + id); },
    };

    function refreshAll() { Object.values(files).forEach((f) => f.refresh()); Object.values(dirs).forEach((d) => d.subs.size && d.refresh()); }
    function pending() { return Object.values(files).reduce((n, f) => n + f.ops.length, 0); }
    function flushAll() { Object.values(files).forEach((f) => f.ops.length && f.flush()); }
    return { doc, collection, images, refreshAll, pending, flushAll, check: () => gh.checkRepo() };
  }

  window.CrochetGH = { createDB };
})();
