import assert from 'assert';
import { describe, it } from 'node:test';
import { buildUserMention } from './index.js';

describe('buildUserMention', () => {
  const id = 12345;

  it('defaults to HTML and combines first and last name', () => {
    const result = buildUserMention({ id, first_name: 'Foo', last_name: 'Bar' });
    assert.strictEqual(result, '<a href="tg://user?id=12345">Foo Bar</a>');
  });

  it('uses only first name if last name is missing', () => {
    const result = buildUserMention({ id, first_name: 'Alice' });
    assert.strictEqual(result, '<a href="tg://user?id=12345">Alice</a>');
  });

  it('uses only last name if first name is missing', () => {
    const result = buildUserMention({ id, last_name: 'Smith' });
    assert.strictEqual(result, '<a href="tg://user?id=12345">Smith</a>');
  });

  it('falls back to unknown when no name or username provided', () => {
    const result = buildUserMention({ id });
    assert.strictEqual(result, '<a href="tg://user?id=12345">unknown</a>');
  });

  it('uses username when provided for HTML', () => {
    const result = buildUserMention({ id, username: 'john_doe' });
    assert.strictEqual(result, '<a href="https://t.me/john_doe">&commat;john&lowbar;doe</a>');
  });

  it('escapes HTML special characters in display name', () => {
    const result = buildUserMention({ id, first_name: '<&>' });
    assert.strictEqual(result, '<a href="tg://user?id=12345">&lt;&amp;&gt;</a>');
  });

  it('formats link in legacy Markdown', () => {
    const result = buildUserMention({ id, first_name: 'John_Doe', parseMode: 'Markdown' });
    assert.strictEqual(result, '[John_Doe](tg://user?id=12345)');
  });

  it('handles brackets in legacy Markdown correctly', () => {
    const result = buildUserMention({ id, first_name: 'A[Test]B', parseMode: 'Markdown' });
    assert.strictEqual(result, '[A[TestB](tg://user?id=12345)');
  });

  it('escapes and formats link in MarkdownV2', () => {
    const result = buildUserMention({ id, first_name: 'Test*User', parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[Test\\*User](tg://user?id=12345)');
  });

  it('handles brackets in MarkdownV2 correctly', () => {
    const result = buildUserMention({ id, first_name: 'A[Test]B', parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[A\\[Test\\]B](tg://user?id=12345)');
  });
}); 