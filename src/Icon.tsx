export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    dashboard: "M3 3h18v18H3V3Zm6 0v18m6-18v18M3 8h18",
    sidebar: "M3 4h18v16H3V4Zm12 0v16m-5-11 3 3-3 3",
    pen: "m15 3 6 6-12 12H3v-6L15 3Zm-10 13 3 3M13 5l6 6",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    "eye-off": "m3 3 18 18M10 5.2A12 12 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3 4M6 6a22 22 0 0 0-4 6s3.5 7 10 7a12 12 0 0 0 5-1M9 9a4.2 4.2 0 0 0 6 6",
    clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    locate: "M12 2v3m0 14v3M2 12h3m14 0h3M12 6a6 6 0 1 1 0 12a6 6 0 0 1 0-12Zm0 4a2 2 0 1 1 0 4a2 2 0 0 1 0-4",
    tag: "M3 3h8l10 10-8 8L3 11V3Zm4 4h.01",
    comment: "M4 4h16v12H9l-5 4V4Zm4 4h8m-8 4h5",
    palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4 2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3-4-6-9-6ZM7 8h.01M11 6h.01M16 8h.01M6 13h.01",
    page: "M5 3h10l4 4v14H5V3Zm4 7h6m-6 4h6m-6 4h4",
    image: "M3 4h18v16H3V4Zm3 12 4-4 3 3 3-5 5 6M8 9h.01",
    bookmark: "M6 3h12v18l-6-4-6 4V3Z",
    close: "m6 6 12 12M6 18 18 6",
    search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1.5 4.5L21 21",
    sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z",
    help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 16.5h.01",
    settings:
      "M9 2h6v3l2 1 2.6-1.5 3 5.2L20 11v2l2.6 1.5-3 5.2L17 18l-2 1v3H9v-3l-2-1-2.6 1.5-3-5.2L4 13v-2L1.4 9.5l3-5.2L7 6l2-1V2Z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    refresh:
      "M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3",
    link: "m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    folder: "M3 5h7l2 3h9v13H3V5",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    upload: "M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4",
    arrow: "m8 5 7 7-7 7",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.page} />
    </svg>
  );
}
