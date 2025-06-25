import 'dotenv/config';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import Storage from './storage.js';
import { v7 as uuidv7 } from 'uuid';
import { buildUserMention } from './buildUserMention.js';
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

/**
 * Migrate old user mentions to clickable mentions.
 * @param {Object} [options]
 * @param {number} [options.limit=Number(process.env.MIGRATE_LIMIT)||1] - Max items to migrate per run.
 * @param {boolean} [options.tracing=false] - Enable detailed tracing logs.
 */
async function migrateUserMentions({ limit = Number(process.env.MIGRATE_LIMIT) || 1, tracing = false } = {}) {
  if (tracing) console.log(`migrateUserMentions: starting migration with limit=${limit}`);
  let migratedCount = 0;
  if (tracing) console.log('migrateUserMentions: reading database');
  await storage.readDB();
  const users = storage.db.data.users || {};
  if (tracing) console.log(`migrateUserMentions: found ${Object.keys(users).length} users in DB`);
  outer: for (const [userId, user] of Object.entries(users)) {
    if (tracing) console.log(`migrateUserMentions: inspecting user ${userId}`);
    for (const type of ['needs', 'resources']) {
      if (tracing) console.log(`migrateUserMentions:  checking type ${type}`);
      const items = user[type] || [];
      for (const item of items) {
        if (tracing) console.log(`migrateUserMentions:    processing item channelMessageId=${item.channelMessageId}`);
        const msgId = item.channelMessageId;
        if (!msgId) {
          if (tracing) console.log('migrateUserMentions:      skip - no channelMessageId');
          continue;
        }
        if (migratedCount >= limit) {
          if (tracing) console.log('migrateUserMentions:      reached limit, stopping');
          break outer;
        }
        // Fetch chat to build mention
        let chat;
        try {
          if (tracing) console.log(`migrateUserMentions:      fetching chat for user ${userId}`);
          chat = await bot.telegram.getChat(userId);
          if (tracing) console.log(`migrateUserMentions:      fetched chat: ${JSON.stringify(chat)}`);
        } catch (err) {
          if (tracing) console.error(`migrateUserMentions:      failed to fetch chat for ${userId}`, err);
          continue;
        }
        const mention = buildUserMention({ user: chat });
        const oldItem = { ...item };
        let newContent;
        if (type === 'needs') {
          if (tracing) console.log('migrateUserMentions:      building need content');
          newContent = `${item.description}\n\n<i>Need of ${mention}.</i>`;
        } else {
          if (tracing) console.log('migrateUserMentions:      building resource content');
          newContent = `${item.description}\n\n<i>Resource provided by ${mention}.</i>`;
        }
        // Attempt to edit message; treat 'message is not modified' as success
        try {
          if (tracing) {
            console.log(`Before migration for message ${msgId}:`);
            console.log(JSON.stringify(oldItem, null, 2));
          }
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
        } catch (err) {
          const desc = err.response?.description || '';
          if (/message is not modified/i.test(desc)) {
            if (tracing) console.log(`migrateUserMentions: message not modified, skipping error`);
          } else {
            if (tracing) console.error(`migrateUserMentions: failed to update message ${msgId}`, err);
            console.error(`Failed to migrate message ${msgId} for user ${userId}:`, err);
            // skip persisting in DB for genuine errors
            continue;
          }
        }
        // Persist full user info for future bumps
        item.user = {
          id: chat.id,
          username: chat.username,
          first_name: chat.first_name,
          last_name: chat.last_name
        };
        if (tracing) {
          console.log('migrateUserMentions:      set item.user:');
          console.log(JSON.stringify(item.user, null, 2));
        }
        // Update DB record
        const now = new Date().toISOString();
        item.updatedAt = now;
        const roleField = type === 'needs' ? 'requestor' : 'supplier';
        item[roleField] = chat.username || chat.first_name || 'unknown';
        if (tracing) {
          console.log(`After migration for message ${msgId}:`);
          console.log(JSON.stringify(item, null, 2));
        }
        migratedCount++;
      }
    }
  }
  if (migratedCount > 0) {
    if (tracing) console.log('migrateUserMentions: writing DB updates');
    await storage.writeDB();
    console.log(`User mention migration: ${migratedCount} item(s) updated`);
  } else {
    console.log('User mention migration: no items updated');
  }
}

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const pendingActions = {};
const CHANNEL_USERNAME = '@CorrelationCenter';
// Daily posting limits per user
const DAILY_LIMITS = { need: 3, resource: 3 };
// Delay (ms) before prompting user for description when pending action is set
const PROMPT_DELAY_MS = Number(process.env.PROMPT_DELAY_MS) || 750;

// Helper to list items for both needs and resources
async function listItems(ctx, type) {
  if (ctx.chat.type !== 'private') return;
  const user = await storage.getUserData(ctx.from.id);
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
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const promptKey = `prompt${capitalized}`;

  let description = '';
  let fileId = null;
  // Detect forwarded messages from channel to strip auto-appended lines
  const channelName = CHANNEL_USERNAME.startsWith('@') ? CHANNEL_USERNAME.slice(1) : CHANNEL_USERNAME;
  const isFromChannelMsg = ctx.message.forward_from_chat && ctx.message.forward_from_chat.username === channelName;

  // If command used as a reply, take replied message as input
  if (ctx.message.text && ctx.message.text.startsWith('/') && ctx.message.reply_to_message) {
    const replied = ctx.message.reply_to_message;
    const isFromChannel = replied.forward_from_chat && replied.forward_from_chat.username === channelName;
    if (replied.photo && replied.photo.length > 0) {
      fileId = replied.photo[replied.photo.length - 1].file_id;
      let raw = replied.caption?.trim() || '';
      if (isFromChannel) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    } else if (replied.document && replied.document.mime_type.startsWith('image/')) {
      fileId = replied.document.file_id;
      let raw = replied.caption?.trim() || '';
      if (isFromChannel) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    } else if (replied.text) {
      let raw = replied.text.trim();
      if (isFromChannel) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    }
  } else {
    // Prepare and reject commands as input
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
      await ctx.reply(t(ctx, promptKey));
      return;
    }
    // Support both text and image inputs, strip channel footer if forwarded
    const hasPhoto = ctx.message.photo && ctx.message.photo.length > 0;
    const hasDocImage = ctx.message.document && ctx.message.document.mime_type.startsWith('image/');
    if (hasPhoto) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      let raw = ctx.message.caption?.trim() || '';
      if (isFromChannelMsg) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    } else if (hasDocImage) {
      fileId = ctx.message.document.file_id;
      let raw = ctx.message.caption?.trim() || '';
      if (isFromChannelMsg) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    } else if (ctx.message.text) {
      let raw = ctx.message.text.trim();
      if (isFromChannelMsg) {
        const lines = raw.split('\n');
        if (lines.length >= 3) raw = lines.slice(0, -2).join('\n').trim();
      }
      description = raw;
    }
  }

  if (!description && !fileId) {
    await ctx.reply(t(ctx, promptKey));
    return;
  }
  const user = await storage.getUserData(ctx.from.id);
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
        `${description}\n\n<i>Need of ${buildUserMention({ user: from })}.</i>`
    },
    resource: {
      field: 'resources',
      role: 'supplier',
      channelTemplate: (description, from) =>
        `${description}\n\n<i>Resource provided by ${buildUserMention({ user: from })}.</i>`
    }
  };
  const { field, role, channelTemplate } = config[type];
  const timestamp = new Date().toISOString();
  const item = {
    // Persist full user info for later mentions (e.g. bump)
    user: {
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name
    },
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
    // Disallow anonymous (chat/channel) accounts from creating items
    if (ctx.message.sender_chat) {
      await ctx.reply(t(ctx, 'anonymousNotAllowed'));
      return;
    }
    if (ctx.message.reply_to_message) {
      return addItem(ctx, type);
    }
    // Set pending and schedule prompt after delay
    pendingActions[ctx.from.id] = type;
    setTimeout(() => {
      if (pendingActions[ctx.from.id] === type) {
        ctx.reply(t(ctx, promptKey));
      }
    }, PROMPT_DELAY_MS);
  });
  bot.hears([
    t({ from: { language_code: 'en' } }, buttonKey),
    t({ from: { language_code: 'ru' } }, buttonKey)
  ], async (ctx) => {
    // Disallow anonymous (chat/channel) accounts from creating items
    if (ctx.message.sender_chat) {
      await ctx.reply(t(ctx, 'anonymousNotAllowed'));
      return;
    }
    // Keyboard-triggered same flow with delayed prompt
    pendingActions[ctx.from.id] = type;
    setTimeout(() => {
      if (pendingActions[ctx.from.id] === type) {
        ctx.reply(t(ctx, promptKey));
      }
    }, PROMPT_DELAY_MS);
  });

  // Listing handlers using the generic helper
  bot.command(plural, async (ctx) => {
    await listItems(ctx, type);
  });
  bot.hears([
    t({ from: { language_code: 'en' } }, `buttonMy${capitalizedPlural}`),
    t({ from: { language_code: 'ru' } }, `buttonMy${capitalizedPlural}`)
  ], async (ctx) => {
    // Disallow anonymous (chat/channel) accounts from creating items
    if (ctx.message.sender_chat) {
      await ctx.reply(t(ctx, 'anonymousNotAllowed'));
      return;
    }
    await listItems(ctx, type);
  });

  // Deletion handlers
  bot.action(new RegExp(`delete_${type}_(\\d+)`), async (ctx) => {
    const msgId = parseInt(ctx.match[1], 10);
    const user = await storage.getUserData(ctx.from.id);
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
    const user = await storage.getUserData(ctx.from.id);
    const items = user[plural];
    const item = _.find(items, (it) => it.channelMessageId === msgId);
    if (!item) return ctx.answerCbQuery('Not found');
    // Repair missing or damaged user info from ctx.from
    if (!item.user || item.user.id !== ctx.from.id) {
      item.user = {
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      };
    }
    // Remove old channel message
    try {
      await ctx.telegram.deleteMessage(CHANNEL_USERNAME, msgId);
    } catch (e) {}
    // Build mention from repaired item.user
    const mention = buildUserMention({ user: item.user });
    const content = `${item.description}\n\n<i>${
      type === 'need' ? 'Need of ' + mention : 'Resource provided by ' + mention
    }.</i>`;
    let post;
    if (item.fileId) {
      post = await ctx.telegram.sendPhoto(CHANNEL_USERNAME, item.fileId, { caption: content, parse_mode: 'HTML' });
    } else {
      post = await ctx.telegram.sendMessage(CHANNEL_USERNAME, content, { parse_mode: 'HTML' });
    }
    item.channelMessageId = post.message_id;
    // Update updatedAt after bump
    item.updatedAt = new Date().toISOString();
    await storage.writeDB();
    // Update private chat message to show updatedAt and remove bump button
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
  const newRow = itemTypes.map((type) =>
    t(ctx, `button${type.charAt(0).toUpperCase() + type.slice(1)}`)
  );
  const myRow = itemTypes.map((type) => {
    const plural = `${type}s`;
    return t(ctx, `buttonMy${plural.charAt(0).toUpperCase() + plural.slice(1)}`);
  });
  return Markup.keyboard([newRow, myRow]).resize();
}

bot.start(async (ctx) => {
  // Ensure we at least have an empty user object in the DB
  await storage.getUserData(ctx.from.id);
  await storage.writeDB();
  await ctx.reply(t(ctx, 'welcome', { description: t(ctx, 'description') }), getMainKeyboard(ctx));
});

// Handle all incoming messages (text or images) for adding items
bot.on('message', async (ctx, next) => {
  // If user sent /cancel, bypass addItem so cancel command can run
  if (ctx.message.text && ctx.message.text.startsWith('/cancel')) return next();
  const action = pendingActions[ctx.from.id];
  if (!action) return next();
  await addItem(ctx, action);
});

// Help command: private vs group
bot.command('help', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply(t(ctx, 'help'));
  } else {
    await ctx.reply(t(ctx, 'helpGroup'));
  }
});

// Cancel any pending action
bot.command('cancel', async (ctx) => {
  if (pendingActions[ctx.from.id]) {
    delete pendingActions[ctx.from.id];
    await ctx.reply(t(ctx, 'actionCancelled'));
  } else {
    await ctx.reply(t(ctx, 'noPendingAction'));
  }
});

// Only start the bot outside of test environment
if (process.env.NODE_ENV !== 'test') {
  console.log('Migrating old user mentions...');
  await migrateUserMentions({ limit: 1, tracing: true });
  console.log('Launching bot...');
  bot.launch().catch((error) => {
    console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
    process.exit(1);
  });
  console.log('Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}