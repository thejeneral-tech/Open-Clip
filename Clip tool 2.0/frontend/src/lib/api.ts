"use client";

import { clearTokens, getRefreshToken, getToken, setTokens, setUserEmail } from "./auth";
import type { Project, Token, User, Video } from "./types";

/**
 * API base. In dev, Next rewrites proxy `/api/*` to the FastAPI backend
 * (see next.config.js), so relative URLs work from the browser.
 */
const PREFIX = "/api/v1";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function refreshAccessToken(): Promise<boolean> {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  try {
    const res = await fetch(`${PREFIX}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return false;
    const t = (await res.json()) as Token;
    setTokens(t);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(
  path: string,
  opts: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = getToken();
  const headers = new Headers(opts.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (opts.body && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${PREFIX}${path}`, { ...opts, headers });

  if (res.status === 401 && retry) {
    if (await refreshAccessToken()) return request<T>(path, opts, false);
    clearTokens();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : "Request failed");
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // ── auth ──
  async login(email: string, password: string): Promise<Token> {
    // Use the OAuth2 form endpoint rather than /auth/login: the JSON endpoint
    // validates `email` as a strict EmailStr, which rejects reserved TLDs like
    // the seeded `admin@openclip.local`. The form endpoint takes a plain
    // `username` string, so any login email works.
    const form = new URLSearchParams({ username: email, password });
    const res = await fetch(`${PREFIX}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      let detail = "Login failed";
      try {
        detail = (await res.json()).detail ?? detail;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, detail);
    }
    const t = (await res.json()) as Token;
    setTokens(t);
    setUserEmail(email);
    return t;
  },
  me: () => request<User>("/auth/me"),

  // ── projects ──
  listProjects: () => request<Project[]>("/projects"),
  createProject: (name: string, description?: string) =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, description: description ?? null }),
    }),
  getProject: (id: number) => request<Project>(`/projects/${id}`),

  // ── videos ──
  listVideos: (projectId: number) =>
    request<Video[]>(`/projects/${projectId}/videos`),
  importYouTube: (projectId: number, url: string, title?: string) =>
    request<Video>(`/projects/${projectId}/videos/youtube`, {
      method: "POST",
      body: JSON.stringify({ url, title: title ?? null }),
    }),
  deleteVideo: (id: number) =>
    request<{ detail: string }>(`/videos/${id}`, { method: "DELETE" }),
};
