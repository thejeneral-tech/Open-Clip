"use client";

import type { Token } from "./types";

const ACCESS_KEY = "openclip-access-token";
const REFRESH_KEY = "openclip-refresh-token";
const EMAIL_KEY = "openclip-user-email";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function setTokens(t: Token) {
  window.localStorage.setItem(ACCESS_KEY, t.access_token);
  if (t.refresh_token) window.localStorage.setItem(REFRESH_KEY, t.refresh_token);
}

export function clearTokens() {
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(EMAIL_KEY);
}

/** Remembered login email — used as a sidebar fallback when /auth/me is
 *  unavailable (the seeded `.local` admin makes that endpoint 500). */
export function setUserEmail(email: string) {
  window.localStorage.setItem(EMAIL_KEY, email);
}
export function getUserEmail(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(EMAIL_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}
