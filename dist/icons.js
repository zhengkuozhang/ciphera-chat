const paths = {
  'message-circle':'<path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9 9 0 0 1-4-.9L3 21l1.9-5a8.8 8.8 0 1 1 16.1-4.5Z"/>',
  'square-pen':'<path d="M13 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m15 3 6 6-9 9-5 1 1-5z"/>',
  'search':'<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',
  'key-round':'<circle cx="15" cy="8" r="5"/><path d="M11 12 3 20v1h3v-2h2v-2h2l2-2"/><circle cx="16" cy="7" r=".7"/>',
  'plus':'<path d="M12 5v14M5 12h14"/>',
  'moon':'<path d="M20 15A8 8 0 0 1 9 4 8 8 0 1 0 20 15Z"/>',
  'sun':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  'chevron-left':'<path d="m15 18-6-6 6-6"/>',
  'chevron-right':'<path d="m9 18 6-6-6-6"/>',
  'panel-right':'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  'arrow-up':'<path d="M12 20V4m-7 7 7-7 7 7"/>',
  'timer':'<circle cx="12" cy="14" r="8"/><path d="M12 14 15 11M9 2h6m-3 2v2"/>',
  'timer-reset':'<circle cx="12" cy="14" r="8"/><path d="M12 10v4l3 2M9 2h6"/>',
  'lock-keyhole':'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  'x':'<path d="M18 6 6 18M6 6l12 12"/>',
  'copy':'<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
  'refresh-cw':'<path d="M20 7v5h-5M4 17v-5h5M5 10a7 7 0 0 1 12-3l3 5M19 14a7 7 0 0 1-12 3l-3-5"/>',
  'shield-alert':'<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="M12 7v5m0 3h.01"/>',
  'shield-check':'<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  'crown':'<path d="m3 7 3 11h12l3-11-5 4-4-7-4 7zM6 21h12"/>',
  'log-out':'<path d="M10 4H5v16h5m4-4 4-4-4-4m4 4H9"/>',
  'users':'<circle cx="9" cy="8" r="3"/><path d="M3 19v-2a6 6 0 0 1 12 0v2m1-14a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5"/>',
  'user-round-x':'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 10-4m3 1 5 5m0-5-5 5"/>',
  'boxes':'<path d="m12 3 4 2v4l-4 2-4-2V5zm-5 9 4 2v4l-4 2-4-2v-4zm10 0 4 2v4l-4 2-4-2v-4z"/>',
  'sparkles':'<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  'check':'<path d="m5 12 4 4L19 6"/>',
  'wifi-off':'<path d="M3 3l18 18M4 10a13 13 0 0 1 12-2m3 2a13 13 0 0 1 2 1.5M7 14a8 8 0 0 1 5-2m3 1a8 8 0 0 1 2 1m-7 3a3 3 0 0 1 4 0m-2 3h.01"/>',
  'trash-2':'<path d="M4 7h16M9 4h6M6 7l1 13h10l1-13M10 10v7m4-7v7"/>'
};
export function refreshIcons() {
  document.querySelectorAll('[data-lucide]').forEach(element => {
    const name=element.getAttribute('data-lucide');const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
    svg.innerHTML=paths[name]||paths['shield-check'];element.replaceWith(svg);
  });
}
