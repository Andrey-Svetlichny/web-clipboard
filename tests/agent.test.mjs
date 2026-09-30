// describeAgent() and origin(): the "who" half of the line a peer sees above the text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgent } from '../web/agent.js';
import { FROM_MAX, origin } from '../web/api.js';

test('a userAgent string is read as "browser/platform"', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/131.0.0.0 Safari/537.36', 'Chrome/Windows'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari/iPhone'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Firefox/Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like '
      + 'Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge/macOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome/Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like '
      + 'Gecko) Version/17.5 Safari/605.1.15', 'Safari/macOS'],
  ];
  for (const [userAgent, want] of cases) {
    assert.equal(describeAgent({ userAgent }), want, userAgent.slice(0, 40));
  }
});

test('userAgentData wins, with the placeholder brands stripped', () => {
  // Chromium lists three brands, of which only one means anything.
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
  }), 'Chrome/Windows');

  assert.equal(describeAgent({
    userAgentData: { platform: 'macOS', brands: [{ brand: 'Microsoft Edge' }] },
  }), 'Edge/macOS');
});

test('an unknown agent gives an empty string, not garbage', () => {
  assert.equal(describeAgent({ userAgent: 'curl/8.4.0' }), '');
  assert.equal(describeAgent({}), '');
  // A platform without a recognisable browser is still more useful than nothing.
  assert.equal(describeAgent({ userAgent: 'SomeBot (Windows NT 10.0)' }), 'Windows');
});

test('origin joins the device name to the browser', () => {
  assert.equal(origin('My laptop', 'Chrome/Windows'), 'My laptop · Chrome/Windows');
  // Either half may be missing, and then no separator appears.
  assert.equal(origin('', 'Safari/iPhone'), 'Safari/iPhone');
  assert.equal(origin('Laptop', ''), 'Laptop');
  assert.equal(origin('', ''), '');
  assert.equal(origin('  Laptop  ', ' Firefox/Linux '), 'Laptop · Firefox/Linux');
  // Non-strings come from someone else's code and must not break the join.
  assert.equal(origin(undefined, 'Chrome/Android'), 'Chrome/Android');
  assert.equal(origin(null, null), '');

  // The string ends up in the card header on the other side, so its length is capped here.
  const long = origin('é'.repeat(60), 'Chrome/Windows');
  assert.equal(long.length, FROM_MAX);
});
