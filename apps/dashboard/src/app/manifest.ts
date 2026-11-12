import type { MetadataRoute } from "next";

/** Lets the mail agent be installed as an app on Android and desktop (and receive notifications there). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mail Agent",
    short_name: "Mail Agent",
    description: "An AI assistant for your Gmail: summaries, drafts you approve, and new-mail notifications.",
    start_url: "/agent",
    scope: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#18181b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
