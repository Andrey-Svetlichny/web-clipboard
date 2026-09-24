import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgent } from '../web/agent.js';

test('userAgent разбирается в «браузер on платформа»', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/131.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Firefox on Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like '
      + 'Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge on macOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like '
      + 'Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS'],
  ];
  for (const [userAgent, want] of cases) {
    assert.equal(describeAgent({ userAgent }), want, userAgent.slice(0, 40));
  }
});

test('userAgentData важнее и чистится от служебных брендов', () => {
  // Chromium отдаёт три бренда, осмысленный из них один.
  assert.equal(describeAgent({
    userAgentData: {
      platform: 'Windows',
      brands: [
        { brand: 'Not(A:Brand', version: '99' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
      ],
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0',
  }), 'Chrome on Windows');

  assert.equal(describeAgent({
    userAgentData: { platform: 'macOS', brands: [{ brand: 'Microsoft Edge' }] },
  }), 'Edge on macOS');
});

test('на неизвестном агенте возвращается пустая строка, а не мусор', () => {
  assert.equal(describeAgent({ userAgent: 'curl/8.4.0' }), '');
  assert.equal(describeAgent({}), '');
  // Платформа без узнаваемого браузера всё же полезнее пустоты.
  assert.equal(describeAgent({ userAgent: 'SomeBot (Windows NT 10.0)' }), 'Windows');
});

test('origin склеивает имя устройства с браузером', async () => {
  const { origin, FROM_MAX } = await import('../web/api.js');

  assert.equal(origin('Мой ноутбук', 'Chrome on Windows'), 'Мой ноутбук · Chrome on Windows');
  // Любой половины может не быть: разделитель тогда не появляется.
  assert.equal(origin('', 'Safari on iPhone'), 'Safari on iPhone');
  assert.equal(origin('Ноутбук', ''), 'Ноутбук');
  assert.equal(origin('', ''), '');
  assert.equal(origin('  Ноутбук  ', ' Firefox on Linux '), 'Ноутбук · Firefox on Linux');
  // Не строки приходят от чужого кода и не должны ломать склейку.
  assert.equal(origin(undefined, 'Chrome on Android'), 'Chrome on Android');
  assert.equal(origin(null, null), '');

  // Строка едет в заголовок карточки на той стороне, поэтому длина ограничена здесь.
  const long = origin('Д'.repeat(60), 'Chrome on Windows');
  assert.equal(long.length, FROM_MAX);
});
