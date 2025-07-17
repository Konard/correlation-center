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
  let text = (locales[lang].messages && locales[lang].messages[key]) || locales[lang][key] || locales['en'].messages?.[key] || locales['en'][key] || key;
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
        // Clone and prepare DB updates
        const original = _.cloneDeep(item);
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
        // Update role field for DB
        const roleField = type === 'needs' ? 'requestor' : 'supplier';
        item[roleField] = chat.username || chat.first_name || 'unknown';
        if (tracing) console.log(`migrateUserMentions:      set ${roleField}: ${item[roleField]}`);
        // Detect real changes (excluding updatedAt), stripping undefined fields
        const origClean = JSON.parse(JSON.stringify(_.omit(original, 'updatedAt')));
        const currClean = JSON.parse(JSON.stringify(_.omit(item, 'updatedAt')));
        if (_.isEqual(origClean, currClean)) {
          if (tracing) console.log(`migrateUserMentions: no DB changes detected for message ${msgId}, skipping API call`);
          continue;
        }
        // Build new content only when change detected
        let newContent;
        if (type === 'needs') {
          if (tracing) console.log('migrateUserMentions:      building need content');
          newContent = `${item.description}\n\n<i>Need of ${mention}.</i>`;
        } else {
          if (tracing) console.log('migrateUserMentions:      building resource content');
          newContent = `${item.description}\n\n<i>Resource provided by ${mention}.</i>`;
        }
        // Now perform API call; treat 'message is not modified' as non-error
        try {
          if (tracing) console.log(`migrateUserMentions: editing message ${msgId}`);
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
            continue;
          }
        }
        // After successful API and DB change, set updatedAt and count
        const now = new Date().toISOString();
        item.updatedAt = now;
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

// Insert deleteChannelMessage helper function to encapsulate deletion or marking as deleted
async function deleteChannelMessage({ telegram, channel, msgId, tracing = false }) {
  try {
    if (tracing) console.log(`deleteChannelMessage: deleting message ${msgId}`);
    await telegram.deleteMessage(channel, msgId);
    return true;
  } catch (err) {
    const desc = err.response?.description || err.message;
    if (/message to delete not found/i.test(desc)) {
      if (tracing) console.log(`deleteChannelMessage: message ${msgId} already gone`);
      return true;
    } else if (/message can'?t be deleted/i.test(desc)) {
      if (tracing) console.log(`deleteChannelMessage: message ${msgId} can't be deleted, marking as deleted`);
      let edited = false;
      try {
        await telegram.editMessageText(channel, msgId, undefined, 'Deleted.');
        edited = true;
      } catch (editErr) {
        const desc2 = editErr.response?.description || editErr.message;
        if (/MESSAGE_ID_INVALID/i.test(desc2)) {
          // fallback to editing caption
          try {
            await telegram.editMessageCaption(channel, msgId, undefined, 'Deleted.');
            edited = true;
          } catch (editErr2) {
            if (tracing) console.error(`deleteChannelMessage: failed to edit caption for message ${msgId}`, editErr2);
          }
        } else {
          if (tracing) console.error(`deleteChannelMessage: failed to edit message ${msgId}`, editErr);
        }
      }
      return edited;
    } else {
      if (tracing) console.error(`deleteChannelMessage: failed to delete message ${msgId}`, err);
      return false;
    }
  }
}

/**
 * Delete channel messages for a given unreachable user.
 * @param {Object} options
 * @param {number} options.userId - Telegram ID of the user whose messages should be deleted.
 * @param {boolean} [options.tracing=false] - Enable detailed tracing logs.
 */
async function migrateDeleteUserChannelMessages({ userId, tracing = false } = {}) {
  if (tracing) console.log(`migrateDeleteUserChannelMessages: starting for user ${userId}`);
  await storage.readDB();
  const user = storage.db.data.users?.[userId];
  if (!user) {
    if (tracing) console.log(`migrateDeleteUserChannelMessages: no data for user ${userId}`);
    return;
  }
  let deletedCount = 0;
  for (const type of ['needs', 'resources']) {
    const items = user[type] || [];
    const retained = [];
    for (const item of items) {
      const msgId = item.channelMessageId;
      if (!msgId) {
        // not posted to channel, keep
        retained.push(item);
        continue;
      }
      // Attempt deletion or marking as deleted
      if (tracing) console.log(`migrateDeleteUserChannelMessages: deleting ${type} message ${msgId}`);
      if (await deleteChannelMessage({ telegram: bot.telegram, channel: CHANNEL_USERNAME, msgId, tracing })) {
        deletedCount++;
      } else {
        retained.push(item);
      }
    }
    // replace items array with retained ones only
    user[type] = retained;
  }
  await storage.writeDB();
  console.log(`Deleted ${deletedCount} channel message(s) for user ${userId}`);
}

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const pendingActions = {}; // Structure: { "userId_chatId": action }
const CHANNEL_USERNAME = '@CorrelationCenter';
// Daily posting limits per user
const DAILY_LIMITS = { need: 3, resource: 3 };
// Delay (ms) before prompting user for description when pending action is set
const PROMPT_DELAY_MS = Number(process.env.PROMPT_DELAY_MS) || 750;
// Feature flag to enable repost mode: forward original user message to channel and post metadata separately
const ENABLE_REPOSTS = process.env.ENABLE_REPOSTS === 'true';

// Helper function to generate pending action key
function getPendingActionKey(userId, chatId) {
  return `${userId}_${chatId}`;
}

// Helper function to check if this is the only bot in the chat
async function isOnlyBotInChat(ctx) {
  if (ctx.chat.type === 'private') {
    return true; // Always true for private chats
  }

  try {
    const administrators = await ctx.telegram.getChatAdministrators(ctx.chat.id);
    const otherBots = administrators.filter(admin =>
      admin.user.is_bot && admin.user.id !== ctx.from.id
    );
    return otherBots.length === 0;
  } catch (error) {
    console.log(`Could not check administrators for chat ${ctx.chat.id}:`, error.message);
    return false; // Assume there are other bots if we can't check
  }
}

// Helper function to get all help/start/prompt messages in all languages
function getAllBotMessageVariants() {
  const variants = new Set();
  for (const lang of Object.keys(locales)) {
    if (locales[lang].messages) {
      for (const key of Object.keys(locales[lang].messages)) {
        variants.add(locales[lang].messages[key]);
      }
    }
  }
  return Array.from(variants);
}

// Helper function to check if a message is a help/start/prompt message from our bot
function isBotSystemMessage(msg, botId) {
  if (!msg || !msg.from || msg.from.id !== botId) return false;
  if (!msg.text) return false;
  const variants = getAllBotMessageVariants();
  return variants.some(variant => msg.text.trim().startsWith(variant.trim()));
}

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
    // Check if this is a command reply (like /resource to a help message)
    if (isBotSystemMessage(ctx.message.reply_to_message, bot.botInfo.id)) {
      // Don't treat command replies as content to publish
      await ctx.reply(t(ctx, promptKey));
      return;
    }

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
  
  // Additional safety check: prevent bot system message content from being published
  if (description) {
    const variants = getAllBotMessageVariants();
    const isSystemMessageContent = variants.some(variant => 
      description.trim().startsWith(variant.trim())
    );
    if (isSystemMessageContent) {
      // This looks like a bot system message content, don't publish it
      await ctx.reply(t(ctx, promptKey));
      return;
    }
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
    const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
    delete pendingActions[pendingKey];
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
    if (ENABLE_REPOSTS) {
      // Forward the original user message to the channel
      const forwarded = await ctx.telegram.forwardMessage(
        CHANNEL_USERNAME,
        ctx.chat.id,
        ctx.message.message_id
      );
      // Store the forwarded message ID for reference
      item.descriptionMessageId = forwarded.message_id;
      // Send metadata only (without description) as a reply to the forwarded message
      const mention = buildUserMention({ user: ctx.from });
      const metadata = type === 'need'
        ? `<i>Need of ${mention}.</i>`
        : `<i>Resource provided by ${mention}.</i>`;
      post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        metadata,
        { parse_mode: 'HTML', reply_to_message_id: forwarded.message_id }
      );
    } else if (fileId) {
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
  const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
  delete pendingActions[pendingKey];
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

    // Check if this is a reply to a help/start message
    if (ctx.message.reply_to_message) {
      if (isBotSystemMessage(ctx.message.reply_to_message, bot.botInfo.id)) {
        // Just switch to the new mode without publishing
        const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
        pendingActions[pendingKey] = type;
        await ctx.reply(t(ctx, promptKey));
        return;
      }

      // For other replies, proceed with normal addItem logic
      return addItem(ctx, type);
    }

    // Set pending and schedule prompt after delay
    const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
    pendingActions[pendingKey] = type;
    setTimeout(() => {
      if (pendingActions[pendingKey] === type) {
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
    const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
    pendingActions[pendingKey] = type;
    setTimeout(() => {
      if (pendingActions[pendingKey] === type) {
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
    // Use helper to delete or mark as deleted
    await deleteChannelMessage({ telegram: ctx.telegram, channel: CHANNEL_USERNAME, msgId });
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
    // Remove old channel message or mark as deleted
    await deleteChannelMessage({ telegram: ctx.telegram, channel: CHANNEL_USERNAME, msgId });
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
  
  // Only show "My needs" and "My resources" buttons in private chats
  if (ctx.chat.type === 'private') {
    const myRow = itemTypes.map((type) => {
      const plural = `${type}s`;
      return t(ctx, `buttonMy${plural.charAt(0).toUpperCase() + plural.slice(1)}`);
    });
    return Markup.keyboard([newRow, myRow]).resize();
  } else {
    // In group chats, only show the "New need" and "New resource" buttons
    return Markup.keyboard([newRow]).resize();
  }
}

bot.start(async (ctx) => {
  // In group chats, only allow /start if this is the only bot OR if bot was explicitly mentioned
  if (ctx.chat.type !== 'private') {
    // Check if the bot was explicitly mentioned in the command
    const botMentioned = ctx.message.text && ctx.message.text.includes('@');

    // If bot was not explicitly mentioned, check for other bots
    if (!botMentioned) {
      const isOnlyBot = await isOnlyBotInChat(ctx);
      if (!isOnlyBot) {
        // Don't respond to /start in group chats with multiple bots
        return;
      }
    }
  }

  // Ensure we at least have an empty user object in the DB
  await storage.getUserData(ctx.from.id);
  await storage.writeDB();
  
  // Check if we need to show explicit bot mentions in the welcome message
  let welcomeText = t(ctx, 'welcome', { description: t(ctx, 'description') });
  if (ctx.chat.type !== 'private') {
    const isOnlyBot = await isOnlyBotInChat(ctx);
    if (!isOnlyBot) {
      // Replace /help with explicit bot mention in welcome message
      welcomeText = welcomeText.replace('/help', '/help@CorrelationCenterBot');
    }
  }
  
  await ctx.reply(welcomeText, getMainKeyboard(ctx));
});

// Handle all incoming messages (text or images) for adding items
bot.on('message', async (ctx, next) => {
  // If user sent /cancel, bypass addItem so cancel command can run
  if (ctx.message.text && ctx.message.text.startsWith('/cancel')) return next();
  
  // Check if this is a command-like text (clicked from help message)
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    const command = ctx.message.text.split(' ')[0].toLowerCase();
    if (command === '/need' || command === '/resource') {
      // Handle as if it were a command
      const type = command === '/need' ? 'need' : 'resource';
      
      // Check if this is a reply to a bot system message
      if (ctx.message.reply_to_message && isBotSystemMessage(ctx.message.reply_to_message, bot.botInfo.id)) {
        // Just switch to the new mode without publishing
        const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
        pendingActions[pendingKey] = type;
        const promptKey = `prompt${type.charAt(0).toUpperCase() + type.slice(1)}`;
        await ctx.reply(t(ctx, promptKey));
        return;
      }
      
      // For other replies, proceed with normal addItem logic
      if (ctx.message.reply_to_message) {
        return addItem(ctx, type);
      }
      
      // Set pending and schedule prompt after delay
      const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
      pendingActions[pendingKey] = type;
      setTimeout(() => {
        if (pendingActions[pendingKey] === type) {
          const promptKey = `prompt${type.charAt(0).toUpperCase() + type.slice(1)}`;
          ctx.reply(t(ctx, promptKey));
        }
      }, PROMPT_DELAY_MS);
      return;
    }
  }
  
  const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
  const action = pendingActions[pendingKey];
  if (!action) return next();
  
  // Check if this is a reply to a bot system message
  if (ctx.message.reply_to_message && isBotSystemMessage(ctx.message.reply_to_message, bot.botInfo.id)) {
    // Don't publish bot system messages, just switch to the new mode
    const promptKey = `prompt${action.charAt(0).toUpperCase() + action.slice(1)}`;
    await ctx.reply(t(ctx, promptKey));
    return;
  }
  
  // Additional check: if the message content itself looks like a bot system message, don't publish it
  if (ctx.message.text) {
    const variants = getAllBotMessageVariants();
    const isSystemMessageContent = variants.some(variant => 
      ctx.message.text.trim().startsWith(variant.trim())
    );
    if (isSystemMessageContent) {
      // This looks like a bot system message content, don't publish it
      const promptKey = `prompt${action.charAt(0).toUpperCase() + action.slice(1)}`;
      await ctx.reply(t(ctx, promptKey));
      return;
    }
  }
  
  await addItem(ctx, action);
});

// Help command: private vs group
bot.command('help', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply(t(ctx, 'help'));
  } else {
    const isOnlyBot = await isOnlyBotInChat(ctx);
    if (isOnlyBot) {
      await ctx.reply(t(ctx, 'helpGroup'));
    } else {
      // Show help with explicit bot mention
      const helpText = t(ctx, 'helpGroup')
        .replace('/start', '/start@CorrelationCenterBot')
        .replace('/help', '/help@CorrelationCenterBot');
      await ctx.reply(helpText);
    }
  }
});

// Cancel any pending action
bot.command('cancel', async (ctx) => {
  const pendingKey = getPendingActionKey(ctx.from.id, ctx.chat.id);
  if (pendingActions[pendingKey]) {
    delete pendingActions[pendingKey];
    await ctx.reply(t(ctx, 'actionCancelled'));
  } else {
    await ctx.reply(t(ctx, 'noPendingAction'));
  }
});

// Only start the bot outside of test environment
if (process.env.NODE_ENV !== 'test') {
  // await migrateDeleteUserChannelMessages({ userId: 7419276965, tracing: true });
  // await migrateDeleteUserChannelMessages({ userId: 7474624462, tracing: true });
  // await migrateDeleteUserChannelMessages({ userId: 5309502176, tracing: true });
  // await migrateDeleteUserChannelMessages({ userId: 1673752450, tracing: true });
  // console.log('Migrating old user mentions...');
  // await migrateUserMentions({ limit: 2, tracing: true });
  bot.launch().catch((error) => {
    console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
    process.exit(1);
  });
  console.log('Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}