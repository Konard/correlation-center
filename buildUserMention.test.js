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

  it('supports emoji in HTML', () => {
    const result = buildUserMention({ id, first_name: '😀😃' });
    assert.strictEqual(result, '<a href="tg://user?id=12345">&#x1f600;&#x1f603;</a>');
  });

  it('escapes double quotes in HTML', () => {
    const result = buildUserMention({ id, first_name: 'He said "Hi"' });
    assert.strictEqual(
      result,
      '<a href="tg://user?id=12345">He said &quot;Hi&quot;</a>'
    );
  });

  it('escapes apostrophes in HTML', () => {
    const result = buildUserMention({ id, first_name: "O'Reilly" });
    assert.strictEqual(
      result,
      '<a href="tg://user?id=12345">O&apos;Reilly</a>'
    );
  });

  it('combines names in legacy Markdown', () => {
    const result = buildUserMention({ id, first_name: 'Foo', last_name: 'Bar', parseMode: 'Markdown' });
    assert.strictEqual(result, '[Foo Bar](tg://user?id=12345)');
  });

  it('formats username in legacy Markdown', () => {
    const result = buildUserMention({ id, username: 'john_doe', parseMode: 'Markdown' });
    assert.strictEqual(result, '[@john_doe](https://t.me/john_doe)');
  });

  it('falls back to unknown in legacy Markdown', () => {
    const result = buildUserMention({ id, parseMode: 'Markdown' });
    assert.strictEqual(result, '[unknown](tg://user?id=12345)');
  });

  it('combines names in MarkdownV2', () => {
    const result = buildUserMention({ id, first_name: 'Foo', last_name: 'Bar', parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[Foo Bar](tg://user?id=12345)');
  });

  it('falls back to unknown in MarkdownV2', () => {
    const result = buildUserMention({ id, parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[unknown](tg://user?id=12345)');
  });

  it('supports emoji in Markdown', () => {
    const result = buildUserMention({ id, first_name: '😀😃', parseMode: 'Markdown' });
    assert.strictEqual(result, '[😀😃](tg://user?id=12345)');
  });

  it('supports emoji in MarkdownV2', () => {
    const result = buildUserMention({ id, first_name: '😀😃', parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[😀😃](tg://user?id=12345)');
  });

  it('escapes parentheses in MarkdownV2', () => {
    const result = buildUserMention({ id, first_name: '(Test)', parseMode: 'MarkdownV2' });
    assert.strictEqual(result, '[\\(Test\\)](tg://user?id=12345)');
  });
}); 