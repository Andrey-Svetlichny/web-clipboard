// A short description of this browser: "Chrome/Windows".
//
// The device knows this about itself, so the server plays no part in it and nothing extra
// settles in the record.

const BROWSERS = [
  [/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari'],
];
const PLATFORMS = [
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'], [/Linux/, 'Linux'],
];
const BRAND_NAMES = { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' };

function match(table, text) {
  for (const [pattern, name] of table) if (pattern.test(text)) return name;
  return '';
}

// nav is a test seam: the page passes nothing and gets the real navigator.
export function describeAgent(nav) {
  const source = nav || (typeof navigator === 'undefined' ? {} : navigator);

  let browser = '';
  let platform = '';
  const hints = source.userAgentData;
  if (hints && Array.isArray(hints.brands)) {
    // Chromium lists three brands, of which only one means anything.
    const brand = hints.brands.map((entry) => entry && entry.brand)
      .find((name) => name && !/not[^a-z]*a[^a-z]*brand/i.test(name) && name !== 'Chromium');
    if (brand) browser = BRAND_NAMES[brand] || brand;
    if (hints.platform) platform = hints.platform;
  }

  const ua = source.userAgent || '';
  if (!browser) browser = match(BROWSERS, ua);
  if (!platform) platform = match(PLATFORMS, ua);
  if (browser && platform) return `${browser}/${platform}`;
  return browser || platform || '';
}
