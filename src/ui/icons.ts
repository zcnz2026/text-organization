const wrap = (inner: string) =>
  `<svg class="svg-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  shieldCheck: wrap(
    `<path d="M10 2.5 16 4.8v4.7c0 4.1-2.6 6.9-6 8-3.4-1.1-6-3.9-6-8V4.8L10 2.5Z"/><path d="m7.5 10.2 1.8 1.8 3.5-3.6"/>`,
  ),
  key: wrap(
    `<circle cx="7.5" cy="11.5" r="3.5"/><path d="m10.2 9 6.3-5.5M14 5.7l2 1.8M12 7.5l1.8 1.6"/>`,
  ),
  quotes: wrap(
    `<path d="M4.5 7.5h3.5v3.5c0 2-1.2 3.2-3 3.8M12 7.5h3.5v3.5c0 2-1.2 3.2-3 3.8"/>`,
  ),
  tableGrid: wrap(
    `<rect x="3" y="3.5" width="14" height="13" rx="1.8"/><path d="M3 8h14M8.2 8v8.5M12.8 8v8.5"/>`,
  ),
  columns: wrap(
    `<rect x="3" y="3.5" width="14" height="13" rx="1.8"/><path d="M7.6 3.5v13M12.4 3.5v13"/>`,
  ),
  cloudSync: wrap(
    `<path d="M6.2 15.5h8.1a3.2 3.2 0 0 0 .4-6.4A4.6 4.6 0 0 0 5.8 7.8a3.8 3.8 0 0 0 .4 7.7Z"/><path d="m8.2 11.8 1.8-1.8 1.8 1.8M10 10v4"/>`,
  ),
  upload: wrap(
    `<path d="M10 13.5V4.5M6.8 7.5 10 4.3l3.2 3.2"/><path d="M4 13.8v1.7a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1.7"/>`,
  ),
  download: wrap(
    `<path d="M10 4.5v9M6.8 10.5 10 13.7l3.2-3.2"/><path d="M4 13.8v1.7a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1.7"/>`,
  ),
  play: wrap(`<polygon points="6.5,4.5 15.5,10 6.5,15.5" fill="currentColor" stroke="none"/>`),
  close: wrap(`<path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5"/>`),
  search: wrap(`<circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/>`),
  sparkle: wrap(
    `<path d="m10 3 1.4 4.1L15.5 8.5l-4.1 1.4L10 14l-1.4-4.1L4.5 8.5l4.1-1.4L10 3Z"/>`,
  ),
  settings: wrap(
    `<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v1.9M10 15.3v1.9M3.8 6.4l1.6 1M14.6 12.6l1.6 1M3.8 13.6l1.6-1M14.6 7.4l1.6-1"/>`,
  ),
  subtitles: wrap(
    `<rect x="2.5" y="4" width="15" height="12" rx="1.8"/><path d="M5.5 10.5h4.2M11.5 10.5h3M5.5 13.2h6.5M13.5 13.2h1"/>`,
  ),
  chevronRight: wrap(`<path d="m7.5 5.5 4.5 4.5-4.5 4.5"/>`),
};
