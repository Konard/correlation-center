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
function getMainKeyboard(ctx) {
  return Markup.keyboard([
    [t(ctx, 'buttonNeed'), t(ctx, 'buttonResource')]
  ]).resize();
}

bot.start(async (ctx) => {
  await storage.readDB();
  storage.getUserData(ctx);
  await storage.writeDB();
  await ctx.reply(t(ctx, 'welcome'), getMainKeyboard(ctx));
});

bot.command('need', async (ctx) => {
  pendingActions[ctx.from.id] = 'need';
  await ctx.reply(t(ctx, 'promptNeed'));
});

bot.command('resource', async (ctx) => {
  pendingActions[ctx.from.id] = 'resource';
  await ctx.reply(t(ctx, 'promptResource'));
});

bot.hears([t({from: {language_code: 'en'}}, 'buttonNeed'), t({from: {language_code: 'ru'}}, 'buttonNeed')], async (ctx) => {
  pendingActions[ctx.from.id] = 'need';
  await ctx.reply(t(ctx, 'promptNeed'));
});

bot.hears([t({from: {language_code: 'en'}}, 'buttonResource'), t({from: {language_code: 'ru'}}, 'buttonResource')], async (ctx) => {
  pendingActions[ctx.from.id] = 'resource';
  await ctx.reply(t(ctx, 'promptResource'));
});

bot.on('text', async (ctx, next) => {
  const action = pendingActions[ctx.from.id];
  if (!action) return next();
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (action === 'need') {
    const need = {
      requestor: ctx.from.username || ctx.from.first_name || 'unknown',
      guid: uuidv7(),
      description: ctx.message.text
    };
    // Publish to channel
    try {
      const post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        `New need from @${need.requestor}:\n${need.description}`
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
      description: ctx.message.text
    };
    // Publish to channel
    try {
      const post = await ctx.telegram.sendMessage(
        CHANNEL_USERNAME,
        `New resource from @${resource.supplier}:\n${resource.description}`
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

bot.command('listneeds', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.needs.length === 0) return ctx.reply(t(ctx, 'noNeeds'));
  const list = user.needs.map((n, i) => `${i + 1}. ${n.description} (by ${n.requestor}, id: ${n.guid})`).join('\n');
  ctx.reply(t(ctx, 'listNeeds', { list }));
});

bot.command('deleteneed', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const arg = ctx.message.text.split(' ')[1];
  const index = parseInt(arg, 10);
  if (!arg || isNaN(index) || index < 1 || index > user.needs.length) {
    return ctx.reply(t(ctx, 'deleteNeedUsage'));
  }
  const removed = user.needs.splice(index - 1, 1)[0];
  // Delete from channel if posted
  if (removed.channelMessageId) {
    try {
      await ctx.telegram.deleteMessage(CHANNEL_USERNAME, removed.channelMessageId);
    } catch (e) {}
  }
  await storage.writeDB();
  ctx.reply(t(ctx, 'deleteNeedSuccess', { item: removed.description }));
});

bot.command('listresources', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.resources.length === 0) return ctx.reply(t(ctx, 'noResources'));
  const list = user.resources.map((r, i) => `${i + 1}. ${r.description} (by ${r.supplier}, id: ${r.guid})`).join('\n');
  ctx.reply(t(ctx, 'listResources', { list }));
});

bot.command('deleteresource', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const arg = ctx.message.text.split(' ')[1];
  const index = parseInt(arg, 10);
  if (!arg || isNaN(index) || index < 1 || index > user.resources.length) {
    return ctx.reply(t(ctx, 'deleteResourceUsage'));
  }
  const removed = user.resources.splice(index - 1, 1)[0];
  // Delete from channel if posted
  if (removed.channelMessageId) {
    try {
      await ctx.telegram.deleteMessage(CHANNEL_USERNAME, removed.channelMessageId);
    } catch (e) {}
  }
  await storage.writeDB();
  ctx.reply(t(ctx, 'deleteResourceSuccess', { item: removed.description }));
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