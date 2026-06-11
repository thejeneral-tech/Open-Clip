import { redirect } from "next/navigation";

export default function FootageRedirect() {
  // Footage now lives as a tab inside the unified Library page.
  redirect("/storyvault/library");
}
