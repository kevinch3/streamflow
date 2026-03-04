const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractSessionIdFromPath } = require('../app/repo/sessionsRepo');
const { groupActiveStreamsBySession } = require('../app/credits');

describe('session path parsing', () => {
  it('extracts session id from strict path', () => {
    const sessionId = extractSessionIdFromPath('s/0123456789abcdef/stream_1');
    assert.equal(sessionId, '0123456789abcdef');
  });

  it('returns null for invalid path', () => {
    const sessionId = extractSessionIdFromPath('invalid/path');
    assert.equal(sessionId, null);
  });
});

describe('groupActiveStreamsBySession', () => {
  it('groups active streams per session id', () => {
    const publishers = [
      { path: 's/0123456789abcdef/main' },
      { path: 's/0123456789abcdef/backup' },
      { path: 's/fedcba9876543210/cam' },
      { path: 'invalid/path' },
    ];

    const grouped = groupActiveStreamsBySession(publishers);
    assert.equal(grouped.get('0123456789abcdef'), 2);
    assert.equal(grouped.get('fedcba9876543210'), 1);
    assert.equal(grouped.has('invalid'), false);
  });
});
