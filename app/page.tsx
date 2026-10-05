"use client";

import dynamic from "next/dynamic";

// Camera, WebGL and MediaPipe are browser-only.
const Surface = dynamic(() => import("@/components/Surface"), { ssr: false });

export default function Page() {
  return <Surface />;
}
