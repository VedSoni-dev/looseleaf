import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#2F7D4F" }}>
        <svg width="132" height="132" viewBox="8 6 48 52">
          <rect x="15" y="10" width="34" height="44" rx="4" fill="#FFFDF8" />
          <path d="M22 37c5-11 9-11 11-3s6 6 10-7" fill="none" stroke="#1F1F1F" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="20" cy="18" r="1.8" fill="#2F7D4F" />
          <circle cx="20" cy="46" r="1.8" fill="#2F7D4F" />
        </svg>
      </div>
    ),
    size,
  );
}
