// Короткая строка о себе: «Chrome/Windows».
//
// Устройство знает это о себе само, поэтому сервер в этом не участвует и ничего лишнего
// в записи не оседает.


const BROWSERS = [
  [/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari'],
];
const PLATFORMS = [
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'], [/Mac OS X|Macintosh/, 'macOS'], [/Linux/, 'Linux'],
];
const BRAND_NAMES = { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' };

export function describeAgent(nav) {
  const source = nav || (typeof navigator === 'undefined' ? {} : navigator);
  const match = (table, text) => {
    for (const [pattern, name] of table) if (pattern.test(text)) return name;
    return '';
  };

  let browser = '';
  let platform = '';
  const hints = source.userAgentData;
  if (hints && Array.isArray(hints.brands)) {
    // Chromium раскладывает бренды на три штуки, из которых нужен один осмысленный.
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
