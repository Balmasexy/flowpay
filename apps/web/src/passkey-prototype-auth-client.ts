import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

const apiBase = String(
  import.meta.env.VITE_PASSKEY_PROTOTYPE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:3000"
).trim().replace(/\/+$/, "");

export const passkeyPrototypeApiBase = apiBase;
export const passkeyPrototypeAuthClient = createAuthClient({
  baseURL: apiBase + "/prototype-auth",
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient()]
});
