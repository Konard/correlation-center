import 'dotenv/config';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import Storage from './storage.js';
import { v7 as uuidv7 } from 'uuid';
import { html as htmlFormat, markdown as mdFormat, markdownv2 as mdv2Format } from '@flla/telegram-format';
import _ from 'lodash';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load localization files
const locales = {
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/en.json'))),
  ru: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/ru.json'))),
};

// Translation helper
function t(ctx, key, vars = {}) {
  const lang = locales[ctx.from.language_code] ? ctx.from.language_code : 'en';
  let text = locales[lang][key] || locales['en'][key] || key;
  Object.keys(vars).forEach((k) => {
    text = text.replace(`{{${k}}}`, vars[k]);
  });
  return text;
}

// Initialize database
const storage = new Storage();
await storage.initDB();

// Migrate old user mentions to new clickable mentions on startup
async function migrateUserMentions() {
  await storage.readDB();
  const users = storage.db.data.users || {};
  let anyUpdated = false;
  for (const [userId, user] of Object.entries(users)) {
    for (const type of ['needs', 'resources']) {
      const items = user[type] || [];
      for (const item of items) {
        const msgId = item.channelMessageId;
        if (!msgId) continue;
        let chat;
        try {
          chat = await bot.telegram.getChat(userId);
        } catch (err) {
          console.error(`Failed to fetch chat for user ${userId}:`, err);
          continue;
        }
        const mention = buildUserMention({
          id: chat.id,
          username: chat.username,
          first_name: chat.first_name,
          last_name: chat.last_name,
          parseMode: 'HTML'
        });
        let newContent;
        if (type === 'needs') {
          newContent = `${item.description}\n\n<i>Need of ${mention}.</i>`;
        } else {
          newContent = `${item.description}\n\n<i>Resource provided by ${mention}.</i>`;
        }
        try {
          if (item.fileId) {
            await bot.telegram.editMessageCaption(
              CHANNEL_USERNAME,
              msgId,
              undefined,
              newContent,
              { parse_mode: 'HTML' }
            );
          } else {
            await bot.telegram.editMessageText(
              CHANNEL_USERNAME,
              msgId,
              undefined,
              newContent,
              { parse_mode: 'HTML' }
            );
          }
          // Update updatedAt and role field to reflect latest user data
          const now = new Date().toISOString();
          item.updatedAt = now;
          const roleField = type === 'needs' ? 'requestor' : 'supplier';
          item[roleField] = chat.username || chat.first_name || 'unknown';
          anyUpdated = true;
          console.log(`Migrated message ${msgId} for user ${userId}`);
        } catch (err) {
          console.error(`Failed to migrate message ${msgId} for user ${userId}:`, err);
        }
      }
    }
  }
  if (anyUpdated) {
    await storage.writeDB();
    console.log('User mention migration: database updated');
  }
}

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const pendingActions = {};
const CHANNEL_USERNAME = '@CorrelationCenter';
// Daily posting limits per user
const DAILY_LIMITS = { need: 3, resource: 3 };

/**
 * Build a Telegram user mention link in various parse modes.
 *
 * @param {Object} options - Options for building the mention link.
 * @param {number|string} options.id - Telegram user ID.
 * @param {string} [options.username] - Telegram username (without '@').
 * @param {string} [options.first_name] - User's first name.
 * @param {string} [options.last_name] - User's last name.
 * @param {'HTML'|'Markdown'|'MarkdownV2'} [options.parseMode='HTML'] - The parse mode to use.
 * @returns {string} A formatted mention link for the user.
 */
export function buildUserMention({ id, username, first_name, last_name, parseMode = 'HTML' }) {
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

// Helper to list items for both needs and resources
async function listItems(ctx, type) {
  if (ctx.chat.type !== 'private') return;
  await storage.readDB();
  const user = storage.getUserData(ctx.from.id);
  const plural = `${type}s`;
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const capitalizedPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
  if (user[plural].length === 0) {
    return ctx.reply(t(ctx, `no${capitalizedPlural}`));
  }
  for (let i = 0; i < user[plural].length; i++) {
    const item = user[plural][i];
    const createdAt = formatDate(item.createdAt);
    const updatedAt = formatDate(item.updatedAt);
    // Build delete (and optional bump) buttons, keyed by channelMessageId
    const delId = item.channelMessageId;
    const buttons = [
      Markup.button.callback(
        t(ctx, `delete${capitalized}Button`) || 'Delete',
        `delete_${type}_${delId}`
      )
    ];
    const last = new Date(item.updatedAt || item.createdAt);
    const ageMs = Date.now() - last.getTime();
    // Show bump only if item is older than 24 hours, using channelMessageId
    if (ageMs >= 24 * 60 * 60 * 1000 && item.channelMessageId) {
      buttons.push(
        Markup.button.callback(
          t(ctx, 'bumpButton') || 'Bump',
          `bump_${type}_${item.channelMessageId}`
        )
      );
    }
    // Localized creation and update timestamps
    let message = `${item.description}\n\n${t(ctx, 'createdAt', { date: createdAt })}`;
    if (item.updatedAt && item.updatedAt !== item.createdAt) {
      message += `\n${t(ctx, 'updatedAt', { date: updatedAt })}`;
    }
    await ctx.reply(
      message,
      Markup.inlineKeyboard([buttons])
    );
  }
}
// Helper to add a new item (need or resource)
async function addItem(ctx, type) {
  // Prepare and reject commands as input
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const promptKey = `prompt${capitalized}`;
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    await ctx.reply(t(ctx, promptKey));
    return;
  }
  // Support both text and image inputs
  const hasPhoto = ctx.message.photo && ctx.message.photo.length > 0;
  const hasDocImage = ctx.message.document && ctx.message.document.mime_type.startsWith('image/');
  let description = '';
  let fileId = null;
  if (hasPhoto) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    description = ctx.message.caption?.trim() || '';
  } else if (hasDocImage) {
    fileId = ctx.message.document.file_id;
    description = ctx.message.caption?.trim() || '';
  } else if (ctx.message.text) {
    description = ctx.message.text.trim();
  }
  if (!description && !fileId) {
    await ctx.reply(t(ctx, promptKey));
    return;
  }
  await storage.readDB();
  const user = storage.getUserData(ctx.from.id);
  // Enforce rolling 24-hour creation limits
  const fieldKey = `${type}s`;
  const sinceTs = Date.now() - 24 * 60 * 60 * 1000;
  const recentItems = _.filter(
    user[fieldKey],
    (item) => new Date(item.createdAt).getTime() >= sinceTs
  );
  const limitKey = type === 'need' ? 'limitNeedsPerDay' : 'limitResourcesPerDay';
  const limit = DAILY_LIMITS[type];
  if (recentItems.length >= limit) {
    await ctx.reply(t(ctx, limitKey, { count: recentItems.length, limit }));
    delete pendingActions[ctx.from.id];
    return;
  }
  const config = {
    need: {
      field: 'needs',
      role: 'requestor',
      channelTemplate: (description, from) =>
        `${description}\n\n<i>Need of ${buildUserMention({
          id: from.id,
          username: from.username,
          first_name: from.first_name,
          last_name: from.last_name,
          parseMode: 'HTML'
        })}.</i>`
    },
    resource: {
      field: 'resources',
      role: 'supplier',
      channelTemplate: (description, from) =>
        `${description}\n\n<i>Resource provided by ${buildUserMention({
          id: from.id,
          username: from.username,
          first_name: from.first_name,
          last_name: from.last_name,
          parseMode: 'HTML'
        })}.</i>`
    }
  };
  const { field, role, channelTemplate } = config[type];
  const timestamp = new Date().toISOString();
  const item = {
    [role]: ctx.from.username || ctx.from.first_name || 'unknown',
    guid: uuidv7(),
    description,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (fileId) item.fileId = fileId;
  try {
    let post;
    if (fileId) {
      post = await ctx.telegram.sendPhoto(
        CHANNEL_USERNAME,
        fileId,
        { caption: channelTemplate(item.description, ctx.from), parse_mode: 'HTML' }
      );
    } else {
      post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        channelTemplate(item.description, ctx.from),
        { parse_mode: 'HTML' }
      );
    }
    item.channelMessageId = post.message_id;
  } catch (e) {
    item.channelMessageId = null;
  }
  user[field].push(item);
  await storage.writeDB();
  // Send confirmation: private chat vs group chat
  // Use specialized translation in private chats to mention management commands
  const privateKey = type === 'need' ? 'needAddedPrivate' : 'resourceAddedPrivate';
  const groupKey = type === 'need' ? 'needAdded' : 'resourceAdded';
  const replyKey = ctx.chat.type === 'private' ? privateKey : groupKey;
  await ctx.reply(t(ctx, replyKey, { channel: CHANNEL_USERNAME }));
  delete pendingActions[ctx.from.id];
}
// Helper to format timestamps consistently
function formatDate(ts) {
  return new Date(ts || Date.now()).toLocaleString();
}
// Consolidated handlers for prompt, listing, and deletion of needs and resources
const itemTypes = ['need', 'resource'];
itemTypes.forEach((type) => {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const plural = `${type}s`;
  const capitalizedPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
  const buttonKey = `button${capitalized}`;
  const promptKey = `prompt${capitalized}`;
  const deleteButtonKey = `delete${capitalized}Button`;

  // Prompt handlers (/need and keyboard)
  bot.command(type, async (ctx) => {
    pendingActions[ctx.from.id] = type;
    await ctx.reply(t(ctx, promptKey));
  });
  bot.hears(
    [t({ from: { language_code: 'en' } }, buttonKey), t({ from: { language_code: 'ru' } }, buttonKey)],
    async (ctx) => {
      pendingActions[ctx.from.id] = type;
      await ctx.reply(t(ctx, promptKey));
    }
  );

  // Listing handlers using the generic helper
  bot.command(plural, async (ctx) => {
    await listItems(ctx, type);
  });
  bot.hears([
    t({ from: { language_code: 'en' } }, `buttonMy${capitalizedPlural}`),
    t({ from: { language_code: 'ru' } }, `buttonMy${capitalizedPlural}`)
  ], async (ctx) => {
    await listItems(ctx, type);
  });

  // Deletion handlers
  bot.action(new RegExp(`delete_${type}_(\\d+)`), async (ctx) => {
    const msgId = parseInt(ctx.match[1], 10);
    await storage.readDB();
    const user = storage.getUserData(ctx.from.id);
    const collection = user[plural];
    // Remove items matching channelMessageId
    const removedItems = _.remove(collection, (it) => it.channelMessageId === msgId);
    if (!removedItems.length) {
      return ctx.answerCbQuery('Not found');
    }
    const removed = removedItems[0];
    try {
      await ctx.telegram.deleteMessage(CHANNEL_USERNAME, msgId);
    } catch (e) {}
    await storage.writeDB();
    const createdAt = formatDate(removed.createdAt);
    const deletedAt = formatDate();
    await ctx.editMessageText(
      `${removed.description}\n\n${t(ctx, 'createdAt', { date: createdAt })}\n${t(ctx, 'deletedAt', { date: deletedAt })}`
    );
    // answer the callback query to remove loading state
    await ctx.answerCbQuery();
  });
});
// Bump handlers to refresh old messages in the channel
itemTypes.forEach((type) => {
  const plural = `${type}s`;
  bot.action(new RegExp(`bump_${type}_(\\d+)`), async (ctx) => {
    const msgId = parseInt(ctx.match[1], 10);
    await storage.readDB();
    const user = storage.getUserData(ctx.from.id);
    const items = user[plural];
    // Find item by channelMessageId
    const item = _.find(items, (it) => it.channelMessageId === msgId);
    if (!item) return ctx.answerCbQuery('Not found');
    // Remove old channel message
    if (msgId) {
      try { await ctx.telegram.deleteMessage(CHANNEL_USERNAME, msgId); } catch (e) {}
    }
    // Re-post to channel
    let post;
    const role = type === 'need' ? 'requestor' : 'supplier';
    const channelTemplate = type === 'need'
      ? (desc, name) => `${desc}\n\n<i>Need of @${name}.</i>`
      : (desc, name) => `${desc}\n\n<i>Resource provided by @${name}.</i>`;
    if (item.fileId) {
      post = await ctx.telegram.sendPhoto(
        CHANNEL_USERNAME,
        item.fileId,
        { caption: channelTemplate(item.description, item[role]), parse_mode: 'HTML' }
      );
    } else {
      post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        channelTemplate(item.description, item[role]),
        { parse_mode: 'HTML' }
      );
    }
    item.channelMessageId = post.message_id;
    // Update updatedAt after bump
    item.updatedAt = new Date().toISOString();
    await storage.writeDB();
    // Update the private chat message: show Updated at and remove Bump button
    const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
    const deleteButtonKey = `delete${capitalized}Button`;
    const createdAtStr = formatDate(item.createdAt);
    const updatedAtStr = formatDate();
    await ctx.editMessageText(
      `${item.description}\n\n${t(ctx, 'createdAt', { date: createdAtStr })}\n${t(ctx, 'updatedAt', { date: updatedAtStr })}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(
          t(ctx, deleteButtonKey),
          `delete_${type}_${item.channelMessageId}`
        )]
      ])
    );
    await ctx.answerCbQuery(t(ctx, 'bumped'));
  });
});
function getMainKeyboard(ctx) {
  // Build keyboard rows from itemTypes
  const newRow = itemTypes.map(type =>
    t(ctx, `button${type.charAt(0).toUpperCase() + type.slice(1)}`)
  );
  const myRow = itemTypes.map(type => {
    const plural = `${type}s`;
    return t(ctx, `buttonMy${plural.charAt(0).toUpperCase() + plural.slice(1)}`);
  });
  return Markup.keyboard([newRow, myRow]).resize();
}

bot.start(async (ctx) => {
  await storage.readDB();
  storage.getUserData(ctx.from.id);
  await storage.writeDB();
  await ctx.reply(t(ctx, 'welcome', { description: t(ctx, 'description') }), getMainKeyboard(ctx));
});

// Handle all incoming messages (text or images) for adding items
bot.on('message', async (ctx, next) => {
  const action = pendingActions[ctx.from.id];
  if (!action) return next();
  await addItem(ctx, action);
});

bot.command('help', async (ctx) => {
  await ctx.reply(t(ctx, 'help'));
});

// Only start the bot outside of test environment
if (process.env.NODE_ENV !== 'test') {
  // console.log('Migrating old user mentions...');
  // await migrateUserMentions();
  console.log('Launching bot...');
  bot.launch().catch((error) => {
    console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
    process.exit(1);
  });
  console.log('Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}