import _ from 'lodash';
import { html as htmlFormat, markdown as mdFormat, markdownv2 as mdv2Format } from '@flla/telegram-format';

/**
 * Build a Telegram user mention link in various parse modes.
 *
 * @param {Object} options - Options for building the mention link.
 * @param {Object} [options.user] - Telegram user object with id, username, first_name, last_name.
 * @param {number|string} [options.id] - Telegram user ID (overrides user.id).
 * @param {string} [options.username] - Telegram username (without '@', overrides user.username).
 * @param {string} [options.first_name] - User's first name (overrides user.first_name).
 * @param {string} [options.last_name] - User's last name (overrides user.last_name).
 * @param {'HTML'|'Markdown'|'MarkdownV2'} [options.parseMode='HTML'] - The parse mode to use.
 * @returns {string} A formatted mention link for the user.
 */
export function buildUserMention({
  user,
  id: idParam,
  username: usernameParam,
  first_name: firstNameParam,
  last_name: lastNameParam,
  parseMode = 'HTML',
}) {
  // Derive core fields from `user` with inline overrides
  const id = idParam ?? user?.id;
  const username = usernameParam ?? user?.username;
  const first_name = firstNameParam ?? user?.first_name;
  const last_name = lastNameParam ?? user?.last_name;
   
  let displayName;
  if (username) {
    displayName = `@${username}`;
  } else {
    // Trim all string names, then filter out empty values
    const raw = [first_name, last_name];
    const trimmedAll = _.map(raw, (rawName) => (_.isString(rawName) ? _.trim(rawName) : rawName));
    const cleaned = _.filter(trimmedAll, (name) => _.isString(name) ? !_.isEmpty(name) : Boolean(name));
    displayName = cleaned.length ? _.join(cleaned, ' ') : 'unknown';
  }
  const link = username ? `https://t.me/${username}` : `tg://user?id=${id}`;
  switch (parseMode) {
    case 'Markdown':
      // Legacy Markdown: no manual escape (formatter handles it)
      return mdFormat.url(displayName, link);
    case 'MarkdownV2':
      return mdv2Format.url(mdv2Format.escape(displayName), link);
    case 'HTML':
    default:
      // In HTML mode, use htmlFormat.escape for any needed escaping
      if (username) {
        // preserve literal @username
        return htmlFormat.url(`@${username}`, link);
      }
      return htmlFormat.url(htmlFormat.escape(displayName), link);
  }
} 