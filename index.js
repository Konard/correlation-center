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

  // Listing handlers (/needs and 'My needs' button)
  bot.command(plural, async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await storage.readDB();
    const user = storage.getUserData(ctx);
    if (user[plural].length === 0) return ctx.reply(t(ctx, `no${capitalizedPlural}`));
    for (let i = 0; i < user[plural].length; i++) {
      const item = user[plural][i];
      const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleString() : new Date().toLocaleString();
      await ctx.reply(
        `${item.description}\n\nCreated at ${createdAt}`,
        Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, deleteButtonKey) || 'Delete', `delete_${type}_${i}`)]
        ])
      );
    }
  });
  bot.hears(
    [t({ from: { language_code: 'en' } }, `buttonMy${capitalizedPlural}`), t({ from: { language_code: 'ru' } }, `buttonMy${capitalizedPlural}`)],
    async (ctx) => {
      if (ctx.chat.type !== 'private') return;
      await storage.readDB();
      const user = storage.getUserData(ctx);
      if (user[plural].length === 0) return ctx.reply(t(ctx, `no${capitalizedPlural}`));
      for (let i = 0; i < user[plural].length; i++) {
        const item = user[plural][i];
        const createdAt = item.createdAt ? new Date(item.createdAt).toLocaleString() : new Date().toLocaleString();
        await ctx.reply(
          `${item.description}\n\nCreated at ${createdAt}`,
          Markup.inlineKeyboard([
            [Markup.button.callback(t(ctx, deleteButtonKey) || 'Delete', `delete_${type}_${i}`)]
          ])
        );
      }
    }
  );

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
      const createdAt = removed.createdAt ? new Date(removed.createdAt).toLocaleString() : new Date().toLocaleString();
      const deletedAt = new Date().toLocaleString();
      await ctx.editMessageText(`${removed.description}\n\nCreated at ${createdAt}\nDeleted at ${deletedAt}`);
    } else {
      await ctx.answerCbQuery('Not found');
    }
  });
});
function getMainKeyboard(ctx) {
  return Markup.keyboard([
    [t(ctx, 'buttonNeed'), t(ctx, 'buttonResource')],
    [t(ctx, 'buttonMyNeeds'), t(ctx, 'buttonMyResources')]
  ]).resize();
}

bot.start(async (ctx) => {
  await storage.readDB();
  storage.getUserData(ctx);
  await storage.writeDB();
  await ctx.reply(t(ctx, 'welcome', { description: t(ctx, 'description') }), getMainKeyboard(ctx));
});

bot.command('needs', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.needs.length === 0) return ctx.reply(t(ctx, 'noNeeds'));
  for (let i = 0; i < user.needs.length; i++) {
    const n = user.needs[i];
    const createdAt = n.createdAt ? new Date(n.createdAt).toLocaleString() : new Date().toLocaleString();
    await ctx.reply(
      `${n.description}\n\nCreated at ${createdAt}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx, 'deleteNeedButton') || 'Delete', `delete_need_${i}`)]
      ])
    );
  }
});

bot.command('resources', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.resources.length === 0) return ctx.reply(t(ctx, 'noResources'));
  for (let i = 0; i < user.resources.length; i++) {
    const r = user.resources[i];
    const createdAt = r.createdAt ? new Date(r.createdAt).toLocaleString() : new Date().toLocaleString();
    await ctx.reply(
      `${r.description}\n\nCreated at ${createdAt}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx, 'deleteResourceButton') || 'Delete', `delete_resource_${i}`)]
      ])
    );
  }
});

bot.on('text', async (ctx, next) => {
  const action = pendingActions[ctx.from.id];
  if (!action) return next();
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    await ctx.reply(t(ctx, action === 'need' ? 'promptNeed' : 'promptResource'));
    return;
  }
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (action === 'need') {
    const need = {
      requestor: ctx.from.username || ctx.from.first_name || 'unknown',
      guid: uuidv7(),
      description: text,
      createdAt: new Date().toISOString()
    };
    // Publish to channel
    try {
      const post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        `${need.description}\n\n<i>Need of @${need.requestor}.</i>`,
        { parse_mode: 'HTML' }
      );
      need.channelMessageId = post.message_id;
    } catch (e) {
      need.channelMessageId = null;
    }
    user.needs.push(need);
    await storage.writeDB();
    await ctx.reply(t(ctx, 'needAdded', { item: need.description }));
  } else if (action === 'resource') {
    const resource = {
      supplier: ctx.from.username || ctx.from.first_name || 'unknown',
      guid: uuidv7(),
      description: text,
      createdAt: new Date().toISOString()
    };
    // Publish to channel
    try {
      const post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        `${resource.description}\n\n<i>Resource provided by @${resource.supplier}.</i>`,
        { parse_mode: 'HTML' }
      );
      resource.channelMessageId = post.message_id;
    } catch (e) {
      resource.channelMessageId = null;
    }
    user.resources.push(resource);
    await storage.writeDB();
    await ctx.reply(t(ctx, 'resourceAdded', { item: resource.description }));
  }
  delete pendingActions[ctx.from.id];
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