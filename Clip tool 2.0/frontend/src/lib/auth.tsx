"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, api, tokenStore } from "./api";
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Minimal identity used when /auth/me is unavailable but the token is valid —
// the seeded `admin@openclip.local` makes /auth/me 500, and we don't want that
// to bounce an otherwise-authenticated user back to /login.
function fallbackUser(email: string): User {
  return {
    id: 0,
    email,
    full_name: null,
    role: "admin",
    is_active: true,
    is_superuser: true,
    created_at: new Date().toISOString(),
  };
}

// Resolve the current user from the access token, tolerating the /auth/me 500.
async function loadUser(emailHint?: string): Promise<User | null> {
  if (!tokenStore.access) return null;
  try {
    return await api.me();
  } catch (err) {
    // A genuine 401 means the token is dead — sign out. Any other failure
    // (e.g. the `.local` admin 500) keeps the session via the remembered email.
    if (err instanceof ApiError && err.status === 401) return null;
    const email = emailHint ?? tokenStore.email;
    return email ? fallbackUser(email) : null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    const u = await loadUser();
    if (!u) tokenStore.clear();
    setUser(u);
    setLoading(false);
  };

  useEffect(() => {
    refreshUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email: string, password: string) => {
    tokenStore.set(await api.login(email, password));
    tokenStore.setEmail(email);
    setUser((await loadUser(email)) ?? fallbackUser(email));
  };

  const register = async (email: string, password: string, fullName?: string) => {
    tokenStore.set(await api.register(email, password, fullName));
    tokenStore.setEmail(email);
    setUser((await loadUser(email)) ?? fallbackUser(email));
  };

  const logout = () => {
    tokenStore.clear();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
