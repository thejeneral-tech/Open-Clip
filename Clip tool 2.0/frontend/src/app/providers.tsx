"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";
import { BackgroundEffects } from "@/components/theme/BackgroundEffects";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <BackgroundEffects />
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--panel)",
              color: "var(--fg)",
              border: "1px solid var(--border)",
              fontFamily: "var(--font-family)",
            },
          }}
        />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
