import type { MetadataRoute } from "next";

/**
 * Lets a phone add Housepot to its home screen with its own icon, opening full screen like an app.
 * iPhone: Share, then "Add to Home Screen". Android: the browser menu, then "Install app".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Housepot",
    short_name: "Housepot",
    description: "Chores, shared bills and settling up for your house.",
    // "/" sends a signed-in housemate straight to their house.
    start_url: "/",
    display: "standalone",
    background_color: "#151411",
    theme_color: "#151411",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Drawn with extra room around the mark, for phones that crop icons to a circle.
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
