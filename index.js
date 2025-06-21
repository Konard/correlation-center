import 'dotenv/config';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import Storage from './storage.js';
import { v7 as uuidv7 } from 'uuid';

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

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const pendingActions = {};
const CHANNEL_USERNAME = '@CorrelationCenter';
// Helper to list items for both needs and resources
async function listItems(ctx, type) {
  if (ctx.chat.type !== 'private') return;
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const plural = `${type}s`;
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const capitalizedPlural = plural.charAt(0).toUpperCase() + plural.slice(1);
  if (user[plural].length === 0) {
    return ctx.reply(t(ctx, `no${capitalizedPlural}`));
  }
  for (let i = 0; i < user[plural].length; i++) {
    const item = user[plural][i];
    const createdAt = formatDate(item.createdAt);
    await ctx.reply(
      `${item.description}\n\nCreated at ${createdAt}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx, `delete${capitalized}Button`) || 'Delete', `delete_${type}_${i}`)]
      ])
    );
  }
}
// Helper to add a new item (need or resource)
async function addItem(ctx, type) {
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
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
  const promptKey = `prompt${capitalized}`;
  if (!description && !fileId) {
    await ctx.reply(t(ctx, promptKey));
    return;
  }
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const config = {
    need: {
      field: 'needs',
      role: 'requestor',
      addedKey: 'needAdded',
      channelTemplate: (desc, name) => `${desc}\n\n<i>Need of @${name}.</i>`
    },
    resource: {
      field: 'resources',
      role: 'supplier',
      addedKey: 'resourceAdded',
      channelTemplate: (desc, name) => `${desc}\n\n<i>Resource provided by @${name}.</i>`
    }
  };
  const { field, role, addedKey, channelTemplate } = config[type];
  const item = {
    [role]: ctx.from.username || ctx.from.first_name || 'unknown',
    guid: uuidv7(),
    description,
    createdAt: new Date().toISOString()
  };
  if (fileId) item.fileId = fileId;
  try {
    let post;
    if (fileId) {
      post = await ctx.telegram.sendPhoto(
        CHANNEL_USERNAME,
        fileId,
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
  } catch (e) {
    item.channelMessageId = null;
  }
  user[field].push(item);
  await storage.writeDB();
  await ctx.reply(t(ctx, addedKey, { channel: CHANNEL_USERNAME }));
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
    const index = parseInt(ctx.match[1], 10);
    await storage.readDB();
    const user = storage.getUserData(ctx);
    const collection = user[plural];
    if (index >= 0 && index < collection.length) {
      const removed = collection.splice(index, 1)[0];
      if (removed.channelMessageId) {
        try {
          await ctx.telegram.deleteMessage(CHANNEL_USERNAME, removed.channelMessageId);
        } catch (e) {}
      }
      await storage.writeDB();
      const createdAt = formatDate(removed.createdAt);
      const deletedAt = formatDate();
      await ctx.editMessageText(`${removed.description}\n\nCreated at ${createdAt}\nDeleted at ${deletedAt}`);
    } else {
      await ctx.answerCbQuery('Not found');
    }
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
  storage.getUserData(ctx);
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

// Launch bot
console.log('Launching bot...');
bot.launch().catch((error) => {
  console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
  process.exit(1);
});
console.log('Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));